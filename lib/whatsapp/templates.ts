import "server-only";

import { and, desc, eq, ne, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { storeWhatsappAccounts, whatsappTemplates } from "@/drizzle/schema";
import { decryptSecret } from "@/lib/payments/crypto";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  createMessageTemplate,
  deleteMessageTemplate,
  isTemplateExistsError,
  isTokenError,
  listMessageTemplates,
} from "./graph";
import {
  WHATSAPP_TEMPLATE_CATALOG,
  catalogEntryForName,
  knownTemplateStatus,
  templateComponentsFor,
  templateRowVariables,
} from "./template-catalog";
import {
  customTemplateComponents,
  templateButtonsOf,
  templateFooterText,
  templateHeaderText,
  templateNeedsSendParameters,
  type CustomTemplateDraft,
  type TemplateButtonView,
} from "./custom-template";

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
//
// ── ★ A TEMPLATE BELONGS TO ONE WABA ───────────────────────────────────────
// Meta's id and its answer describe the template on the WABA it was submitted
// to. A store that reconnects on another WABA keeps its rows (the queue points
// at them), so resetTemplatesForWaba wipes what the old WABA said before
// anything reads the rows against the new one: connect, bootstrap and sync
// all run it.
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

/** What a reset StoreMink template says until Meta answers on the new WABA
 *  (bootstrap resubmits the current ones and clears it). */
export const TEMPLATE_WABA_CHANGED_NOTE =
  "Your WhatsApp Business account changed, so this template has to be approved again on the new one.";
/** What a reset merchant template says: it is theirs to send again. */
export const CUSTOM_TEMPLATE_WABA_CHANGED_NOTE =
  "This template was on your previous WhatsApp Business account. Delete it here and add it again to submit it on this one.";

/**
 * Wipe what ANOTHER WABA said about this store's templates, and file the rows
 * under `wabaId`. Returns how many rows were reset.
 *
 * ★ WHY. A reconnect on a different WABA used to rewrite only `waba_id`, so
 * every row kept the old WABA's Meta id and APPROVED: bootstrap then skipped
 * them as already submitted, sync touched only what the new WABA listed, and
 * the fan-out (which reads `status`, never `waba_id`) kept queuing templates
 * the new WABA does not have. Meta refuses those sends (132001), the SMS
 * fallback never fires because WhatsApp looked deliverable, and the card
 * read "20 of 20 approved".
 *
 * ★ A RESET ROW IS PENDING WITH NO META ID AND A NOTE, which is exactly the
 * state of a submission Meta never took: not APPROVED, so nothing sends it;
 * no id, so bootstrap resubmits it and the card counts it as still to submit;
 * a sync_error, so the template manager says why. Sync adopts any row the new
 * WABA already holds by name and clears the note.
 *
 * ★ A MERCHANT'S OWN TEMPLATE IS NOT RESUBMITTED FOR THEM. The new WABA can
 * belong to another business whose name the old wording does not carry, and
 * every submission is reviewed by hand against that WABA's standing, so the
 * note asks them to add it again (deleting a row with no Meta id never
 * touches Meta). The category is kept: bootstrap submits the catalogue's own
 * and records Meta's answer.
 *
 * Takes the caller's transaction so connect can reset in the same commit
 * that moves the account to the new WABA.
 */
export async function resetTemplatesForWaba(
  db: Db,
  storeId: string,
  wabaId: string,
  now: string = new Date().toISOString(),
): Promise<number> {
  const rows = await db
    .update(whatsappTemplates)
    .set({
      wabaId,
      providerTemplateId: null,
      status: "PENDING",
      rejectionReason: null,
      quality: null,
      syncError: sql`case when ${whatsappTemplates.eventKey} is null then ${CUSTOM_TEMPLATE_WABA_CHANGED_NOTE} else ${TEMPLATE_WABA_CHANGED_NOTE} end`,
      lastSyncedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(whatsappTemplates.storeId, storeId),
        ne(whatsappTemplates.wabaId, wabaId),
      ),
    )
    .returning({ id: whatsappTemplates.id });
  return rows.length;
}

