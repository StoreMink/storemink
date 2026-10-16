"use server";

// ---------------------------------------------------------------------------
// Connecting a store's OWN WhatsApp number (Channels → WhatsApp).
// docs/whatsapp-commerce-plan.md §5; the sms-provider-actions.ts shape.
//
// The difference from Razorpay and Twilio: there is nothing to type. Meta's
// Embedded Signup popup does the login, the business selection and the OTP,
// and hands the browser a short-lived CODE plus the ids it picked. This file
// is the gate in front of lib/whatsapp/connect.ts, which exchanges that code
// server-side (app secret) and proves the ids before anything is stored.
//
// ── ★ THE TOKEN IS NEVER IN ANY RESULT ─────────────────────────────────────
// A business token can send messages as the merchant and read every chat.
// No action returns it, decrypts it for display or masks it; the card shows
// the phone number and Meta's facts about it.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import {
  getManagerUserId,
  getActingStoreId,
  getViewerAccess,
} from "@/app/dashboard/lib/access";
import { storeWhatsappAccounts, stores } from "@/drizzle/schema";
import { effectivePlan, limitsFor } from "@/lib/plans";
import {
  whatsappConfig,
  whatsappConnectConfigured,
} from "@/lib/whatsapp/config";
import {
  connectWhatsAppAccount,
  disconnectWhatsAppAccount,
  refreshWhatsAppAccount,
} from "@/lib/whatsapp/connect";
import {
  bootstrapWhatsAppTemplates,
  deleteStoreTemplate,
  listStoreTemplates,
  listTemplateRowsForEvent,
  submitCustomTemplate,
  syncWhatsAppTemplates,
  type ManagedTemplate,
} from "@/lib/whatsapp/templates";
import { validateCustomTemplate } from "@/lib/whatsapp/custom-template";
import { rateLimit } from "@/lib/rate-limit";
import {
  WHATSAPP_TEMPLATE_CATALOG,
  catalogEntryForName,
  pickTemplateRow,
  type WhatsAppTemplateVariant,
} from "@/lib/whatsapp/template-catalog";
import { whatsAppChatLink } from "@/lib/whatsapp/chat-link";
import { getCurrentStore } from "@/lib/store/resolve";
import { whatsappTemplates } from "@/drizzle/schema";
import { and, eq, inArray } from "drizzle-orm";

export interface WhatsAppChannelState {
  connected: boolean;
  enabled: boolean;
  /** connected | needs_reauth | disconnected — Meta's view, separate from the
   *  merchant's own pause switch above. */
  status: string | null;
  displayPhone: string | null;
  verifiedName: string | null;
  /** APPROVED | PENDING_REVIEW | DECLINED | NONE | null */
  nameStatus: string | null;
  /** TIER_250 | TIER_1K | TIER_10K | TIER_100K | TIER_UNLIMITED | null */
  messagingTier: string | null;
  /** GREEN | YELLOW | RED | UNKNOWN | null */
  qualityRating: string | null;
  coexistence: boolean;
  lastError: string | null;
  planAllows: boolean;
  /** The notification templates StoreMink registers on this number: how many
   *  Meta has approved, how many it is reviewing, how many it holds nothing
   *  for (never submitted, refused or unanswered at submission, or reset by a
   *  WABA change: what "Set up templates" sends), and the catalogue size. The
   *  fan-out queues only approved ones, so "0 of 19 approved" is why a freshly
   *  connected store sends nothing yet. */
  templates: {
    approved: number;
    pending: number;
    unsubmitted: number;
    total: number;
  };
  /** The click-to-chat link for this number (QR + storefront button). Null
   *  until connected. */
  chatLink: string | null;
  /** The platform has a Meta app and an Embedded Signup configuration. False
   *  means the connect button must not open a popup it cannot finish. */
  configured: boolean;
  /** Public identifiers the Facebook SDK needs in the browser. Empty when not
   *  configured. */
  appId: string;
  configId: string;
  graphVersion: string;
}

export interface WhatsAppActionResult {
  success?: boolean;
  error?: string;
}

