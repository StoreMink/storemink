import { describe, expect, it } from "vitest";
import {
  clearMinkActiveChat,
  isMinkChatStale,
  MINK_CHAT_RESUME_MS,
  readMinkActiveChat,
  writeMinkActiveChat,
} from "./chat-session";

const KEY = "storemink:mink-active-chat";
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size;
    },
  } as Storage;
}

describe("when a Mink chat may be continued", () => {
  it("continues a chat used within the last two hours", () => {
    expect(isMinkChatStale(NOW - 5 * 60_000, NOW)).toBe(false);
    expect(isMinkChatStale(NOW - MINK_CHAT_RESUME_MS + 1, NOW)).toBe(false);
  });

  it("starts fresh once the chat has been quiet for two hours, or was never used", () => {
    expect(isMinkChatStale(NOW - MINK_CHAT_RESUME_MS, NOW)).toBe(true);
    expect(isMinkChatStale(NOW - 3 * 60 * 60_000, NOW)).toBe(true);
    expect(isMinkChatStale(null, NOW)).toBe(true);
  });

  it("reads back the chat this tab was in while it is recent", () => {
    const storage = memoryStorage();
    writeMinkActiveChat(storage, {
      id: "chat-1",
      lastActivityAt: NOW - 60_000,
    });
    expect(readMinkActiveChat(storage, NOW)).toEqual({
      id: "chat-1",
      lastActivityAt: NOW - 60_000,
    });
  });

  it("does not hand back a chat that has gone quiet", () => {
    const storage = memoryStorage();
    writeMinkActiveChat(storage, {
      id: "chat-1",
      lastActivityAt: NOW - MINK_CHAT_RESUME_MS,
    });
    expect(readMinkActiveChat(storage, NOW)).toBeNull();
  });

  it("ignores anything it did not write, rather than reopening a guess", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ id: "", lastActivityAt: NOW }),
      JSON.stringify({ id: 7, lastActivityAt: NOW }),
      JSON.stringify({ id: "chat-1", lastActivityAt: "yesterday" }),
      JSON.stringify({ id: "chat-1", lastActivityAt: null }),
    ]) {
      expect(readMinkActiveChat(memoryStorage({ [KEY]: raw }), NOW)).toBeNull();
    }
  });

  it("forgets the chat, and survives storage that refuses or is missing", () => {
    const storage = memoryStorage();
    writeMinkActiveChat(storage, { id: "chat-1", lastActivityAt: NOW });
    clearMinkActiveChat(storage);
    expect(readMinkActiveChat(storage, NOW)).toBeNull();

    const refusing = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(() =>
      writeMinkActiveChat(refusing, { id: "chat-1", lastActivityAt: NOW }),
    ).not.toThrow();
    expect(() => clearMinkActiveChat(refusing)).not.toThrow();
    expect(readMinkActiveChat(refusing, NOW)).toBeNull();
    expect(readMinkActiveChat(null, NOW)).toBeNull();
  });
});
