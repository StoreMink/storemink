import "server-only";

import { eq, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { stores, whatsappAutoReplies } from "@/drizzle/schema";
import { logWarn } from "@/lib/observability/logger";
import {
  autoReplySettingsFromRow,
  type WhatsAppAutoReplySettings,
} from "./auto-reply-settings";

// ---------------------------------------------------------------------------
// Reading and writing a store's WhatsApp automatic replies
// (whatsapp_auto_replies, migration 20261013_0197). Every function takes the
// TRUSTED store id: the table is service-only, so the predicate is the tenant
// boundary.
// ---------------------------------------------------------------------------

export interface StoredAutoReplies {
  settings: WhatsAppAutoReplySettings;
  /** False until the merchant first saves: the form says the texts are drafts. */
  saved: boolean;
  updatedAt: string | null;
}

/** A store's settings, or the defaults (every reply off) when none are saved. */
export async function loadAutoReplies(
  db: Db,
  storeId: string,
): Promise<StoredAutoReplies> {
  const rows = await db
    .select({
      storeName: stores.name,
      welcomeEnabled: whatsappAutoReplies.welcomeEnabled,
      welcomeText: whatsappAutoReplies.welcomeText,
      awayEnabled: whatsappAutoReplies.awayEnabled,
      awayText: whatsappAutoReplies.awayText,
      businessHours: whatsappAutoReplies.businessHours,
      orderStatusEnabled: whatsappAutoReplies.orderStatusEnabled,
      updatedAt: whatsappAutoReplies.updatedAt,
    })
    .from(stores)
    .leftJoin(whatsappAutoReplies, eq(whatsappAutoReplies.storeId, stores.id))
    .where(eq(stores.id, storeId))
    .limit(1);
  const row = rows[0];
  const saved = Boolean(row?.updatedAt);
  return {
    settings: autoReplySettingsFromRow(
      saved && row
        ? {
            welcomeEnabled: row.welcomeEnabled === true,
            welcomeText: row.welcomeText ?? "",
            awayEnabled: row.awayEnabled === true,
            awayText: row.awayText ?? "",
            businessHours: row.businessHours,
            orderStatusEnabled: row.orderStatusEnabled === true,
          }
        : null,
      row?.storeName ?? null,
    ),
    saved,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Write a store's settings, already validated by the caller. */
export async function saveAutoReplies(
  db: Db,
  input: {
    storeId: string;
    settings: WhatsAppAutoReplySettings;
    updatedBy: string;
  },
): Promise<void> {
  const { settings } = input;
  const values = {
    welcomeEnabled: settings.welcomeEnabled,
    welcomeText: settings.welcomeText,
    awayEnabled: settings.awayEnabled,
    awayText: settings.awayText,
    businessHours: settings.hours,
    orderStatusEnabled: settings.orderStatusEnabled,
    updatedBy: input.updatedBy,
  };
  await db
    .insert(whatsappAutoReplies)
    .values({ storeId: input.storeId, ...values })
    .onConflictDoUpdate({
      target: whatsappAutoReplies.storeId,
      set: { ...values, updatedAt: sql`now()` },
    });
}

/**
 * Does this store answer "where is my order?" automatically? Read BEFORE a
 * message is filed, outside its transaction, so a failure here can never stop
 * the message being recorded. ★ Fails to false: the question then waits for a
 * person, exactly as it did before the feature existed.
 */
export async function answersOrderQuestions(storeId: string): Promise<boolean> {
  try {
    const rows = await withService((db) =>
      db
        .select({ on: whatsappAutoReplies.orderStatusEnabled })
        .from(whatsappAutoReplies)
        .where(eq(whatsappAutoReplies.storeId, storeId))
        .limit(1),
    );
    return rows[0]?.on === true;
  } catch (err) {
    logWarn("whatsapp auto-replies: order-question setting unreadable", {
      storeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
