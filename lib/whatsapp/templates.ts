import "server-only";

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { storeWhatsappAccounts, whatsappTemplates } from "@/drizzle/schema";
import { decryptSecret } from "@/lib/payments/crypto";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  createMessageTemplate,
  isTemplateExistsError,
  isTokenError,
  listMessageTemplates,
} from "./graph";
import {
  WHATSAPP_TEMPLATE_CATALOG,
  templateComponentsFor,
} from "./template-catalog";

// ---------------------------------------------------------------------------
// Registering StoreMink's notification templates on a merchant's WABA, and
// keeping their status current (docs/whatsapp-commerce-plan.md §8).
//
// ── ★ BOOTSTRAP IS IDEMPOTENT, AT META AND HERE ────────────────────────────
// Meta refuses a duplicate name per WABA, and that refusal is read as
// "already there" — the id is then recovered by listing — rather than as a
// failure, so a merchant who reconnects, or a bootstrap interrupted halfway,
// converges on the same rows. Locally the row is keyed on (store, name,
// language) by the 0174 UNIQUE.
//
// ── ★ STATUS COMES FROM META, NEVER FROM US ────────────────────────────────
// A row is PENDING until Meta's answer says otherwise — the create response,
// a later list, or the message_template_status_update webhook. The fan-out
// reads the status column and queues only APPROVED (lib/whatsapp/channel.ts),
// so nothing sends ahead of Meta's review.
//
// ── ★ A SUBMISSION REFUSED IS NOT A TEMPLATE REJECTED ──────────────────────
// `sync_error` holds why Meta would not TAKE a template (a bad parameter, a
// dead token); `rejection_reason` holds why Meta turned one DOWN after review.
// The console shows both, with different advice.
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  ok: boolean;
  submitted: number;
  existing: number;
  failed: number;
  error?: string;
}

interface AccountRow {
  wabaId: string;
  token: string;
}

async function loadAccount(storeId: string): Promise<AccountRow | null> {
  const rows = await withService((db) =>
    db
      .select({
        wabaId: storeWhatsappAccounts.wabaId,
        tokenEnc: storeWhatsappAccounts.businessTokenEnc,
        status: storeWhatsappAccounts.status,
      })
      .from(storeWhatsappAccounts)
      .where(eq(storeWhatsappAccounts.storeId, storeId))
      .limit(1),
  );
  const row = rows[0];
  if (!row || row.status !== "connected") return null;
  return { wabaId: row.wabaId, token: decryptSecret(row.tokenEnc) };
}

/**
 * Submit every catalogue template this store does not yet hold, then sync
 * statuses. Best-effort per template: one refusal does not stop the rest,
 * because a store with eleven approved updates and one refused is far better
 * off than one with none.
 */
