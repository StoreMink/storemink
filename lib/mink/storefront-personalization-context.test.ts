import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import { DEFAULT_CHROME } from "@/lib/chrome/types";
import type { PageSectionItem } from "@/lib/sections/registry";
import type { MinkActorContext } from "./types";
import {
  assertBuilderAccess,
  eligiblePages,
  summarizePersonalizationTarget,
  type PersonalizationTarget,
  type PersonalizationTargetPage,
} from "./storefront-personalization-context";

function page(
  slug: string,
  extra: Partial<PersonalizationTargetPage> = {},
  sections: PageSectionItem[] = [],
): PersonalizationTargetPage {
  return {
    id: slug,
    slug,
    title: slug,
    status: "published",
    updatedAt: "2026-10-20 10:00:00+00",
    sections,
    sectionsDigest: "d".repeat(64),
    edited: false,
    skipped: null,
    ...extra,
  };
}

const hero: PageSectionItem = {
  id: "hero",
  type: "hero",
  enabled: true,
  config: {
    heading: "Fresh produce",
    image_url: "/themes/basket/hero.webp",
  } as never,
};

function target(
  overrides: Partial<PersonalizationTarget> = {},
): PersonalizationTarget {
  return {
    storeId: "store",
    storeName: "Lumen",
    themeName: "Basket",
    themeDesign: null,
    pages: [
      page("home", { edited: true }, [hero]),
      page("about", { edited: true }),
      page("faqs"),
      page("terms", { skipped: "policy" }),
      page("broken", { skipped: "invalid" }),
    ],
    chrome: {
      rowExists: true,
      version: null,
      value: DEFAULT_CHROME,
      designDigest: "e".repeat(64),
      textDigest: "f".repeat(64),
    },
    brand: { tagline: null, blurb: null, digest: "a".repeat(64) },
    categories: [],
    sampleProducts: [],
    facts: {
      delivery: null,
      freeDeliveryAbove: null,
      returns: null,
      pickup: false,
      onlinePayments: false,
      cashOnDelivery: true,
    },
    headroom: { period: "2026-10", planCap: 20, remaining: 14 },
    photos: { allowed: true, reason: null },
    ...overrides,
  };
}

describe("which pages a personalisation writes", () => {
  it("★ always the homepage, and other pages only while they are still the theme's", () => {
    expect(eligiblePages(target(), null).map((entry) => entry.slug)).toEqual([
      "home",
      "faqs",
    ]);
  });

  it("an edited page only when it is named, and never a policy", () => {
    expect(
      eligiblePages(target(), ["about", "terms"]).map((entry) => entry.slug),
    ).toEqual(["about"]);
  });

  it("★ a photos-only pass covers every writable page by default", () => {
    expect(
      eligiblePages(target(), null, { photosOnly: true }).map(
        (entry) => entry.slug,
      ),
    ).toEqual(["home", "about", "faqs"]);
  });
});

describe("the interview summary the model reads", () => {
  it("★★ never carries a credit figure", () => {
    const summary = summarizePersonalizationTarget(target());
    expect(JSON.stringify(summary)).not.toMatch(
      /credit|remaining|planCap|headroom/i,
    );
    expect(summary.photos).toMatchObject({
      themePhotoSlots: 1,
      newPhotosThisTime: 1,
      available: true,
    });
  });

  it("names the pages it will never change and why", () => {
    const summary = summarizePersonalizationTarget(target());
    expect(summary.neverChanged).toEqual([
      expect.objectContaining({
        slug: "terms",
        reason: expect.stringMatching(/policy/),
      }),
      expect.objectContaining({ slug: "broken" }),
    ]);
    expect(summary.pages.find((entry) => entry.slug === "about")).toMatchObject(
      {
        editedByMerchant: true,
        includedByDefault: false,
      },
    );
  });

  it("says when not every photo fits", () => {
    const summary = summarizePersonalizationTarget(
      target({ headroom: { period: "2026-10", planCap: 20, remaining: 3 } }),
    );
    expect(summary.photos.newPhotosThisTime).toBe(0);
    expect(summary.photos).toHaveProperty("note");
  });
});

describe("who may personalise", () => {
  const actor = (
    permissions: Record<string, string[]>,
    draftingEnabled = true,
  ) =>
    ({
      storeId: "store",
      adminId: "admin",
      email: null,
      roleSlug: "member",
      permissions,
      isSuperadmin: false,
      effectivePlan: "pro",
      locationIds: null,
      analyticsTimeZone: "Asia/Kolkata",
      currency: "INR",
      defaultLowStockThreshold: 5,
      requestId: "request",
      draftingEnabled,
    }) as MinkActorContext;

  it("needs Website Builder manage, and drafting, to propose", () => {
    expect(() =>
      assertBuilderAccess(actor({ builder: ["view", "manage"] }), "manage"),
    ).not.toThrow();
    expect(() =>
      assertBuilderAccess(actor({ builder: ["view"] }), "manage"),
    ).toThrow(/manage permission/);
    expect(() =>
      assertBuilderAccess(
        actor({ builder: ["view", "manage"] }, false),
        "manage",
      ),
    ).toThrow(/drafting/);
    expect(() => assertBuilderAccess(actor({}), "view")).toThrow(
      /Website Builder access/,
    );
  });
});
