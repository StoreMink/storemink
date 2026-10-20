import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import type { PageSectionItem } from "@/lib/sections/registry";
import type { MinkActorContext } from "./types";
import type {
  PersonalizationTarget,
  PersonalizationTargetPage,
} from "./storefront-personalization-context";
import type { PersonalizationWriterInput } from "./storefront-personalization-writer";

const STORE = "11111111-1111-4111-8111-111111111111";
const BUCKET = "https://storage.googleapis.com/storemink-media";

const holder = vi.hoisted(() => ({
  target: null as unknown as PersonalizationTarget,
  toolEnabled: true,
  rateAllowed: [] as boolean[],
  writer: vi.fn(),
  generate: vi.fn(),
  upload: vi.fn(),
  deletePaths: vi.fn(),
  inserted: [] as unknown[],
  deleted: 0,
  createDraft: vi.fn(),
  owned: vi.fn(),
  uuid: 0,
  claim: vi.fn(),
  release: vi.fn(),
  /** A section id whose changed version fails publish validation. */
  failSection: null as string | null,
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (work: (db: unknown) => unknown) =>
    work({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ enabled: holder.toolEnabled }],
          }),
        }),
      }),
      execute: async () => ({
        rows: [
          {
            allowed: holder.rateAllowed.length
              ? holder.rateAllowed.shift()
              : true,
          },
        ],
      }),
      insert: () => ({
        values: async (row: unknown) => {
          holder.inserted.push(row);
        },
      }),
      delete: () => ({
        where: async () => {
          holder.deleted += 1;
        },
      }),
    }),
  ),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsUploadObject: holder.upload,
  gcsDeletePaths: holder.deletePaths,
}));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("./config", () => ({
  getMinkConfig: () => ({
    projectId: "project",
    location: "global",
    model: "gemini-3.7-flash",
    fallbackModel: "gemini-3.5-flash",
    fallbackLocation: "asia-south1",
    imageModel: "gemini-3.1-flash-image",
    imageLocation: "global",
  }),
}));
vi.mock("./drafts", () => ({ createMinkDraftProposal: holder.createDraft }));
vi.mock("./media-generation", () => ({
  generateMinkMediaImage: holder.generate,
}));
vi.mock("./storefront-media-read", () => ({
  readOwnedStorefrontImageUrls: holder.owned,
}));
vi.mock("./storefront-personalization-writer", () => ({
  writePersonalizationCopy: holder.writer,
}));
vi.mock("./spend-limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./spend-limits")>()),
  claimSpendLimits: holder.claim,
  releaseSpendLimits: holder.release,
}));
vi.mock("@/lib/sections/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sections/registry")>();
  return {
    ...real,
    // ★ One section's NEW version fails the publish bar, the way a rewrite
    //   that broke a section's rules does; its original passes.
    validateSections: vi.fn(
      (sections: unknown, options?: { mode?: string }) => {
        if (options?.mode === "publish" && holder.failSection) {
          const list = sections as PageSectionItem[];
          const index = list.findIndex(
            (entry) => entry.id === holder.failSection,
          );
          const original = holder.target.pages
            .flatMap((entry) => entry.sections)
            .find((entry) => entry.id === holder.failSection);
          if (index >= 0 && list[index] !== original) {
            return { error: `Section ${index + 1}: the heading is too long.` };
          }
        }
        return real.validateSections(
          sections as Parameters<typeof real.validateSections>[0],
          options as Parameters<typeof real.validateSections>[1],
        );
      },
    ),
  };
});
vi.mock("./storefront-personalization-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./storefront-personalization-context")
  >()),
  readPersonalizationTarget: vi.fn(async () => holder.target),
}));

import { createMinkStorefrontPersonalizationProposal } from "./storefront-personalization-proposals";

const actor: MinkActorContext = {
  storeId: STORE,
  adminId: "owner",
  email: null,
  roleSlug: "superadmin",
  permissions: {},
  isSuperadmin: true,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request",
  draftingEnabled: true,
  runId: "22222222-2222-4222-8222-222222222222",
};

function page(
  slug: string,
  sections: PageSectionItem[],
  extra: Partial<PersonalizationTargetPage> = {},
): PersonalizationTargetPage {
  return {
    id: `33333333-3333-4333-8333-${String(slug.length).padStart(12, "0")}`,
    slug,
    title: slug === "home" ? "Home" : slug,
    status: "published",
    updatedAt: "2026-10-20 10:00:00.123456+00",
    sections,
    sectionsDigest: "d".repeat(64),
    edited: false,
    // Fixtures are the theme's own pages unless a test says otherwise.
    themeSectionIds: sections.map((section) => section.id),
    skipped: null,
    ...extra,
  };
}

