/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/payments/crypto", () => ({
  decryptSecret: vi.fn((v: string) => `plain:${v}`),
  encryptSecret: vi.fn((v: string) => `enc:${v}`),
}));
vi.mock("./graph", () => ({
  createMessageTemplate: vi.fn(),
  deleteMessageTemplate: vi.fn(async () => ({ ok: true, data: {} })),
  listMessageTemplates: vi.fn(async () => ({ ok: true, data: { data: [] } })),
  isTemplateExistsError: vi.fn(
    (r: any) => !r.ok && r.outcome === "rejected" && r.subcode === 2388023,
  ),
  isTokenError: vi.fn(
    (r: any) => !r.ok && r.outcome === "rejected" && r.code === 190,
  ),
}));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  createMessageTemplate,
  deleteMessageTemplate,
  listMessageTemplates,
} from "./graph";
import { WHATSAPP_TEMPLATE_CATALOG } from "./template-catalog";
import {
  bootstrapWhatsAppTemplates,
  deleteStoreTemplate,
  listStoreTemplates,
  normalizeStatus,
  submitCustomTemplate,
  syncWhatsAppTemplates,
} from "./templates";
import { storeWhatsappAccounts, whatsappTemplates } from "@/drizzle/schema";

const ACCOUNT = [{ wabaId: "W", tokenEnc: "tok", status: "connected" }];

function setup(opts: { providerIds?: (string | null)[] } = {}) {
  // One upsert per catalogue entry, each returning its row.
  const returningQueue = WHATSAPP_TEMPLATE_CATALOG.map((_, i) => [
    { id: `row-${i}`, providerTemplateId: opts.providerIds?.[i] ?? null },
  ]);
  dbHolder.current = makeDbMock({
    selectByTable: { store_whatsapp_accounts: [ACCOUNT, ACCOUNT] },
    returningQueue,
  });
}

beforeEach(() => {
  setup();
  vi.mocked(createMessageTemplate).mockResolvedValue({
    ok: true,
    data: { id: "meta-1", status: "PENDING", category: "UTILITY" },
  });
});

describe("bootstrapWhatsAppTemplates", () => {
  it("submits every catalogue template with its examples and records Meta's id", async () => {
    const r = await bootstrapWhatsAppTemplates("store-1");
    expect(r).toMatchObject({
      ok: true,
      submitted: WHATSAPP_TEMPLATE_CATALOG.length,
      failed: 0,
    });
    expect(createMessageTemplate).toHaveBeenCalledTimes(
      WHATSAPP_TEMPLATE_CATALOG.length,
    );
    const first = vi.mocked(createMessageTemplate).mock.calls[0]!;
    expect(first[0]).toBe("plain:tok");
    expect(first[1]).toBe("W");
    expect(first[2]).toMatchObject({
      name: WHATSAPP_TEMPLATE_CATALOG[0]!.name,
      language: "en",
      category: "UTILITY",
      components: [
        expect.objectContaining({
          type: "BODY",
          example: { body_text: [WHATSAPP_TEMPLATE_CATALOG[0]!.examples] },
        }),
      ],
    });
    // The local row was upserted on (store, name, language) — the 0174 key.
    const upserts = dbHolder.current.calls.insert.filter(
      (t: any) => t === whatsappTemplates,
    );
    expect(upserts).toHaveLength(WHATSAPP_TEMPLATE_CATALOG.length);
    const recorded = dbHolder.current.calls.set.find(
      (s: any) => s.providerTemplateId === "meta-1",
    );
    expect(recorded).toMatchObject({ status: "PENDING", syncError: null });
  });

  it("skips Meta for a row that already carries a provider id", async () => {
    setup({
      providerIds: WHATSAPP_TEMPLATE_CATALOG.map(() => "existing"),
    });
    const r = await bootstrapWhatsAppTemplates("store-1");
    expect(r).toMatchObject({
      existing: WHATSAPP_TEMPLATE_CATALOG.length,
      submitted: 0,
    });
    expect(createMessageTemplate).not.toHaveBeenCalled();
  });

  it("★ reads Meta's 'already exists' as existing, not as a failure", async () => {
    vi.mocked(createMessageTemplate).mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "Template name already exists",
      code: 100,
      subcode: 2388023,
    });
    const r = await bootstrapWhatsAppTemplates("store-1");
    expect(r.ok).toBe(true);
    expect(r.existing).toBe(WHATSAPP_TEMPLATE_CATALOG.length);
    expect(r.failed).toBe(0);
  });

  it("records a refusal on the row and carries on with the rest", async () => {
    vi.mocked(createMessageTemplate)
      .mockResolvedValueOnce({
        ok: false,
        outcome: "rejected",
        error: "Invalid parameter",
        code: 100,
      })
      .mockResolvedValue({
        ok: true,
        data: { id: "meta-2", status: "APPROVED" },
      });
    const r = await bootstrapWhatsAppTemplates("store-1");
    expect(r.failed).toBe(1);
    expect(r.submitted).toBe(WHATSAPP_TEMPLATE_CATALOG.length - 1);
    const refused = dbHolder.current.calls.set.find((s: any) =>
      String(s.syncError ?? "").includes("Invalid parameter"),
    );
    expect(refused).toBeTruthy();
  });

  it("★ a dead token stops the loop and marks the account for reconnection", async () => {
    vi.mocked(createMessageTemplate).mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "Invalid OAuth access token",
      code: 190,
    });
    const r = await bootstrapWhatsAppTemplates("store-1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Reconnect/);
    expect(createMessageTemplate).toHaveBeenCalledTimes(1);
    const accountUpdate = dbHolder.current.calls.update.findIndex(
      (t: any) => t === storeWhatsappAccounts,
    );
    expect(accountUpdate).toBeGreaterThanOrEqual(0);
    expect(dbHolder.current.calls.set[accountUpdate]).toMatchObject({
      status: "needs_reauth",
    });
  });

  it("refuses when the store is not connected", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { store_whatsapp_accounts: [[]] },
    });
    const r = await bootstrapWhatsAppTemplates("store-1");
    expect(r.ok).toBe(false);
    expect(createMessageTemplate).not.toHaveBeenCalled();
  });
});