export async function bootstrapWhatsAppTemplates(
  storeId: string,
): Promise<BootstrapResult> {
  const account = await loadAccount(storeId).catch((err) => {
    logError("whatsapp templates: account load failed", err, { storeId });
    return null;
  });
  if (!account) {
    return {
      ok: false,
      submitted: 0,
      existing: 0,
      failed: 0,
      error: "WhatsApp isn't connected.",
    };
  }

  const result: BootstrapResult = {
    ok: true,
    submitted: 0,
    existing: 0,
    failed: 0,
  };
  const now = new Date().toISOString();

  for (const def of WHATSAPP_TEMPLATE_CATALOG) {
    // Ensure the local row first, so a later status webhook has something to
    // land on even if the create call below never answers.
    const baseRow = {
      storeId,
      wabaId: account.wabaId,
      eventKey: def.eventKey,
      audience: def.audience,
      name: def.name,
      language: def.language,
      category: def.category,
      components: templateComponentsFor(def),
      variables: def.variables,
    };
    let existing: { id: string; providerTemplateId: string | null } | undefined;
    try {
      const rows = await withService((db) =>
        db
          .insert(whatsappTemplates)
          .values({ ...baseRow, status: "PENDING", updatedAt: now })
          .onConflictDoUpdate({
            target: [
              whatsappTemplates.storeId,
              whatsappTemplates.name,
              whatsappTemplates.language,
            ],
            // A reconnect may land on a different WABA; everything else about
            // the catalogue row is ours and unchanged.
            set: { wabaId: account.wabaId, updatedAt: now },
          })
          .returning({
            id: whatsappTemplates.id,
            providerTemplateId: whatsappTemplates.providerTemplateId,
          }),
      );
      existing = rows[0];
    } catch (err) {
      logError("whatsapp templates: row upsert failed", err, {
        storeId,
        name: def.name,
      });
      result.failed++;
      continue;
    }
    if (!existing) {
      result.failed++;
      continue;
    }
    if (existing.providerTemplateId) {
      // Already at Meta from an earlier bootstrap; the sync below refreshes it.
      result.existing++;
      continue;
    }

    const created = await createMessageTemplate(account.token, account.wabaId, {
      name: def.name,
      language: def.language,
      category: def.category,
      components: templateComponentsFor(def),
    });

    if (created.ok) {
      await withService((db) =>
        db
          .update(whatsappTemplates)
          .set({
            providerTemplateId: created.data.id,
            status: created.data.status ?? "PENDING",
            category: created.data.category ?? def.category,
            syncError: null,
            lastSyncedAt: now,
            updatedAt: now,
          })
          .where(eq(whatsappTemplates.id, existing.id)),
      ).catch((err) =>
        logError("whatsapp templates: record create failed", err, { storeId }),
      );
      result.submitted++;
      continue;
    }

    if (isTemplateExistsError(created)) {
      // The sync below picks up the id and status by name.
      result.existing++;
      continue;
    }

    if (isTokenError(created)) {
      // Dead token: every later call fails the same way, so stop and say so.
      result.ok = false;
      result.error =
        "Meta no longer accepts this connection. Reconnect WhatsApp in Channels.";
      result.failed++;
      await markNeedsReauth(storeId, result.error);
      break;
    }

    result.failed++;
    await withService((db) =>
      db
        .update(whatsappTemplates)
        .set({
          syncError:
            created.outcome === "unknown"
              ? `Meta didn't answer: ${created.error}`
              : `Meta refused the template: ${created.error}`,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(whatsappTemplates.id, existing.id)),
    ).catch(() => undefined);
    logWarn("whatsapp templates: create refused", {
      storeId,
      name: def.name,
      outcome: created.outcome,
      code: created.code,
    });
  }

  const synced = await syncWhatsAppTemplates(storeId);
  if (!synced.ok && result.ok) {
    result.ok = false;
    result.error = synced.error;
  }
  logInfo("whatsapp templates bootstrapped", {
    storeId,
    submitted: result.submitted,
    existing: result.existing,
    failed: result.failed,
  });
  return result;
}

export interface SyncResult {
  ok: boolean;
  updated: number;
  error?: string;
}

/**
 * Read every template Meta holds for the WABA and update the rows we know by
 * (name, language). Called after bootstrap, from the Channels refresh, and
 * safe to call at any time — the webhook is the primary channel for status,
 * this is the reconciliation.
 */
export async function syncWhatsAppTemplates(
  storeId: string,
): Promise<SyncResult> {
  const account = await loadAccount(storeId).catch(() => null);
  if (!account)
    return { ok: false, updated: 0, error: "WhatsApp isn't connected." };

  const listed = await listMessageTemplates(account.token, account.wabaId);
  if (!listed.ok) {
    if (isTokenError(listed)) {
      const error =
        "Meta no longer accepts this connection. Reconnect WhatsApp in Channels.";
      await markNeedsReauth(storeId, error);
      return { ok: false, updated: 0, error };
    }
    return {
      ok: false,
      updated: 0,
      error:
        listed.outcome === "unknown"
          ? "Meta didn't answer. Try again in a minute."
          : `Meta refused: ${listed.error}`,
    };
  }

  const now = new Date().toISOString();
  let updated = 0;
  for (const t of listed.data.data ?? []) {
    if (!t.name || !t.language) continue;
    try {
      const rows = await withService((db) =>
        db
          .update(whatsappTemplates)
          .set({
            providerTemplateId: t.id,
            status: normalizeStatus(t.status),
            category: t.category ?? undefined,
            rejectionReason:
              normalizeStatus(t.status) === "REJECTED"
                ? (t.rejected_reason ?? null)
                : null,
            quality: t.quality_score?.score ?? undefined,
            syncError: null,
            lastSyncedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(whatsappTemplates.storeId, storeId),
              eq(whatsappTemplates.name, t.name),
              eq(whatsappTemplates.language, t.language),
            ),
          )
          .returning({ id: whatsappTemplates.id }),
      );
      updated += rows.length;
    } catch (err) {
      logError("whatsapp templates: sync write failed", err, {
        storeId,
        name: t.name,
      });
    }
  }
  return { ok: true, updated };
}

/** Meta's status vocabulary onto the 0174 CHECK; anything new stays PENDING
 *  rather than failing the whole sync on an unknown word. */
const KNOWN_STATUSES = new Set([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "PAUSED",
  "DISABLED",
  "IN_APPEAL",
  "PENDING_DELETION",
  "DELETED",
  "LIMIT_EXCEEDED",
]);

export function normalizeStatus(status: string | undefined): string {
  const s = (status ?? "").toUpperCase();
  return KNOWN_STATUSES.has(s) ? s : "PENDING";
}

async function markNeedsReauth(storeId: string, error: string): Promise<void> {
  await withService((db) =>
    db
      .update(storeWhatsappAccounts)
      .set({
        status: "needs_reauth",
        lastError: error,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(storeWhatsappAccounts.storeId, storeId)),
  ).catch(() => undefined);
}

/** The rows the notification console shows for one event: every audience,
 *  with the status Meta last reported. Service scope; the caller gates. */
export async function listTemplateRowsForEvent(
  storeId: string,
  eventKey: string,
): Promise<
  {
    id: string;
    audience: string;
    name: string;
    status: string;
    rejectionReason: string | null;
    syncError: string | null;
    quality: string | null;
    lastSyncedAt: string | null;
    body: string;
  }[]
> {
  const { bodyFromComponents } = await import("./channel");
  const rows = await withService((db) =>
    db
      .select({
        id: whatsappTemplates.id,
        audience: whatsappTemplates.audience,
        name: whatsappTemplates.name,
        status: whatsappTemplates.status,
        rejectionReason: whatsappTemplates.rejectionReason,
        syncError: whatsappTemplates.syncError,
        quality: whatsappTemplates.quality,
        lastSyncedAt: whatsappTemplates.lastSyncedAt,
        components: whatsappTemplates.components,
      })
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.storeId, storeId),
          eq(whatsappTemplates.eventKey, eventKey),
        ),
      ),
  );
  return rows
    .filter((r) => r.audience)
    .map((r) => ({
      id: r.id,
      audience: r.audience as string,
      name: r.name,
      status: r.status,
      rejectionReason: r.rejectionReason,
      syncError: r.syncError,
      quality: r.quality,
      lastSyncedAt: r.lastSyncedAt,
      body: bodyFromComponents(r.components),
    }));
}
