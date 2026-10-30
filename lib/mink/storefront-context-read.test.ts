import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { withService } from "@/lib/db/client";
import {
  buildBlockedMediaSet,
  maskBlockedMedia,
  type BlockedMediaSet,
} from "@/lib/moderation/blocked-objects";
import { blockedItemIds } from "@/lib/moderation/merchant";
import { PLACEHOLDER_URL_PATH } from "@/lib/moderation/placeholder";
import type { MinkActorContext } from "./types";
import {
  readMinkStorefrontDesignContext,
  readMinkStorefrontPageContext,
  readMinkStorefrontPages,
  readMinkStorefrontSectionContext,
} from "./storefront-context-read";

const { execute, blocks } = vi.hoisted(() => ({
  execute: vi.fn(),
  blocks: {
    marks: new Map<string, string>(),
    set: null as BlockedMediaSet | null,
  },
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((run: (db: unknown) => unknown) => run({ execute })),
}));
vi.mock("@/lib/moderation/merchant", () => ({
  blockedItemIds: vi.fn(async () => blocks.marks),
}));
vi.mock("@/lib/moderation/blocked-objects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/blocked-objects")>();
  const current = () => blocks.set ?? actual.emptyBlockedMediaSet(1, "b");
  return {
    ...actual,
    blockedMedia: vi.fn(async () => current()),
    maskBlockedMedia: vi.fn(async (value: unknown) =>
      actual.maskBlockedMediaWith(value, current()),
    ),
  };
});
vi.mock("@/lib/themes/runtime-registry", () => ({
  resolveInstalledThemeDefinitionWithDb: vi.fn(
    async (
      _db: unknown,
      selection: { id: string; version?: string } | null,
    ) => {
      const { getThemeDefinition, isBundledThemeId } =
        await import("@/lib/themes");
      return selection && isBundledThemeId(selection.id)
        ? getThemeDefinition(selection.id, selection.version)
        : null;
    },
  ),
}));

const ACTOR: MinkActorContext = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "designer",
  permissions: { builder: ["view"] },
  isSuperadmin: false,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
};

const CUSTOM_SECTION = {
  id: "section-1",
  type: "custom_code",
  enabled: true,
  config: {
    html: `<section>${"x".repeat(8_100)}</section>`,
    css: ".hero { color: rebeccapurple; }",
    js: "document.querySelector('.hero')?.classList.add('ready');",
    height_mode: "auto",
    fixed_height: 480,
  },
};

function pageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "",
    title: "Home",
    status: "published",
    seo_title: "Echos furniture",
    seo_description: "Shop the Echos collection.",
    seo_noindex: false,
    sections: [CUSTOM_SECTION],
    published_sections: [],
    published_at: "2026-09-01T10:00:00.000000+00:00",
    updated_at: "2026-09-04T10:20:30.123456+00:00",
    ...overrides,
  };
}

