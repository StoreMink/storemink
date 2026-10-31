import "server-only";

/**
 * StoreMink's OWN tax identity — the operator-managed half of §34.
 *
 * ★★ WHY AN OPERATOR SCREEN AND NOT A CONFIG FILE. This decides what appears on
 * a GST tax invoice: the legal name, the GSTIN, the place-of-supply origin, and
 * whether tax is charged at all. Those change on a business timetable (the day a
 * GSTIN is issued, the day an address changes), not on a deploy timetable — and
 * the person who knows is the operator, not whoever is shipping that week.
 *
 * ★★ TURNING TAX ON IS NOT RETROACTIVE, and cannot be. Finalized invoices are
 * immutable by trigger (billing_03), so an April invoice cannot sprout GST in
 * September. That is the correct behaviour and it is worth saying out loud on the
 * screen, because the intuition ("I've added my GSTIN, now everything is a tax
 * invoice") is the opposite.
 *
 * ★ THE DATABASE IS THE BOUNDARY, not this module.
 * `platform_billing_tax_needs_gstin` refuses `tax_enabled` without a GSTIN, so an
 * invoice can never charge GST while naming no GSTIN — which would not be a valid
 * tax invoice, and the merchant could not claim input credit against it. The
 * checks here exist to give a sentence instead of a constraint violation.
 *
 * ★★ THREE SAVES, NOT ONE (GST design 5.8). `saveTaxIdentity` writes who
 * StoreMink is and never what is charged; `scheduleTaxChange` changes what is
 * charged, now or from a start time, under the notice rule;
 * `cancelScheduledTaxChange` withdraws a change that has not started. Each runs
 * in one transaction that first promotes a change that has already started
 * (`promoteDueTaxChange`) and then reads the row under a lock, so it judges the
 * row as it is, and each busts the cached public source after it commits
 * (`bustPlatformTax`). None of them reads or writes `auto_refunds` or
 * `automatic_refunds_from`.
 */

import { eq, sql } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { withService, type Db } from "@/lib/db/client";
import { pgConstraint, pgErrorCode } from "@/lib/db/errors";
import {
  platformAnnouncements,
  platformBillingSettings,
} from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import type { PlatformTaxSettings } from "./invoice-types";
import {
  isValidGstinFormat,
  normalizeStateCode,
  stateCodeFromGstin,
} from "./gst";
import {
  AUTO_REFUNDS_IDENTITY_INCOMPLETE,
  INVALID_GSTIN,
  TAX_SETTINGS_REFUSAL,
  noticeRefusal,
  tooSoonAfterNotice,
} from "./tax-copy";
import {
  LAW_SET_RATE_RISE_WITHOUT_NOTICE,
  noticeQualifies,
  raisesPayable,
  termsAt,
  type TaxTerms,
  type TaxTermsSource,
  type TaxValues,
} from "./tax-terms";

export type { PlatformTaxSettings };

export const DEFAULT_TAX_SETTINGS: PlatformTaxSettings = {
  legalName: null,
  gstin: null,
  address: {},
  stateCode: null,
  taxEnabled: false,
  taxRateBps: 1800,
  taxInclusive: false,
  invoicePrefix: "SM",
  updatedAt: null,
  updatedBy: null,
  // Off, as migration 0264 ships it: a refund is sent only when a person
  // presses Send until an operator switches automatic sending on.
  autoRefunds: false,
  nextTax: null,
  sacCode: null,
  llpin: null,
  registeredOffice: null,
};

/**
 * The scheduled change as the console shows it, or null.
 *
 * ★ ALL FOUR OR NOTHING, the rule `termsAt` reads by: the database refuses a
 * half-scheduled change (`platform_billing_next_tax_shape`), and a row that
 * somehow has one anyway is shown as no change rather than as a change to
 * "off" or to rate 0.
 */
function nextTaxOf(row: {
  nextTaxEnabled: boolean | null;
  nextTaxInclusive: boolean | null;
  nextTaxRateBps: number | null;
  nextTaxStartsAt: string | null;
  nextTaxNoticeId: string | null;
}): PlatformTaxSettings["nextTax"] {
  if (
    row.nextTaxStartsAt == null ||
    row.nextTaxEnabled == null ||
    row.nextTaxInclusive == null ||
    row.nextTaxRateBps == null
  ) {
    return null;
  }
  return {
    enabled: row.nextTaxEnabled === true,
    inclusive: row.nextTaxInclusive === true,
    rateBps: row.nextTaxRateBps,
    startsAt: row.nextTaxStartsAt,
    noticeId: row.nextTaxNoticeId ?? null,
  };
}

/**
 * Read the singleton, for the Billing & tax console.
 *
 * ★ NO ROW IS THE DEFAULTS (GST off, nothing configured), which is true. ★★ AN
 * UNREADABLE ROW IS NULL, never the defaults (review R3-05): the console is
 * the one screen that edits StoreMink's identity, and defaults drawn there
 * read as "GST off, no GSTIN", which an operator could then save over the
 * stored identity. The console shows `TAX_CONSOLE.readFailed` and disables
 * every save until a read succeeds. ⚠ For display only: an invoice reads its
 * tax through `loadTaxSnapshot`, which throws on a read error instead,
 * because building an invoice on a guess would charge the wrong GST.
 */