function target(
  overrides: Partial<PersonalizationTarget> = {},
): PersonalizationTarget {
  return {
    storeId: STORE,
    storeName: "Lumen",
    themeName: "Basket",
    themeDesign: null,
    pages: [
      page("home", [
        {
          id: "hero",
          type: "hero",
          enabled: true,
          config: {
            variant: "banner",
            heading: "Fresh produce, delivered",
            image_url: "/themes/basket/hero.webp",
          } as never,
        },
        {
          id: "quotes",
          type: "testimonials",
          enabled: true,
          config: {
            heading: "Loved",
            items: [{ quote: "Great", name: "A" }],
          } as never,
        },
      ]),
      page("about", [
        {
          id: "story",
          type: "media_text",
          enabled: true,
          config: {
            heading: "Our grocery story",
            body: "We pick fruit daily.",
            image_url: "/themes/basket/story.webp",
            media_ratio: "portrait",
          } as never,
        },
      ]),
      page("terms", [], { skipped: "policy" }),
    ],
    chrome: {
      rowExists: true,
      version: "2026-10-20 10:00:00+00",
      value: {
        ...DEFAULT_CHROME,
        header: {
          ...DEFAULT_CHROME.header,
          announcement: {
            enabled: true,
            text: "Free delivery over Rs 499",
            href: "",
          },
        },
      },
      designDigest: "e".repeat(64),
      textDigest: "f".repeat(64),
    },
    brand: { tagline: "Fresh groceries", blurb: null, digest: "a".repeat(64) },
    categories: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Fruit",
        slug: "fruit",
        description: null,
        imageUrl: "/themes/basket/fruit.webp",
        status: "active",
        updatedAt: "2026-10-20 10:00:00+00",
        sample: true,
        productCount: 0,
      },
    ],
    sampleProducts: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        name: "Apples (Sample)",
        slug: "apples-sample",
        status: "published",
        updatedAt: "2026-10-20 10:00:00+00",
      },
    ],
    facts: {
      delivery: "3 to 5 days",
      freeDeliveryAbove: null,
      returns: null,
      pickup: false,
      onlinePayments: true,
      cashOnDelivery: true,
    },
    headroom: { period: "2026-10", planCap: null, remaining: null },
    photos: { allowed: true, reason: null },
    ...overrides,
  };
}

/** A writer that rewrites every field it is offered and describes every photo. */
function fakeWriter(input: PersonalizationWriterInput) {
  return {
    texts: new Map(
      input.pages.flatMap((entry) =>
        entry.texts.map((text) => [
          text.ref,
          `Candle ${text.label.toLowerCase()}`,
        ]),
      ),
    ),
    lists: new Map(),
    photos: new Map(
      input.photos.map((entry) => [
        entry.ref,
        {
          scene: "Amber soy candles on linen in soft light",
          alt: "Amber candles",
        },
      ]),
    ),
    chrome: {
      announcement: "Free shipping over Rs 999",
      tagline: "Candles for slow evenings",
    },
    categoryDescriptions: new Map(),
    model: "gemini-3.7-flash",
    attempts: 1,
  };
}

const args = (extra: Record<string, unknown> = {}) => ({
  brief: {
    what_you_sell: "Hand-poured soy candles",
    look_and_feel: "Warm and calm",
  },
  unpublish_sample_products: true,
  explanation: "Makes the store about candles.",
  ...extra,
});

beforeEach(() => {
  holder.target = target();
  holder.toolEnabled = true;
  holder.rateAllowed = [];
  holder.failSection = null;
  holder.claim.mockReset();
  holder.claim.mockResolvedValue({ ok: true });
  holder.release.mockReset();
  holder.release.mockResolvedValue(undefined);
  holder.inserted = [];
  holder.deleted = 0;
  holder.uuid = 0;
  holder.writer.mockImplementation(async (input: PersonalizationWriterInput) =>
    fakeWriter(input),
  );
  holder.generate.mockImplementation(async () => ({
    bytes: Buffer.from("jpeg"),
    mimeType: "image/jpeg",
  }));
  holder.upload.mockImplementation(async (path: string) => `${BUCKET}/${path}`);
  holder.deletePaths.mockResolvedValue([]);
  holder.owned.mockImplementation(
    async (_store: string, urls: string[]) => urls,
  );
  holder.createDraft.mockImplementation(
    async (input: Record<string, unknown>) => ({
      type: "proposal",
      draftId: "66666666-6666-4666-8666-666666666666",
      title: input.title,
      expectedCredits: input.expectedCredits,
      chargedCredits: input.expectedCredits,
      creditSource: "plan",
    }),
  );
});

