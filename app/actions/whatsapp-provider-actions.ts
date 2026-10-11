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
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
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
  listTemplateRowsForEvent,
  syncWhatsAppTemplates,
} from "@/lib/whatsapp/templates";
import { WHATSAPP_TEMPLATE_CATALOG } from "@/lib/whatsapp/template-catalog";
import { whatsAppChatLink } from "@/lib/whatsapp/chat-link";
import { getCurrentStore } from "@/lib/store/resolve";
import { whatsappTemplates } from "@/drizzle/schema";
import { and, eq, sql } from "drizzle-orm";

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
  /** The notification templates StoreMink registered on this number: how many
   *  Meta has approved, how many it is still reviewing, and the catalogue
   *  size. The fan-out queues only approved ones, so "0 of 19 approved" is why
   *  a freshly connected store sends nothing yet. */
  templates: { approved: number; pending: number; total: number };
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
          status: whatsappTemplates.status,
          n: sql<number>`count(*)::int`,
        })
        .from(whatsappTemplates)
        .where(
          and(
            eq(whatsappTemplates.storeId, storeId),
            sql`${whatsappTemplates.eventKey} is not null`,
          ),
        )
        .groupBy(whatsappTemplates.status),
    );
    let approved = 0;
    let pending = 0;
    for (const r of rows) {
      if (r.status === "APPROVED") approved += r.n;
      else if (r.status === "PENDING" || r.status === "IN_APPEAL")
        pending += r.n;
    }
    return { approved, pending, total: WHATSAPP_TEMPLATE_CATALOG.length };
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
 */
export async function connectWhatsApp(input: {
  code: string;
  wabaId: string;
  phoneNumberId: string;
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
        const row = rows.find((r) => r.audience === def.audience);
        return {
          audience: def.audience,
          name: row?.name ?? def.name,
          status: row ? row.status : "missing",
          rejectionReason: row?.rejectionReason ?? null,
          syncError: row?.syncError ?? null,
          lastSyncedAt: row?.lastSyncedAt ?? null,
          body: row?.body || def.body,
          variables: def.variables,
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