describe("Phase 7A storefront context reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blocks.marks = new Map();
    blocks.set = null;
  });

  it("lists bounded current-store pages and maps the homepage sentinel to home", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          slug: "",
          title: "Home",
          status: "published",
          draft_section_count: 1,
          published_section_count: 0,
          has_unpublished_changes: true,
          published_at: "2026-09-01T10:00:00.000000+00:00",
          updated_at: "2026-09-04T10:20:30.123456+00:00",
        },
        {
          slug: "about-us",
          title: "About us",
          status: "draft",
          draft_section_count: 2,
          published_section_count: 0,
          has_unpublished_changes: true,
          published_at: null,
          updated_at: "2026-09-04T10:20:30.123456+00:00",
        },
      ],
    });
    const output = await readMinkStorefrontPages(ACTOR);

    expect(withService).toHaveBeenCalledOnce();
    expect(output.pages[0]).toMatchObject({
      pageSlug: "home",
      draftSectionCount: 1,
      publishedSectionCount: 0,
      hasUnpublishedChanges: true,
      requiresRepair: false,
    });
    const compiled = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(compiled.sql).not.toContain("store-1");
    expect(compiled.params).toContain("store-1");
    expect(compiled.sql).toContain("where store_id =");
    expect(compiled.sql).not.toMatch(/select[\s\S]*\n\s+sections,/);
    expect(compiled.sql).toContain("jsonb_array_length(sections)");
    expect(compiled.params).toContain(41);
  });

  it("returns exact page versions and section digests without exposing custom code", async () => {
    execute.mockResolvedValue({ rows: [pageRow()] });
    const output = await readMinkStorefrontPageContext(ACTOR, {
      pageSlug: "home",
    });

    expect(output.page).toMatchObject({
      pageSlug: "home",
      pageVersion: "2026-09-04T10:20:30.123456+00:00",
      hasUnpublishedChanges: true,
    });
    // The optimistic lock for a LAYOUT proposal is over the ordered list, and
    // per-section digests cannot see an added or reordered section. Without
    // this field a layout proposal cannot be created at all.
    expect(output.page.sectionsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(output.sections[0]).toMatchObject({
      id: "section-1",
      position: 1,
      type: "custom_code",
      customCode: { htmlCharacters: 8_119 },
    });
    expect(output.sections[0].sectionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(output)).not.toContain("<section>");
    const compiled = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(compiled.params).toContain("store-1");
    expect(compiled.params).toContain("");
  });

  it("reads custom code only in bounded, resumable chunks", async () => {
    execute.mockResolvedValue({ rows: [pageRow()] });
    const output = await readMinkStorefrontSectionContext(ACTOR, {
      pageSlug: "home",
      sectionId: "section-1",
      codeField: "html",
      codeOffset: 0,
    });

    expect(output).toMatchObject({
      codeContentIncluded: true,
      codeChunk: {
        field: "html",
        offset: 0,
        totalCharacters: 8_119,
        hasMore: true,
        nextOffset: 8_000,
      },
    });
    expect(
      (output as { codeChunk: { content: string } }).codeChunk.content,
    ).toHaveLength(8_000);
  });

  it("fails closed for malformed stored sections and denies direct permission bypass", async () => {
    execute.mockResolvedValue({
      rows: [pageRow({ sections: [{ id: "bad", type: "unknown" }] })],
    });
    await expect(
      readMinkStorefrontPageContext(ACTOR, { pageSlug: "home" }),
    ).rejects.toThrow("cannot be inspected safely");

    execute.mockClear();
    await expect(
      readMinkStorefrontPages({ ...ACTOR, permissions: {} }),
    ).rejects.toThrow("Builder view permission");
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns only safe brand/theme/chrome fields and an actor-aware sandbox contract", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        {
          name: "Echos",
          settings: {
            brand: {
              name: "Echos",
              logoUrl: "/echos-logo.png",
              primaryColor: "#6d4aff",
              tagline: "Designed for living",
              email: "private@echos.example",
              phone: "+919999999999",
              social: { instagram: "secret-social-handle" },
            },
            theme: { presetId: "basket", presetVersion: "1.0.0" },
            features: { "pages.customCode": true },
            internalSecret: "never-return-this",
          },
          chrome_store_id: "store-1",
          draft: {
            header: {
              links: [{ label: "Shop", href: "/shop" }],
              showSearch: true,
              showAccount: true,
              showCart: true,
              sticky: true,
            },
          },
          published: null,
          published_at: null,
          updated_at: "2026-09-04T10:20:30.123456+00:00",
        },
      ],
    });

    const output = await readMinkStorefrontDesignContext(ACTOR);
    expect(output).toMatchObject({
      brand: {
        name: "Echos",
        primaryColor: "#6d4aff",
        tagline: "Designed for living",
      },
      theme: { id: "basket", version: "1.0.0" },
      capabilities: { customCodeEnabled: true },
      sandboxContract: {
        phase: "7B",
        mode: "private_proposal_preview",
        authority: {
          canCreatePrivateProposal: false,
          canPreviewGeneratedCode: false,
          canSaveCode: false,
          canPublish: false,
        },
      },
    });
    // ★★ THE LOCK VALUE AND THE RUBRIC. Without `designDigest` a design
    //    proposal cannot be created at all -- there is nothing for the model to
    //    echo back -- and without the theme defaults it is judged on contrast
    //    against colours it was never shown. The same gap `page.sectionsDigest`
    //    closes for 9B, and an absent field here fails nothing loudly.
    expect(output.design.designDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(output.design.current).toEqual({
      palette: {},
      fonts: { body: null, display: null },
      shape: {},
    });
    expect(output.design.themeDefaults.palette.cream).toMatch(/^#[0-9a-f]{6}$/);
    // ★ Fonts come back as KEYS, not the `var(--font-…)` the storefront writes:
    //   the patch vocabulary is `inter`, so handing over the CSS form would
    //   have the model propose a value the validator then rejects.
    expect(output.design.themeDefaults.fonts.body).toBe("inter");
    expect(output.design.vocabulary).toMatchObject({
      minContrast: 4.5,
      nullMeans: "inherit_the_pinned_theme",
    });
    expect(output.design.vocabulary.paletteTokens).toContain("accent");
    expect(output.design.vocabulary.fonts).toContain("jost");

    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("private@echos.example");
    expect(serialized).not.toContain("+919999999999");
    expect(serialized).not.toContain("secret-social-handle");
    expect(serialized).not.toContain("never-return-this");
    expect(execute).toHaveBeenCalledTimes(1);
    for (const [statement] of execute.mock.calls) {
      const compiled = new PgDialect().sqlToQuery(statement);
      expect(compiled.params).toContain("store-1");
      expect(compiled.sql).not.toContain("store-1");
    }
  });
});

