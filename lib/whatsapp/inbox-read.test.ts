/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("./inbox", () => ({
  serviceWindow: () => ({ open: true, closesAt: null }),
}));
vi.mock("./mink-drafts", () => ({ loadMinkDraft: vi.fn(async () => null) }));
vi.mock("./channel", () => ({
  bodyFromComponents: () => "Hi {{1}}",
  consented: () => false,
}));

import {
  listConversations,
  listReplyTemplates,
  loadInboxChannelState,
} from "./inbox-read";

const STORE = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  dbHolder.current = makeDbMock({ executeQueue: [[], []] });
});

describe("listConversations search", () => {
  const search = (q: string) =>
    listConversations(STORE, { filter: "all", q, page: 1 });

  it("★ escapes what was typed, so % and _ match only themselves and a backslash escapes nothing", async () => {
    await search("50%_off\\");
    const query = dbHolder.current.calls.execute[0];
    expect(sqlText(query)).toContain("k.profile_name ilike");
    expect(sqlParamValues(query)).toContain("%50\\%\\_off\\\\%");
  });

  it("a name is matched anywhere in it, and three digits or more search the number too", async () => {
    await search("Rohan 98765");
    const params = sqlParamValues(dbHolder.current.calls.execute[0]);
    expect(params).toContain("%Rohan 98765%");
    expect(params).toContain("%98765%");
  });

  it("no search, no LIKE", async () => {
    await search("  ");
    expect(sqlText(dbHolder.current.calls.execute[0])).not.toContain("ilike");
  });
});

describe("listReplyTemplates", () => {
  it("★ carries Meta's category with each customer template, for the offers rule", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "t1",
            name: "diwali_offer",
            language: "en",
            category: "MARKETING",
            variables: ["customer_name"],
            components: [{ type: "BODY", text: "Hi {{1}}" }],
            audience: "customer",
            eventKey: null,
          },
          {
            id: "t2",
            name: "sm_order_ready_team_v1",
            language: "en",
            category: "UTILITY",
            variables: [],
            components: [],
            audience: "team",
            eventKey: "order.ready",
          },
        ],
      ],
    });
    const templates = await listReplyTemplates(STORE);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      id: "t1",
      category: "MARKETING",
      variables: ["customer_name"],
    });
  });
});

describe("loadInboxChannelState", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    plan: "basic",
    planExpiresAt: null,
    compPlan: null,
    compExpiresAt: null,
    accountStoreId: STORE,
    enabled: true,
    status: "connected",
    ...over,
  });
  const read = async (rows: unknown[]) => {
    dbHolder.current = makeDbMock({ selectQueue: [rows] });
    return loadInboxChannelState(STORE);
  };

  it("a connected, switched-on number on a plan with WhatsApp is live", async () => {
    expect(await read([row()])).toEqual({
      connected: true,
      live: true,
      planAllows: true,
    });
    // The store's own row, with its account joined: never another store's.
    expect(dbHolder.current.calls.leftJoin).toHaveLength(1);
  });

  it("a paused or reconnect-needed number is connected but not live", async () => {
    expect((await read([row({ enabled: false })])).live).toBe(false);
    expect((await read([row({ status: "needs_reauth" })])).live).toBe(false);
    expect((await read([row({ status: "needs_reauth" })])).connected).toBe(
      true,
    );
  });

  it("no account row is not connected, and the plan still says whether it could be", async () => {
    expect(
      await read([row({ accountStoreId: null, enabled: null, status: null })]),
    ).toEqual({ connected: false, live: false, planAllows: true });
    expect(
      await read([
        row({
          plan: "free",
          accountStoreId: null,
          enabled: null,
          status: null,
        }),
      ]),
    ).toEqual({ connected: false, live: false, planAllows: false });
    expect(await read([])).toEqual({
      connected: false,
      live: false,
      planAllows: false,
    });
  });
});
