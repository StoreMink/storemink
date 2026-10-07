import { describe, expect, it } from "vitest";
import { STORE_POLICIES } from "@/lib/legal/store-policies";
import {
  LAUNCH_POLICY_SLUGS,
  evaluateLaunchChecklist,
  type LaunchFacts,
} from "./launch-checklist-rules";

const READY: LaunchFacts = {
  plan: "free",
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
};

describe("evaluateLaunchChecklist", () => {
  it("★ a Free store with the required items done is ready, whatever it skipped", () => {
    const c = evaluateLaunchChecklist(READY);
    expect(c.ready).toBe(true);
    expect(c.missing).toEqual([]);
    expect(c.requiredDone).toBe(c.requiredTotal);
    // Recommended items are visible but never block.
    expect(
      c.items.filter((i) => !i.required && !i.done).length,
    ).toBeGreaterThan(0);
  });

  it("every required fact blocks on its own and is named in `missing`", () => {
    const cases: [string, Partial<LaunchFacts>][] = [
      ["Add your first product", { publishedProducts: 0 }],
      [
        "Complete your business details",
        { business: { ...READY.business, address: false } },
      ],
      [
        "Complete your business details",
        { business: { ...READY.business, phone: false } },
      ],
      [
        "Publish your Refund & Cancellation Policy",
        { policies: { ...READY.policies, "refund-policy": false } },
      ],
      [
        "Publish your Privacy Policy",
        { policies: { ...READY.policies, "privacy-policy": false } },
      ],
      ["Set your delivery charges", { shippingSaved: false }],
    ];
    for (const [title, patch] of cases) {
      const c = evaluateLaunchChecklist({ ...READY, ...patch });
      expect(c.ready, title).toBe(false);
      expect(c.missing, title).toContain(title);
    }
  });

  it("theme samples never count as a published product", () => {
    const c = evaluateLaunchChecklist({
      ...READY,
      publishedProducts: 0,
      sampleProducts: 12,
    });
    expect(c.ready).toBe(false);
    expect(c.items.find((i) => i.key === "samples")?.done).toBe(false);
  });

  it("payments and domain point at Plans on a plan that lacks them, and never block", () => {
    const free = evaluateLaunchChecklist(READY);
    expect(free.items.find((i) => i.key === "payments")?.href).toBe(
      "/dashboard/plans",
    );
    expect(free.items.find((i) => i.key === "domain")?.href).toBe(
      "/dashboard/plans",
    );
    const pro = evaluateLaunchChecklist({ ...READY, plan: "pro" });
    expect(pro.items.find((i) => i.key === "payments")?.href).toBe(
      "/dashboard/channels",
    );
    expect(pro.items.find((i) => i.key === "domain")?.href).toBe(
      "/dashboard/settings/domain",
    );
    expect(pro.items.find((i) => i.key === "payments")?.required).toBe(false);
  });

  it("★ the policy list is exactly the Settings → Policies registry", () => {
    // The rules module does not import the registry (to stay dependency-free),
    // so this is the guard that keeps the two from drifting apart.
    expect([...LAUNCH_POLICY_SLUGS].sort()).toEqual(
      STORE_POLICIES.map((p) => p.slug).sort(),
    );
  });
});