describe("takedown: blocked pages and pictures in the Builder reads", () => {
  const TOLD = "22222222-2222-4222-8222-222222222222";
  const UNTOLD = "33333333-3333-4333-8333-333333333333";
  const BLOCKED_PHOTO =
    "https://storage.googleapis.com/b/stores/store-1/media/x.webp";

  beforeEach(() => {
    vi.clearAllMocks();
    blocks.marks = new Map([[TOLD, "44444444-4444-4444-8444-444444444444"]]);
    blocks.set = buildBlockedMediaSet(
      [
        {
          id: "55555555-5555-4555-8555-555555555555",
          objectPath: "stores/store-1/media/x.webp",
          fileSource: "bucket",
          storeId: "store-1",
          objectMd5: null,
          tellStore: false,
        },
      ],
      { bucket: "b", loadedAt: 1 },
    );
  });

  function listRow(id: string, title: string, slug: string) {
    return {
      id,
      slug,
      title,
      status: "published",
      draft_section_count: 1,
      published_section_count: 1,
      has_unpublished_changes: false,
      published_at: "2026-09-01T10:00:00.000000+00:00",
      updated_at: "2026-09-04T10:20:30.123456+00:00",
    };
  }

  it("marks a page StoreMink blocked and told the store about, by its title", async () => {
    execute.mockResolvedValue({
      rows: [
        listRow(TOLD, "Size guide", "size-guide"),
        listRow(UNTOLD, "Our story", "our-story"),
      ],
    });
    const output = await readMinkStorefrontPages(ACTOR);
    expect(output.pages[0]).toMatchObject({
      pageSlug: "size-guide",
      blockedByStoreMink: true,
      storeMinkNotice:
        "StoreMink has blocked Size guide. It stays hidden from your store until StoreMink lifts the block. You can read why in Settings, Notices from StoreMink.",
    });
    // A page with no told block (kept from the store, or not blocked at all)
    // carries no mark and no word about one.
    expect(output.pages[1]).not.toHaveProperty("blockedByStoreMink");
    expect(JSON.stringify(output.pages[1])).not.toMatch(/block/i);
    expect(vi.mocked(blockedItemIds)).toHaveBeenCalledWith("store-1", "page");
    // The page ids are read for the lookup but never returned.
    expect(JSON.stringify(output)).not.toContain(UNTOLD);
    const compiled = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(compiled.sql).toMatch(/select\s+id,/);
  });

  it("looks the marks up after the page read's scope has closed", async () => {
    execute.mockResolvedValue({ rows: [listRow(TOLD, "Size guide", "x")] });
    await readMinkStorefrontPages(ACTOR);
    expect(
      vi.mocked(blockedItemIds).mock.invocationCallOrder[0],
    ).toBeGreaterThan(vi.mocked(withService).mock.invocationCallOrder[0]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("marks the page context of a told block", async () => {
    execute.mockResolvedValue({
      rows: [pageRow({ id: TOLD, slug: "size-guide", title: "Size guide" })],
    });
    const output = await readMinkStorefrontPageContext(ACTOR, {
      pageSlug: "size-guide",
    });
    expect(output.page).toMatchObject({
      blockedByStoreMink: true,
      storeMinkNotice: expect.stringContaining("Size guide"),
    });
    execute.mockResolvedValue({ rows: [pageRow({ id: UNTOLD })] });
    const untold = await readMinkStorefrontPageContext(ACTOR, {
      pageSlug: "home",
    });
    expect(untold.page).not.toHaveProperty("blockedByStoreMink");
    expect(untold.page).not.toHaveProperty("storeMinkNotice");
  });

  it("hands a section's blocked picture over only as the placeholder", async () => {
    const section = {
      ...CUSTOM_SECTION,
      config: {
        ...CUSTOM_SECTION.config,
        html: `<img src="${BLOCKED_PHOTO}" alt="">`,
      },
    };
    execute.mockResolvedValue({ rows: [pageRow({ sections: [section] })] });
    const output = await readMinkStorefrontSectionContext(ACTOR, {
      pageSlug: "home",
      sectionId: "section-1",
      codeField: "html",
    });
    const text = JSON.stringify(output);
    expect(text).not.toContain(BLOCKED_PHOTO);
    expect(text).toContain(PLACEHOLDER_URL_PATH);
    // The digest still describes what is stored, so a proposal's lock holds.
    const stored = await readMinkStorefrontSectionContext(ACTOR, {
      pageSlug: "home",
      sectionId: "section-1",
    });
    expect(stored.section.sectionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(vi.mocked(maskBlockedMedia)).toHaveBeenCalled();
  });
});