const EMPTY: Omit<
  WhatsAppChannelState,
  "planAllows" | "configured" | "appId" | "configId" | "graphVersion"
> = {
  connected: false,
  enabled: false,
  status: null,
  displayPhone: null,
  verifiedName: null,
  nameStatus: null,
  messagingTier: null,
  qualityRating: null,
  coexistence: false,
  lastError: null,
  templates: {
    approved: 0,
    pending: 0,
    // Unknown counts keep "Set up templates" on offer: it is idempotent, and
    // it is the merchant's way out when the read failed.
    unsubmitted: WHATSAPP_TEMPLATE_CATALOG.length,
    total: WHATSAPP_TEMPLATE_CATALOG.length,
  },
  chatLink: null,
};

async function templateCounts(
  storeId: string,
): Promise<WhatsAppChannelState["templates"]> {
  try {
    const rows = await withService((db) =>
      db
        .select({
          name: whatsappTemplates.name,
          language: whatsappTemplates.language,
          status: whatsappTemplates.status,
          providerTemplateId: whatsappTemplates.providerTemplateId,
        })
        .from(whatsappTemplates)
        .where(
          and(
            eq(whatsappTemplates.storeId, storeId),
            // ★ CURRENT CATALOGUE NAMES ONLY. A replaced version (a rejected
            // v1 beside its v2) is history, and counting it would report
            // "20 of 19" or a rejection the merchant has nothing to do about.
            inArray(
              whatsappTemplates.name,
              WHATSAPP_TEMPLATE_CATALOG.map((t) => t.name),
            ),
          ),
        ),
    );
    const byKey = new Map(rows.map((r) => [`${r.name}:${r.language}`, r]));
    let approved = 0;
    let pending = 0;
    let unsubmitted = 0;
    for (const def of WHATSAPP_TEMPLATE_CATALOG) {
      const row = byKey.get(`${def.name}:${def.language}`);
      if (row?.status === "APPROVED") approved++;
      // ★ NO META ID MEANS META IS REVIEWING NOTHING. A create Meta refused
      // or never answered keeps its row PENDING with no id (and a sync_error);
      // counted as "in review", it made approved + pending reach the total
      // and hid "Set up templates", the one button that resubmits it.
      else if (!row || !row.providerTemplateId) unsubmitted++;
      else if (row.status === "PENDING" || row.status === "IN_APPEAL")
        pending++;
    }
    return {
      approved,
      pending,
      unsubmitted,
      total: WHATSAPP_TEMPLATE_CATALOG.length,
    };
  } catch {
    return EMPTY.templates;
  }
}