/** resetTemplatesForWaba in its own transaction, for bootstrap and sync.
 *  False when it could not run: reading rows against the new WABA before
 *  the old WABA's answers are gone is the defect it exists to prevent. */
async function resetForAccount(
  storeId: string,
  wabaId: string,
): Promise<boolean> {
  try {
    const moved = await withService((db) =>
      resetTemplatesForWaba(db, storeId, wabaId),
    );
    if (moved > 0) {
      logInfo("whatsapp templates: reset for a new WABA", {
        storeId,
        templates: moved,
      });
    }
    return true;
  } catch (err) {
    logError("whatsapp templates: WABA reset failed", err, { storeId });
    return false;
  }
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
  // Before any row is read as "already at Meta": a row Meta answered for on
  // another WABA would otherwise be skipped below and never submitted here.
  if (!(await resetForAccount(storeId, account.wabaId))) {
    return {
      ok: false,
      submitted: 0,
      existing: 0,
      failed: 0,
      error: "Couldn't prepare your templates. Please try again.",
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
            // The reset above has already moved every row to this WABA and
            // cleared what another one said; everything else about the
            // catalogue row is ours and unchanged.
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
  // A row this WABA does not list would otherwise keep another WABA's
  // APPROVED, and the fan-out would keep sending a template Meta lacks here.
  if (!(await resetForAccount(storeId, account.wabaId))) {
    return {
      ok: false,
      updated: 0,
      error: "Couldn't read your templates. Please try again.",
    };
  }

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
export function normalizeStatus(status: string | undefined): string {
  return knownTemplateStatus(status) ?? "PENDING";
}

/**
 * Flip the store's account to `needs_reauth` with the reason the card shows.
 * For Meta's code 190 (the token is dead): every later call fails the same
 * way, so the merchant is told to reconnect instead of watching sends fail.
 * Exported for the WhatsApp worker, which meets 190 on a send. Never throws.
 */
export async function markNeedsReauth(
  storeId: string,
  error: string,
): Promise<void> {
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
    variables: string[];
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
        variables: whatsappTemplates.variables,
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
      variables: templateRowVariables(r.name, r.variables),
    }));
}

// ── The template manager (plan §4 Templates) ───────────────────────────────

export interface ManagedTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectionReason: string | null;
  syncError: string | null;
  quality: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  /** StoreMink's own (an order-update template behind an event), or the
   *  merchant's. Only the merchant's can be deleted here. */
  catalogue: boolean;
  /** The event a catalogue template serves, for the label. */
  eventKey: string | null;
  audience: string | null;
  headerText: string;
  body: string;
  footerText: string;
  /** Which named value fills each {{n}}, in order. */
  variables: string[];
  buttons: TemplateButtonView[];
  /** Whether the inbox composer can send it (approved, for customers, and
   *  needing no value at send time beyond the body's). */
  sendableFromInbox: boolean;
  /** Whether Meta holds it: a row with Meta's id. A row without one was
   *  never accepted for review here (refused at submission, or reset when
   *  the account moved to another WhatsApp Business account), so it is not
   *  "in review" and deleting it touches only our copy. */
  submitted: boolean;
}

/** Every template this store holds, newest first. Service scope; the
 *  caller gates. */
