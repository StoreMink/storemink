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

import { createMessageTemplate, listMessageTemplates } from "./graph";
import { WHATSAPP_TEMPLATE_CATALOG } from "./template-catalog";
import {
  bootstrapWhatsAppTemplates,
  normalizeStatus,
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
