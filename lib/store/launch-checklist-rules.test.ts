import { describe, expect, it } from "vitest";
import { STORE_POLICIES } from "@/lib/legal/store-policies";
import {
  LAUNCH_POLICY_SLUGS,
  evaluateLaunchChecklist,
  type LaunchChecklistItem,
  type LaunchFacts,
} from "./launch-checklist-rules";

const READY: LaunchFacts = {
  plan: "free",
  ownerPhoneVerified: true,
  themeChosen: true,
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

/** Nothing done: a store the minute signup finishes. */
const FRESH: LaunchFacts = {
  ...READY,
  ownerPhoneVerified: false,
  themeChosen: false,
  publishedProducts: 0,
  business: { name: false, address: false, email: false, phone: false },
  policies: {},
  shippingSaved: false,
};

const task = (items: LaunchChecklistItem[], key: string) => {
  const found = items.find((i) => i.key === key);
  if (!found) throw new Error(`no task ${key}`);
  return found;
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

  it("★ five required tasks, in the owner's order", () => {
    const c = evaluateLaunchChecklist(FRESH);
    expect(c.items.filter((i) => i.required).map((i) => i.key)).toEqual([
      "phone",
      "theme",
      "products",
      "business",
      "policies",
    ]);
    expect(c.requiredTotal).toBe(5);
    expect(c.requiredDone).toBe(0);
  });

  // ★★ Grouping must not drop a requirement: every predicate the nine-row
  // list enforced still holds the store closed on its own, and the refusal
  // still says which one.
  it("★★ every old predicate still blocks on its own and is named in `missing`", () => {
    const cases: [string, Partial<LaunchFacts>][] = [
      ["Verify your mobile number", { ownerPhoneVerified: false }],
      ["Choose your storefront theme", { themeChosen: false }],
      ["Add your first product", { publishedProducts: 0 }],
      [
        "Add your business and delivery details (Business details)",
        { business: { ...READY.business, name: false } },
      ],
      [
        "Add your business and delivery details (Business details)",
        { business: { ...READY.business, address: false } },
      ],
      [
        "Add your business and delivery details (Business details)",
        { business: { ...READY.business, email: false } },
      ],
      [
        "Add your business and delivery details (Business details)",
        { business: { ...READY.business, phone: false } },
      ],
      [
        "Add your business and delivery details (Delivery charges)",
        { shippingSaved: false },
      ],
      [
        "Publish your store policies (Terms & Conditions)",
        { policies: { ...READY.policies, terms: false } },
      ],
      [
        "Publish your store policies (Refund & Cancellation)",
        { policies: { ...READY.policies, "refund-policy": false } },
      ],
      [
        "Publish your store policies (Shipping)",
        { policies: { ...READY.policies, "shipping-policy": false } },
      ],
      [
        "Publish your store policies (Privacy)",
        { policies: { ...READY.policies, "privacy-policy": false } },
      ],
    ];
    for (const [label, patch] of cases) {
      const c = evaluateLaunchChecklist({ ...READY, ...patch });
      expect(c.ready, label).toBe(false);
      expect(c.missing, label).toEqual([label]);
      expect(c.requiredDone, label).toBe(4);
    }
  });

  it("a policy that is missing from the facts counts as unpublished", () => {
    const { "privacy-policy": _omit, ...rest } = READY.policies;
    void _omit;
    const c = evaluateLaunchChecklist({ ...READY, policies: rest });
    expect(c.missing).toEqual(["Publish your store policies (Privacy)"]);
  });

  it("★ a grouped refusal names every outstanding step, in order", () => {
    const c = evaluateLaunchChecklist({
      ...READY,
      policies: { terms: true, "shipping-policy": true },
    });
    expect(c.missing).toEqual([
      "Publish your store policies (Refund & Cancellation, Privacy)",
    ]);
    const fresh = evaluateLaunchChecklist(FRESH);
    expect(fresh.missing).toEqual([
      "Verify your mobile number",
      "Choose your storefront theme",
      "Add your first product",
      "Add your business and delivery details (Business details, Delivery charges)",
      "Publish your store policies (Terms & Conditions, Refund & Cancellation, Shipping, Privacy)",
    ]);
  });

  it("★ a grouped task is done only when every step is, and counts once", () => {
    const partly = evaluateLaunchChecklist({
      ...READY,
      policies: { ...READY.policies, terms: false },
      shippingSaved: false,
    });
    const policies = task(partly.items, "policies");
    expect(policies.done).toBe(false);
    expect(policies.steps?.map((s) => [s.key, s.done])).toEqual([
      ["policy:terms", false],
      ["policy:refund-policy", true],
      ["policy:shipping-policy", true],
      ["policy:privacy-policy", true],
    ]);
    const business = task(partly.items, "business");
    expect(business.done).toBe(false);
    expect(business.steps?.map((s) => [s.key, s.done])).toEqual([
      ["business:details", true],
      ["business:delivery", false],
    ]);
    // Two tasks outstanding, however many steps sit behind them.
    expect(partly.requiredDone).toBe(3);
    expect(partly.requiredTotal).toBe(5);
  });

  it("★ the theme task follows the pending flag and links to Storefront", () => {
    const pending = task(
      evaluateLaunchChecklist({ ...READY, themeChosen: false }).items,
      "theme",
    );
    expect(pending.done).toBe(false);
    expect(pending.required).toBe(true);
    expect(pending.href).toBe("/dashboard/storefront");
    expect(pending.action).toBe("Choose a theme");
    expect(pending.description).toMatch(/store in progress/);
    expect(task(evaluateLaunchChecklist(READY).items, "theme").done).toBe(true);
  });

  it("the business task's button goes to the first step still to do", () => {
    const fresh = task(evaluateLaunchChecklist(FRESH).items, "business");
    expect(fresh.href).toBe("/dashboard/billing");
    expect(fresh.action).toBe("Add business details");
    const detailsDone = task(
      evaluateLaunchChecklist({ ...READY, shippingSaved: false }).items,
      "business",
    );
    expect(detailsDone.href).toBe("/dashboard/settings/shipping");
    expect(detailsDone.action).toBe("Set delivery charges");
    // Each step keeps its own destination for the guide's per-step buttons.
    expect(fresh.steps?.map((s) => s.href)).toEqual([
      "/dashboard/billing",
      "/dashboard/settings/shipping",
    ]);
  });

  it("the four policies share one destination and one button", () => {
    const policies = task(evaluateLaunchChecklist(FRESH).items, "policies");
    expect(policies.href).toBe("/dashboard/settings/policies");
    expect(policies.action).toBe("Write policies");
    expect(new Set(policies.steps?.map((s) => s.href))).toEqual(
      new Set(["/dashboard/settings/policies"]),
    );
    expect(policies.steps?.map((s) => s.title)).toEqual([
      "Terms & Conditions",
      "Refund & Cancellation",
      "Shipping",
      "Privacy",
    ]);
  });

  it("★ the owner's mobile is the first required task and links to its form", () => {
    const c = evaluateLaunchChecklist({ ...READY, ownerPhoneVerified: false });
    const first = c.items.find((i) => i.required);
    expect(first?.key).toBe("phone");
    expect(first?.done).toBe(false);
    expect(first?.steps).toBeUndefined();
    // `focus=phone` opens the Security tab and the number form directly.
    expect(first?.href).toBe("/dashboard/settings/account?focus=phone");
    expect(c.missing).toEqual(["Verify your mobile number"]);
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

  it("recommended tasks are unchanged and say Storefront, not Themes", () => {
    const c = evaluateLaunchChecklist(READY);
    expect(c.items.filter((i) => !i.required).map((i) => i.key)).toEqual([
      "homepage",
      "logo",
      "samples",
      "payments",
      "gst",
      "domain",
    ]);
    for (const i of c.items) {
      expect(i.description, i.key).not.toMatch(/\bThemes\b/);
    }
    expect(task(c.items, "homepage").description).toMatch(/under Storefront/);
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