async function planAllowsWhatsApp(storeId: string): Promise<boolean> {
  try {
    const rows = await withService((db) =>
      db
        .select({
          plan: stores.plan,
          plan_expires_at: stores.planExpiresAt,
          comp_plan: stores.compPlan,
          comp_expires_at: stores.compExpiresAt,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    );
    return limitsFor(effectivePlan(rows[0] ?? {})).whatsapp;
  } catch (err) {
    console.error(
      "planAllowsWhatsApp:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

function platformBits() {
  const c = whatsappConfig();
  const configured = whatsappConnectConfigured();
  return {
    configured,
    appId: configured ? c.appId : "",
    configId: configured ? c.configId : "",
    graphVersion: c.graphVersion,
  };
}

export async function getWhatsAppChannelState(): Promise<WhatsAppChannelState> {
  const userId = await getManagerUserId("channels");
  const bits = platformBits();
  if (!userId) return { ...EMPTY, planAllows: false, ...bits };

  const storeId = await getActingStoreId();
  const [row, planAllows] = await Promise.all([
    withService((db) =>
      db
        // Deliberately never selects the token or PIN columns.
        .select({
          enabled: storeWhatsappAccounts.enabled,
          status: storeWhatsappAccounts.status,
          displayPhone: storeWhatsappAccounts.displayPhone,
          verifiedName: storeWhatsappAccounts.verifiedName,
          nameStatus: storeWhatsappAccounts.nameStatus,
          messagingTier: storeWhatsappAccounts.messagingTier,
          qualityRating: storeWhatsappAccounts.qualityRating,
          coexistence: storeWhatsappAccounts.coexistence,
          lastError: storeWhatsappAccounts.lastError,
        })
        .from(storeWhatsappAccounts)
        .where(eq(storeWhatsappAccounts.storeId, storeId))
        .limit(1),
    ).then(
      (rows) => rows[0],
      // ⚠ Same known gap as the SMS card: an unreachable database reads as
      // "not connected". Pinned there; shared here.
      () => undefined,
    ),
    planAllowsWhatsApp(storeId),
  ]);

  if (!row) return { ...EMPTY, planAllows, ...bits };
  const store = await getCurrentStore().catch(() => null);
  return {
    connected: true,
    templates: await templateCounts(storeId),
    chatLink: whatsAppChatLink(row.displayPhone, store?.name ?? null),
    enabled: row.enabled,
    status: row.status,
    displayPhone: row.displayPhone,
    verifiedName: row.verifiedName,
    nameStatus: row.nameStatus,
    messagingTier: row.messagingTier,
    qualityRating: row.qualityRating,
    coexistence: row.coexistence,
    lastError: row.lastError,
    planAllows,
    ...bits,
  };
}

/**
 * Finish Embedded Signup. The browser supplies what Meta's popup gave it;
 * nothing in it is trusted until lib/whatsapp/connect.ts has proved it.
 * `phoneNumberId` is null when the Coexistence popup named only the WABA;
 * the server then reads the number from Meta.
 */
export async function connectWhatsApp(input: {
  code: string;
  wabaId: string;
  phoneNumberId: string | null;
  coexistence: boolean;
}): Promise<WhatsAppActionResult & { displayPhone?: string }> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };
  if (!whatsappConnectConfigured()) {
    return { error: "WhatsApp isn't available on this environment yet." };
  }
  const code = (input.code ?? "").trim();
  if (!code || code.length > 1024) {
    return { error: "Meta's popup didn't return a sign-in code. Try again." };
  }

  const storeId = await getActingStoreId();
  if (!(await planAllowsWhatsApp(storeId))) {
    return {
      error:
        "WhatsApp is available on the Basic plan and above. Upgrade under Plans & Billing.",
    };
  }

  const result = await connectWhatsAppAccount({
    storeId,
    code,
    wabaId: String(input.wabaId ?? ""),
    // Empty when the popup named no number; connect.ts accepts that only
    // for Coexistence, and reads the number from Meta.
    phoneNumberId: String(input.phoneNumberId ?? ""),
    coexistence: Boolean(input.coexistence),
  });
  if (!result.ok) return { error: result.error };

  // ★ TEMPLATES ARE SUBMITTED AS PART OF CONNECTING, best-effort: a number
  // with no approved template sends nothing, and making the merchant find a
  // second button for the half that makes the first useful is how a channel
  // stays silent for a week. A refusal here is reported on the card, not as
  // a failed connect — the connection itself succeeded.
  await bootstrapWhatsAppTemplates(storeId).catch(() => undefined);

  revalidatePath("/dashboard/channels");
  return { success: true, displayPhone: result.displayPhone };
}

/** Submit any catalogue template this store still lacks, and re-read the
 *  status of every one. The card's "Set up templates" button, for a store
 *  whose bootstrap at connect time was refused or interrupted. */
export async function setupWhatsAppTemplates(): Promise<
  WhatsAppActionResult & { submitted?: number; approved?: number }
> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  if (!(await planAllowsWhatsApp(storeId))) {
    return {
      error:
        "WhatsApp is available on the Basic plan and above. Upgrade under Plans & Billing.",
    };
  }
  const r = await bootstrapWhatsAppTemplates(storeId);
  revalidatePath("/dashboard/channels");
  if (!r.ok) return { error: r.error ?? "Couldn't submit the templates." };
  const counts = await templateCounts(storeId);
  return { success: true, submitted: r.submitted, approved: counts.approved };
}

export interface WhatsAppEventTemplate {
  audience: "team" | "customer";
  name: string;
  /** Meta's status for the row, or `missing` when the catalogue has one for
   *  this event and audience but the store holds no row yet. */
  status: string;
  rejectionReason: string | null;
  syncError: string | null;
  lastSyncedAt: string | null;
  body: string;
  /** Which named event value fills each `{{n}}`, in order — for the preview. */
  variables: string[];
  /** Set for a second wording of the same event (the COD confirmation),
   *  which the tab shows separately with what decides when it is used. */
  variant: WhatsAppTemplateVariant | null;
  /** Quick-reply button labels, in order. */
  buttons: string[];
}

/**
 * The WhatsApp templates behind one notification, for the console's tab —
 * one per audience the catalogue covers. Gated on `notifications` like
 * getSmsTemplates, because it is read from that page.
 */
export async function getWhatsAppTemplatesForEvent(
  eventKey: string,
): Promise<{ templates: WhatsAppEventTemplate[]; error?: string }> {
  const userId = await getManagerUserId("notifications");
  if (!userId) return { templates: [], error: "You don't have permission." };
  const storeId = await getActingStoreId();
  const catalogue = WHATSAPP_TEMPLATE_CATALOG.filter(
    (t) => t.eventKey === eventKey,
  );
  if (catalogue.length === 0) return { templates: [] };
  try {
    const rows = await listTemplateRowsForEvent(storeId, eventKey);
    return {
      templates: catalogue.map((def) => {
        // The row that is live or awaited (pickTemplateRow), never simply the
        // first one: an older rejected version would otherwise hide its
        // replacement, and its own wording would be filled with the new
        // version's variables.
        // ★ Only rows of THIS entry's wording: the COD variant shares the
        // event and audience with the plain message, and picking across both
        // would show one's approval under the other's name.
        const row = pickTemplateRow(
          rows.filter(
            (r) =>
              r.audience === def.audience &&
              catalogEntryForName(r.name)?.variant === def.variant,
          ),
          def.name,
        );
        return {
          audience: def.audience,
          name: row?.name ?? def.name,
          status: row ? row.status : "missing",
          rejectionReason: row?.rejectionReason ?? null,
          syncError: row?.syncError ?? null,
          lastSyncedAt: row?.lastSyncedAt ?? null,
          body: row?.body || def.body,
          variables:
            row && row.name !== def.name && row.variables.length > 0
              ? row.variables
              : def.variables,
          variant: def.variant ?? null,
          buttons: def.quickReplies ?? [],
        };
      }),
    };
  } catch (err) {
    console.error(
      "getWhatsAppTemplatesForEvent:",
      err instanceof Error ? err.message : err,
    );
    return { templates: [], error: "Couldn't load the WhatsApp templates." };
  }
}

/** Pause or resume, keeping the connection. */
export async function setWhatsAppEnabled(
  enabled: boolean,
): Promise<WhatsAppActionResult> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };

  const storeId = await getActingStoreId();
  if (enabled && !(await planAllowsWhatsApp(storeId))) {
    return {
      error:
        "WhatsApp is available on the Basic plan and above. Upgrade under Plans & Billing.",
    };
  }
  try {
    await withService((db) =>
      db
        .update(storeWhatsappAccounts)
        .set({ enabled, updatedAt: new Date().toISOString() })
        .where(eq(storeWhatsappAccounts.storeId, storeId)),
    );
  } catch {
    return { error: "Couldn't update the WhatsApp channel. Please try again." };
  }
  revalidatePath("/dashboard/channels");
  return { success: true };
}

