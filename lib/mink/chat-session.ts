// ---------------------------------------------------------------------------
// ★★ WHEN MINK CONTINUES A CHAT AND WHEN IT STARTS A NEW ONE.
//
// Every dashboard load used to reopen the actor's NEWEST conversation, however
// old, in every tab: a question asked from Home landed in last week's thread,
// deleting the open chat jumped into another old one, and a message sent while
// that old chat was still loading was replaced by it when it arrived. The rule
// now follows ChatGPT, Claude and Shopify's Sidekick:
//
//   - a new tab (or window) starts a new chat; recent ones are in History;
//   - in the same tab the chat continues across pages, reloads and closing and
//     reopening the panel ...
//   - ... until it has had no message for MINK_CHAT_RESUME_MS, after which the
//     next open starts a new chat (the old one stays in History);
//   - a question asked from Home, or an "Ask Mink" button, starts a new chat;
//   - choosing a chat in History continues it, and deleting the open chat
//     leaves a new one.
//
// The tab is remembered in sessionStorage, which a reload keeps and a new tab
// does not, so "same tab" needs no other bookkeeping. Pure apart from the
// storage it is handed, and every storage call fails quiet: a private window
// that refuses storage only loses the continuation after a reload.
// ---------------------------------------------------------------------------

/** A chat with no message for this long is not reopened; a new one starts. */
export const MINK_CHAT_RESUME_MS = 2 * 60 * 60 * 1000;

/**
 * What a chat is called until its title arrives (conversation-title.ts), in
 * the header and the History sidebar, as ChatGPT and Claude show it.
 */
export const MINK_NEW_CHAT_TITLE = "New chat";

/** Recent chats kept per admin and store; starting another prunes the oldest. */
export const MINK_CONVERSATION_LIMIT = 10;

const STORAGE_KEY = "storemink:mink-active-chat";

export type MinkActiveChat = { id: string; lastActivityAt: number };

/** True when a chat last used at `lastActivityAt` should not be continued. */
export function isMinkChatStale(
  lastActivityAt: number | null,
  now: number,
): boolean {
  return lastActivityAt === null || now - lastActivityAt >= MINK_CHAT_RESUME_MS;
}

export function minkSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The chat this tab was in, when it is still recent enough to reopen. */
export function readMinkActiveChat(
  storage: Storage | null,
  now: number,
): MinkActiveChat | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !row.id ||
      typeof row.lastActivityAt !== "number" ||
      !Number.isFinite(row.lastActivityAt)
    )
      return null;
    if (isMinkChatStale(row.lastActivityAt, now)) return null;
    return { id: row.id, lastActivityAt: row.lastActivityAt };
  } catch {
    return null;
  }
}

export function writeMinkActiveChat(
  storage: Storage | null,
  chat: MinkActiveChat,
) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(chat));
  } catch {
    // Storage refused (private window, quota): the chat still works in memory.
  }
}

export function clearMinkActiveChat(storage: Storage | null) {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
