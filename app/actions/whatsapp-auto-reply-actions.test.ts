/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerAccess: vi.fn(),
  getActingStoreId: vi.fn(async () => "s1"),
}));
vi.mock("@/lib/analytics/settings", () => ({
  getStoreAnalyticsTimeZone: vi.fn(async () => "Asia/Kolkata"),
}));

import {
  getWhatsAppAutoReplies,
  saveWhatsAppAutoReplies,
} from "./whatsapp-auto-reply-actions";
import { getViewerAccess } from "@/app/dashboard/lib/access";
import { whatsappAutoReplies } from "@/drizzle/schema";
import {
  DEFAULT_AWAY_TEXT,
  defaultAutoReplySettings,
} from "@/lib/whatsapp/auto-reply-settings";

function viewer(grants: Record<string, string[]>) {
  vi.mocked(getViewerAccess).mockResolvedValue({
    userId: "a1",
    can: (section: string, action: string) =>
      (grants[section] ?? []).includes(action),
  } as any);
}

const valid = () => ({
  ...defaultAutoReplySettings("Echoss"),
  welcomeEnabled: true,
});

beforeEach(() => {
  dbHolder.current = makeDbMock();
});

describe("getWhatsAppAutoReplies", () => {
  it("needs Inbox: view", async () => {
    viewer({});
    expect(await getWhatsAppAutoReplies()).toEqual({
      ok: false,
      error: expect.stringMatching(/permission/),
    });
  });

  it("★ with nothing saved, every reply is off and the texts are the defaults", async () => {
    viewer({ inbox: ["view"] });
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            storeName: "Echoss",
            welcomeEnabled: null,
            welcomeText: null,
            awayEnabled: null,
            awayText: null,
            businessHours: null,
            orderStatusEnabled: null,
            updatedAt: null,
          },
        ],
      ],
    });
    const r = await getWhatsAppAutoReplies();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view).toMatchObject({
      saved: false,
      canManage: false,
      timeZoneLabel: "India - Kolkata",
      canChangeTimeZone: false,
      settings: {
        welcomeEnabled: false,
        awayEnabled: false,
        orderStatusEnabled: false,
        welcomeText:
          "Hi, thanks for messaging Echoss! How can we help you today?",
        awayText: DEFAULT_AWAY_TEXT,
      },
    });
  });
});

describe("saveWhatsAppAutoReplies", () => {
  it("needs Inbox: manage, and writes nothing without it", async () => {
    viewer({ inbox: ["view"] });
    expect(await saveWhatsAppAutoReplies(valid())).toEqual({
      ok: false,
      error: expect.stringMatching(/permission/),
    });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ the server checks the rules, not just the form", async () => {
    viewer({ inbox: ["view", "manage"] });
    expect(
      await saveWhatsAppAutoReplies({ ...valid(), welcomeText: "   " }),
    ).toEqual({
      ok: false,
      error: "Write a welcome message, or turn the welcome message off.",
    });
    expect(
      await saveWhatsAppAutoReplies({
        ...valid(),
        hours: { ...valid().hours, mon: { open: "10:00", close: "10:00" } },
      }),
    ).toEqual({ ok: false, error: expect.stringMatching(/^Monday: /) });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ upserts this store's row, from the session, never the request", async () => {
    viewer({ inbox: ["view", "manage"] });
    const r = await saveWhatsAppAutoReplies({
      ...valid(),
      storeId: "someone-else",
      welcomeText: "  Hello!\r\nHow can we help?  ",
    });
    expect(r).toEqual({ ok: true });
    const { calls } = dbHolder.current;
    expect(calls.insert[0]).toBe(whatsappAutoReplies);
    expect(calls.values[0]).toMatchObject({
      storeId: "s1",
      welcomeEnabled: true,
      // Trimmed, with one kind of line ending.
      welcomeText: "Hello!\nHow can we help?",
      updatedBy: "a1",
    });
    expect(calls.values[0]).not.toHaveProperty("storeId", "someone-else");
    expect(calls.onConflict).toHaveLength(1);
  });

  it("a failed write is reported, not thrown", async () => {
    viewer({ inbox: ["view", "manage"] });
    dbHolder.current = makeDbMock({ failInsertFor: [whatsappAutoReplies] });
    expect(await saveWhatsAppAutoReplies(valid())).toEqual({
      ok: false,
      error: expect.stringMatching(/Couldn't save/),
    });
  });
});
