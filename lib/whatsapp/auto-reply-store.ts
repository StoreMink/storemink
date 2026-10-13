import "server-only";

import { eq, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { stores, whatsappAutoReplies } from "@/drizzle/schema";
import { logWarn } from "@/lib/observability/logger";
import {
  autoReplySettingsFromRow,
  normalizeMinkMode,
  type MinkMode,
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
      menuEnabled: whatsappAutoReplies.menuEnabled,
      menuButtons: whatsappAutoReplies.menuButtons,
      minkMode: whatsappAutoReplies.minkMode,
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
            menuEnabled: row.menuEnabled === true,
            menuButtons: row.menuButtons,
            minkMode: row.minkMode,
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
    menuEnabled: settings.menuEnabled,
    menuButtons: settings.menuButtons,
    minkMode: settings.minkMode,
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

/** The switches read BEFORE a message is filed (see loadAutoReplyFlags). */
export interface AutoReplyFlags {
  /** "Where is my order?" is answered from the customer's orders. */
  orderStatus: boolean;
  /** The menu's buttons go out with the welcome and on request. */
  menu: boolean;
  /** Customer-facing Mink: off, answers (helps) or drafts for a person. */
  minkMode: MinkMode;
}

const NO_FLAGS: AutoReplyFlags = {
  orderStatus: false,
  menu: false,
  minkMode: "off",
};

/**
 * Which automatic answers this store has switched on, read BEFORE a message
 * is filed and outside its transaction, so a failure here can never stop the
 * message being recorded. The filing uses them to decide whether the message
 * is one the system will answer (no unread, no Needs reply, no bell).
 * ★ Fails to every flag off: the message then waits for a person, exactly as
 * it did before the feature existed.
 */
export async function loadAutoReplyFlags(
  storeId: string,
): Promise<AutoReplyFlags> {
  try {
    const rows = await withService((db) =>
      db
        .select({
          orderStatus: whatsappAutoReplies.orderStatusEnabled,
          menu: whatsappAutoReplies.menuEnabled,
          minkMode: whatsappAutoReplies.minkMode,
        })
        .from(whatsappAutoReplies)
        .where(eq(whatsappAutoReplies.storeId, storeId))
        .limit(1),
    );
    const row = rows[0];
    if (!row) return NO_FLAGS;
    return {
      orderStatus: row.orderStatus === true,
      menu: row.menu === true,
      minkMode: normalizeMinkMode(row.minkMode),
    };
  } catch (err) {
    logWarn("whatsapp auto-replies: settings unreadable before filing", {
      storeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NO_FLAGS;
  }
}

/** Does this store answer "where is my order?" automatically? */
export async function answersOrderQuestions(storeId: string): Promise<boolean> {
  return (await loadAutoReplyFlags(storeId)).orderStatus;
}
