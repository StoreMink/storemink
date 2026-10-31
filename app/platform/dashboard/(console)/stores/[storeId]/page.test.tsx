// @vitest-environment jsdom
// One store's page in the operator console, its StoreMink holds and blocks
// part (takedown design 6.7, plan A7 and A13).
//
// ★★ The operator gate runs before any read: these reads cross every store.
// ★★ The holds-and-blocks read decides the Delete button, so a read that
// failed keeps Delete off (fail closed) and says so, without taking the rest
// of the page down.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreDetail } from "@/lib/platform/store-detail";
import type { StoreModerationSummary } from "@/lib/moderation/console-read";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const HOLD_ID = "22222222-2222-4222-8222-222222222222";
const BLOCK_ID = "33333333-3333-4333-8333-333333333333";

const H = vi.hoisted(() => ({
  calls: [] as string[],
  role: "superadmin" as "superadmin" | "member",
  operator: true,
  summary: null as unknown,
  summaryFails: false,
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("../../require-operator", () => ({
  requireOperator: vi.fn(async () => {
    H.calls.push("requireOperator");
    if (!H.operator) throw new Error("redirect:/dashboard");
    return { email: "ops@storemink.com", role: H.role };
  }),
  canManage: (viewer: { role: string }) => viewer.role === "superadmin",
}));

vi.mock("@/app/actions/platform", () => ({
  getStoreAudit: vi.fn(async () => {
    H.calls.push("audit");
    return { planEvents: [], creditLedger: [] };
  }),
  deleteStore: vi.fn(),
  grantAiCredits: vi.fn(),
  setStorePlan: vi.fn(),
  setStoreStatus: vi.fn(),
}));
vi.mock("@/app/actions/platform-billing", () => ({
  listStoreBilling: vi.fn(async () => {
    H.calls.push("billing");
    return null;
  }),
}));
vi.mock("@/app/actions/takedown-actions", () => ({
  setStoreHoldAction: vi.fn(),
  releaseStoreHoldAction: vi.fn(),
}));
// The billing tools and the comp card are other stages' screens.
vi.mock("./billing-actions", () => ({
  StoreBillingTools: () => null,
  StoreRefundsList: () => null,
}));
vi.mock("./comp-grant", () => ({ CompGrantCard: () => null }));

vi.mock("@/lib/platform/store-detail", () => ({
  loadStoreDetail: vi.fn(async (id: string) => {
    H.calls.push("detail");
    return id === STORE_ID ? detail() : null;
  }),
  loadStorePeople: vi.fn(async () => {
    H.calls.push("people");
    return [];
  }),
}));
vi.mock("@/lib/moderation/console-read", () => ({
  storeModerationSummary: vi.fn(async () => {
    H.calls.push("moderation");
    if (H.summaryFails) throw new Error("read failed");
    return H.summary;
  }),
}));

function detail(over: Partial<StoreDetail> = {}): StoreDetail {
  return {
    id: STORE_ID,
    slug: "echos",
    name: "Echos",
    status: "active",
    plan: "pro",
    effective: "pro",
    planSource: "paid",
    planExpiresAt: null,
    comp: { offer: null, active: null },
    createdAt: "2026-10-01T00:00:00.000Z",
    storeNo: 1001,
    customDomain: null,
    domainVerified: false,
    launched: true,
    demo: false,
    business: { country: "IN", city: "Faridkot" },
    owner: { email: "owner@echos.in", firstName: null, lastName: null },
    counts: {
      orders: 0,
      orders30d: 0,
      products: 0,
      customers: 0,
      locations: 1,
      blogs: 0,
      admins: 1,
      posStaff: 0,
    },
    revenue: { lifetime: 0, last30d: 0 },
    ai: { used: 0, cap: 300, creditBalance: 0 },
    mink: { betaEnabled: true },
    channels: { payments: "none", logistics: "none", sms: "none" },
    subscription: null,
    ...over,
  } as StoreDetail;
}

function summary(
  over: Partial<StoreModerationSummary> = {},
): StoreModerationSummary {
  return {
    activeBlocks: 0,
    openComplaints: 0,
    unfinishedArchives: 0,
    storeBlock: null,
    hold: null,
    deleteRefusal: null,
    ...over,
  };
}

const HOLD = {
  id: HOLD_ID,
  reason: "Police request",
  authorityRef: "Cyber Cell, letter 42",
  setAt: "2026-10-25T20:00:00.000Z",
  setBy: "ops@storemink.com",
  reviewOn: null,
  complaintId: null,
};

import StoreDetailPage from "./page";
import { STORE_MANAGE_TEXT } from "./store-manage";
import { MODERATION_CARD_TEXT } from "./moderation-card";
import { storeModerationSummary } from "@/lib/moderation/console-read";

async function renderPage(storeId = STORE_ID) {
  render(
    await StoreDetailPage({
      params: Promise.resolve({ storeId }),
      searchParams: Promise.resolve({}),
    }),
  );
}

function describedBy(name: string): string | null | undefined {
  const button = screen.getByRole("button", { name }) as HTMLButtonElement;
  const id = button.getAttribute("aria-describedby");
  return id ? document.getElementById(id)?.textContent : null;
}

beforeEach(() => {
  H.calls = [];
  H.role = "superadmin";
  H.operator = true;
  H.summary = summary();
  H.summaryFails = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StoreDetailPage, StoreMink's holds and blocks", () => {
  it("★★ checks the operator before any read", async () => {
    await renderPage();
    expect(H.calls[0]).toBe("requireOperator");
    expect(H.calls).toContain("moderation");
  });

  it("★★ reads nothing when the viewer is not an operator", async () => {
    H.operator = false;
    await expect(renderPage()).rejects.toThrow("redirect:/dashboard");
    expect(storeModerationSummary).not.toHaveBeenCalled();
  });

  it("shows the Complaints and holds card, and Delete on when nothing blocks it", async () => {
    H.summary = summary({ activeBlocks: 3, openComplaints: 2 });
    await renderPage();
    expect(screen.getByText(MODERATION_CARD_TEXT.title)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Blocked items: 3" })).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open complaints: 2" })
        .getAttribute("href"),
    ).toBe(`/dashboard/complaints?store=${STORE_ID}`);
    expect(
      (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByText(/On hold for an investigation/)).toBeNull();
  });

  it("★ a hold shows the banner and keeps Delete off with its reason", async () => {
    H.summary = summary({
      hold: HOLD,
      deleteRefusal: { reason: "hold", message: "x" },
    });
    await renderPage();
    expect(
      screen.getByText(
        "On hold for an investigation since 26 Oct 2026, set by ops@storemink.com: Police request. It can't be deleted.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: MODERATION_CARD_TEXT.release }),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(describedBy("Delete")).toBe(STORE_MANAGE_TEXT.deleteBlocked.hold);
  });

  it("an unfinished archive keeps Delete off with its own reason", async () => {
    H.summary = summary({
      unfinishedArchives: 1,
      deleteRefusal: { reason: "archive", message: "x" },
    });
    await renderPage();
    expect(describedBy("Delete")).toBe(STORE_MANAGE_TEXT.deleteBlocked.archive);
  });

  it("★★ a failed read keeps Delete off and says so, and the page still renders", async () => {
    H.summaryFails = true;
    await renderPage();
    expect(screen.getByText(MODERATION_CARD_TEXT.readFailed)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(describedBy("Delete")).toBe(
      STORE_MANAGE_TEXT.deleteBlocked.unchecked,
    );
    expect(screen.getByText("Echos", { selector: "h1" })).toBeTruthy();
  });

  it("★ a store suspended by a block cannot be reactivated here", async () => {
    H.summary = summary({
      storeBlock: { id: BLOCK_ID, blockedAt: "2026-10-25T20:00:00.000Z" },
    });
    vi.mocked(
      (await import("@/lib/platform/store-detail")).loadStoreDetail,
    ).mockImplementationOnce(async () => detail({ status: "suspended" }));
    await renderPage();
    expect(
      (screen.getByRole("button", { name: "Activate" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(describedBy("Activate")).toBe(STORE_MANAGE_TEXT.suspendedByBlock);
    expect(
      screen
        .getByRole("link", { name: "Suspended by a block since 26 Oct 2026" })
        .getAttribute("href"),
    ).toBe(`/dashboard/complaints/blocks/${BLOCK_ID}`);
  });

  it("★★ a member sees the hold and the lines, and nothing to do", async () => {
    H.role = "member";
    H.summary = summary({
      hold: HOLD,
      deleteRefusal: { reason: "hold", message: "x" },
    });
    await renderPage();
    expect(screen.getByText(/On hold for an investigation since/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: MODERATION_CARD_TEXT.release }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: MODERATION_CARD_TEXT.putOnHold }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", {
        name: MODERATION_CARD_TEXT.suspendOnComplaint,
      }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("is a plain 404 for an unknown store", async () => {
    await expect(
      renderPage("44444444-4444-4444-8444-444444444444"),
    ).rejects.toThrow("notFound");
  });
});