describe("syncWhatsAppTemplates", () => {
  it("writes Meta's status, id and rejection reason onto the row matched by name and language", async () => {
    vi.mocked(listMessageTemplates).mockResolvedValue({
      ok: true,
      data: {
        data: [
          {
            id: "meta-9",
            name: "sm_order_placed_customer_v1",
            language: "en",
            status: "REJECTED",
            rejected_reason: "INVALID_FORMAT",
            quality_score: { score: "UNKNOWN" },
          },
        ],
      },
    });
    dbHolder.current = makeDbMock({
      selectByTable: { store_whatsapp_accounts: [ACCOUNT] },
      returning: [{ id: "row-1" }],
    });
    const r = await syncWhatsAppTemplates("store-1");
    expect(r).toEqual({ ok: true, updated: 1 });
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      providerTemplateId: "meta-9",
      status: "REJECTED",
      rejectionReason: "INVALID_FORMAT",
      quality: "UNKNOWN",
    });
  });

  it("reports an unanswered list without touching any row", async () => {
    vi.mocked(listMessageTemplates).mockResolvedValue({
      ok: false,
      outcome: "unknown",
      error: "Meta 502.",
    });
    const r = await syncWhatsAppTemplates("store-1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/didn't answer/);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });
});

describe("normalizeStatus", () => {
  it("maps Meta's vocabulary onto the CHECK and keeps an unknown word PENDING", () => {
    expect(normalizeStatus("approved")).toBe("APPROVED");
    expect(normalizeStatus("PAUSED")).toBe("PAUSED");
    expect(normalizeStatus("SOMETHING_NEW")).toBe("PENDING");
    expect(normalizeStatus(undefined)).toBe("PENDING");
  });
});

const DRAFT = {
  name: "delivery_delay",
  language: "en" as const,
  category: "UTILITY" as const,
  headerText: "",
  body: "Hi {{1}}, your order is running late.",
  variables: [{ name: "customer_name", sample: "Rohan" }],
  footerText: "",
  buttons: [{ type: "quick_reply" as const, text: "Okay" }],
};

describe("submitCustomTemplate", () => {
  it("★ writes the row PENDING for customers, then submits Meta's components and records the answer", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { store_whatsapp_accounts: [ACCOUNT] },
      returningQueue: [[{ id: "row-c", providerTemplateId: null }]],
    });
    vi.mocked(createMessageTemplate).mockResolvedValue({
      ok: true,
      data: { id: "meta-c", status: "PENDING", category: "UTILITY" },
    });
    const r = await submitCustomTemplate("store-1", DRAFT);
    expect(r).toEqual({ ok: true, id: "row-c", status: "PENDING" });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "store-1",
      wabaId: "W",
      eventKey: null,
      audience: "customer",
      name: "delivery_delay",
      language: "en",
      status: "PENDING",
      variables: ["customer_name"],
    });
    expect(createMessageTemplate).toHaveBeenCalledWith("plain:tok", "W", {
      name: "delivery_delay",
      language: "en",
      category: "UTILITY",
      components: [
        {
          type: "BODY",
          text: "Hi {{1}}, your order is running late.",
          example: { body_text: [["Rohan"]] },
        },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Okay" }] },
      ],
    });
    // The record of Meta's answer.
    const set = dbHolder.current.calls.set.find(
      (v: any) => v.providerTemplateId === "meta-c",
    );
    expect(set).toMatchObject({ status: "PENDING", syncError: null });
  });

  it("★ a name the store already holds is refused before Meta is asked", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { store_whatsapp_accounts: [ACCOUNT] },
      returningQueue: [[]],
    });
    const r = await submitCustomTemplate("store-1", DRAFT);
    expect(r).toEqual({
      ok: false,
      error: expect.stringMatching(
        /already have a template called delivery_delay/,
      ),
    });
    expect(createMessageTemplate).not.toHaveBeenCalled();
  });

  it("a refusal at submission stays on the row as the reason, and is reported", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { store_whatsapp_accounts: [ACCOUNT] },
      returningQueue: [[{ id: "row-c", providerTemplateId: null }]],
    });
    vi.mocked(createMessageTemplate).mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "Invalid parameter",
      code: 100,
    } as any);
    const r = await submitCustomTemplate("store-1", DRAFT);
    expect(r).toEqual({
      ok: false,
      error: "Meta refused the template: Invalid parameter",
    });
    const set = dbHolder.current.calls.set.find((v: any) => v.syncError);
    expect(set.syncError).toBe("Meta refused the template: Invalid parameter");
  });

  it("refuses when the store is not connected", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { store_whatsapp_accounts: [[]] },
    });
    expect(await submitCustomTemplate("store-1", DRAFT)).toEqual({
      ok: false,
      error: "WhatsApp isn't connected.",
    });
  });
});

