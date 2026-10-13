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
import { MENU_BUTTON_ID } from "./menu-payload";

/** Well under WhatsApp's 4,096, and more than a greeting needs. */
export const AUTO_REPLY_MAX_CHARS = 1000;

/** WhatsApp allows three reply buttons on one message, no more. */
export const MENU_MAX_BUTTONS = 3;

/** WhatsApp's limit on a reply button's label. */
export const MENU_BUTTON_TITLE_MAX_CHARS = 20;

/**
 * An interactive message's body may be 1,024 characters. The welcome and the
 * away message are each capped at AUTO_REPLY_MAX_CHARS, so the two together
 * can exceed it; answer-automatically.ts then sends the text first and the
 * buttons on their own.
 */
export const INTERACTIVE_BODY_MAX_CHARS = 1024;

/**
 * What the menu says when it goes out on its own (the customer typed "menu",
 * and the welcome is off or already sent).
 */
export const MENU_PROMPT_TEXT = "How can we help? Choose an option:";

/** What a button does when the customer taps it. */
export const MENU_ACTIONS = ["order_status", "person", "text"] as const;
export type MenuButtonAction = (typeof MENU_ACTIONS)[number];

export const MENU_ACTION_LABELS: Record<MenuButtonAction, string> = {
  order_status: "Check my order",
  person: "Talk to a person",
  text: "Send a message",
};

/** What "Talk to a person" answers with when the merchant wrote nothing. */
export const DEFAULT_PERSON_TEXT =
  "Sure. Someone from our team will reply here shortly.";

/**
 * What Mink AI does with a customer's question (docs/whatsapp-commerce-plan.md
 * §13). `off` is the shipped default; `helps` answers from the store's own
 * facts and hands over the rest; `drafts` writes a reply for a person to
 * approve and never sends on its own.
 */
export const MINK_MODES = ["off", "helps", "drafts"] as const;
export type MinkMode = (typeof MINK_MODES)[number];

export const MINK_MODE_LABELS: Record<MinkMode, string> = {
  off: "Off",
  helps: "Answers customers",
  drafts: "Drafts replies for you",
};

/** One Mink credit per answer that is sent (plan §19.6), from the same pool
 *  as the dashboard's Mink. A draft nobody sends costs nothing. */
export const MINK_ANSWER_CREDITS = 1;

/** A stored or posted mode, read leniently: anything unknown is off. */
export function normalizeMinkMode(value: unknown): MinkMode {
  return value === "helps" || value === "drafts" ? value : "off";
}

export interface MenuButton {
  /** Stable, generated once; it is what a tap carries back (menu-payload.ts). */
  id: string;
  /** The button's label, as the customer sees it. */
  title: string;
  action: MenuButtonAction;
  /** The reply for `text`; the acknowledgement for `person`; unused otherwise. */
  text: string;
}

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
  /** Reply buttons sent with the welcome, and whenever a customer asks for the menu. */
  menuEnabled: boolean;
  menuButtons: MenuButton[];
  /** Customer-facing Mink: off, helps (answers) or drafts (a person approves). */
  minkMode: MinkMode;
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
    menuEnabled: false,
    menuButtons: [],
    minkMode: "off",
  };
}

/** One line ending, trimmed. */
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\r\n?/g, "\n").trim();
}

/** A button label: one line, trimmed, inner runs of spaces collapsed. */
function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim();
}

export type MenuButtonsCheck =
  | { ok: true; buttons: MenuButton[] }
  | { ok: false; error: string };

/**
 * The menu's buttons, checked the way WhatsApp will check them: at most
 * three, each with a label of up to 20 characters, ids and labels unique.
 * ★ A button that sends a message needs the message; "Talk to a person" may
 * leave its acknowledgement blank (DEFAULT_PERSON_TEXT is sent then); "Check
 * my order" answers from the customer's orders and carries no text.
 */
