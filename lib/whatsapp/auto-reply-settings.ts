// ---------------------------------------------------------------------------
// A store's WhatsApp automatic replies: the welcome message, the away message
// and its business hours, and answering "where is my order?". Pure and
// client-safe, so the settings form and the save action check one shape.
//
// ★ EVERY ONE IS OFF UNTIL THE MERCHANT TURNS IT ON. Each sends messages a
// store has never sent before, and new behaviour on a live store is the
// merchant's decision. The texts start from defaults written for a shop, so
// turning one on is one click.
//
// ★ THE TEXTS ARE THE MERCHANT'S, SENT AS WRITTEN. No tokens are filled in:
// what the form shows is exactly what the customer reads.
// ---------------------------------------------------------------------------

import {
  DEFAULT_BUSINESS_HOURS,
  normalizeBusinessHours,
  validateBusinessHours,
  type BusinessHours,
} from "./business-hours";

/** Well under WhatsApp's 4,096, and more than a greeting needs. */
export const AUTO_REPLY_MAX_CHARS = 1000;

/**
 * A welcome goes to somebody writing for the first time, or for the first time
 * after this many days with no message either way: the rule the WhatsApp
 * Business app uses for its own greeting, so it is what merchants expect.
 */
export const WELCOME_QUIET_DAYS = 14;

/**
 * No away message right after a person on the team replied: "we're closed"
 * just after someone answered contradicts them.
 */
export const AWAY_AFTER_HUMAN_REPLY_HOURS = 2;

export interface WhatsAppAutoReplySettings {
  welcomeEnabled: boolean;
  welcomeText: string;
  awayEnabled: boolean;
  awayText: string;
  hours: BusinessHours;
  orderStatusEnabled: boolean;
}

/** Reads as an acknowledgement, so it also fits a reply to an order update. */
export function defaultWelcomeText(storeName: string | null): string {
  const shop = storeName?.trim();
  return shop
    ? `Hi, thanks for messaging ${shop}! How can we help you today?`
    : "Hi, thanks for messaging us! How can we help you today?";
}

/** Written to follow the welcome in the same message without repeating it. */
export const DEFAULT_AWAY_TEXT =
  "We're closed right now, and we'll reply as soon as we open.";

export function defaultAutoReplySettings(
  storeName: string | null,
): WhatsAppAutoReplySettings {
  return {
    welcomeEnabled: false,
    welcomeText: defaultWelcomeText(storeName),
    awayEnabled: false,
    awayText: DEFAULT_AWAY_TEXT,
    hours: DEFAULT_BUSINESS_HOURS,
    orderStatusEnabled: false,
  };
}

/** One line ending, trimmed. */
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\r\n?/g, "\n").trim();
}

export type AutoReplyCheck =
  | { ok: true; settings: WhatsAppAutoReplySettings }
  | { ok: false; error: string };

/** The strict check a save runs; the form calls it too, before sending. */
export function validateAutoReplySettings(input: unknown): AutoReplyCheck {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "The settings are missing." };
  }
  const raw = input as Record<string, unknown>;
  const welcomeText = cleanText(raw.welcomeText);
  const awayText = cleanText(raw.awayText);
  if (welcomeText === null || awayText === null) {
    return { ok: false, error: "The messages are missing." };
  }
  const welcomeEnabled = raw.welcomeEnabled === true;
  const awayEnabled = raw.awayEnabled === true;
  const orderStatusEnabled = raw.orderStatusEnabled === true;

  if (welcomeText.length > AUTO_REPLY_MAX_CHARS) {
    return {
      ok: false,
      error: `The welcome message can be at most ${AUTO_REPLY_MAX_CHARS} characters.`,
    };
  }
  if (awayText.length > AUTO_REPLY_MAX_CHARS) {
    return {
      ok: false,
      error: `The away message can be at most ${AUTO_REPLY_MAX_CHARS} characters.`,
    };
  }
  if (welcomeEnabled && !welcomeText) {
    return {
      ok: false,
      error: "Write a welcome message, or turn the welcome message off.",
    };
  }
  if (awayEnabled && !awayText) {
    return {
      ok: false,
      error: "Write an away message, or turn the away message off.",
    };
  }
  const hours = validateBusinessHours(raw.hours);
  if (!hours.ok) return hours;

  return {
    ok: true,
    settings: {
      welcomeEnabled,
      welcomeText,
      awayEnabled,
      awayText,
      hours: hours.hours,
      orderStatusEnabled,
    },
  };
}

/** The stored row, as the table holds it. */
export interface AutoReplyRow {
  welcomeEnabled: boolean;
  welcomeText: string;
  awayEnabled: boolean;
  awayText: string;
  businessHours: unknown;
  orderStatusEnabled: boolean;
}

/**
 * What a store's settings are, from its row or, with none saved, the defaults.
 * An empty saved text shows the default again, so the form is never blank.
 */
export function autoReplySettingsFromRow(
  row: AutoReplyRow | null,
  storeName: string | null,
): WhatsAppAutoReplySettings {
  const defaults = defaultAutoReplySettings(storeName);
  if (!row) return defaults;
  return {
    welcomeEnabled: row.welcomeEnabled === true,
    welcomeText: row.welcomeText?.trim()
      ? row.welcomeText
      : defaults.welcomeText,
    awayEnabled: row.awayEnabled === true,
    awayText: row.awayText?.trim() ? row.awayText : defaults.awayText,
    hours: normalizeBusinessHours(row.businessHours),
    orderStatusEnabled: row.orderStatusEnabled === true,
  };
}
