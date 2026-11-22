import "server-only";

/**
 * Is a merchant's autopay mandate still chargeable, by the gateway's word?
 *
 * ★★ WHY (21 Nov 2026). StoreMink's own record said `active` from the day a
 * mandate was authorised until the merchant cancelled their plan, and nothing
 * ever asked the gateway again. But a customer can cancel or pause a mandate
 * from their bank or UPI app at any time, and Razorpay's rule is that "Only
 * tokens in the confirmed state can be used to execute subsequent payments."
 * A renewal sent against a mandate that was gone would tell the merchant
 * "we'll charge your saved payment method, there's nothing you need to do",
 * send a pre-debit notice, wait a day and a half, and then fail.
 *
 * So the mandate is verified before every automatic try and again just before
 * the debit, and StoreMink's record follows the answer:
 *
 *   confirmed            stays `active` (an `unknown` one becomes active again)
 *   paused / initiated   `unknown`: not chargeable now, asked again next time
 *   cancelled / rejected `revoked` / `failed`, for good
 *   expired              `expired`
 *   could not be read    NOTHING changes, and the caller does nothing this run
 *
 * `unknown` is exactly what docs/billing-architecture.md §4 says it is: a
 * state that "triggers verification, never an assumption".
 */

import { and, eq, inArray } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { billingMandates } from "@/drizzle/schema";
import { logError, logWarn } from "@/lib/observability/logger";
import type { MandateRail, RecurringGateway } from "./collect";
import type { MandateStatus } from "./cycle";

/** A mandate as the billing passes hold it. */
export interface MandateRecord {
  id: string;
  status: MandateStatus | null;
  maxAmountPaise: number | null;
  providerTokenId: string | null;
  providerCustomerId: string | null;
  method: MandateRail | null;
}

export type MandateVerdict =
  /** Chargeable. `mandate.status` is `active`. */
  | { result: "usable"; mandate: MandateRecord }
  /**
   * Not chargeable. `mandate.status` is what StoreMink now records, and
   * `changed` is true when THIS call is the one that moved it off `active`:
   * the moment, exactly once, to tell the merchant autopay has stopped.
   */
  | {
      result: "unusable";
      mandate: MandateRecord;
      changed: boolean;
      reason: "paused" | "ended";
    }
  /** The gateway could not be asked. Nothing was written. */
  | { result: "unknown" };

/** Mandates worth asking the gateway about: live, or waiting to be re-read. */
export function isVerifiable(mandate: MandateRecord | null): boolean {
  return (
    !!mandate &&
    (mandate.status === "active" || mandate.status === "unknown") &&
    !!mandate.providerTokenId &&
    !!mandate.providerCustomerId
  );
}

/** Load one mandate, or null (missing, or a failed read). */
export async function loadMandateRecord(
  mandateId: string | null,
): Promise<MandateRecord | null> {
  if (!mandateId) return null;
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          id: billingMandates.id,
          status: billingMandates.status,
          maxAmountPaise: billingMandates.maxAmountPaise,
          providerTokenId: billingMandates.providerTokenId,
          providerCustomerId: billingMandates.providerCustomerId,
          method: billingMandates.method,
        })
        .from(billingMandates)
        .where(eq(billingMandates.id, mandateId))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        status: row.status as MandateStatus,
        maxAmountPaise: row.maxAmountPaise,
        providerTokenId: row.providerTokenId,
        providerCustomerId: row.providerCustomerId,
        method: (row.method ?? "unknown") as MandateRail,
      };
    });
  } catch (err) {
    logError("billing.load_mandate", err, { mandateId });
    return null;
  }
}

/**
 * Ask the gateway about one mandate and bring StoreMink's record in line.
 *
 * ★ Every write is a conditional claim on the status it was read with, so two
 * passes asking about the same mandate cannot both report `changed`, and a
 * mandate the merchant cancelled meanwhile (`revoked`) is never revived.
 * Never throws.
 */
export async function verifyMandate(
  mandate: MandateRecord,
  gateway: RecurringGateway,
  now: Date = new Date(),
): Promise<MandateVerdict> {
  if (!mandate.providerTokenId || !mandate.providerCustomerId) {
    return { result: "unusable", mandate, changed: false, reason: "ended" };
  }

  let check: Awaited<ReturnType<RecurringGateway["checkMandate"]>>;
  try {
    check = await gateway.checkMandate({
      providerCustomerId: mandate.providerCustomerId,
      providerTokenId: mandate.providerTokenId,
    });
  } catch (err) {
    logError("billing.mandate_check_threw", err, { mandateId: mandate.id });
    return { result: "unknown" };
  }
  if (check.state === "unknown") return { result: "unknown" };

  try {
    if (check.state === "chargeable") {
      if (mandate.status === "active") return { result: "usable", mandate };
      // A paused mandate the customer resumed: live again. ★ A store may hold
      // only ONE active mandate (a partial unique index), so when a newer one
      // has taken its place this write is refused, and that is the answer:
      // this mandate is not the one to charge.
      let revived: boolean;
      try {
        revived = await moveStatus(mandate.id, ["unknown"], "active", now);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        revived = false;
      }
      return revived
        ? { result: "usable", mandate: { ...mandate, status: "active" } }
        : // Someone else moved it (the merchant cancelled, or a newer mandate
          // took its place): not ours to charge.
          { result: "unusable", mandate, changed: false, reason: "ended" };
    }

    const next: MandateStatus =
      check.state === "paused"
        ? "unknown"
        : check.detail === "expired"
          ? "expired"
          : check.detail.startsWith("rejected")
            ? "failed"
            : "revoked";
    // ★ `changed` only when this call took it off `active`. An `unknown`
    // (paused) mandate that has now ended is recorded as ended, but the
    // merchant was already told when it was paused.
    const from: MandateStatus[] =
      next === "unknown" ? ["active"] : ["active", "unknown"];
    const moved = await moveStatus(mandate.id, from, next, now);
    const changed = moved && mandate.status === "active";
    if (changed) {
      logWarn("billing.mandate_unusable", {
        mandateId: mandate.id,
        gatewayState: check.detail,
        recordedAs: next,
      });
    }
    return {
      result: "unusable",
      mandate: { ...mandate, status: moved ? next : mandate.status },
      changed,
      reason: check.state,
    };
  } catch (err) {
    logError("billing.mandate_status_write", err, { mandateId: mandate.id });
    // The gateway said no and we could not record it. Do not charge; the next
    // pass asks again and records it then.
    return check.state === "chargeable"
      ? { result: "unknown" }
      : { result: "unusable", mandate, changed: false, reason: check.state };
  }
}

/** Move a mandate's status, only from one of `from`. True when a row moved. */
async function moveStatus(
  mandateId: string,
  from: MandateStatus[],
  to: MandateStatus,
  now: Date,
): Promise<boolean> {
  const rows = await withService((db) =>
    db
      .update(billingMandates)
      .set({
        status: to,
        updatedAt: now.toISOString(),
        // Stamped when it ends for good, as the merchant's own cancel does.
        ...(to === "revoked" || to === "expired" || to === "failed"
          ? { revokedAt: now.toISOString() }
          : {}),
      })
      .where(
        and(
          eq(billingMandates.id, mandateId),
          inArray(billingMandates.status, from),
        ),
      )
      .returning({ id: billingMandates.id }),
  );
  return rows.length > 0;
}
