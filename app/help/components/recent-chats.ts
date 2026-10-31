/**
 * The Help Centre Mink AI chat's recent conversations, kept in this browser
 * only (localStorage). Nothing here reaches StoreMink: a rating sends its own
 * question and answer when the visitor presses it (rateHelpAnswer), and that
 * is the only thing that leaves the browser.
 *
 * ★ EVERYTHING READ BACK IS UNTRUSTED. Another tab, an extension or a person
 * can write this key, so parseRecentChats keeps only the shape the chat
 * renders, bounds every string, and keeps a source link only when it is a
 * Help Centre path. A stored answer can therefore never become a link off
 * the Help Centre or an oversized render.
 */

import type {
  HelpAssistantAnswer,
  HelpAssistantSource,
} from "@/app/actions/help-assistant-actions";
import {
  isHelpLanguageCode,
  type HelpLanguageCode,
} from "@/lib/help/languages";

export const RECENT_CHATS_KEY = "sm-help-mink-chats-v1";
export const RECENT_CHATS_MAX = 20;
export const RECENT_CHAT_MESSAGES_MAX = 40;
const TEXT_MAX = 4_000;
const LIST_MAX = 12;
const SOURCE_MAX = 6;

export type HelpRating = "up" | "down";

export type StoredUserMessage = {
  key: string;
  role: "user";
  content: string;
  spoken?: boolean;
};

export type StoredAssistantMessage = {
  key: string;
  role: "assistant";
  content: string;
  answer?: HelpAssistantAnswer;
  rating?: HelpRating;
};

export type StoredMessage = StoredUserMessage | StoredAssistantMessage;

export type RecentChat = {
  id: string;
  title: string;
  updatedAt: number;
  language: HelpLanguageCode | null;
  messages: StoredMessage[];
};

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const HELP_PATH = /^\/help\/[a-z0-9-]+(\/[a-z0-9-]+)?$/;

/**
 * A random id for a chat or a message. crypto.randomUUID needs a secure
 * context, which a phone reaching the dev server over plain http is not, so
 * it falls back to getRandomValues and then to Math.random.
 */
export function newMinkId(): string {
  const cryptoApi =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    try {
      return cryptoApi.randomUUID().replace(/-/g, "");
    } catch {
      // Not a secure context; fall through.
    }
  }
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  let id = "";
  while (id.length < 32) id += Math.random().toString(36).slice(2);
  return id.slice(0, 32);
}

/** A chat's title: its first question, cut at a word. */
export function chatTitle(messages: StoredMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  const text = (first?.content ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= 60) return text;
  const cut = text.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function text(value: unknown, max = TEXT_MAX): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function textList(value: unknown, max = LIST_MAX): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, max)
    .map((item) => item.slice(0, 1_000));
}

function readSources(value: unknown): HelpAssistantSource[] {
  if (!Array.isArray(value)) return [];
  const sources: HelpAssistantSource[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const url = text(record.url, 300);
    const title = text(record.title, 200);
    if (!url || !title || !HELP_PATH.test(url)) continue;
    sources.push({
      url,
      title,
      excerpt: text(record.excerpt, 400),
      category: text(record.category, 120),
    });
    if (sources.length >= SOURCE_MAX) break;
  }
  return sources;
}

function readAnswer(value: unknown): HelpAssistantAnswer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const answer = text(record.answer);
  if (answer === null) return undefined;
  return {
    answer,
    steps: textList(record.steps),
    notes: textList(record.notes),
    sources: readSources(record.sources),
    clarificationPrompts: textList(record.clarificationPrompts),
    followUps: textList(record.followUps, 6),
    needsHuman: record.needsHuman === true,
  };
}

function readMessage(value: unknown): StoredMessage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const key = typeof record.key === "string" ? record.key : "";
  const content = text(record.content);
  if (!ID_PATTERN.test(key) || content === null) return null;
  if (record.role === "user") {
    return {
      key,
      role: "user",
      content,
      ...(record.spoken === true ? { spoken: true } : {}),
    };
  }
  if (record.role === "assistant") {
    const answer = readAnswer(record.answer);
    const rating =
      record.rating === "up" || record.rating === "down"
        ? record.rating
        : undefined;
    return {
      key,
      role: "assistant",
      content,
      ...(answer ? { answer } : {}),
      ...(rating ? { rating } : {}),
    };
  }
  return null;
}

function readChat(value: unknown): RecentChat | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!ID_PATTERN.test(id)) return null;
  const messages = Array.isArray(record.messages)
    ? record.messages
        .slice(-RECENT_CHAT_MESSAGES_MAX)
        .map(readMessage)
        .filter((message): message is StoredMessage => message !== null)
    : [];
  if (!messages.some((message) => message.role === "user")) return null;
  const updatedAt =
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : 0;
  return {
    id,
    title: chatTitle(messages),
    updatedAt,
    language: isHelpLanguageCode(record.language) ? record.language : null,
    messages,
  };
}

/** Reads the stored list, newest first, keeping only what the chat can show. */
export function parseRecentChats(raw: string | null): RecentChat[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const chats: RecentChat[] = [];
  for (const item of value) {
    const chat = readChat(item);
    if (!chat || seen.has(chat.id)) continue;
    seen.add(chat.id);
    chats.push(chat);
  }
  return chats
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT_CHATS_MAX);
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadRecentChats(): RecentChat[] {
  try {
    return parseRecentChats(storage()?.getItem(RECENT_CHATS_KEY) ?? null);
  } catch {
    return [];
  }
}

function write(chats: RecentChat[]) {
  try {
    storage()?.setItem(RECENT_CHATS_KEY, JSON.stringify(chats));
  } catch {
    // Storage full or disabled: the chat still works for this visit.
  }
}

/** Saves one chat at the top of the list and returns the new list. */
export function saveRecentChat(chat: RecentChat): RecentChat[] {
  const clean = readChat({
    ...chat,
    messages: chat.messages.slice(-RECENT_CHAT_MESSAGES_MAX),
  });
  const others = loadRecentChats().filter((item) => item.id !== chat.id);
  const next = clean ? [clean, ...others].slice(0, RECENT_CHATS_MAX) : others;
  write(next);
  return next;
}

/** Removes one chat and returns the new list. */
export function deleteRecentChat(id: string): RecentChat[] {
  const next = loadRecentChats().filter((chat) => chat.id !== id);
  write(next);
  return next;
}