export async function getPlatformTaxSettings(): Promise<PlatformTaxSettings | null> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select()
        .from(platformBillingSettings)
        .where(eq(platformBillingSettings.id, true))
        .limit(1);
      if (!row) return DEFAULT_TAX_SETTINGS;
      return {
        legalName: row.legalName,
        gstin: row.gstin,
        address: (row.address ?? {}) as PlatformTaxSettings["address"],
        stateCode: row.stateCode,
        taxEnabled: row.taxEnabled,
        taxRateBps: row.taxRateBps,
        taxInclusive: row.taxInclusive,
        invoicePrefix: row.invoicePrefix,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        autoRefunds: row.autoRefunds === true,
        nextTax: nextTaxOf({
          nextTaxEnabled: row.nextTaxEnabled ?? null,
          nextTaxInclusive: row.nextTaxInclusive ?? null,
          nextTaxRateBps: row.nextTaxRateBps ?? null,
          nextTaxStartsAt: row.nextTaxStartsAt ?? null,
          nextTaxNoticeId: row.nextTaxNoticeId ?? null,
        }),
        sacCode: row.sacCode ?? null,
        llpin: row.llpin ?? null,
        registeredOffice: row.registeredOffice ?? null,
      };
    });
  } catch (err) {
    logError("billing.platform_settings.read", err);
    return null;
  }
}

/** No settings row: GST off, nothing scheduled. */
const NO_TAX_TERMS_SOURCE: TaxTermsSource = {
  taxEnabled: false,
  taxInclusive: false,
  taxRateBps: 0,
  nextTaxEnabled: null,
  nextTaxInclusive: null,
  nextTaxRateBps: null,
  nextTaxStartsAt: null,
};

/**
 * The settings columns that decide which GST applies (`TaxTermsSource`),
 * read LIVE. `db` runs the read inside the caller's transaction.
 *
 * ★ A READ FAILURE THROWS: whatever follows may take a payment, and a
 * guessed "GST off" would quote the wrong amount.
 */
export async function readTaxTermsSource(db?: Db): Promise<TaxTermsSource> {
  const run = async (handle: Db): Promise<TaxTermsSource> => {
    const [row] = await handle
      .select({
        taxEnabled: platformBillingSettings.taxEnabled,
        taxInclusive: platformBillingSettings.taxInclusive,
        taxRateBps: platformBillingSettings.taxRateBps,
        nextTaxEnabled: platformBillingSettings.nextTaxEnabled,
        nextTaxInclusive: platformBillingSettings.nextTaxInclusive,
        nextTaxRateBps: platformBillingSettings.nextTaxRateBps,
        nextTaxStartsAt: platformBillingSettings.nextTaxStartsAt,
      })
      .from(platformBillingSettings)
      .where(eq(platformBillingSettings.id, true))
      .limit(1);
    if (!row) return NO_TAX_TERMS_SOURCE;
    return {
      taxEnabled: row.taxEnabled === true,
      taxInclusive: row.taxInclusive === true,
      taxRateBps: Number(row.taxRateBps ?? 0),
      nextTaxEnabled: row.nextTaxEnabled ?? null,
      nextTaxInclusive: row.nextTaxInclusive ?? null,
      nextTaxRateBps: row.nextTaxRateBps ?? null,
      nextTaxStartsAt: row.nextTaxStartsAt ?? null,
    };
  };
  return db ? run(db) : withService(run);
}

/**
 * The GST terms at `now`, read LIVE (GST design 5.11): for the dashboard,
 * signup and anything followed by a payment. Never cached, so a change the
 * operator saves or a scheduled start shows on the very next request.
 * Marketing pages read the cached public source instead (GST Stage 9).
 *
 * ★ Throws on a read failure, like `readTaxTermsSource`.
 */
export async function getTaxTermsLive(
  now: Date = new Date(),
): Promise<TaxTerms> {
  return termsAt(await readTaxTermsSource(), now);
}

/**
 * The cache tag of the public tax source (`getPublicTaxSource`,
 * `lib/billing/public-tax.ts`, GST design 5.11).
 *
 * ★ DEFINED HERE, RE-EXPORTED THERE: the three saves below bust it, and
 * public-tax.ts reads `readTaxTermsSource` from this module, so keeping the tag
 * and the bust here leaves the import one way (no cycle).
 */
export const PLATFORM_TAX_TAG = "platform-tax";

/**
 * Mark the cached public tax source stale, so the pricing pages show a saved
 * change on their next request (GST design 5.11).
 *
 * `revalidateTag(tag, "max")`: Next 16 needs the profile (`bustPlanPricing`,
 * lib/plans/pricing.ts). ★ NEVER THROWS: it runs after the save has committed,
 * and a failed bust must not report a saved change as failed. The cache
 * expires on its own within 300 seconds in any case.
 */