describe("deleteStoreTemplate", () => {
  it("★ deletes a merchant's template at Meta by its id, then here", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        whatsapp_templates: [
          [
            {
              id: "row-c",
              name: "delivery_delay",
              eventKey: null,
              providerTemplateId: "meta-c",
            },
          ],
        ],
        store_whatsapp_accounts: [ACCOUNT],
      },
    });
    expect(await deleteStoreTemplate("store-1", "row-c")).toEqual({ ok: true });
    expect(deleteMessageTemplate).toHaveBeenCalledWith("plain:tok", "W", {
      name: "delivery_delay",
      hsmId: "meta-c",
    });
    expect(dbHolder.current.calls.delete.length).toBe(1);
  });

  it("★ refuses one of StoreMink's own, by event or by name", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        whatsapp_templates: [
          [
            {
              id: "row-1",
              name: "sm_order_placed_customer_v1",
              eventKey: "order.placed",
              providerTemplateId: "m",
            },
          ],
        ],
      },
    });
    const r = await deleteStoreTemplate("store-1", "row-1");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/can't be deleted/);
    expect(deleteMessageTemplate).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.delete.length).toBe(0);
  });

  it("Meta no longer holding it reads as gone; any other refusal keeps the row", async () => {
    const row = {
      id: "row-c",
      name: "delivery_delay",
      eventKey: null,
      providerTemplateId: null,
    };
    dbHolder.current = makeDbMock({
      selectByTable: {
        whatsapp_templates: [[row]],
        store_whatsapp_accounts: [ACCOUNT],
      },
    });
    vi.mocked(deleteMessageTemplate).mockResolvedValueOnce({
      ok: false,
      outcome: "rejected",
      error: "Message template does not exist",
    } as any);
    expect(await deleteStoreTemplate("store-1", "row-c")).toEqual({ ok: true });

    dbHolder.current = makeDbMock({
      selectByTable: {
        whatsapp_templates: [[row]],
        store_whatsapp_accounts: [ACCOUNT],
      },
    });
    vi.mocked(deleteMessageTemplate).mockResolvedValueOnce({
      ok: false,
      outcome: "unknown",
      error: "timeout",
    } as any);
    expect(await deleteStoreTemplate("store-1", "row-c")).toEqual({
      ok: false,
      error: "Meta didn't answer. Try again in a minute.",
    });
    expect(dbHolder.current.calls.delete.length).toBe(0);
  });
});

describe("listStoreTemplates", () => {
  it("★ tells StoreMink's templates from the merchant's, and which the inbox may send", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "a",
            name: "sm_order_placed_customer_cod_confirm_v1",
            language: "en",
            category: "UTILITY",
            status: "APPROVED",
            rejectionReason: null,
            syncError: null,
            quality: null,
            lastSyncedAt: null,
            createdAt: "2026-10-01T00:00:00Z",
            eventKey: "order.placed",
            audience: "customer",
            components: [
              { type: "BODY", text: "Confirm {{1}}" },
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Confirm order" }],
              },
            ],
            variables: ["subject_label"],
            enabled: true,
          },
          {
            id: "b",
            name: "delivery_delay",
            language: "hi",
            category: "UTILITY",
            status: "APPROVED",
            rejectionReason: null,
            syncError: null,
            quality: "GREEN",
            lastSyncedAt: null,
            createdAt: "2026-10-02T00:00:00Z",
            eventKey: null,
            audience: "customer",
            components: [
              { type: "HEADER", format: "TEXT", text: "Update" },
              { type: "BODY", text: "Hi {{1}}" },
              { type: "FOOTER", text: "Echoss" },
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Okay" }],
              },
            ],
            variables: ["customer_name"],
            enabled: true,
          },
        ],
      ],
    });
    const rows = await listStoreTemplates("store-1");
    expect(rows.map((r) => [r.name, r.catalogue, r.sendableFromInbox])).toEqual(
      [
        ["sm_order_placed_customer_cod_confirm_v1", true, false],
        ["delivery_delay", false, true],
      ],
    );
    expect(rows[1]).toMatchObject({
      headerText: "Update",
      body: "Hi {{1}}",
      footerText: "Echoss",
      buttons: [{ type: "quick_reply", text: "Okay" }],
      variables: ["customer_name"],
    });
  });
});
