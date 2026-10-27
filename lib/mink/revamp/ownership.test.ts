/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gcs = vi.hoisted(() => ({
  bucket: "sm-media",
  objectInfo: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/storage/gcs", () => ({
  gcsObjectInfo: (...args: unknown[]) => gcs.objectInfo(...args),
  gcsPathFromUrl: (url: string) => {
    try {
      const parsed = new URL(url);
      const prefix = `/${gcs.bucket}/`;
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== "storage.googleapis.com" ||
        !parsed.pathname.startsWith(prefix)
      ) {
        return null;
      }
      return parsed.pathname.slice(prefix.length) || null;
    } catch {
      return null;
    }
  },
}));
const fsMock = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  stat: (...args: unknown[]) => fsMock.stat(...args),
  default: { stat: (...args: unknown[]) => fsMock.stat(...args) },
}));
const logMock = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logWarn: (...args: unknown[]) => logMock.warn(...args),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";
import {
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { digestMinkStorefrontValue } from "../storefront-code-contract";
import { sectionContentDigest } from "../storefront-personalization-context";
import {
  classifySectionOwners,
  collectRevampImageUrls,
  findBrokenImages,
  isReplaceablePhotoUrl,
  readMinkWrittenSectionDigests,
} from "./ownership";

const STORE = "11111111-1111-4111-8111-111111111111";
const OTHER_STORE = "22222222-2222-4222-8222-222222222222";
const HOME = "33333333-3333-4333-8333-333333333333";
const ABOUT = "44444444-4444-4444-8444-444444444444";
const BUCKET = `https://storage.googleapis.com/${gcs.bucket}`;

function section(
  id: string,
  type: string,
  config: Record<string, unknown>,
  extra: Partial<PageSectionItem> = {},
): PageSectionItem {
  return {
    id,
    type: type as PageSectionItem["type"],
    enabled: true,
    config: config as never,
    ...extra,
  };
}

/** The digest of a section in the draft-validated form the reader compares
 *  in (the Builder reader normalises every stored section the same way). */
function written(item: PageSectionItem): string {
  const result = validateSections([item], { mode: "draft" });
  if ("error" in result) throw new Error(result.error);
  return sectionContentDigest(result.sections[0]);
}

/** Every array bound with `sql.param(...)` in a raw query, in order. */
function boundArrays(query: any): unknown[][] {
  const out: unknown[][] = [];
  const walk = (chunk: any) => {
    if (!chunk || typeof chunk !== "object") return;
    if (Array.isArray(chunk)) {
      chunk.forEach(walk);
      return;
    }
    if (chunk.queryChunks) {
      walk(chunk.queryChunks);
      return;
    }
    if ("encoder" in chunk && Array.isArray(chunk.value)) out.push(chunk.value);
  };
  walk(query?.queryChunks);
  return out;
}

const themeHero = section("hero-theme", "hero", {
  heading: "Fresh produce, delivered",
  image_url: "/themes/basket/hero.webp",
});
const minkHero = section("hero-mink", "hero", {
  heading: "Cold pressed in our own mill",
  image_url: `${BUCKET}/stores/${STORE}/mink-generated/abc.webp`,
});
const merchantText = section("own-text", "rich_text", {
  html: "<p>Our grandmother's recipe.</p>",
});
const code = section("own-code", "custom_code", {
  html: "<div>hi</div>",
  css: "",
  js: "",
  height_mode: "auto",
  fixed_height: 400,
});

describe("classifySectionOwners", () => {
  const owners = (
    sections: PageSectionItem[],
    themeIds: string[],
    mink: PageSectionItem[],
  ) =>
    classifySectionOwners({
      sections,
      themeSectionIds: new Set(themeIds),
      minkDigests: new Set(mink.map(sectionContentDigest)),
    });

  it("theme by id, mink by content, merchant otherwise", () => {
    expect(
      owners([themeHero, minkHero, merchantText], ["hero-theme"], [minkHero]),
    ).toEqual({
      "hero-theme": "theme",
      "hero-mink": "mink",
      "own-text": "merchant",
    });
  });

  it("★ mink is matched by CONTENT, whatever the section's id is now", () => {
    const moved = { ...minkHero, id: "renamed" };
    expect(owners([moved], [], [minkHero])).toEqual({ renamed: "mink" });
  });

  it("★★ custom code is always the merchant's, whatever else matches", () => {
    expect(owners([code], ["own-code"], [code])).toEqual({
      "own-code": "merchant",
    });
  });

  it("the theme wins when a section is both the theme's and Mink's", () => {
    expect(owners([themeHero], ["hero-theme"], [themeHero])).toEqual({
      "hero-theme": "theme",
    });
  });

  it("★ one changed character makes a Mink section the merchant's", () => {
    const edited = {
      ...minkHero,
      config: { ...minkHero.config, heading: "Cold pressed in our own mill!" },
    } as PageSectionItem;
    expect(owners([edited], [], [minkHero])).toEqual({
      "hero-mink": "merchant",
    });
  });

  it("switching a Mink section off or restyling it does not change its owner", () => {
    const off = {
      ...minkHero,
      enabled: false,
      style: { scheme: "accent" } as never,
    };
    expect(owners([off], [], [minkHero])).toEqual({ "hero-mink": "mink" });
  });

  it("an id that names a prototype key stays an ordinary own property", () => {
    const odd = { ...merchantText, id: "__proto__" };
    const result = owners([odd], [], []);
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(
      true,
    );
    expect(JSON.stringify(result)).toBe('{"__proto__":"merchant"}');
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(owners([], [], [])).toEqual({});
  });
});

// ---------------------------------------------------------------------------

function v1Plan(pages: Array<Record<string, unknown>>) {
  return {
    schemaVersion: 1,
    pages,
    chrome: null,
    brand: null,
    categories: [],
    products: [],
    photos: [],
    skipped: [],
    explanation: "Personalised",
    credits: {
      pages: 0,
      photos: 0,
      design: 0,
      chrome: 0,
      categories: 0,
      total: 0,
    },
  };
}

function personalizationRow(plan: unknown, revampPages: unknown = null) {
  return {
    plan_json: JSON.stringify(plan),
    plan_digest: digestMinkStorefrontValue(plan),
    revamp_pages: revampPages,
  };
}

function layoutRow(after: PageSectionItem[], before: PageSectionItem[]) {
  return {
    after_json: JSON.stringify(after),
    before_json: JSON.stringify(before),
  };
}

const rewritten = section("hero-1", "hero", {
  heading: "Mustard oil, pressed slowly",
  image_url: `${BUCKET}/stores/${STORE}/mink-generated/p1.webp`,
});
const hiddenSample = section(
  "quotes-1",
  "testimonials",
  { heading: "What customers say", items: [] },
  { enabled: false },
);

describe("readMinkWrittenSectionDigests", () => {
  beforeEach(() => {
    logMock.warn.mockReset();
  });

  it("★★ v1: a page still the theme's when it ran counts; custom code never does", async () => {
    const plan = v1Plan([
      {
        pageId: HOME,
        slug: "home",
        expectedVersion: "2026-10-01 10:00:20.123456+00",
        sections: [rewritten, hiddenSample, code],
      },
    ]);
    const { db } = makeDbMock({
      executeQueue: [
        [personalizationRow(plan)],
        [
          {
            id: HOME,
            slug: "",
            created_at: "2026-10-01 10:00:00+00",
            settings: {},
          },
        ],
        [],
      ],
    });
    const digests = await readMinkWrittenSectionDigests(db, STORE);
    expect(digests).toEqual(
      new Set([written(rewritten), written(hiddenSample)]),
    );
  });

  it("★★ v1: an EDITED page proves nothing, so its merchant sections stay the merchant's", async () => {
    const plan = v1Plan([
      {
        pageId: ABOUT,
        slug: "about",
        // Saved weeks after the theme wrote it: the merchant's page.
        expectedVersion: "2026-10-01 10:00:00+00",
        sections: [merchantText, rewritten],
      },
    ]);
    const { db } = makeDbMock({
      executeQueue: [
        [personalizationRow(plan)],
        [
          {
            id: ABOUT,
            slug: "about",
            created_at: "2026-09-01 10:00:00+00",
            settings: {},
          },
        ],
        [],
      ],
    });
    expect(await readMinkWrittenSectionDigests(db, STORE)).toEqual(new Set());
  });

  it("v1 homepage: a theme switch since then (a later seed time) counts nothing", async () => {
    const plan = v1Plan([
      {
        pageId: HOME,
        slug: "home",
        expectedVersion: "2026-10-01 10:00:20+00",
        sections: [rewritten],
      },
    ]);
    const settings = {
      theme: { presetId: "vitrine", homepageSeededAt: "2026-10-15T08:00:00Z" },
    };
    const { db } = makeDbMock({
      executeQueue: [
        [personalizationRow(plan)],
        [
          {
            id: HOME,
            slug: "",
            created_at: "2026-10-01 10:00:00+00",
            settings,
          },
        ],
        [],
      ],
    });
    expect(await readMinkWrittenSectionDigests(db, STORE)).toEqual(new Set());
  });

  it("v1: an unreadable version, a missing page or a malformed id counts nothing", async () => {
    const plan = v1Plan([
      {
        pageId: HOME,
        slug: "home",
        expectedVersion: "not a time",
        sections: [rewritten],
      },
      {
        pageId: ABOUT,
        slug: "about",
        expectedVersion: "2026-10-01 10:00:00+00",
        sections: [rewritten],
      },
      {
        pageId: "not-a-uuid",
        slug: "x",
        expectedVersion: "2026-10-01 10:00:00+00",
        sections: [rewritten],
      },
    ]);
    const mock = makeDbMock({
      executeQueue: [
        [personalizationRow(plan)],
        // Only the homepage row comes back: About was deleted since.
        [
          {
            id: HOME,
            slug: "",
            created_at: "2026-10-01 10:00:00+00",
            settings: {},
          },
        ],
        [],
      ],
    });
    expect(await readMinkWrittenSectionDigests(mock.db, STORE)).toEqual(
      new Set(),
    );
    // ★ The malformed id never reaches the uuid cast.
    const pageQuery = mock.calls.execute[1];
    expect(boundArrays(pageQuery)).toEqual([[HOME, ABOUT]]);
  });

  it("★★ v2 (a revamp): only what the job's own snapshot of the page did not hold", async () => {
    const newHero = section("rv-hero", "hero", {
      heading: "From our mill to your kitchen",
      image_url: `${BUCKET}/stores/${STORE}/mink-generated/revamp/r1/hero.webp`,
    });
    const newStory = section("rv-story", "media_text", {
      heading: "How we press",
      body: "Slowly, in small batches.",
    });
    const plan = {
      schemaVersion: 2,
      revampId: "r1",
      pages: [
        {
          pageId: HOME,
          slug: "",
          create: false,
          sections: [merchantText, newHero],
        },
        {
          pageId: null,
          slug: "our-process",
          create: true,
          sections: [newStory],
        },
      ],
    };
    const snapshotPages = [
      { id: HOME, slug: "", sections: [merchantText, themeHero] },
    ];
    const { db } = makeDbMock({
      executeQueue: [[personalizationRow(plan, snapshotPages)], []],
    });
    expect(await readMinkWrittenSectionDigests(db, STORE)).toEqual(
      new Set([written(newHero), written(newStory)]),
    );
  });

  it("v2 without its job row: a created page still counts, an existing one does not", async () => {
    const newStory = section("rv-story", "rich_text", { html: "<p>Ours</p>" });
    const plan = {
      schemaVersion: 2,
      pages: [
        { pageId: HOME, slug: "", create: false, sections: [merchantText] },
        { pageId: null, slug: "process", create: true, sections: [newStory] },
      ],
    };
    const { db } = makeDbMock({
      executeQueue: [[personalizationRow(plan, null)], []],
    });
    expect(await readMinkWrittenSectionDigests(db, STORE)).toEqual(
      new Set([written(newStory)]),
    );
  });

  it("★★ layout: sections carried through unchanged are not Mink's", async () => {
    const gallery = section("g1", "gallery", {
      heading: "Inside the mill",
      items: [],
    });
    const retitled = {
      ...merchantText,
      config: { html: "<p>Rewritten by Mink</p>" },
    } as PageSectionItem;
    const { db } = makeDbMock({
      executeQueue: [
        [],
        [
          // Kept (by reference), moved, added and edited, all in one list.
          layoutRow([themeHero, gallery, retitled], [merchantText, themeHero]),
        ],
      ],
    });
    expect(await readMinkWrittenSectionDigests(db, STORE)).toEqual(
      new Set([written(gallery), written(retitled)]),
    );
  });

  it("★ tolerant: unreadable rows add nothing, readable ones still count, one warning", async () => {
    const good = v1Plan([
      {
        pageId: HOME,
        slug: "home",
        expectedVersion: "2026-10-01 10:00:10+00",
        sections: [rewritten],
      },
    ]);
    const tampered = {
      ...personalizationRow(good),
      plan_digest: "0".repeat(64),
    };
    const future = personalizationRow({ schemaVersion: 3, pages: [] });
    const { db } = makeDbMock({
      executeQueue: [
        [
          { plan_json: "{not json", plan_digest: "x", revamp_pages: null },
          tampered,
          future,
          { plan_json: null, plan_digest: null, revamp_pages: null },
          personalizationRow(good),
        ],
        [
          {
            id: HOME,
            slug: "",
            created_at: "2026-10-01 10:00:00+00",
            settings: {},
          },
        ],
        [
          { after_json: "[", before_json: "[]" },
          { after_json: "[]", before_json: null },
          { after_json: JSON.stringify({ not: "a list" }), before_json: "[]" },
        ],
      ],
    });
    expect(await readMinkWrittenSectionDigests(db, STORE)).toEqual(
      new Set([written(rewritten)]),
    );
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.stringMatching(/unreadable/),
      { storeId: STORE, unreadable: 7 },
    );
  });

  it("★★ every query is scoped to the store, on every table it reads", async () => {
    const plan = v1Plan([
      {
        pageId: HOME,
        slug: "home",
        expectedVersion: "2026-10-01 10:00:10+00",
        sections: [rewritten],
      },
    ]);
    const mock = makeDbMock({
      executeQueue: [
        [personalizationRow(plan)],
        [
          {
            id: HOME,
            slug: "",
            created_at: "2026-10-01 10:00:00+00",
            settings: {},
          },
        ],
        [],
      ],
    });
    await readMinkWrittenSectionDigests(mock.db, STORE);
    expect(mock.calls.execute).toHaveLength(3);
    const [approvals, pages, layouts] = mock.calls.execute;
    for (const query of [approvals, layouts]) {
      const text = sqlText(query);
      expect(text).toMatch(/a\.store_id = /);
      expect(text).toMatch(/d\.store_id = /);
      expect(text).toMatch(/a\.status = 'executed'/);
      const params = sqlParamValues(query);
      expect(
        params.filter((value) => value === STORE).length,
      ).toBeGreaterThanOrEqual(2);
      expect(params).not.toContain(OTHER_STORE);
      // ★ The newest 50 per tool.
      expect(params).toContain(50);
    }
    expect(sqlText(approvals)).toMatch(/r\.store_id = /);
    expect(sqlText(approvals)).toMatch(/apply_storefront_personalization/);
    expect(sqlText(layouts)).toMatch(/apply_storefront_layout/);
    expect(sqlText(pages)).toMatch(/page\.store_id = /);
    expect(sqlParamValues(pages)).toContain(STORE);
  });

  it("asks nothing about pages when no schema-1 plan was applied", async () => {
    const mock = makeDbMock({ executeQueue: [[], []] });
    expect(await readMinkWrittenSectionDigests(mock.db, STORE)).toEqual(
      new Set(),
    );
    expect(mock.calls.execute).toHaveLength(2);
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("isReplaceablePhotoUrl", () => {
  const none = new Set<string>();
  const replaceable = (url: string, broken: ReadonlySet<string> = none) =>
    isReplaceablePhotoUrl(url, { storeId: STORE, broken });

  it("★ a theme file: bundled or a published Studio release", () => {
    expect(replaceable("/themes/basket/hero.webp")).toBe(true);
    expect(
      replaceable(`${BUCKET}/theme-releases/luxe/1.0.0/hero-abc.webp`),
    ).toBe(true);
  });

  it("★ a picture an earlier Mink run drew for THIS store", () => {
    expect(replaceable(`${BUCKET}/stores/${STORE}/mink-generated/a.jpg`)).toBe(
      true,
    );
    expect(
      replaceable(`${BUCKET}/stores/${STORE}/mink-generated/revamp/r1/s.webp`),
    ).toBe(true);
    expect(
      replaceable(`${BUCKET}/stores/${OTHER_STORE}/mink-generated/a.jpg`),
    ).toBe(false);
  });

  it("★★ never a working merchant upload or a product photo", () => {
    expect(replaceable(`${BUCKET}/stores/${STORE}/media/shop.webp`)).toBe(
      false,
    );
    expect(replaceable(`${BUCKET}/stores/${STORE}/uploads/a.webp`)).toBe(false);
    expect(
      replaceable(
        `${BUCKET}/stores/${STORE}/mink-generated/product-photos/oil.webp`,
      ),
    ).toBe(false);
    expect(replaceable(`${BUCKET}/stores/${STORE}/edited/ai-1.webp`)).toBe(
      false,
    );
    expect(replaceable("https://images.unsplash.com/photo-1.jpg")).toBe(false);
  });

  it("★ a broken URL shows nothing, so it may be replaced whoever owns it", () => {
    const upload = `${BUCKET}/stores/${STORE}/media/gone.webp`;
    expect(replaceable(upload, new Set([upload]))).toBe(true);
    expect(replaceable(`  ${upload} `, new Set([upload]))).toBe(true);
  });

  it("nothing for an empty value, a traversal or an unknown host", () => {
    expect(replaceable("")).toBe(false);
    expect(replaceable("   ")).toBe(false);
    expect(
      replaceable(`${BUCKET}/stores/${STORE}/mink-generated/../media/a.webp`),
    ).toBe(false);
    expect(replaceable("/themes/../etc/passwd")).toBe(false);
    expect(
      isReplaceablePhotoUrl(`${BUCKET}/stores/${STORE}/mink-generated/a.jpg`, {
        storeId: "",
        broken: none,
      }),
    ).toBe(false);
  });
});

describe("collectRevampImageUrls", () => {
  it("finds images at every depth and leaves videos out", () => {
    const sections = [
      section("h", "hero", {
        image_url: "/themes/basket/hero.webp",
        video_url: "/themes/basket/hero.mp4",
        mobile_image_url: "",
      }),
      section("g", "gallery", {
        items: [{ image_url: `${BUCKET}/a.webp` }, { image_url: "/b.jpg?x=1" }],
      }),
    ];
    expect(collectRevampImageUrls(sections)).toEqual([
      "/themes/basket/hero.webp",
      `${BUCKET}/a.webp`,
      "/b.jpg?x=1",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("findBrokenImages", () => {
  const signal = () => new AbortController().signal;
  const enoent = () => Object.assign(new Error("missing"), { code: "ENOENT" });

  beforeEach(() => {
    gcs.objectInfo.mockReset();
    fsMock.stat.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("★ our bucket: a missing or empty object is broken, a present one is not", async () => {
    gcs.objectInfo.mockImplementation(async (_kind: string, p: string) =>
      p.endsWith("gone.webp")
        ? null
        : p.endsWith("empty.webp")
          ? { size: 0, contentType: "image/webp" }
          : { size: 1200, contentType: "image/webp" },
    );
    const urls = [
      `${BUCKET}/stores/${STORE}/media/gone.webp`,
      `${BUCKET}/stores/${STORE}/media/empty.webp`,
      `${BUCKET}/stores/${STORE}/media/ok.webp`,
    ];
    expect(await findBrokenImages(urls, { signal: signal() })).toEqual(
      new Set([urls[0], urls[1]]),
    );
    expect(gcs.objectInfo).toHaveBeenCalledWith(
      "public",
      `stores/${STORE}/media/gone.webp`,
    );
  });

  it("★ theme files: the file under public/, query strings ignored", async () => {
    fsMock.stat.mockImplementation(async (file: string) => {
      if (file.endsWith("missing.webp")) throw enoent();
      if (file.endsWith("locked.webp")) {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      if (file.endsWith("folder")) return { isFile: () => false };
      return { isFile: () => true };
    });
    const urls = [
      "/themes/basket/missing.webp",
      "/themes/basket/hero.webp?v=2",
      "/themes/basket/locked.webp",
      "/themes/basket/folder",
    ];
    const broken = await findBrokenImages(urls, { signal: signal() });
    expect(broken).toEqual(
      new Set(["/themes/basket/missing.webp", "/themes/basket/folder"]),
    );
    const files = fsMock.stat.mock.calls.map(([file]) => String(file));
    expect(
      files.some((file) =>
        /public[\\/]themes[\\/]basket[\\/]hero\.webp$/.test(file),
      ),
    ).toBe(true);
  });

  it("★★ external hosts are never checked and never counted broken", async () => {
    const broken = await findBrokenImages(
      [
        "https://images.unsplash.com/photo-1.jpg",
        "https://storage.googleapis.com/another-bucket/x.webp",
        "https://cdn.example.com/a.png",
        "/marketing/hero.webp",
      ],
      { signal: signal() },
    );
    expect(broken).toEqual(new Set());
    expect(gcs.objectInfo).not.toHaveBeenCalled();
    expect(fsMock.stat).not.toHaveBeenCalled();
  });

  it("never leaves public/themes: a traversal is not stat'ed at all", async () => {
    await findBrokenImages(
      [
        "/themes/../../etc/passwd",
        "/themes/%2e%2e/%2e%2e/secret",
        "/themes/%E0%A4%A",
      ],
      { signal: signal() },
    );
    expect(fsMock.stat).not.toHaveBeenCalled();
  });

  it("★ an error or a timeout reads as loading, never as broken", async () => {
    vi.useFakeTimers();
    gcs.objectInfo.mockImplementation(async (_kind: string, p: string) => {
      if (p.endsWith("error.webp")) throw new Error("network");
      return new Promise(() => {}); // never answers
    });
    const pending = findBrokenImages(
      [`${BUCKET}/a/error.webp`, `${BUCKET}/a/slow.webp`],
      { signal: signal() },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toEqual(new Set());
  });

  it("★ checks at most `limit` URLs (default 80), duplicates once", async () => {
    gcs.objectInfo.mockResolvedValue(null);
    const urls = Array.from(
      { length: 100 },
      (_, index) => `${BUCKET}/stores/${STORE}/media/${index}.webp`,
    );
    const broken = await findBrokenImages(
      [...urls.slice(0, 5), ...urls.slice(0, 5), ...urls.slice(5)],
      { signal: signal() },
    );
    expect(gcs.objectInfo).toHaveBeenCalledTimes(80);
    expect(broken.size).toBe(80);

    gcs.objectInfo.mockClear();
    const limited = await findBrokenImages(
      ["https://example.com/external.png", ...urls],
      { signal: signal(), limit: 3 },
    );
    // External URLs do not use up the limit: they are never checked.
    expect(gcs.objectInfo).toHaveBeenCalledTimes(3);
    expect(limited).toEqual(new Set(urls.slice(0, 3)));
  });

  it("★ runs six checks at a time, no more", async () => {
    let inFlight = 0;
    let peak = 0;
    gcs.objectInfo.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { size: 10, contentType: "image/webp" };
    });
    const urls = Array.from({ length: 20 }, (_, i) => `${BUCKET}/x/${i}.webp`);
    await findBrokenImages(urls, { signal: signal() });
    expect(gcs.objectInfo).toHaveBeenCalledTimes(20);
    expect(peak).toBe(6);
  });

  it("★★ an abort before it starts rejects with the reason and checks nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("lease lost");
    controller.abort(reason);
    await expect(
      findBrokenImages([`${BUCKET}/x/1.webp`], { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(gcs.objectInfo).not.toHaveBeenCalled();
  });

  it("★★ an abort mid-way stops at once and is never swallowed", async () => {
    const controller = new AbortController();
    let started = 0;
    gcs.objectInfo.mockImplementation(() => {
      started += 1;
      if (started === 2) controller.abort(new Error("cancelled"));
      return new Promise(() => {}); // every check hangs
    });
    const urls = Array.from({ length: 30 }, (_, i) => `${BUCKET}/x/${i}.webp`);
    await expect(
      findBrokenImages(urls, { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    // The pool had started its first wave; nothing after the abort.
    expect(started).toBeLessThanOrEqual(6);
  });

  it("nothing to check is an empty answer with no work", async () => {
    expect(await findBrokenImages([], { signal: signal() })).toEqual(new Set());
    expect(await findBrokenImages(["", "  "], { signal: signal() })).toEqual(
      new Set(),
    );
  });
});