export function bustPlatformTax(): void {
  try {
    revalidateTag(PLATFORM_TAX_TAG, "max");
  } catch (err) {
    logWarn("billing.platform_tax.bust_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The change `promoteDueTaxChange` copied into the in-force columns. */
export type PromotedTaxChange = TaxValues & {
  /** When it was scheduled to start. */
  startsAt: string;
  noticeId: string | null;
};

/** Who `updated_by` names when the hourly run applies a scheduled change. */
export const PROMOTED_BY = "system: scheduled GST change";

/**
 * Copy a scheduled change that has started into the in-force columns and
 * clear it (GST design 5.8 item 4, probe T2j).
 *
 * One statement: a locked read of the due change, then the update from it.
 * Two runs at once cannot both promote: the second waits on the row lock and
 * then finds `next_tax_starts_at` null. Idempotent, so the hourly run and
 * every save may call it.
 *
 * ★ CORRECTNESS NEVER DEPENDS ON IT: `termsAt` already applies a change from
 * its start. It keeps the in-force columns true for anything that reads them
 * directly, the replaced revision included.
 *
 * ★ THE CALLER BUSTS: when this returns a change, call `bustPlatformTax()`
 * after the transaction commits (the hourly route does; the saves bust after
 * every commit anyway). `db` runs it inside the caller's transaction.
 *
 * Throws on a database error.
 */
export async function promoteDueTaxChange(
  now: Date = new Date(),
  db?: Db,
): Promise<PromotedTaxChange | null> {
  return db
    ? promoteDueWith(db, now)
    : withService((h) => promoteDueWith(h, now));
}

async function promoteDueWith(
  db: Db,
  now: Date,
): Promise<PromotedTaxChange | null> {
  const res = await db.execute(sql`
    with due as (
      select next_tax_enabled, next_tax_inclusive, next_tax_rate_bps,
             next_tax_starts_at, next_tax_notice_id
        from public.platform_billing_settings
       where id
         and next_tax_starts_at is not null
         and next_tax_starts_at <= ${now.toISOString()}::timestamptz
         for update
    )
    update public.platform_billing_settings s
       set tax_enabled = d.next_tax_enabled,
           tax_inclusive = d.next_tax_inclusive,
           tax_rate_bps = d.next_tax_rate_bps,
           next_tax_enabled = null,
           next_tax_inclusive = null,
           next_tax_rate_bps = null,
           next_tax_starts_at = null,
           next_tax_notice_id = null,
           updated_at = now(),
           updated_by = ${PROMOTED_BY}
      from due d
     where s.id
    returning d.next_tax_enabled as enabled,
              d.next_tax_inclusive as inclusive,
              d.next_tax_rate_bps as rate_bps,
              d.next_tax_starts_at as starts_at,
              d.next_tax_notice_id as notice_id`);
  const row = res.rows?.[0] as
    | {
        enabled: boolean;
        inclusive: boolean;
        rate_bps: number | string;
        starts_at: string | Date;
        notice_id: string | null;
      }
    | undefined;
  if (!row) return null;
  const startsAt =
    row.starts_at instanceof Date
      ? row.starts_at.toISOString()
      : String(row.starts_at);
  return {
    enabled: row.enabled === true,
    inclusive: row.inclusive === true,
    rateBps: Number(row.rate_bps),
    startsAt,
    noticeId: row.notice_id ?? null,
  };
}

/** What the refund pass needs to know before money moves (design 6.6). */
export interface RefundSettings {
  /** Whether automatic (system) refunds are sent without a person. */
  autoRefunds: boolean;
  /**
   * When automatic refunds were installed (migration 0264). A payment recorded
   * on an `uncollectible` invoice before it was kept by older code and is filed
   * for a person, never refunded by the pass on its own (owner decision D7).
   * Null when there is no settings row: no moment at all, which reads as
   * "infinity", so nothing is treated as new money.
   */
  automaticRefundsFrom: string | null;
}

/** SQLSTATE of a CHECK constraint violation. */
const CHECK_VIOLATION = "23514";

/** No settings row: sending off, and no payment counts as new money. */
const NO_REFUND_SETTINGS: RefundSettings = {
  autoRefunds: false,
  automaticRefundsFrom: null,
};

/**
 * The refund switches, read LIVE.
 *
 * ★★ NEVER CACHED, because it decides whether money moves: an operator who
 * switches automatic sending off must stop the very next run, not one a cache
 * lifetime later.
 *
 * ★ A READ FAILURE THROWS, unlike `getPlatformTaxSettings`. That one answers
 * null for a page; this one is asked by the refund pass and the
 * operator's actions, which must not guess. The pass counts the failure in its
 * errors (the cron answers 503 and Cloud Scheduler retries) and sends nothing,
 * and a caller that forgets to catch it also sends nothing.
 *
 * `db` runs the read inside the caller's transaction (never a scope inside
 * another scope's callback, lib/db/nested-scope-coverage.test.ts).
 */
export async function getRefundSettings(db?: Db): Promise<RefundSettings> {
  const run = async (handle: Db): Promise<RefundSettings> => {
    const [row] = await handle
      .select({
        autoRefunds: platformBillingSettings.autoRefunds,
        automaticRefundsFrom: platformBillingSettings.automaticRefundsFrom,
      })
      .from(platformBillingSettings)
      .where(eq(platformBillingSettings.id, true))
      .limit(1);
    if (!row) return NO_REFUND_SETTINGS;
    return {
      autoRefunds: row.autoRefunds === true,
      automaticRefundsFrom: row.automaticRefundsFrom ?? null,
    };
  };
  return db ? run(db) : withService(run);
}

/**
 * Switch automatic refund sending on or off (the console's "Send refunds
 * automatically", Billing & tax).
 *
 * ★ THE GATE IS THE CALLER'S: a platform superadmin, checked in the action
 * (`setAutoRefunds`), exactly as the three tax saves leave theirs to the
 * console's actions in app/actions/platform.ts. This writes `auto_refunds`
 * and who changed it, and
 * nothing else: the tax identity and `automatic_refunds_from` (the history
 * line) are never touched, so flipping the switch cannot restate an invoice
 * or turn history into new money.
 */
export async function savePlatformAutoRefunds(
  on: boolean,
  actor: string | null,
): Promise<SaveResult> {
  // A server action hands over whatever it was sent: only a real boolean may
  // decide whether money moves by itself.
  if (typeof on !== "boolean") {
    return { ok: false, error: "Choose on or off." };
  }
  const updatedAt = new Date().toISOString();
  try {
    await withService(async (db) => {
      await db
        .insert(platformBillingSettings)
        .values({ id: true, autoRefunds: on, updatedAt, updatedBy: actor })
        .onConflictDoUpdate({
          target: platformBillingSettings.id,
          set: { autoRefunds: on, updatedAt, updatedBy: actor },
        });
    });
    logInfo("billing.auto_refunds_changed", { autoRefunds: on });
    return { ok: true };
  } catch (err) {
    // ★ A CHECK JUDGES THE WHOLE ROW ON EVERY UPDATE (GST plan A2). While
    // StoreMink's tax identity is incomplete with GST on (a row 0266 left NOT
    // VALID, or an invoice prefix longer than 2 characters), every write of
    // the row is refused, this switch included. Saying which constraint is
    // for the log; the operator needs to know what to do.
    if (pgErrorCode(err) === CHECK_VIOLATION) {
      logWarn("billing.auto_refunds.identity_incomplete", {
        constraint: pgConstraint(err) ?? null,
      });
      return { ok: false, error: AUTO_REFUNDS_IDENTITY_INCOMPLETE };
    }
    logError("billing.auto_refunds.save", err);
    return {
      ok: false,
      error: "Couldn't save that setting. Please try again.",
    };
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string };

const trim = (v: unknown, max = 200): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

// The switch-on refusals (GST design 5.8: "existing GSTIN and state checks
// stay") and the rate and start refusals live in tax-copy.ts with the rest of
// the console's words, so the console page and these saves cannot drift.
const ENABLE_WITHOUT_GSTIN = TAX_SETTINGS_REFUSAL.enableWithoutGstin;
const ENABLE_WITHOUT_STATE = TAX_SETTINGS_REFUSAL.enableWithoutState;
const ENABLE_WITHOUT_LEGAL_NAME = TAX_SETTINGS_REFUSAL.enableWithoutLegalName;
const RATE_OUT_OF_RANGE = TAX_SETTINGS_REFUSAL.rateRange;
const SAVE_FAILED = "Couldn't save those settings. Please try again.";

/** "Your GSTIN starts with 07, ..." when its state digits and the state differ. */
function gstinStateMismatch(gstin: string, stateCode: string): string | null {
  const fromGstin = stateCodeFromGstin(gstin);
  if (fromGstin && fromGstin !== stateCode) {
    return `Your GSTIN starts with ${fromGstin}, which is a different state from the one selected (${stateCode}). One of them is wrong - they decide CGST+SGST vs IGST on every invoice.`;
  }
  return null;
}

// ── The three saves (GST design 5.8) ───────────────────────────────────────

/** What `saveTaxIdentity` takes: who StoreMink is, never what it charges. */
export interface TaxIdentityInput {
  legalName: string;
  gstin: string;
  stateCode: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postalCode: string;
  /** 6 digits starting with 99. */
  sacCode: string;
  /** ADC-5432: three letters, a hyphen and four digits. */
  llpin: string;
  registeredOffice: string;
  /** 1 or 2 letters or digits. */
  invoicePrefix: string;
}

/** What `scheduleTaxChange` takes (GST design 5.8 item 2). */
export interface TaxChangeInput {
  enabled: boolean;
  inclusive: boolean;
  /** Percent, as typed. Converted to basis points here. */
  ratePercent: number;
  when: "now" | "scheduled";
  /** Required when `when` is "scheduled": an instant at least 5 minutes and
   *  at most 400 days on. */
  startsAt?: string;
  /** The Operational notice a rise in what merchants pay needs. */
  noticeId?: string | null;
  /** The law changed the rate (read only once
   *  LAW_SET_RATE_RISE_WITHOUT_NOTICE is true). */
  rateSetByLaw?: boolean;
}

export type TaxChangeResult =
  | { ok: true; applied: "now" | "scheduled"; startsAt: string | null }
  | { ok: false; error: string };

/** A scheduled start must be at least this far ahead. */
export const MIN_START_LEAD_MS = 5 * 60_000;

/**
 * ...and at most this far (review R3-09). A start decades out is almost
 * always a typo in the year (2062 for 2026), and a pending change that far
 * away blocks clearing the identity until someone notices it.
 */
export const MAX_START_AHEAD_MS = 400 * 24 * 60 * 60_000;

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const SAC_RE = /^99[0-9]{4}$/;
const LLPIN_RE = /^[A-Z]{3}-[0-9]{4}$/;
const PREFIX_RE = /^[A-Z0-9]{1,2}$/;
const PIN_RE = /^[1-9][0-9]{5}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The earliest start a notice allows: its `sent_at` plus 1 calendar month,
 * counted in IST (GST design 5.8: a notice sent 10 Nov 15:00 IST allows 10 Dec
 * 15:00 IST onwards). The same wall-clock time a month on; a day the next month
 * does not have becomes its last day (31 Jan becomes 28 or 29 Feb). IST has no
 * daylight saving, so the fixed offset is exact. Null for a date that cannot
 * be read.
 */
export function earliestStartAfterNotice(sentAt: string): string | null {
  const ms = Date.parse(sentAt);
  if (!Number.isFinite(ms)) return null;
  const wall = new Date(ms + IST_OFFSET_MS);
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(wall.getUTCDate(), lastDay);
  const next = Date.UTC(
    year,
    month,
    day,
    wall.getUTCHours(),
    wall.getUTCMinutes(),
    wall.getUTCSeconds(),
    wall.getUTCMilliseconds(),
  );
  return new Date(next - IST_OFFSET_MS).toISOString();
}

/**
 * Does `before` to `after` raise what merchants pay, as the save treats it?
 * A rise in the rate alone counts as the operator's choice (and so needs the
 * notice) until the Terms cover a rate set by law
 * (`LAW_SET_RATE_RISE_WITHOUT_NOTICE`).
 */
export function effectiveRise(
  before: TaxValues,
  after: TaxValues,
  lawSetRateRiseWithoutNotice: boolean = LAW_SET_RATE_RISE_WITHOUT_NOTICE,
): "choice" | "rate" | null {
  const rise = raisesPayable(before, after);
  return rise === "rate" && !lawSetRateRiseWithoutNotice ? "choice" : rise;
}

/** The particulars every tax invoice and every invoice of the LLP carries. */
interface IdentityFields {
  gstin: string | null;
  stateCode: string | null;
  legalName: string | null;
  sacCode: string | null;
  llpin: string | null;
  registeredOffice: string | null;
  address: unknown;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The first particular missing before GST can be on, as the refusal to show,
 * or null when the identity is complete. Mirrors
 * `platform_billing_tax_needs_gstin`, `platform_billing_tax_needs_invoice_identity`
 * and `platform_billing_next_tax_needs_invoice_identity` (0266): the GSTIN,
 * state and legal name, the SAC code, address line 1 and a 6-digit PIN, the
 * LLPIN and the registered office.
 */
function identityGap(i: IdentityFields): string | null {
  const address =
    i.address && typeof i.address === "object" && !Array.isArray(i.address)
      ? (i.address as Record<string, unknown>)
      : {};
  if (!text(i.gstin)) return ENABLE_WITHOUT_GSTIN;
  if (!text(i.stateCode)) return ENABLE_WITHOUT_STATE;
  if (!text(i.legalName)) return ENABLE_WITHOUT_LEGAL_NAME;
  if (!text(i.sacCode)) return TAX_SETTINGS_REFUSAL.enableWithoutSac;
  if (!text(address.line1) || !PIN_RE.test(text(address.postalCode))) {
    return TAX_SETTINGS_REFUSAL.enableWithoutAddress;
  }
  if (!text(i.llpin) || !text(i.registeredOffice)) {
    return TAX_SETTINGS_REFUSAL.enableWithoutLlp;
  }
  return null;
}

type SettingsRow = typeof platformBillingSettings.$inferSelect;

/** The settings row under a lock, or null when there is none. */
async function lockedSettings(db: Db): Promise<SettingsRow | null> {
  const [row] = await db
    .select()
    .from(platformBillingSettings)
    .where(eq(platformBillingSettings.id, true))
    .for("update")
    .limit(1);
  return row ?? null;
}

/**
 * Write the settings row read under the lock: an UPDATE of that row, or an
 * INSERT only when there is none yet. Both `scheduleTaxChange` and
 * `saveTaxIdentity` write through it.
 *
 * ★★ NEVER `INSERT ... ON CONFLICT DO UPDATE` HERE. PostgreSQL checks the
 * PROPOSED insert row against every CHECK before it looks for the conflict,
 * and that row carries the column defaults (no GSTIN, no SAC code, no LLPIN).
 * So switching GST on, now or scheduled, was refused every time by
 * platform_billing_tax_needs_gstin, platform_billing_tax_needs_invoice_identity
 * or platform_billing_next_tax_needs_invoice_identity, however complete the
 * saved identity was. Found by gst.local case 10; a mocked database cannot
 * see it. With no row, `identityGap` has already refused switching GST on, so
 * the insert never carries a value those checks refuse; an identity save with
 * no row inserts GST off, which they accept.
 */
async function writeTaxColumns(
  db: Db,
  exists: boolean,
  write: Partial<typeof platformBillingSettings.$inferInsert>,
): Promise<void> {
  if (exists) {
    await db
      .update(platformBillingSettings)
      .set(write)
      .where(eq(platformBillingSettings.id, true));
    return;
  }
  await db.insert(platformBillingSettings).values({ id: true, ...write });
}

/** A refusal decided inside the transaction: nothing is written. */
class Refusal {
  constructor(readonly error: string) {}
}

/**
 * Save StoreMink's tax identity (GST design 5.8 item 1): legal name, GSTIN,
 * state, address, SAC code, LLPIN, registered office, invoice prefix.
 *
 * ★ NEVER CHANGES WHAT IS CHARGED: the GST columns, the scheduled change and
 * the refund switches are not written.
 *
 * ★★ WHILE GST IS ON OR SCHEDULED ON, a particular an invoice must carry
 * cannot be removed (the database's identity CHECKs refuse the same, probe
 * T2f2, T2f3, T2m): judged against the row read under a lock, after a change
 * that has already started is promoted.
 *
 * ★ AN LLPIN NEEDS THE LEGAL NAME BESIDE IT (review R2-08), whatever the GST
 * state: every invoice prints "{legal name} is registered with limited
 * liability. LLPIN ...", and without the name that line would name
 * "StoreMink" instead of the registered LLP. Checked after the GST-on rule,
 * so clearing the name while GST is on or scheduled keeps that refusal.
 *
 * ★★ A ROW THAT CANNOT BE READ REFUSES THE SAVE (review R3-05): the lock read
 * throws, the transaction rolls back and the answer is SAVE_FAILED, so a save
 * never writes over a row it could not judge. (No row at all is not a failed
 * read: the identity is then inserted, GST off.)
 *
 * ★ THE LOCKED ROW IS UPDATED, AND INSERTED ONLY WHEN THERE IS NONE
 * (`writeTaxColumns`, review R3-13), never `INSERT ... ON CONFLICT DO UPDATE`:
 * PostgreSQL checks the proposed insert row against every CHECK first, and
 * that row would carry the defaults of every column this save does not write.
 *
 * The gate is the caller's (a platform superadmin, in the action).
 */
export async function saveTaxIdentity(
  input: TaxIdentityInput,
  actor: string | null,
): Promise<SaveResult> {
  if (!input || typeof input !== "object") {
    return { ok: false, error: SAVE_FAILED };
  }
  const legalName = trim(input.legalName);
  const gstin = trim(input.gstin, 20).toUpperCase();
  const stateCode = normalizeStateCode(trim(input.stateCode, 4));
  const address = {
    line1: trim(input.addressLine1),
    line2: trim(input.addressLine2),
    city: trim(input.city, 80),
    postalCode: trim(input.postalCode, 12).replace(/\s+/g, ""),
  };
  const sacCode = trim(input.sacCode, 12).replace(/\s+/g, "");
  const llpin = trim(input.llpin, 20).toUpperCase();
  const registeredOffice = trim(input.registeredOffice, 300);
  const prefix = trim(input.invoicePrefix, 8).toUpperCase();

  if (gstin && !isValidGstinFormat(gstin)) {
    return { ok: false, error: INVALID_GSTIN };
  }
  if (sacCode && !SAC_RE.test(sacCode)) {
    return { ok: false, error: TAX_SETTINGS_REFUSAL.sacShape };
  }
  if (llpin && !LLPIN_RE.test(llpin)) {
    return { ok: false, error: TAX_SETTINGS_REFUSAL.llpinShape };
  }
  // Mirrors platform_billing_invoice_prefix_length: invoice numbers stay
  // within the 16 characters GST allows.
  if (!PREFIX_RE.test(prefix)) {
    return { ok: false, error: TAX_SETTINGS_REFUSAL.prefix };
  }
  if (gstin && stateCode) {
    const mismatch = gstinStateMismatch(gstin, stateCode);
    if (mismatch) return { ok: false, error: mismatch };
  }
  const identity = {
    legalName: legalName || null,
    gstin: gstin || null,
    stateCode: stateCode || null,
    address,
    sacCode: sacCode || null,
    llpin: llpin || null,
    registeredOffice: registeredOffice || null,
    invoicePrefix: prefix,
  };

  let outcome: Refusal | null = null;
  try {
    outcome = await withService(async (db) => {
      await promoteDueWith(db, new Date());
      const row = await lockedSettings(db);
      const onOrScheduledOn =
        row?.taxEnabled === true || row?.nextTaxEnabled === true;
      if (onOrScheduledOn && identityGap(identity) !== null) {
        return new Refusal(TAX_SETTINGS_REFUSAL.clearIdentityWhileOn);
      }
      // After the GST-on rule, so clearing the name while GST is on keeps
      // that refusal, which also says what to do first.
      if (llpin && !legalName) {
        return new Refusal(TAX_SETTINGS_REFUSAL.llpinWithoutLegalName);
      }
      const write = {
        ...identity,
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
      };
      await writeTaxColumns(db, row !== null, write);
      return null;
    });
  } catch (err) {
    logError("billing.tax_identity.save", err);
    return { ok: false, error: SAVE_FAILED };
  }
  bustPlatformTax();
  if (outcome) return { ok: false, error: outcome.error };
  logInfo("billing.tax_identity_saved", {});
  return { ok: true };
}

/** The announcement columns the notice rule reads. */
async function noticeFor(db: Db, noticeId: string) {
  const [row] = await db
    .select({
      category: platformAnnouncements.category,
      status: platformAnnouncements.status,
      sent: platformAnnouncements.sent,
      sentAt: platformAnnouncements.sentAt,
      channels: platformAnnouncements.channels,
      audience: platformAnnouncements.audience,
    })
    .from(platformAnnouncements)
    .where(eq(platformAnnouncements.id, noticeId))
    .limit(1);
  return row ?? null;
}

/**
 * Is `noticeId` a notice that allows a rise starting at `startsAtMs`? The
 * refusal to show, or null when it does.
 *
 * ★ ONE RULE WITH THE CONSOLE: `noticeQualifies` (tax-terms.ts) decides
 * whether a notice counts, then the start must be at least 1 calendar month
 * after it was sent, in IST.
 */
async function noticeRuleRefusal(
  db: Db,
  noticeId: string | null | undefined,
  startsAtMs: number,
): Promise<string | null> {
  const id = typeof noticeId === "string" ? noticeId.trim() : "";
  if (!UUID_RE.test(id)) return TAX_SETTINGS_REFUSAL.riseWithoutNotice;
  const notice = await noticeFor(db, id);
  if (!notice) return TAX_SETTINGS_REFUSAL.riseWithoutNotice;
  const check = noticeQualifies(notice);
  if (!check.ok) return noticeRefusal(check.reason);
  const sentAt = String(notice.sentAt);
  const earliest = earliestStartAfterNotice(sentAt);
  if (!earliest) return noticeRefusal("not_sent");
  if (startsAtMs < Date.parse(earliest)) {
    return tooSoonAfterNotice(earliest, sentAt);
  }
  return null;
}

/**
 * Change what StoreMink charges, now or from a start time (GST design 5.8
 * item 2).
 *
 * Steps, in one transaction: promote a change that has already started; read
 * the row under a lock; `before` = the values in force (a new schedule
 * replaces any pending one), `after` = the proposed values. Switching GST on
 * (now or scheduled) needs the whole identity.
 *
 * - "now": allowed only when it does not raise what merchants pay (or, once
 *   the Terms cover it, a rate set by law, with `rateSetByLaw`). Writes the
 *   in-force columns and clears the scheduled change.
 * - "scheduled": at least 5 minutes and at most 400 days ahead (a start
 *   further out is usually a typo in the year). A rise needs an Operational email
 *   notice to all store owners (`noticeQualifies`) and a start at least 1
 *   calendar month after it went out, in IST. Writes the scheduled change.
 *
 * ★★ THE NOTICE IS READ IN THE SAME TRANSACTION AS THE WRITE, from
 * platform_announcements itself, never from the browser's word for it.
 *
 * ★ A ROW THAT CANNOT BE READ REFUSES (review R3-05): the lock read throws,
 * the transaction rolls back and the answer is SAVE_FAILED.
 *
 * The gate is the caller's (a platform superadmin, in the action).
 */
export async function scheduleTaxChange(
  input: TaxChangeInput,
  actor: string | null,
): Promise<TaxChangeResult> {
  if (!input || typeof input !== "object") {
    return { ok: false, error: SAVE_FAILED };
  }
  if (input.when !== "now" && input.when !== "scheduled") {
    return { ok: false, error: TAX_SETTINGS_REFUSAL.whenMissing };
  }
  const pct = Number(input.ratePercent);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ok: false, error: RATE_OUT_OF_RANGE };
  }
  const after: TaxValues = {
    enabled: input.enabled === true,
    inclusive: input.inclusive === true,
    rateBps: Math.round(pct * 100),
  };
  const now = new Date();

  let startsAt: string | null = null;
  if (input.when === "scheduled") {
    const ms =
      typeof input.startsAt === "string" ? Date.parse(input.startsAt) : NaN;
    if (!Number.isFinite(ms) || ms < now.getTime() + MIN_START_LEAD_MS) {
      return { ok: false, error: TAX_SETTINGS_REFUSAL.startTooClose };
    }
    if (ms > now.getTime() + MAX_START_AHEAD_MS) {
      return { ok: false, error: TAX_SETTINGS_REFUSAL.startTooFar };
    }
    startsAt = new Date(ms).toISOString();
  }

  let outcome: Refusal | TaxChangeResult;
  try {
    outcome = await withService(
      async (db): Promise<Refusal | TaxChangeResult> => {
        await promoteDueWith(db, now);
        const row = await lockedSettings(db);
        const before: TaxValues = {
          enabled: row?.taxEnabled === true,
          inclusive: row?.taxInclusive === true,
          rateBps: Number(row?.taxRateBps ?? 0),
        };

        if (after.enabled) {
          const gap = identityGap({
            gstin: row?.gstin ?? null,
            stateCode: row?.stateCode ?? null,
            legalName: row?.legalName ?? null,
            sacCode: row?.sacCode ?? null,
            llpin: row?.llpin ?? null,
            registeredOffice: row?.registeredOffice ?? null,
            address: row?.address ?? {},
          });
          if (gap) return new Refusal(gap);
        }

        const rise = effectiveRise(before, after);
        const stamp = { updatedAt: new Date().toISOString(), updatedBy: actor };

        if (input.when === "now") {
          if (rise === "choice") {
            return new Refusal(TAX_SETTINGS_REFUSAL.riseNow);
          }
          if (rise === "rate" && input.rateSetByLaw !== true) {
            return new Refusal(TAX_SETTINGS_REFUSAL.rateRiseNotConfirmed);
          }
          const write = {
            taxEnabled: after.enabled,
            taxInclusive: after.inclusive,
            taxRateBps: after.rateBps,
            nextTaxEnabled: null,
            nextTaxInclusive: null,
            nextTaxRateBps: null,
            nextTaxStartsAt: null,
            nextTaxNoticeId: null,
            ...stamp,
          };
          await writeTaxColumns(db, row !== null, write);
          return { ok: true, applied: "now", startsAt: null };
        }

        const startsAtMs = Date.parse(startsAt!);
        let noticeId: string | null = null;
        if (rise === "rate" && input.rateSetByLaw !== true && !input.noticeId) {
          return new Refusal(TAX_SETTINGS_REFUSAL.rateRiseNotConfirmed);
        }
        if (
          rise === "choice" ||
          (rise === "rate" && input.rateSetByLaw !== true)
        ) {
          const refusal = await noticeRuleRefusal(
            db,
            input.noticeId,
            startsAtMs,
          );
          if (refusal) return new Refusal(refusal);
          noticeId = String(input.noticeId).trim();
        }
        const write = {
          nextTaxEnabled: after.enabled,
          nextTaxInclusive: after.inclusive,
          nextTaxRateBps: after.rateBps,
          nextTaxStartsAt: startsAt,
          nextTaxNoticeId: noticeId,
          ...stamp,
        };
        await writeTaxColumns(db, row !== null, write);
        return { ok: true, applied: "scheduled", startsAt };
      },
    );
  } catch (err) {
    logError("billing.tax_change.save", err);
    return { ok: false, error: SAVE_FAILED };
  }
  bustPlatformTax();
  if (outcome instanceof Refusal) return { ok: false, error: outcome.error };
  logInfo("billing.tax_change_saved", {
    applied: outcome.ok ? outcome.applied : null,
    enabled: after.enabled,
    inclusive: after.inclusive,
    rateBps: after.rateBps,
    startsAt,
  });
  return outcome;
}

/**
 * Withdraw the scheduled change (GST design 5.8 item 3).
 *
 * First promotes a change that has already started; then clears the
 * scheduled change only while its start is still ahead.
 *
 * ★★ ONE CLOCK FOR BOTH STEPS (review R1-13): the promotion promotes a start
 * at or before `now` and the clear clears a start after the same `now`, so a
 * change is either promoted or withdrawn, never both and never neither. The
 * clear used to compare against the database's `now()` (the transaction's
 * start) while the promotion used the caller's clock, so a few seconds of
 * skew at the exact start instant could do both or neither. `now` is the
 * caller's, as it is for every other save and the hourly run.
 *
 * ★★ A TAB OPENED BEFORE THE START CAN NEVER SWITCH GST OFF SILENTLY AFTER
 * IT: once the change has started, there is nothing left to cancel, and the
 * refusal says to switch GST off with "Now" and its confirmation instead.
 *
 * The gate is the caller's (a platform superadmin, in the action).
 */
export async function cancelScheduledTaxChange(
  actor: string | null,
  now: Date = new Date(),
): Promise<SaveResult> {
  let cancelled = false;
  try {
    cancelled = await withService(async (db) => {
      await promoteDueWith(db, now);
      const res = await db.execute(sql`
        update public.platform_billing_settings
           set next_tax_enabled = null,
               next_tax_inclusive = null,
               next_tax_rate_bps = null,
               next_tax_starts_at = null,
               next_tax_notice_id = null,
               updated_at = now(),
               updated_by = ${actor}
         where id
           and next_tax_starts_at > ${now.toISOString()}::timestamptz
        returning id`);
      return (res.rows?.length ?? 0) > 0;
    });
  } catch (err) {
    logError("billing.tax_change.cancel", err);
    return { ok: false, error: SAVE_FAILED };
  }
  bustPlatformTax();
  if (!cancelled) {
    return { ok: false, error: TAX_SETTINGS_REFUSAL.cancelAfterStart };
  }
  logInfo("billing.tax_change_cancelled", {});
  return { ok: true };
}