export async function listStoreTemplates(
  storeId: string,
): Promise<ManagedTemplate[]> {
  const { bodyFromComponents, templateHasButtons } = await import("./channel");
  const rows = await withService((db) =>
    db
      .select({
        id: whatsappTemplates.id,
        name: whatsappTemplates.name,
        language: whatsappTemplates.language,
        category: whatsappTemplates.category,
        status: whatsappTemplates.status,
        rejectionReason: whatsappTemplates.rejectionReason,
        syncError: whatsappTemplates.syncError,
        quality: whatsappTemplates.quality,
        lastSyncedAt: whatsappTemplates.lastSyncedAt,
        createdAt: whatsappTemplates.createdAt,
        eventKey: whatsappTemplates.eventKey,
        audience: whatsappTemplates.audience,
        components: whatsappTemplates.components,
        variables: whatsappTemplates.variables,
        enabled: whatsappTemplates.enabled,
        providerTemplateId: whatsappTemplates.providerTemplateId,
      })
      .from(whatsappTemplates)
      .where(eq(whatsappTemplates.storeId, storeId))
      .orderBy(desc(whatsappTemplates.createdAt)),
  );
  return rows.map((r) => {
    const catalogue =
      r.eventKey !== null || Boolean(catalogEntryForName(r.name));
    return {
      id: r.id,
      name: r.name,
      language: r.language,
      category: r.category,
      status: r.status,
      rejectionReason: r.rejectionReason,
      syncError: r.syncError,
      quality: r.quality,
      lastSyncedAt: r.lastSyncedAt,
      createdAt: r.createdAt,
      catalogue,
      eventKey: r.eventKey,
      audience: r.audience,
      headerText: templateHeaderText(r.components),
      body: bodyFromComponents(r.components),
      footerText: templateFooterText(r.components),
      variables: templateRowVariables(r.name, r.variables),
      buttons: templateButtonsOf(r.components),
      sendableFromInbox:
        r.status === "APPROVED" &&
        r.enabled &&
        r.audience !== "team" &&
        (catalogue
          ? !templateHasButtons(r.components)
          : !templateNeedsSendParameters(r.components)),
      submitted: Boolean(r.providerTemplateId),
    };
  });
}

export type SubmitTemplateResult =
  | { ok: true; id: string; status: string }
  | { ok: false; error: string };

/**
 * Submit a merchant's template to Meta for review and keep the row. The row
 * is written PENDING before the call, like the catalogue's, so the status
 * webhook has something to land on; a refusal at submission is kept on the
 * row as `sync_error` with the merchant's words beside it, and the row stays
 * so the reason can be read and the template deleted or rewritten.
 */