/** Re-read Meta's facts about the number (tier, quality, name review). */
export async function refreshWhatsApp(): Promise<WhatsAppActionResult> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  const r = await refreshWhatsAppAccount(storeId);
  if (!r.ok) return { error: r.error };
  // Template statuses too — the webhook is the primary channel for them, but
  // a merchant pressing Refresh is asking "what does Meta say now".
  await syncWhatsAppTemplates(storeId).catch(() => undefined);
  revalidatePath("/dashboard/channels");
  return { success: true };
}

/** Forget the connection. Meta is told (best effort) to stop posting. */
export async function disconnectWhatsApp(): Promise<WhatsAppActionResult> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  try {
    await disconnectWhatsAppAccount(storeId);
  } catch {
    return { error: "Couldn't disconnect. Please try again." };
  }
  revalidatePath("/dashboard/channels");
  return { success: true };
}

// ── The template manager (Channels → WhatsApp → Templates) ─────────────────

export interface WhatsAppTemplateManagerView {
  connected: boolean;
  /** Meta's view of the connection; `needs_reauth` disables submitting. */
  status: string | null;
  canManage: boolean;
  templates: ManagedTemplate[];
}

/** Every template the store holds, for the manager page. Read with
 *  `channels` view; the page gates the same way. */
export async function getWhatsAppTemplateManager(): Promise<
  { ok: true; view: WhatsAppTemplateManagerView } | { ok: false; error: string }
