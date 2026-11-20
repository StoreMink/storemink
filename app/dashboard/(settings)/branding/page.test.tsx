/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Branding page reads whether the store's plan removes the "Powered by
// StoreMink" badge with the helper every dashboard page uses for the plan in
// force (getStorePlanContext: the effective plan), and hands it to the form.

const H = vi.hoisted(() => ({
  limits: { removeBadge: false } as { removeBadge: boolean } | null,
  storeIds: [] as string[],
}));

vi.mock("../../lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({
    can: (section: string, action: string) =>
      section === "branding" && action === "manage",
  })),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/app/actions/store-branding", () => ({
  getStoreBrandingForEditor: vi.fn(async () => ({ name: "Acme Foods" })),
}));
vi.mock("@/app/actions/brand-voice-actions", () => ({
  getBrandVoiceForEditor: vi.fn(async () => ({
    content: "Warm and plain.",
    structured: { sell: "Spices" },
    usage: { used: 3, cap: 20 },
  })),
}));
vi.mock("@/lib/plans/entitlements", () => ({
  getStorePlanContext: vi.fn(async (storeId: string) => {
    H.storeIds.push(storeId);
    if (!H.limits) throw new Error("connection refused");
    return { plan: "free", limits: H.limits };
  }),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("./branding-form", () => ({ BrandingForm: () => null }));

import BrandingPage from "./page";
import { BrandingForm } from "./branding-form";
import { logError } from "@/lib/observability/logger";

/** The props the page hands the Branding editor (the whole page). */
async function formProps(): Promise<any> {
  const tree: any = await BrandingPage();
  expect(tree.type).toBe(BrandingForm);
  return tree.props;
}

beforeEach(() => {
  H.limits = { removeBadge: false };
  H.storeIds = [];
});

describe("BrandingPage plan read", () => {
  it("passes the acting store's removeBadge to the form (Free keeps the badge)", async () => {
    const props = await formProps();
    expect(props.removeBadge).toBe(false);
    expect(props.canManage).toBe(true);
    expect(H.storeIds).toEqual(["store-1"]);
  });

  it("hands the editor the brand voice guide and answers, never the credit usage", async () => {
    const props = await formProps();
    expect(props.voice).toEqual({
      content: "Warm and plain.",
      structured: { sell: "Spices" },
    });
    expect(props.initial).toEqual({ name: "Acme Foods" });
  });

  it("passes true on a plan that removes the badge", async () => {
    H.limits = { removeBadge: true };
    expect((await formProps()).removeBadge).toBe(true);
  });

  it("★ a failed plan read costs the hint its plan, never the page", async () => {
    H.limits = null;
    const props = await formProps();
    expect(props.removeBadge).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "branding: plan read failed",
      expect.anything(),
      { storeId: "store-1" },
    );
  });
});
