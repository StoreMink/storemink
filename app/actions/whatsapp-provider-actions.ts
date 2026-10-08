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

import { eq } from "drizzle-orm";
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
};

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
  return {
    connected: true,
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

  revalidatePath("/dashboard/channels");
  return { success: true, displayPhone: result.displayPhone };
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
