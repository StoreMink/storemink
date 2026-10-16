/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";
import { WHATSAPP_TEMPLATE_CATALOG } from "@/lib/whatsapp/template-catalog";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
  getViewerAccess: vi.fn(),
}));
vi.mock("@/lib/whatsapp/templates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/whatsapp/templates")>()),
  submitCustomTemplate: vi.fn(),
  deleteStoreTemplate: vi.fn(),
  listStoreTemplates: vi.fn(async () => []),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/whatsapp/config", () => ({
  whatsappConfig: vi.fn(() => ({
    appId: "APP",
    appSecret: "SECRET",
    verifyToken: "V",
    configId: "CFG",
    graphVersion: "v26.0",
  })),
  whatsappConnectConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/whatsapp/connect", () => ({
  connectWhatsAppAccount: vi.fn(),
  disconnectWhatsAppAccount: vi.fn(async () => undefined),
  refreshWhatsAppAccount: vi.fn(async () => ({ ok: true })),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getManagerUserId, getViewerAccess } from "@/app/dashboard/lib/access";
import {
  deleteStoreTemplate,
  listStoreTemplates,
  submitCustomTemplate,
} from "@/lib/whatsapp/templates";
import { rateLimit } from "@/lib/rate-limit";
import { whatsappConnectConfigured } from "@/lib/whatsapp/config";
import { connectWhatsAppAccount } from "@/lib/whatsapp/connect";
import {
  connectWhatsApp,
  disconnectWhatsApp,
  getWhatsAppChannelState,
  getWhatsAppTemplatesForEvent,
  getWhatsAppTemplateManager,
  setWhatsAppEnabled,
  submitWhatsAppTemplate,
  deleteWhatsAppTemplate,
} from "./whatsapp-provider-actions";

const BASIC_STORE = [
  {
    plan: "basic",
    plan_expires_at: null,
    comp_plan: null,
    comp_expires_at: null,
  },
];
const FREE_STORE = [
  {
    plan: "free",
    plan_expires_at: null,
    comp_plan: null,
    comp_expires_at: null,
  },
];
const ACCOUNT = [
  {
    enabled: true,
    status: "connected",
    displayPhone: "+91 98765 43210",
    verifiedName: "Echos",
    nameStatus: "APPROVED",
    messagingTier: "TIER_1K",
    qualityRating: "GREEN",
    coexistence: false,
    lastError: null,
  },
];
const POPUP = {
  code: "CODE",
  wabaId: "2323545385144849",
  phoneNumberId: "1280649011808874",
  coexistence: false,
};

beforeEach(() => {
  vi.mocked(getManagerUserId).mockResolvedValue("admin-1");
  vi.mocked(whatsappConnectConfigured).mockReturnValue(true);
  vi.mocked(connectWhatsAppAccount).mockResolvedValue({
    ok: true,
    displayPhone: "+91 98765 43210",
    verifiedName: "Echos",
  });
  dbHolder.current = makeDbMock({
    selectByTable: {
      store_whatsapp_accounts: [ACCOUNT],
      stores: [BASIC_STORE],
    },
  });
});

describe("permissions", () => {
  it.each([
    ["connectWhatsApp", () => connectWhatsApp(POPUP)],
    ["setWhatsAppEnabled", () => setWhatsAppEnabled(true)],
    ["disconnectWhatsApp", () => disconnectWhatsApp()],
  ])("%s refuses without the channels grant", async (_n, call) => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    expect((await call()).error).toMatch(/permission/i);
    expect(connectWhatsAppAccount).not.toHaveBeenCalled();
  });

  it("getWhatsAppChannelState reports nothing without the grant", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    const s = await getWhatsAppChannelState();
    expect(s.connected).toBe(false);
    expect(s.planAllows).toBe(false);
  });
});