export function validateMenuButtons(
  input: unknown,
  menuEnabled: boolean,
): MenuButtonsCheck {
  if (input === undefined || input === null) {
    return menuEnabled
      ? {
          ok: false,
          error: "Add at least one menu button, or turn the menu off.",
        }
      : { ok: true, buttons: [] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, error: "The menu buttons are missing." };
  }
  if (input.length > MENU_MAX_BUTTONS) {
    return {
      ok: false,
      error: `A menu can have at most ${MENU_MAX_BUTTONS} buttons.`,
    };
  }
  const buttons: MenuButton[] = [];
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const [index, raw] of input.entries()) {
    const n = index + 1;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `Menu button ${n} is missing.` };
    }
    const b = raw as Record<string, unknown>;
    const id = typeof b.id === "string" ? b.id : "";
    if (!MENU_BUTTON_ID.test(id)) {
      return { ok: false, error: `Menu button ${n} has no id.` };
    }
    if (ids.has(id)) {
      return { ok: false, error: `Menu button ${n} repeats another's id.` };
    }
    const title = cleanTitle(b.title);
    if (!title) {
      return { ok: false, error: `Give menu button ${n} a label.` };
    }
    if (title.length > MENU_BUTTON_TITLE_MAX_CHARS) {
      return {
        ok: false,
        error: `Menu button labels can be at most ${MENU_BUTTON_TITLE_MAX_CHARS} characters ("${title}" is too long).`,
      };
    }
    const titleKey = title.toLowerCase();
    if (titles.has(titleKey)) {
      return {
        ok: false,
        error: `Two menu buttons are both called "${title}". Give each a different label.`,
      };
    }
    const action = b.action;
    if (
      typeof action !== "string" ||
      !(MENU_ACTIONS as readonly string[]).includes(action)
    ) {
      return { ok: false, error: `Choose what menu button ${n} does.` };
    }
    const text = cleanText(b.text ?? "") ?? "";
    if (text.length > AUTO_REPLY_MAX_CHARS) {
      return {
        ok: false,
        error: `A menu button's message can be at most ${AUTO_REPLY_MAX_CHARS} characters.`,
      };
    }
    if (action === "text" && !text) {
      return {
        ok: false,
        error: `Write the message "${title}" sends, or change what it does.`,
      };
    }
    ids.add(id);
    titles.add(titleKey);
    buttons.push({
      id,
      title,
      action: action as MenuButtonAction,
      text: action === "order_status" ? "" : text,
    });
  }
  if (menuEnabled && buttons.length === 0) {
    return {
      ok: false,
      error: "Add at least one menu button, or turn the menu off.",
    };
  }
  return { ok: true, buttons };
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
  const menuEnabled = raw.menuEnabled === true;
  const menu = validateMenuButtons(raw.menuButtons, menuEnabled);
  if (!menu.ok) return menu;
  // Absent means off (a form written before the control existed); a value
  // that is present must be one of the three.
  if (
    raw.minkMode !== undefined &&
    !(MINK_MODES as readonly unknown[]).includes(raw.minkMode)
  ) {
    return { ok: false, error: "Choose what Mink AI does with messages." };
  }

  return {
    ok: true,
    settings: {
      welcomeEnabled,
      welcomeText,
      awayEnabled,
      awayText,
      hours: hours.hours,
      orderStatusEnabled,
      menuEnabled,
      menuButtons: menu.buttons,
      minkMode: normalizeMinkMode(raw.minkMode),
    },
  };
}

/**
 * Stored buttons, read leniently: a row written by an older revision holds
 * none, and a button that no longer validates is dropped rather than taking
 * the whole menu down. Never throws.
 */
export function normalizeMenuButtons(value: unknown): MenuButton[] {
  if (!Array.isArray(value)) return [];
  const checked = validateMenuButtons(value, false);
  if (checked.ok) return checked.buttons;
  const kept: MenuButton[] = [];
  for (const raw of value) {
    const one = validateMenuButtons([raw], false);
    if (one.ok && one.buttons[0]) {
      const b = one.buttons[0];
      if (!kept.some((k) => k.id === b.id || k.title === b.title)) kept.push(b);
    }
    if (kept.length === MENU_MAX_BUTTONS) break;
  }
  return kept;
}

/** The stored row, as the table holds it. */
export interface AutoReplyRow {
  welcomeEnabled: boolean;
  welcomeText: string;
  awayEnabled: boolean;
  awayText: string;
  businessHours: unknown;
  orderStatusEnabled: boolean;
  menuEnabled?: boolean;
  menuButtons?: unknown;
  minkMode?: unknown;
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
    menuEnabled: row.menuEnabled === true,
    menuButtons: normalizeMenuButtons(row.menuButtons),
    minkMode: normalizeMinkMode(row.minkMode),
  };
}
