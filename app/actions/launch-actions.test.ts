import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchFacts } from "@/lib/store/launch-checklist-rules";

vi.mock("next/cache", () => ({ updateTag: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn(async () => []) }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerContext: vi.fn(async () => null),
  isStoreSuperadmin: vi.fn(async () => true),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: vi.fn(async () => undefined),
}));
vi.mock("@/lib/site", () => ({
  getStoreUrl: vi.fn(async () => "https://acme.storemink.com"),
}));
vi.mock("@/lib/request-url", () => ({
  getRequestOrigin: vi.fn(async () => null),
}));
// The predicates stay REAL (isStoreLaunched, isThemePending): the point is
// that the action judges the actual store row. Only the write is stubbed.
vi.mock("@/lib/store/launch", async () => {
  const state = await vi.importActual<
    typeof import("@/lib/store/launch-state")
  >("@/lib/store/launch-state");
  return { ...state, markStoreLaunched: vi.fn(async () => undefined) };
});
vi.mock("@/lib/store/resolve", () => ({
  STORE_TAG: "stores",
  getCurrentStore: vi.fn(),
  lookupStoreById: vi.fn(),
}));
vi.mock("@/lib/store/storefront-access", () => ({
  getOrCreateStorefrontPassword: vi.fn(async () => ({ password: "bsjchm49" })),
  rotateStorefrontPassword: vi.fn(async () => ({ password: "newpass22" })),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
// ★ The facts reader hits the database; this stand-in mirrors its theme fact
// and runs the REAL rules, so these tests prove what go-live refuses for a
// given set of facts. The reader's own `themeChosen` line is pinned against
// real code in lib/store/launch-checklist.test.ts, not by this copy.
const factPatch = vi.hoisted(() => ({
  current: {} as Partial<LaunchFacts>,
}));
vi.mock("@/lib/store/launch-checklist", async () => {
  const rules = await vi.importActual<
    typeof import("@/lib/store/launch-checklist-rules")
  >("@/lib/store/launch-checklist-rules");
  const state = await vi.importActual<
    typeof import("@/lib/store/launch-state")
  >("@/lib/store/launch-state");
  return {
    buildLaunchChecklist: vi.fn(
      async (store: { settings?: Record<string, unknown> }) =>
        rules.evaluateLaunchChecklist({
          plan: "free",
          ownerPhoneVerified: true,
          themeChosen: !state.isThemePending(store),
          publishedProducts: 1,
          sampleProducts: 0,
          business: { name: true, address: true, email: true, phone: true },
          policies: {
            terms: true,
            "refund-policy": true,
            "shipping-policy": true,
            "privacy-policy": true,
          },
          shippingSaved: true,
          homepageEdited: false,
          logo: false,
          paymentsConnected: false,
          gstin: false,
          customDomainLive: false,
          ...factPatch.current,
        }),
    ),
  };
});

import { updateTag } from "next/cache";
import { isStoreSuperadmin } from "@/app/dashboard/lib/access";
import { emitEvent } from "@/lib/notifications/record";
import { markStoreLaunched } from "@/lib/store/launch";
import { buildLaunchChecklist } from "@/lib/store/launch-checklist";
import { getCurrentStore, lookupStoreById } from "@/lib/store/resolve";
import { launchStore } from "./launch-actions";

type StoreRow = Awaited<ReturnType<typeof getCurrentStore>>;
const store = (settings: Record<string, unknown>) =>
  ({ id: "store-1", name: "Acme", settings }) as unknown as StoreRow;

describe("launchStore", () => {
  beforeEach(() => {
    factPatch.current = {};
    vi.mocked(getCurrentStore).mockResolvedValue(store({ launched: false }));
    vi.mocked(lookupStoreById).mockResolvedValue(store({ launched: true }));
  });

  it("only the store owner can open the store", async () => {
    vi.mocked(isStoreSuperadmin).mockResolvedValueOnce(false);
    const res = await launchStore();
    expect(res.error).toMatch(/Only the store owner/);
    expect(buildLaunchChecklist).not.toHaveBeenCalled();
    expect(markStoreLaunched).not.toHaveBeenCalled();
  });

  it("★ refuses while no theme has been chosen, and names the task", async () => {
    vi.mocked(getCurrentStore).mockResolvedValue(
      store({ launched: false, themePending: true }),
    );
    const res = await launchStore();
    expect(res.success).toBeUndefined();
    expect(res.error).toBe("Finish the required steps before going live.");
    expect(res.missing).toEqual(["Choose your storefront theme"]);
    expect(markStoreLaunched).not.toHaveBeenCalled();
    expect(updateTag).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  // ★★ Five grouped tasks on screen, every predicate still enforced here.
  it("★★ every underlying predicate still refuses go-live on its own", async () => {
    const cases: [Partial<LaunchFacts>, string][] = [
      [{ ownerPhoneVerified: false }, "Verify your mobile number"],
      [{ publishedProducts: 0 }, "Add your first product"],
      [
        {
          business: { name: true, address: false, email: true, phone: true },
        },
        "Add your business and delivery details (Business details)",
      ],
      [
        { shippingSaved: false },
        "Add your business and delivery details (Delivery charges)",
      ],
      [
        { policies: { terms: true, "shipping-policy": true } },
        "Publish your store policies (Refund & Cancellation, Privacy)",
      ],
    ];
    for (const [patch, label] of cases) {
      factPatch.current = patch;
      const res = await launchStore();
      expect(res.missing, label).toEqual([label]);
    }
    expect(markStoreLaunched).not.toHaveBeenCalled();
  });

  it("opens a store with every required task done and a theme chosen", async () => {
    const res = await launchStore();
    expect(res).toEqual({
      success: true,
      storeUrl: "https://acme.storemink.com",
    });
    expect(markStoreLaunched).toHaveBeenCalledWith("store-1");
    expect(updateTag).toHaveBeenCalledWith("stores");
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "store.launched", storeId: "store-1" }),
    );
  });

  it("a store with no themePending key (every existing store) is not held back", async () => {
    vi.mocked(getCurrentStore).mockResolvedValue(store({ launched: false }));
    const res = await launchStore();
    expect(res.success).toBe(true);
  });

  it("an already-open store answers success without re-running the checklist", async () => {
    vi.mocked(getCurrentStore).mockResolvedValue(store({ launched: true }));
    const res = await launchStore();
    expect(res.success).toBe(true);
    expect(buildLaunchChecklist).not.toHaveBeenCalled();
    expect(markStoreLaunched).not.toHaveBeenCalled();
  });
});