describe("getWhatsAppChannelState", () => {
  it("returns Meta's facts, the plan gate and the public SDK ids — never a token", async () => {
    const s = await getWhatsAppChannelState();
    expect(s).toMatchObject({
      connected: true,
      enabled: true,
      status: "connected",
      displayPhone: "+91 98765 43210",
      messagingTier: "TIER_1K",
      planAllows: true,
      configured: true,
      appId: "APP",
      configId: "CFG",
    });
    expect(JSON.stringify(s)).not.toMatch(/token|pin/i);
  });

  it("withholds the SDK ids when the platform is not configured", async () => {
    vi.mocked(whatsappConnectConfigured).mockReturnValue(false);
    const s = await getWhatsAppChannelState();
    expect(s.configured).toBe(false);
    expect(s.appId).toBe("");
    expect(s.configId).toBe("");
  });
});

describe("connectWhatsApp", () => {
  it("hands the popup's values to the connect flow for the acting store", async () => {
    const r = await connectWhatsApp(POPUP);
    expect(r).toEqual({ success: true, displayPhone: "+91 98765 43210" });
    expect(connectWhatsAppAccount).toHaveBeenCalledWith({
      storeId: "store-1",
      ...POPUP,
    });
  });

  it("★ refuses on Free before calling Meta — the plan gate is server-side", async () => {
    dbHolder.current = makeDbMock({ selectByTable: { stores: [FREE_STORE] } });
    const r = await connectWhatsApp(POPUP);
    expect(r.error).toMatch(/Basic plan/);
    expect(connectWhatsAppAccount).not.toHaveBeenCalled();
  });

  it("refuses when the platform has no Embedded Signup configuration", async () => {
    vi.mocked(whatsappConnectConfigured).mockReturnValue(false);
    const r = await connectWhatsApp(POPUP);
    expect(r.error).toMatch(/isn't available/);
    expect(connectWhatsAppAccount).not.toHaveBeenCalled();
  });

  it("refuses an empty code without a lookup", async () => {
    const r = await connectWhatsApp({ ...POPUP, code: "  " });
    expect(r.error).toMatch(/sign-in code/);
    expect(connectWhatsAppAccount).not.toHaveBeenCalled();
  });

  it("★ hands a Coexistence finish with no number to the connect flow as an empty id", async () => {
    const r = await connectWhatsApp({
      ...POPUP,
      phoneNumberId: null,
      coexistence: true,
    });
    expect(r.success).toBe(true);
    expect(connectWhatsAppAccount).toHaveBeenCalledWith({
      storeId: "store-1",
      code: "CODE",
      wabaId: POPUP.wabaId,
      phoneNumberId: "",
      coexistence: true,
    });
  });

  it("surfaces the connect flow's own error", async () => {
    vi.mocked(connectWhatsAppAccount).mockResolvedValue({
      ok: false,
      error: "Meta refused while x: y",
    });
    expect((await connectWhatsApp(POPUP)).error).toBe(
      "Meta refused while x: y",
    );
  });
});

describe("setWhatsAppEnabled", () => {
  it("resuming is plan-gated; pausing never is", async () => {
    dbHolder.current = makeDbMock({ selectByTable: { stores: [FREE_STORE] } });
    expect((await setWhatsAppEnabled(true)).error).toMatch(/Basic plan/);
    expect((await setWhatsAppEnabled(false)).success).toBe(true);
  });
});

describe("template versions", () => {
  const V1 = "sm_order_ready_for_pickup_customer_v1";
  const V2 = "sm_order_ready_for_pickup_customer_v3"; // the current name
  const tplRow = (name: string, status: string, text: string) => ({
    id: name,
    audience: "customer",
    name,
    status,
    rejectionReason: status === "REJECTED" ? "INCORRECT_CATEGORY" : null,
    syncError: null,
    quality: null,
    lastSyncedAt: null,
    components: [{ type: "BODY", text }],
    variables: ["subject_label"],
  });

  it("★ the console shows the replacement, not the rejected version it replaces", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        whatsapp_templates: [
          [tplRow(V1, "REJECTED", "old"), tplRow(V2, "PENDING", "new")],
        ],
      },
    });
    const { templates } = await getWhatsAppTemplatesForEvent(
      "order.ready_for_pickup",
    );
    const customer = templates.find((t) => t.audience === "customer");
    expect(customer).toMatchObject({
      name: V2,
      status: "PENDING",
      body: "new",
    });
  });

  it("★ the COD wording is its own row: the plain message's approval never shows under it", async () => {
    const plain = "sm_order_placed_customer_v1";
    const cod = "sm_order_placed_customer_cod_confirm_v1";
    dbHolder.current = makeDbMock({
      selectByTable: {
        whatsapp_templates: [
          [tplRow(plain, "APPROVED", "plain"), tplRow(cod, "PENDING", "cod")],
        ],
      },
    });
    const { templates } = await getWhatsAppTemplatesForEvent("order.placed");
    const customer = templates.filter((t) => t.audience === "customer");
    expect(customer).toHaveLength(2);
    expect(customer.find((t) => !t.variant)).toMatchObject({
      name: plain,
      status: "APPROVED",
      buttons: [],
    });
    expect(customer.find((t) => t.variant === "cod_confirm")).toMatchObject({
      name: cod,
      status: "PENDING",
      body: "cod",
      buttons: ["Confirm order", "Cancel order"],
    });
  });

  it("…and a store that has not submitted it yet sees it as not set up", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        whatsapp_templates: [
          [tplRow("sm_order_placed_customer_v1", "APPROVED", "plain")],
        ],
      },
    });
    const { templates } = await getWhatsAppTemplatesForEvent("order.placed");
    expect(templates.find((t) => t.variant === "cod_confirm")?.status).toBe(
      "missing",
    );
  });

  it("★ the card counts only current catalogue names", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        store_whatsapp_accounts: [ACCOUNT],
        stores: [BASIC_STORE],
        whatsapp_templates: [
          [
            ...WHATSAPP_TEMPLATE_CATALOG.map((t) => ({
              name: t.name,
              language: t.language,
              status: "PENDING",
              providerTemplateId: `meta-${t.name}`,
            })),
            // An old version's row is history, never counted.
            {
              name: V1,
              language: "en",
              status: "REJECTED",
              providerTemplateId: "meta-old",
            },
          ],
        ],
      },
    });
    const s = await getWhatsAppChannelState();
    expect(s.templates).toEqual({
      approved: 0,
      pending: WHATSAPP_TEMPLATE_CATALOG.length,
      unsubmitted: 0,
      total: WHATSAPP_TEMPLATE_CATALOG.length,
    });
    const params = dbHolder.current.calls.where.flatMap((w: any) =>
      sqlParamValues(w),
    );
    expect(params).toContain(V2);
    expect(params).not.toContain(V1);
  });

  it("★★ a template Meta holds nothing for is still to submit, never 'in review'", async () => {
    const [refused, unanswered, missing, inReview, approved, ...rest] =
      WHATSAPP_TEMPLATE_CATALOG;
    const tpl = (
      t: (typeof WHATSAPP_TEMPLATE_CATALOG)[number],
      status: string,
      providerTemplateId: string | null,
    ) => ({ name: t.name, language: t.language, status, providerTemplateId });
    dbHolder.current = makeDbMock({
      selectByTable: {
        store_whatsapp_accounts: [ACCOUNT],
        stores: [BASIC_STORE],
        whatsapp_templates: [
          [
            // Refused at submission and never answered: PENDING, no Meta id.
            tpl(refused!, "PENDING", null),
            tpl(unanswered!, "PENDING", null),
            // (`missing` has no row at all.)
            tpl(inReview!, "PENDING", "meta-1"),
            tpl(approved!, "APPROVED", "meta-2"),
            ...rest.map((t) => tpl(t, "APPROVED", `meta-${t.name}`)),
          ],
        ],
      },
    });
    void missing;
    const s = await getWhatsAppChannelState();
    expect(s.templates).toEqual({
      approved: WHATSAPP_TEMPLATE_CATALOG.length - 4,
      pending: 1,
      unsubmitted: 3,
      total: WHATSAPP_TEMPLATE_CATALOG.length,
    });
  });

  it("a REJECTED template Meta reviewed is neither in review nor to submit", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        store_whatsapp_accounts: [ACCOUNT],
        stores: [BASIC_STORE],
        whatsapp_templates: [
          WHATSAPP_TEMPLATE_CATALOG.map((t) => ({
            name: t.name,
            language: t.language,
            status: "REJECTED",
            providerTemplateId: `meta-${t.name}`,
          })),
        ],
      },
    });
    const s = await getWhatsAppChannelState();
    expect(s.templates).toMatchObject({
      approved: 0,
      pending: 0,
      unsubmitted: 0,
    });
  });
});

