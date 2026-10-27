import { describe, expect, it } from "vitest";
import * as chatSession from "./chat-session";
import {
  CHAT_ID_PATTERN,
  clearMinkActiveChat,
  isMinkChatStale,
  MINK_CHAT_PARAM,
  MINK_CHAT_RESUME_MS,
  MINK_CONVERSATION_RETENTION_DAYS,
  MINK_HISTORY_PAGE_SIZE,
  minkChatHref,
  readMinkActiveChat,
  readMinkChatParam,
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

describe("★★ the dashboard address that opens a chat (B20)", () => {
  const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  it("builds one address for a chat, and plain /dashboard for none", () => {
    expect(MINK_CHAT_PARAM).toBe("chat");
    expect(minkChatHref(ID)).toBe(`/dashboard?chat=${ID}`);
    expect(minkChatHref(ID.toUpperCase())).toBe(`/dashboard?chat=${ID}`);
    expect(minkChatHref(null)).toBe("/dashboard");
    expect(minkChatHref(undefined)).toBe("/dashboard");
    expect(minkChatHref("")).toBe("/dashboard");
  });

  it("★ reads only a conversation id, in any case and with stray spaces", () => {
    expect(readMinkChatParam(ID)).toBe(ID);
    expect(readMinkChatParam(` ${ID.toUpperCase()} `)).toBe(ID);
    expect(readMinkChatParam(null)).toBeNull();
    expect(readMinkChatParam(undefined)).toBeNull();
    // Anything else names no chat, so nothing is asked for.
    for (const value of [
      "",
      "chat-1",
      `${ID}x`,
      `${ID}/../other`,
      "javascript:alert(1)",
      "00000000-0000-0000-0000-000000000000",
    ]) {
      expect(readMinkChatParam(value)).toBeNull();
    }
  });

  it("★ an address that is not a chat id is never written into a link", () => {
    expect(minkChatHref("https://evil.example/x")).toBe("/dashboard");
    expect(minkChatHref(`${ID}&next=/admin`)).toBe("/dashboard");
  });
});

describe("how long chats are kept and how History pages them", () => {
  it("★ keeps a chat 90 days after its last use, with no count limit", () => {
    expect(MINK_CONVERSATION_RETENTION_DAYS).toBe(90);
    // The ten-chat cap is gone, not merely raised.
    expect("MINK_CONVERSATION_LIMIT" in chatSession).toBe(false);
  });

  it("pages History 30 chats at a time", () => {
    expect(MINK_HISTORY_PAGE_SIZE).toBe(30);
  });

  it("knows a chat id as the database writes one", () => {
    expect(CHAT_ID_PATTERN.test("0b1d4e2a-6c3f-4a5b-9c7d-1e2f3a4b5c6d")).toBe(
      true,
    );
    expect(CHAT_ID_PATTERN.test("0B1D4E2A-6C3F-4A5B-9C7D-1E2F3A4B5C6D")).toBe(
      false,
    );
    expect(CHAT_ID_PATTERN.test("not-a-chat")).toBe(false);
  });
});