> {
  const access = await getViewerAccess();
  if (!access || !access.can("channels", "view")) {
    return { ok: false, error: "You don't have permission to view Channels." };
  }
  const storeId = await getActingStoreId();
  try {
    const [account, templates] = await Promise.all([
      withService((db) =>
        db
          .select({ status: storeWhatsappAccounts.status })
          .from(storeWhatsappAccounts)
          .where(eq(storeWhatsappAccounts.storeId, storeId))
          .limit(1),
      ).then((rows) => rows[0] ?? null),
      listStoreTemplates(storeId),
    ]);
    return {
      ok: true,
      view: {
        connected: Boolean(account),
        status: account?.status ?? null,
        canManage: access.can("channels", "manage"),
        templates,
      },
    };
  } catch (err) {
    console.error(
      "getWhatsAppTemplateManager:",
      err instanceof Error ? err.message : err,
    );
    return {
      ok: false,
      error: "Couldn't load your templates. Please try again.",
    };
  }
}

/**
 * Submit a merchant's own template to Meta for review. The server runs the
 * same check the editor ran, because the editor is not the boundary; Meta
 * then reviews the words, usually within a day, and the status webhook (or
 * Refresh) brings the answer back onto the row.
 */
export async function submitWhatsAppTemplate(
  input: unknown,
): Promise<WhatsAppActionResult & { id?: string; status?: string }> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  if (!(await planAllowsWhatsApp(storeId))) {
    return {
      error:
        "WhatsApp is available on the Basic plan and above. Upgrade under Plans & Billing.",
    };
  }
  const checked = validateCustomTemplate(input);
  if (!checked.ok) return { error: checked.error };
  // Meta reviews each submission by hand; a loop submitting junk is a WABA
  // Meta stops trusting, so a store may submit a few an hour, not hundreds.
  const limit = await rateLimit(`whatsapp-template-submit:${storeId}`, {
    max: 20,
    windowSeconds: 3600,
  });
  if (!limit.allowed) {
    return {
      error:
        "You've submitted a lot of templates recently. Try again in an hour.",
    };
  }
  const r = await submitCustomTemplate(storeId, checked.template);
  revalidatePath("/dashboard/channels/whatsapp/templates");
  revalidatePath("/dashboard/channels");
  if (!r.ok) return { error: r.error };
  return { success: true, id: r.id, status: r.status };
}

/** Delete a merchant's own template at Meta and here. StoreMink's
 *  order-update templates are refused (lib/whatsapp/templates.ts). */
export async function deleteWhatsAppTemplate(
  templateId: string,
): Promise<WhatsAppActionResult> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };
  if (!/^[0-9a-f-]{36}$/i.test(String(templateId ?? ""))) {
    return { error: "That template no longer exists." };
  }
  const storeId = await getActingStoreId();
  const r = await deleteStoreTemplate(storeId, templateId);
  revalidatePath("/dashboard/channels/whatsapp/templates");
  revalidatePath("/dashboard/channels");
  if (!r.ok) return { error: r.error };
  return { success: true };
}

/** Re-read every template's status from Meta, for the manager's Refresh. */
export async function refreshWhatsAppTemplates(): Promise<WhatsAppActionResult> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  const r = await syncWhatsAppTemplates(storeId);
  revalidatePath("/dashboard/channels/whatsapp/templates");
  if (!r.ok) return { error: r.error ?? "Couldn't reach Meta." };
  return { success: true };
}