describe("the template manager", () => {
  const DRAFT = {
    name: "delivery_delay",
    language: "en",
    category: "UTILITY",
    headerText: "",
    body: "Hi {{1}}, your order is late.",
    variables: [{ name: "customer_name", sample: "Rohan" }],
    footerText: "",
    buttons: [],
  };

  it("reads with Channels: view and says whether the viewer may change anything", async () => {
    vi.mocked(getViewerAccess).mockResolvedValue({
      can: (section: string, action: string) =>
        section === "channels" && action === "view",
    } as any);
    const r = await getWhatsAppTemplateManager();
    expect(r).toEqual({
      ok: true,
      view: {
        connected: true,
        status: "connected",
        canManage: false,
        templates: [],
      },
    });
    expect(listStoreTemplates).toHaveBeenCalledWith("store-1");

    vi.mocked(getViewerAccess).mockResolvedValue({ can: () => false } as any);
    expect(await getWhatsAppTemplateManager()).toEqual({
      ok: false,
      error: "You don't have permission to view Channels.",
    });
  });

  it("★ submit checks the template on the server, then hands it to Meta", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { stores: [BASIC_STORE, BASIC_STORE] },
    });
    vi.mocked(submitCustomTemplate).mockResolvedValue({
      ok: true,
      id: "row-c",
      status: "PENDING",
    });
    expect(await submitWhatsAppTemplate(DRAFT)).toEqual({
      success: true,
      id: "row-c",
      status: "PENDING",
    });
    expect(submitCustomTemplate).toHaveBeenCalledWith(
      "store-1",
      expect.objectContaining({ name: "delivery_delay" }),
    );
    expect(await submitWhatsAppTemplate({ ...DRAFT, name: "sm_mine" })).toEqual(
      { error: expect.stringMatching(/StoreMink's own/) },
    );
    expect(submitCustomTemplate).toHaveBeenCalledTimes(1);
  });

  it("submit needs Channels: manage, the plan, and is rate-limited", async () => {
    vi.mocked(getManagerUserId).mockResolvedValueOnce(null);
    expect(await submitWhatsAppTemplate(DRAFT)).toEqual({
      error: "You don't have permission to do this.",
    });
    dbHolder.current = makeDbMock({ selectByTable: { stores: [FREE_STORE] } });
    expect((await submitWhatsAppTemplate(DRAFT)).error).toMatch(/Basic plan/);
    dbHolder.current = makeDbMock({ selectByTable: { stores: [BASIC_STORE] } });
    vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false } as any);
    expect((await submitWhatsAppTemplate(DRAFT)).error).toMatch(
      /Try again in an hour/,
    );
    expect(submitCustomTemplate).not.toHaveBeenCalled();
  });

  it("delete passes a uuid through and surfaces the refusal", async () => {
    vi.mocked(deleteStoreTemplate).mockResolvedValue({ ok: true });
    const id = "11111111-1111-4111-8111-111111111111";
    expect(await deleteWhatsAppTemplate(id)).toEqual({ success: true });
    expect(deleteStoreTemplate).toHaveBeenCalledWith("store-1", id);
    expect(await deleteWhatsAppTemplate("junk")).toEqual({
      error: "That template no longer exists.",
    });
    vi.mocked(deleteStoreTemplate).mockResolvedValue({
      ok: false,
      error: "nope",
    });
    expect(await deleteWhatsAppTemplate(id)).toEqual({ error: "nope" });
  });
});