function storedPlan() {
  const call = holder.createDraft.mock.calls.at(-1)![0] as {
    content: { plan_json: string };
    expectedCredits: number;
  };
  return {
    plan: JSON.parse(call.content.plan_json),
    expectedCredits: call.expectedCredits,
  };
}

describe("a storefront personalisation proposal", () => {
  it("★★ rewrites every page but the policy, draws the theme's photos and charges for what it made", async () => {
    const artifact = await createMinkStorefrontPersonalizationProposal({
      actor,
      args: args(),
    });
    expect(artifact.type).toBe("storefront_personalization_proposal");
    expect(artifact.pages.map((entry) => entry.slug)).toEqual([
      "home",
      "about",
    ]);
    expect(artifact.photos).toHaveLength(2);
    expect(
      artifact.photos.every((entry) => entry.url.includes("/mink-generated/")),
    ).toBe(true);
    expect(artifact.products).toEqual([{ name: "Apples (Sample)" }]);
    expect(artifact.live).toEqual([
      "Theme sample products taken off the shop",
      "Your store's tagline and footer description",
    ]);
    // Two pages, two photos, header/footer text: 3 + 3 + 3 + 3 + 2.
    const { plan, expectedCredits } = storedPlan();
    expect(expectedCredits).toBe(14);
    expect(plan.credits.total).toBe(14);
    const home = plan.pages.find(
      (entry: { slug: string }) => entry.slug === "home",
    );
    expect(home.hidden).toEqual([
      expect.objectContaining({ sectionId: "quotes" }),
    ]);
    const hero = home.sections.find(
      (entry: { id: string }) => entry.id === "hero",
    );
    expect(hero.config.heading).toBe("Candle heading");
    expect(hero.config.image_url).toMatch(/\/mink-generated\/.+\.jpg$/);
    // ★ Every photo was saved as the store's own media before validation.
    expect(holder.inserted).toHaveLength(2);
    expect(holder.writer.mock.calls[0][0].brief.language).toBe("English");
  });

  it("★★ never touches a photo the merchant uploaded", async () => {
    const own = `${BUCKET}/stores/${STORE}/uploads/my-shop.webp`;
    holder.target = target();
    (
      holder.target.pages[0].sections[0].config as unknown as Record<
        string,
        unknown
      >
    ).image_url = own;
    await createMinkStorefrontPersonalizationProposal({ actor, args: args() });
    const { plan } = storedPlan();
    const hero = plan.pages[0].sections.find(
      (entry: { id: string }) => entry.id === "hero",
    );
    expect(hero.config.image_url).toBe(own);
    expect(holder.generate).toHaveBeenCalledTimes(1);
  });

  it("refuses before any paid call when the tool is switched off", async () => {
    holder.toolEnabled = false;
    await expect(
      createMinkStorefrontPersonalizationProposal({ actor, args: args() }),
    ).rejects.toThrow(/has not enabled storefront personalisation/);
    expect(holder.writer).not.toHaveBeenCalled();
    expect(holder.generate).not.toHaveBeenCalled();
  });

  it("refuses an unconfirmed category change before anything is paid for", async () => {
    await expect(
      createMinkStorefrontPersonalizationProposal({
        actor,
        args: args({ categories: [{ action: "hide", slug: "fruit" }] }),
      }),
    ).rejects.toThrow(/ask the merchant/);
    expect(holder.writer).not.toHaveBeenCalled();
  });

  it("refuses a category the store does not have", async () => {
    await expect(
      createMinkStorefrontPersonalizationProposal({
        actor,
        args: args({
          categories: [
            { action: "hide", slug: "dairy", merchant_confirmed: true },
          ],
        }),
      }),
    ).rejects.toThrow(/There is no category "dairy"/);
  });

  it("refuses a new look when the store's look changed since it was read", async () => {
    await expect(
      createMinkStorefrontPersonalizationProposal({
        actor,
        args: args({
          design: { expected_design_digest: "0".repeat(64), palette: {} },
        }),
      }),
    ).rejects.toThrow(/look changed since you read it/);
  });

  it("★ buys the homepage first when credits run short and says what was left", async () => {
    holder.target = target({
      headroom: { period: "2026-10", planCap: 20, remaining: 3 },
    });
    await createMinkStorefrontPersonalizationProposal({ actor, args: args() });
    const { plan, expectedCredits } = storedPlan();
    expect(expectedCredits).toBe(3);
    expect(plan.pages.map((entry: { slug: string }) => entry.slug)).toEqual([
      "home",
    ]);
    expect(plan.photos).toEqual([]);
    expect(plan.skipped.map((note: { label: string }) => note.label)).toEqual(
      expect.arrayContaining(["about", "2 more photos"]),
    );
  });

  it("refuses when not even the homepage fits", async () => {
    holder.target = target({
      headroom: { period: "2026-10", planCap: 20, remaining: 1 },
    });
    await expect(
      createMinkStorefrontPersonalizationProposal({ actor, args: args() }),
    ).rejects.toThrow(/enough Mink credits/);
    expect(holder.writer).not.toHaveBeenCalled();
  });

  it("keeps the theme's photos and charges nothing for them when the day's photo limit is reached", async () => {
    // The attempt is claimed, the photos are not.
    holder.claim.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({
      ok: false,
      refusedKey: `mink-personalize-images:${STORE}`,
    });
    await createMinkStorefrontPersonalizationProposal({ actor, args: args() });
    const { plan } = storedPlan();
    expect(plan.photos).toEqual([]);
    expect(plan.credits.photos).toBe(0);
    expect(holder.generate).not.toHaveBeenCalled();
  });

  it("★★ claims the photos after the writer, only for the ones it described, together with the platform's hour", async () => {
    holder.writer.mockImplementation(
      async (input: PersonalizationWriterInput) => {
        const answer = fakeWriter(input);
        // One scene does not come back.
        answer.photos.delete(input.photos[1].ref);
        return answer;
      },
    );
    await createMinkStorefrontPersonalizationProposal({ actor, args: args() });
    expect(holder.claim).toHaveBeenCalledTimes(2);
    const photoClaim = holder.claim.mock.calls[1][0] as Array<{
      key: string;
      cost?: number;
    }>;
    expect(photoClaim).toEqual([
      expect.objectContaining({
        key: `mink-personalize-images:${STORE}`,
        cost: 1,
      }),
      expect.objectContaining({ key: "mink-image-global", cost: 1 }),
    ]);
    // ★ The writer ran before the photos were claimed.
    expect(holder.writer.mock.invocationCallOrder[0]).toBeLessThan(
      holder.claim.mock.invocationCallOrder[1],
    );
    expect(holder.generate).toHaveBeenCalledTimes(1);
  });

  it("★ refuses a second personalisation while the first is still running, and says so", async () => {
    holder.claim.mockResolvedValueOnce({
      ok: false,
      refusedKey: `mink-personalize-running:${STORE}:owner`,
    });
    await expect(
      createMinkStorefrontPersonalizationProposal({ actor, args: args() }),
    ).rejects.toMatchObject({
      code: "personalization_rate_limit",
      status: 429,
      message: expect.stringMatching(/already personalising/),
    });
    expect(holder.writer).not.toHaveBeenCalled();
    // Nothing was claimed, so nothing is given back.
    expect(holder.release).not.toHaveBeenCalled();
  });

  it("names the day's limit when that is what refused", async () => {
    holder.claim.mockResolvedValueOnce({
      ok: false,
      refusedKey: `mink-personalize-store:${STORE}`,
    });
    await expect(
      createMinkStorefrontPersonalizationProposal({ actor, args: args() }),
    ).rejects.toThrow(/six personalised storefront cards today/);
  });

  it("★★ a failed attempt gives back its claims, so a retry is not refused", async () => {
    holder.writer.mockRejectedValueOnce(new Error("writer busy"));
    await expect(
      createMinkStorefrontPersonalizationProposal({ actor, args: args() }),
    ).rejects.toThrow(/writer busy/);
    expect(holder.release).toHaveBeenCalledWith([
      expect.objectContaining({
        key: `mink-personalize-running:${STORE}:owner`,
      }),
      expect.objectContaining({ key: `mink-personalize-store:${STORE}` }),
    ]);
    // ★ No photo was claimed before the writer failed.
    expect(holder.claim).toHaveBeenCalledTimes(1);
  });

  it("★ a card that was made keeps the day's count and gives back only the running claim", async () => {
    await createMinkStorefrontPersonalizationProposal({ actor, args: args() });
    expect(holder.release).toHaveBeenCalledWith([
      expect.objectContaining({
        key: `mink-personalize-running:${STORE}:owner`,
      }),
    ]);
  });

  it("★★ a photo in a section put back to the theme's version is neither charged, listed nor kept", async () => {
    // About keeps one surviving change (its intro), so the page is stored
    // while the section holding the new photo goes back to the theme's.
    const about = holder.target.pages.find((entry) => entry.slug === "about")!;
    about.sections = [
      {
        id: "intro",
        type: "rich_text",
        enabled: true,
        config: { html: "<p>We pick fruit daily.</p>" } as never,
      },
      ...about.sections,
    ];
    about.themeSectionIds = about.sections.map((entry) => entry.id);
    holder.failSection = "story";
    await createMinkStorefrontPersonalizationProposal({ actor, args: args() });
    const { plan } = storedPlan();
    const stored = plan.pages.find(
      (entry: { slug: string }) => entry.slug === "about",
    );
    // Only the intro's rewrite counts: the story's went back with it.
    expect(stored.textChanges).toBe(1);
    expect(stored.photoChanges).toBe(0);
    expect(
      stored.sections.find((entry: { id: string }) => entry.id === "story")
        .config.image_url,
    ).toBe("/themes/basket/story.webp");
    expect(plan.photos).toHaveLength(1);
    expect(plan.credits.photos).toBe(3);
    // Its picture was drawn, never used, and is removed from Media.
    expect(holder.generate).toHaveBeenCalledTimes(2);
    expect(holder.deletePaths).toHaveBeenCalledWith([
      expect.stringMatching(/^stores\/.+\/mink-generated\//),
    ]);
  });

  it("★ a photo the image service refused keeps the theme's picture and is not charged", async () => {
    holder.generate
      .mockResolvedValueOnce({
        bytes: Buffer.from("jpeg"),
        mimeType: "image/jpeg",
      })
      .mockRejectedValueOnce(new Error("provider down"));
    await createMinkStorefrontPersonalizationProposal({ actor, args: args() });
    const { plan } = storedPlan();
    expect(plan.credits.photos).toBe(3);
    expect(
      plan.skipped.some((note: { reason: string }) =>
        /Nothing was charged/.test(note.reason),
      ),
    ).toBe(true);
  });

  it("★★ removes the photos it made when the proposal cannot be stored", async () => {
    holder.createDraft.mockRejectedValueOnce(new Error("database down"));
    await expect(
      createMinkStorefrontPersonalizationProposal({ actor, args: args() }),
    ).rejects.toThrow(/database down/);
    expect(holder.deleted).toBe(1);
    expect(holder.deletePaths).toHaveBeenCalledWith([
      expect.stringMatching(/^stores\/.+\/mink-generated\//),
      expect.stringMatching(/^stores\/.+\/mink-generated\//),
    ]);
  });

  it("★ a photos-only pass changes no words and charges only for photos", async () => {
    await createMinkStorefrontPersonalizationProposal({
      actor,
      args: args({ unpublish_sample_products: false, photos_only: true }),
    });
    const { plan, expectedCredits } = storedPlan();
    expect(expectedCredits).toBe(6);
    expect(plan.chrome).toBeNull();
    expect(plan.brand).toBeNull();
    expect(plan.products).toEqual([]);
    const hero = plan.pages[0].sections.find(
      (entry: { id: string }) => entry.id === "hero",
    );
    expect(hero.config.heading).toBe("Fresh produce, delivered");
    expect(hero.config.image_url).toMatch(/\/mink-generated\//);
    // The writer is still asked to describe the photos, with no text fields.
    const writerInput = holder.writer.mock
      .calls[0][0] as PersonalizationWriterInput;
    // ★ Every page holding a bought photo is listed, so its scene is asked for.
    expect(writerInput.pages.map((entry) => entry.pageSlug)).toEqual([
      "home",
      "about",
    ]);
    expect(writerInput.pages.every((entry) => entry.texts.length === 0)).toBe(
      true,
    );
    expect(writerInput.photos).toHaveLength(2);
  });

  it("★ asks for an English address when a new category's name has none", async () => {
    await expect(
      createMinkStorefrontPersonalizationProposal({
        actor,
        args: args({
          categories: [
            { action: "create", name: "मिठाई", merchant_confirmed: true },
          ],
        }),
      }),
    ).rejects.toThrow(/cannot be made from the name "मिठाई"/);
    expect(holder.writer).not.toHaveBeenCalled();
  });

  it("says there is nothing left when a photos-only pass finds no theme photos", async () => {
    holder.target = target();
    for (const entry of holder.target.pages) {
      for (const sectionItem of entry.sections) {
        const config = sectionItem.config as unknown as Record<string, unknown>;
        if (config.image_url)
          config.image_url = `${BUCKET}/stores/${STORE}/mink-generated/x.jpg`;
      }
    }
    await expect(
      createMinkStorefrontPersonalizationProposal({
        actor,
        args: args({ unpublish_sample_products: false, photos_only: true }),
      }),
    ).rejects.toThrow(/no theme photos left/);
  });
});
