import "server-only";

import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { storeWhatsappAccounts } from "@/drizzle/schema";
import { effectivePlan, limitsFor } from "@/lib/plans";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { logWarn } from "@/lib/observability/logger";
import { whatsAppChatLink } from "./chat-link";

// ---------------------------------------------------------------------------
// The storefront's "chat on WhatsApp" button (plan §6B): is there one, and
// where does it go?
//
// ★ THREE GATES, CHEAPEST FIRST. The merchant's switch is read from the store
// row the layout already holds (no query); the plan from the same row; only
// then is the account row read — one indexed select by primary key, and only
// for a store that has opted in. A store with the switch off costs nothing.
//
// ★ CONNECTED AND LIVE. A paused number (`enabled = false`) is a merchant
// saying "not now", and a button that opens a chat nobody is answering from
// is §23's control that always fails. `needs_reauth` can still RECEIVE, but
// nothing here can promise a reply, so it is treated the same.
// ---------------------------------------------------------------------------

export interface StorefrontWhatsAppChat {
  href: string;
}

export async function getStorefrontWhatsAppChat(store: {
  id: string;
  name: string;
  plan: string | null;
  plan_expires_at?: string | null;
  comp_plan?: string | null;
  comp_expires_at?: string | null;
  settings: unknown;
}): Promise<StorefrontWhatsAppChat | null> {
  const plan = effectivePlan({
    plan: store.plan,
    plan_expires_at: store.plan_expires_at ?? null,
    comp_plan: store.comp_plan ?? null,
    comp_expires_at: store.comp_expires_at ?? null,
  });
  if (!limitsFor(plan).whatsapp) return null;
  const settings = resolveStoreSettings(
    (store.settings as Record<string, unknown>) ?? {},
    plan,
  );
  if (settings["whatsapp.chatButton"] !== true) return null;

  try {
    const rows = await withService((db) =>
      db
        .select({
          enabled: storeWhatsappAccounts.enabled,
          status: storeWhatsappAccounts.status,
          displayPhone: storeWhatsappAccounts.displayPhone,
        })
        .from(storeWhatsappAccounts)
        .where(eq(storeWhatsappAccounts.storeId, store.id))
        .limit(1),
    );
    const row = rows[0];
    if (!row || !row.enabled || row.status !== "connected") return null;
    const href = whatsAppChatLink(row.displayPhone, store.name);
    return href ? { href } : null;
  } catch (err) {
    // A storefront page must render without its chat button rather than not
    // at all.
    logWarn("whatsapp: storefront chat link failed", {
      storeId: store.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