export async function submitCustomTemplate(
  storeId: string,
  draft: CustomTemplateDraft,
): Promise<SubmitTemplateResult> {
  const account = await loadAccount(storeId).catch((err) => {
    logError("whatsapp templates: account load failed", err, { storeId });
    return null;
  });
  if (!account) return { ok: false, error: "WhatsApp isn't connected." };

  const now = new Date().toISOString();
  const components = customTemplateComponents(draft);
  let row: { id: string; providerTemplateId: string | null } | undefined;
  try {
    const rows = await withService((db) =>
      db
        .insert(whatsappTemplates)
        .values({
          storeId,
          wabaId: account.wabaId,
          eventKey: null,
          // For customers: the composer offers it once approved. Nothing
          // automatic ever picks it, because no event names it.
          audience: "customer",
          name: draft.name,
          language: draft.language,
          category: draft.category,
          components,
          variables: draft.variables.map((v) => v.name),
          status: "PENDING",
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [
            whatsappTemplates.storeId,
            whatsappTemplates.name,
            whatsappTemplates.language,
          ],
        })
        .returning({
          id: whatsappTemplates.id,
          providerTemplateId: whatsappTemplates.providerTemplateId,
        }),
    );
    row = rows[0];
  } catch (err) {
    logError("whatsapp templates: custom row insert failed", err, { storeId });
    return {
      ok: false,
      error: "Couldn't save the template. Please try again.",
    };
  }
  if (!row) {
    return {
      ok: false,
      error: `You already have a template called ${draft.name} in that language. Choose another name.`,
    };
  }

  const created = await createMessageTemplate(account.token, account.wabaId, {
    name: draft.name,
    language: draft.language,
    category: draft.category,
    components,
  });

  if (created.ok) {
    const status = normalizeStatus(created.data.status);
    await withService((db) =>
      db
        .update(whatsappTemplates)
        .set({
          providerTemplateId: created.data.id,
          status,
          category: created.data.category ?? draft.category,
          syncError: null,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(whatsappTemplates.id, row.id)),
    ).catch((err) =>
      logError("whatsapp templates: record custom create failed", err, {
        storeId,
      }),
    );
    logInfo("whatsapp template submitted", {
      storeId,
      name: draft.name,
      status,
    });
    return { ok: true, id: row.id, status };
  }

  if (isTemplateExistsError(created)) {
    // Meta holds this name already (authored in WhatsApp Manager, or an
    // earlier submission we never recorded): adopt its status by listing.
    await syncWhatsAppTemplates(storeId).catch(() => undefined);
    return { ok: true, id: row.id, status: "PENDING" };
  }

  const error = isTokenError(created)
    ? "Meta no longer accepts this connection. Reconnect WhatsApp in Channels."
    : created.outcome === "unknown"
      ? `Meta didn't answer: ${created.error}`
      : `Meta refused the template: ${created.error}`;
  if (isTokenError(created)) await markNeedsReauth(storeId, error);
  await withService((db) =>
    db
      .update(whatsappTemplates)
      .set({ syncError: error, lastSyncedAt: now, updatedAt: now })
      .where(eq(whatsappTemplates.id, row.id)),
  ).catch(() => undefined);
  logWarn("whatsapp templates: custom create refused", {
    storeId,
    name: draft.name,
    outcome: created.outcome,
    code: created.code,
  });
  return { ok: false, error };
}

export type DeleteTemplateResult = { ok: true } | { ok: false; error: string };

/**
 * Delete a merchant's template, at Meta and here. A catalogue template is
 * refused: the notification spine sends it, and removing it would silence an
 * order update with nothing on the console to say why. Meta's "does not
 * exist" reads as already gone; any other refusal keeps the row.
 *
 * ★ META IS ASKED ONLY BY META'S ID, on the WABA that id belongs to. A row
 * with no id is a submission Meta refused or never answered (or one reset by
 * a WABA change), and Meta's delete by NAME removes every language of that
 * name, an approved sibling included, whose own row would then stay APPROVED
 * here. Such a row is deleted here only; a template that did land at Meta
 * after all is adopted again by "already exists" if the merchant re-adds it.
 */
export async function deleteStoreTemplate(
  storeId: string,
  templateId: string,
): Promise<DeleteTemplateResult> {
  const rows = await withService((db) =>
    db
      .select({
        id: whatsappTemplates.id,
        name: whatsappTemplates.name,
        eventKey: whatsappTemplates.eventKey,
        providerTemplateId: whatsappTemplates.providerTemplateId,
        wabaId: whatsappTemplates.wabaId,
      })
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.storeId, storeId),
          eq(whatsappTemplates.id, templateId),
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "That template no longer exists." };
  if (row.eventKey !== null || catalogEntryForName(row.name)) {
    return {
      ok: false,
      error:
        "That is one of StoreMink's order-update templates and can't be deleted. Switch the message off under Settings → Notifications instead.",
    };
  }

  const account = await loadAccount(storeId).catch(() => null);
  if (account && row.providerTemplateId && row.wabaId === account.wabaId) {
    const deleted = await deleteMessageTemplate(account.token, account.wabaId, {
      name: row.name,
      hsmId: row.providerTemplateId,
    });
    if (!deleted.ok) {
      if (isTokenError(deleted)) {
        const error =
          "Meta no longer accepts this connection. Reconnect WhatsApp in Channels.";
        await markNeedsReauth(storeId, error);
        return { ok: false, error };
      }
      const gone =
        deleted.outcome === "rejected" &&
        /does not exist|not found|no template/i.test(deleted.error);
      if (!gone) {
        return {
          ok: false,
          error:
            deleted.outcome === "unknown"
              ? "Meta didn't answer. Try again in a minute."
              : `Meta refused: ${deleted.error}`,
        };
      }
    }
  }
  await withService((db) =>
    db
      .delete(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.storeId, storeId),
          eq(whatsappTemplates.id, templateId),
        ),
      ),
  );
  logInfo("whatsapp template deleted", { storeId, name: row.name });
  return { ok: true };
}
