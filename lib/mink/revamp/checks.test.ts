import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeChromeForSave, type StoreChrome } from "@/lib/chrome/types";
import type { PageSectionItem } from "@/lib/sections/registry";
import { runRevampChecks } from "./checks";
import {
  REVAMP_PRICES,
  REVAMP_SLOT_PREFIX,
  type RevampRequest,
  type RevampSnapshot,
  type RevampStoredPage,
  type RevampStoredPlan,
} from "./contract";
import { revampSectionsDigest } from "./digests";
import type { RevampStepContext } from "./ports";

const gcs = vi.hoisted(() => ({
  info: vi.fn(),
  bucket: "https://storage.googleapis.com/sm-bucket/",
}));

vi.mock("@/lib/storage/gcs", () => ({
  gcsObjectInfo: (kind: string, path: string) => gcs.info(kind, path),
  gcsPathFromUrl: (url: string) =>
    url.startsWith(gcs.bucket) ? url.slice(gcs.bucket.length) : null,
}));

const NEW1 = `${gcs.bucket}stores/s1/mink-generated/revamp/new1.webp`;
const GONE = `${gcs.bucket}stores/s1/mink-generated/revamp/gone.webp`;
const ERR = `${gcs.bucket}stores/s1/mink-generated/revamp/err.webp`;
const THEME_PHOTO = "/themes/basket/hero.webp";
const EM = String.fromCharCode(0x2014);

type Raw = Record<string, unknown>;

function sec(id: string, type: string, config: Raw): PageSectionItem {
  return { id, type, enabled: true, config } as unknown as PageSectionItem;
}

const conf = (s: PageSectionItem | undefined) => s?.config as unknown as Raw;

const T_HERO = sec("t-hero", "hero", {
  variant: "banner",
  heading: "Fresh produce",
});
const K_FAQ = sec("k-faq", "faq_accordion", {
  heading: "Questions",
  items: [{ question: "Do you deliver?", answer: "Yes." }],
});
const M_STORY = sec("m-story", "media_text", {
  heading: "Our story",
  image_url: THEME_PHOTO,
});
const M_BAD = sec("m-bad", "rich_text", { html: "<p>Our terms</p>" });

function snapshot(realProducts = true): RevampSnapshot {
  return {
    storeId: "s1",
    storeName: "Ghani Oils",
    storeSlug: "ghani",
    launched: false,
    theme: {
      id: "basket",
      version: "1.0.0",
      name: "Basket",
      palette: {
        page: "#fbf8f1",
        surface: "#ffffff",
        ink: "#1f1d1a",
        accent: "#2f6b3a",
      },
      layout: {},
    },
    pages: [
      {
        id: "page-home",
        slug: "",
        title: "Home",
        status: "published",
        version: "v",
        sectionsDigest: "d",
        sections: [T_HERO, K_FAQ, M_STORY],
        owners: { "t-hero": "theme", "k-faq": "mink", "m-story": "merchant" },
        skipped: null,
        seoTitle: null,
        seoDescription: null,
      },
      {
        id: "page-about",
        slug: "about",
        title: "About",
        status: "published",
        version: "v",
        sectionsDigest: "d",
        sections: [
          sec("t-about", "rich_text", { html: "<p>Theme words.</p>" }),
          M_BAD,
        ],
        owners: { "t-about": "theme", "m-bad": "merchant" },
        skipped: null,
        seoTitle: null,
        seoDescription: null,
      },
    ],
    chrome: {
      rowExists: false,
      version: null,
      digest: "c",
      value: sanitizeChromeForSave({}),
    },
    brand: { tagline: null, blurb: null, digest: "b" },
    categories: [
      {
        id: "c2",
        slug: "oils",
        name: "Oils",
        description: null,
        imageUrl: null,
        status: "active",
        updatedAt: "t",
        sample: false,
        productCount: 1,
      },
    ],
    products: [
      {
        id: "x1",
        name: "Banana (Sample)",
        slug: "banana",
        status: "published",
        updatedAt: "t",
        sample: true,
        imageUrl: null,
        categoryId: null,
      },
      ...(realProducts
        ? [
            {
              id: "x2",
              name: "Groundnut Oil",
              slug: "groundnut-oil",
              status: "published",
              updatedAt: "t",
              sample: false,
              imageUrl: null,
              categoryId: "c2",
            },
          ]
        : []),
    ],
    facts: {} as RevampSnapshot["facts"],
    photos: { replaceable: [THEME_PHOTO], broken: [] },
    entitlements: { customCode: true },
  };
}

function request(over: Partial<RevampRequest> = {}): RevampRequest {
  return {
    kind: "full",
    brief: {
      business: "Ghani Oils sells cold-pressed oil.",
      look: "warm",
      audience: "cooks",
      facts: [],
      avoid: "",
      language: "English",
    },
    products: [],
    categories: [],
    pages: null,
    instruction: null,
    refineScope: null,
    ...over,
  };
}

function page(
  slug: string,
  sections: PageSectionItem[],
  extra: Partial<RevampStoredPage> = {},
): RevampStoredPage {
  return {
    pageId: slug === "" ? "page-home" : `page-${slug}`,
    slug,
    title: slug ? "About" : "Home",
    seoTitle: "Title",
    seoDescription: "A long enough search description.",
    create: false,
    expectedVersion: "v",
    expectedDigest: "d",
    sections,
    proposedDigest: "stale",
    changes: { added: 0, removed: 0, kept: 0, photos: 0 },
    ...extra,
  };
}

function plan(
  pages: RevampStoredPage[],
  extra: Partial<RevampStoredPlan> = {},
  chrome: Partial<StoreChrome> = {},
): RevampStoredPlan {
  return {
    schemaVersion: 2,
    revampId: "rv1",
    kind: "full",
    summary: "",
    pages,
    chrome: {
      expectedVersion: null,
      expectedDigest: "c",
      next: sanitizeChromeForSave({
        header: { links: [{ label: "Shop", href: "/shop" }] },
        ...chrome,
      }),
    },
    brand: null,
    categories: [],
    products: { hide: [], create: [] },
    photos: [],
    checks: [],
    skipped: [],
    notes: [],
    explanation: "",
    credits: {
      pages: 0,
      photos: 0,
      design: 0,
      chrome: 0,
      categories: 0,
      productPhotos: 0,
      total: 0,
    },
    free: false,
    ...extra,
  };
}

function ctx(signal = new AbortController().signal): RevampStepContext {
  return {
    revampId: "rv1",
    actor: {} as RevampStepContext["actor"],
    signal,
    deadline: Date.now() + 60_000,
    report: vi.fn(async () => {}),
  };
}

async function run(p: RevampStoredPlan, snap = snapshot(), req = request()) {
  return (
    await runRevampChecks(ctx(), { plan: p, snapshot: snap, request: req })
  ).plan;
}

const check = (p: RevampStoredPlan, id: string) =>
  p.checks.find((c) => c.id === id)!;

beforeEach(() => {
  gcs.info.mockImplementation(async (_kind: string, path: string) =>
    path.includes("gone") ? null : { size: 10, contentType: "image/webp" },
  );
});

describe("runRevampChecks: photos", () => {
  it("clears unfinished slots and missing or theme photos, keeping what still renders", async () => {
    gcs.info.mockImplementation(async (_kind: string, path: string) => {
      if (path.includes("gone")) return null;
      if (path.includes("err")) throw new Error("timeout");
      return { size: 10, contentType: null };
    });
    const out = await run(
      plan(
        [
          page("", [
            sec("n-hero", "hero", {
              variant: "banner",
              heading: "Hello",
              image_url: `${REVAMP_SLOT_PREFIX}x`,
            }),
            sec("n-gal", "gallery", {
              items: [{ image_url: NEW1 }, { image_url: GONE }],
            }),
            sec("n-err", "media_text", { heading: "Err", image_url: ERR }),
            sec("n-theme", "media_text", {
              heading: "Theme",
              image_url: THEME_PHOTO,
            }),
            M_STORY,
          ]),
        ],
        {
          photos: [
            { url: NEW1, path: "a", alt: "a", where: "Home page, gallery" },
            { url: GONE, path: "b", alt: "b", where: "Home page, gallery" },
          ],
          categories: [
            {
              action: "update",
              id: "c2",
              slug: "oils",
              expectedUpdatedAt: "t",
              before: {
                name: "Oils",
                description: null,
                imageUrl: "/old.webp",
              },
              name: "Oils",
              description: null,
              imageUrl: `${REVAMP_SLOT_PREFIX}cat`,
            },
          ],
        },
      ),
    );
    const sections = out.pages[0].sections;
    expect(sections.map((s) => s.id)).toEqual([
      "n-hero",
      "n-err",
      "n-theme",
      "m-story",
    ]);
    expect(conf(sections[0]).image_url).toBe("");
    expect(conf(sections[1]).image_url).toBe(ERR);
    expect(conf(sections[2]).image_url).toBe("");
    expect(conf(sections[3]).image_url).toBe(THEME_PHOTO);
    expect(out.categories[0]).toMatchObject({ imageUrl: "/old.webp" });
    expect(out.photos).toEqual([]);
    const result = check(out, "photos");
    expect(result.passed).toBe(true);
    expect(result.note).toMatch(/unfinished photo/);
    expect(result.note).toMatch(/did not load/);
    expect(result.note).toMatch(/old theme photo/);
    expect(out.pages[0].proposedDigest).toBe(revampSectionsDigest(sections));
  });

  it("asks storage at most six at a time and honours the abort signal", async () => {
    let inFlight = 0;
    let peak = 0;
    gcs.info.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return { size: 1, contentType: null };
    });
    const many = Array.from({ length: 14 }, (_, i) =>
      sec(`n-${i}`, "media_text", {
        heading: "H",
        image_url: `${gcs.bucket}stores/s1/p${i}.webp`,
      }),
    );
    await run(plan([page("", many)]));
    expect(gcs.info).toHaveBeenCalledTimes(14);
    expect(peak).toBeLessThanOrEqual(6);

    const controller = new AbortController();
    controller.abort();
    await expect(
      runRevampChecks(ctx(controller.signal), {
        plan: plan([page("", many)]),
        snapshot: snapshot(),
        request: request(),
      }),
    ).rejects.toBeTruthy();
  });
});

describe("runRevampChecks: sections", () => {
  it("removes theme sections left as the theme seeded them; keeps rewritten and merchant ones", async () => {
    const out = await run(
      plan([
        page("", [T_HERO, K_FAQ, M_STORY]),
        page("about", [
          sec("t-about", "rich_text", { html: "<p>New words.</p>" }),
          M_BAD,
        ]),
      ]),
    );
    expect(out.pages[0].sections.map((s) => s.id)).toEqual(["m-story"]);
    expect(out.pages[1].sections.map((s) => s.id)).toEqual([
      "t-about",
      "m-bad",
    ]);
    expect(check(out, "theme_text").note).toMatch(/sample text/);
    expect(out.pages[0].changes).toEqual({
      added: 0,
      removed: 2,
      kept: 1,
      photos: 0,
    });
  });

  it("keeps an earlier Mink section on a refinement", async () => {
    const out = await run(
      plan([page("", [K_FAQ])], { kind: "refine" }),
      snapshot(),
      request({ kind: "refine" }),
    );
    expect(out.pages[0].sections.map((s) => s.id)).toEqual(["k-faq"]);
  });

  it("says, never removes, a theme section that kept the theme's words", async () => {
    const reshot = sec("t-hero", "hero", {
      variant: "banner",
      heading: "Fresh produce",
      image_url: NEW1,
    });
    const out = await run(plan([page("", [reshot])]));
    expect(out.pages[0].sections.map((s) => s.id)).toEqual(["t-hero"]);
    expect(check(out, "theme_text").passed).toBe(false);
    expect(check(out, "theme_text").note).toMatch(/sample words/);
  });

  it("fills titles and search descriptions and removes unfinished new sections", async () => {
    const out = await run(
      plan([
        page(
          "about",
          [
            sec("n-empty", "rich_text", { html: "" }),
            sec("n-ok", "rich_text", { html: "<p>Fine</p>" }),
          ],
          { title: "", seoDescription: "short" },
        ),
      ]),
    );
    const about = out.pages[0];
    expect(about.title).toBe("About");
    expect(about.seoDescription.length).toBeGreaterThanOrEqual(20);
    expect(about.sections.map((s) => s.id)).toEqual(["n-ok"]);
    const result = check(out, "pages");
    expect(result.passed).toBe(true);
    expect(result.note).toMatch(/search description/);
  });

  it("fails the page check for the merchant's own unfinished section, never removing it", async () => {
    const bad = sec("m-bad", "rich_text", { html: "" });
    const out = await run(plan([page("about", [bad])]));
    expect(out.pages[0].sections.map((s) => s.id)).toEqual(["m-bad"]);
    expect(check(out, "pages").passed).toBe(false);
    expect(check(out, "pages").note).toMatch(/needs finishing/);
  });

  it("keeps product sections only when the shop will have real products", async () => {
    const feat = () =>
      sec("n-feat", "featured_products", {
        heading: "Ours",
        source: "featured",
        product_ids: [],
        category_id: null,
        limit: 4,
      });
    const none = await run(plan([page("", [feat()])]), snapshot(false));
    expect(none.pages[0].sections).toEqual([]);
    expect(check(none, "products").note).toMatch(/no products of its own/);
    const some = await run(plan([page("", [feat()])]), snapshot(true));
    expect(some.pages[0].sections.map((s) => s.id)).toEqual(["n-feat"]);
  });
});

describe("runRevampChecks: links", () => {
  it("drops links to pages that will not exist, in sections, header, footer and the bar", async () => {
    const out = await run(
      plan(
        [
          page("", [
            sec("n-hero", "hero", {
              variant: "banner",
              heading: "H",
              cta_label: "Shop now",
              cta_href: "/collections/nope",
            }),
            sec("n-link", "media_text", {
              heading: "About",
              cta_label: "Read",
              cta_href: "/about/",
            }),
            sec("n-ext", "media_text", {
              heading: "Insta",
              cta_label: "Follow",
              cta_href: "https://instagram.com/ghani",
            }),
          ]),
          page("faq", [sec("n-faq", "rich_text", { html: "<p>Q</p>" })], {
            create: true,
            pageId: null,
            expectedVersion: null,
            expectedDigest: null,
          }),
        ],
        {},
        {
          header: {
            ...sanitizeChromeForSave({}).header,
            links: [
              { label: "Shop", href: "/shop" },
              { label: "Gone", href: "/nowhere" },
              { label: "FAQ", href: "/faq" },
            ],
            announcement: { enabled: true, text: "Hi", href: "/nowhere" },
          },
          footer: {
            ...sanitizeChromeForSave({}).footer,
            groups: [
              { title: "Dead", links: [{ label: "X", href: "/nowhere" }] },
              { title: "Help", links: [{ label: "About", href: "/about" }] },
            ],
          },
        },
      ),
    );
    const [hero, link, ext] = out.pages[0].sections;
    expect(conf(hero)).toMatchObject({ cta_href: "", cta_label: "" });
    expect(conf(link).cta_href).toBe("/about");
    expect(conf(ext).cta_href).toBe("https://instagram.com/ghani");
    const next = out.chrome!.next;
    expect(next.header.links.map((l) => l.href)).toEqual(["/shop", "/faq"]);
    expect(next.footer.groups.map((g) => g.title)).toEqual(["Help"]);
    expect(next.header.announcement.href).toBe("");
    const result = check(out, "links");
    expect(result.passed).toBe(true);
    expect(result.note).toMatch(/4 links/);
  });
});

describe("runRevampChecks: reading", () => {
  it("keeps the store's colours when the new ones are hard to read, and fixes heroes", async () => {
    const out = await run(
      plan(
        [
          page("", [
            sec("n-flip", "hero", {
              variant: "banner",
              heading: "Flip",
              subheading: "Sub",
              theme: "light",
              background: "#ffffff",
            }),
            sec("n-clear", "hero", {
              variant: "banner",
              heading: "Grey",
              subheading: "Sub",
              theme: "dark",
              background: "#777777",
            }),
          ]),
        ],
        {},
        {
          design: {
            palette: { cream: "#fbf8f1", ink: "#fbf8f1" },
            fonts: { body: null, display: null },
            shape: {},
          },
        },
      ),
    );
    expect(out.chrome!.next.design.palette).toEqual({});
    const [flip, clear] = out.pages[0].sections;
    expect(conf(flip).theme).toBe("dark");
    expect(conf(clear).background).toBe("");
    const result = check(out, "contrast");
    expect(result.passed).toBe(true);
    expect(result.note).toMatch(/current colours are kept/);
  });

  it("reports text that is not in English only for an English brief", async () => {
    const hindi = () =>
      plan([
        page("", [
          sec("n-h", "hero", { variant: "banner", heading: "मिठाई की दुकान" }),
        ]),
      ]);
    const english = await run(hindi());
    expect(check(english, "language").passed).toBe(false);
    const other = await run(
      hindi(),
      snapshot(),
      request({ brief: { ...request().brief, language: "Hindi" } }),
    );
    expect(other.checks.find((c) => c.id === "language")).toBeUndefined();
  });

  it("takes out long dashes and claims the merchant did not make", async () => {
    const out = await run(
      plan([
        page("", [
          sec("n-copy", "media_text", {
            heading: `Pressed slow${EM}by hand`,
            body: "Pressed slowly. The purest oil you can buy.",
          }),
        ]),
      ]),
    );
    const copy = conf(out.pages[0].sections[0]);
    expect(String(copy.heading)).not.toContain(EM);
    expect(copy.body).toBe("Pressed slowly.");
    const result = check(out, "claims");
    expect(result.passed).toBe(true);
    expect(result.note).toMatch(/"pure"/);
  });

  it("keeps a menu label it cannot blank, and says so", async () => {
    const out = await run(
      plan(
        [page("", [])],
        {},
        {
          header: {
            ...sanitizeChromeForSave({}).header,
            links: [{ label: "Purest oils", href: "/shop" }],
          },
        },
      ),
    );
    expect(out.chrome!.next.header.links[0].label).toBe("Purest oils");
    expect(check(out, "claims").passed).toBe(false);
    expect(check(out, "claims").note).toMatch(/header says "pure"/);
  });
});

describe("runRevampChecks: phones", () => {
  const opening = (mobile: string) =>
    plan(
      [
        page("", [
          sec("n-open", "hero", {
            variant: "fullbleed",
            heading: "Open",
            image_url: NEW1,
            mobile_image_url: mobile,
          }),
        ]),
      ],
      {
        photos: [
          { url: NEW1, path: "p", alt: "a", where: "Home page, opening photo" },
        ],
      },
    );

  it("needs a phone crop for a wide opening photograph", async () => {
    expect(check(await run(opening("")), "phones").passed).toBe(false);
    expect(
      check(
        await run(opening(`${gcs.bucket}stores/s1/new1~phone.webp`)),
        "phones",
      ).passed,
    ).toBe(true);
  });

  it("keeps at most seven links in the header", async () => {
    const links = "abcdefghi"
      .split("")
      .map((c) => ({ label: c, href: `https://example.com/${c}` }));
    const out = await run(
      plan(
        [page("", [])],
        {},
        { header: { ...sanitizeChromeForSave({}).header, links } },
      ),
    );
    expect(out.chrome!.next.header.links).toHaveLength(7);
    expect(check(out, "phones").note).toMatch(/first 7 links/);
  });
});

describe("runRevampChecks: the charge (money-2)", () => {
  const NEW2 = `${gcs.bucket}stores/s1/mink-generated/revamp/new2.webp`;
  const PRICES = REVAMP_PRICES;

  const charged = (extra: Partial<RevampStoredPlan> = {}) =>
    plan(
      [
        page("", [
          sec("n-gal", "gallery", {
            items: [
              { image_url: NEW1 },
              { image_url: GONE },
              { image_url: NEW2 },
            ],
          }),
        ]),
      ],
      {
        photos: [
          { url: NEW1, path: "a", alt: "a", where: "Home page, gallery" },
          { url: GONE, path: "b", alt: "b", where: "Home page, gallery" },
          { url: NEW2, path: "c", alt: "c", where: "Home page, gallery" },
        ],
        credits: {
          pages: PRICES.page,
          photos: 3 * PRICES.photo,
          design: PRICES.design,
          chrome: PRICES.chrome,
          categories: 0,
          productPhotos: 0,
          total: PRICES.page + 3 * PRICES.photo + PRICES.design + PRICES.chrome,
        },
        charges: {
          pages: [""],
          photoUrls: [NEW1, GONE, NEW2],
          design: true,
          chrome: true,
          categories: 0,
          productPhotoKeys: [],
        },
        ...extra,
      },
    );

  it("recounts the charge after taking a photo out, so the card never charges for one it does not show", async () => {
    const out = await run(charged());
    expect(out.photos.map((p) => p.url)).toEqual([NEW1, NEW2]);
    expect(out.credits).toEqual({
      pages: PRICES.page,
      photos: 2 * PRICES.photo,
      design: PRICES.design,
      chrome: PRICES.chrome,
      categories: 0,
      productPhotos: 0,
      total: PRICES.page + 2 * PRICES.photo + PRICES.design + PRICES.chrome,
    });
    expect(out.charges?.photoUrls).toEqual([NEW1, NEW2]);
  });

  it("charges no design when the new colours were too hard to read to keep", async () => {
    const p = charged();
    p.chrome!.next.design = {
      palette: { cream: "#fbf8f1", ink: "#fbf8f1" },
      fonts: { body: null, display: null },
      shape: {},
    };
    const out = await run(p);
    expect(out.chrome!.next.design.palette).toEqual({});
    expect(out.credits.design).toBe(0);
    expect(out.charges?.design).toBe(false);
  });

  it("leaves the charge of a plan stored before charges existed as it was", async () => {
    const p = charged();
    delete p.charges;
    const out = await run(p);
    expect(out.credits).toEqual(p.credits);
  });
});

describe("runRevampChecks: claims judged as the compiler judged them (output-3)", () => {
  const ORGANIC = {
    id: "c3",
    slug: "organic-oils",
    name: "Organic Oils",
    description: null,
    imageUrl: null,
    status: "active",
    updatedAt: "t",
    sample: false,
    productCount: 2,
  };
  const GHEE = {
    id: "x4",
    name: "Pure Cow Ghee",
    slug: "pure-cow-ghee",
    status: "published",
    updatedAt: "t",
    sample: false,
    imageUrl: null,
    categoryId: "c3",
  };

  it("★★ keeps the store's own category and product names, a confirmed category and the store's facts", async () => {
    const snap = snapshot();
    snap.categories.push(ORGANIC);
    snap.products.push(GHEE);
    snap.facts = {
      ...snap.facts,
      delivery: "Fresh vegetables delivered daily",
    } as RevampSnapshot["facts"];
    const req = request({
      categories: [
        {
          action: "create",
          name: "Natural Soaps",
          slug: null,
          description: null,
          newPhoto: false,
        },
      ],
    });
    const out = await run(
      plan(
        [
          page("", [
            sec("n-tiles", "tile_grid", {
              heading: "Shop the range",
              tiles: [
                { title: "Organic Oils", href: "/collections/organic-oils" },
                { title: "Natural Soaps", href: "/collections/natural-soaps" },
              ],
            }),
          ]),
          page("ghee", [sec("n-r", "rich_text", { html: "<p>Ghee</p>" })], {
            title: "Pure Cow Ghee",
            create: true,
            pageId: null,
            expectedVersion: null,
            expectedDigest: null,
          }),
        ],
        {},
        {
          header: {
            ...sanitizeChromeForSave({}).header,
            links: [
              { label: "Organic Oils", href: "/collections/organic-oils" },
            ],
            announcement: {
              enabled: true,
              text: "Fresh vegetables delivered daily",
              href: "",
            },
          },
        },
      ),
      snap,
      req,
    );
    const claims = check(out, "claims");
    expect(claims.passed).toBe(true);
    expect(claims.note).toBeNull();
    expect(out.chrome!.next.header.links[0].label).toBe("Organic Oils");
    expect(
      (conf(out.pages[0].sections[0]).tiles as Raw[]).map((t) => t.title),
    ).toEqual(["Organic Oils", "Natural Soaps"]);
    expect(out.pages[1].title).toBe("Pure Cow Ghee");
    expect(out.chrome!.next.header.announcement.text).toBe(
      "Fresh vegetables delivered daily",
    );
  });

  it("never counts a theme sample's name as the merchant's words", async () => {
    const snap = snapshot();
    snap.categories.push({ ...ORGANIC, sample: true });
    const out = await run(
      plan([
        page("", [
          sec("n-copy", "media_text", {
            heading: "Oils",
            body: "Pressed slowly. Organic oils from our mill.",
          }),
        ]),
      ]),
      snap,
    );
    expect(conf(out.pages[0].sections[0]).body).toBe("Pressed slowly.");
    expect(check(out, "claims").note).toMatch(/"organic"/);
  });
});

describe("runRevampChecks: the shop's own names in another script (output-4)", () => {
  function hindiShop(): RevampSnapshot {
    const snap = snapshot();
    snap.storeName = "मिठाई घर";
    snap.products.push({
      id: "x5",
      name: "काजू कतली",
      slug: "kaju-katli",
      status: "published",
      updatedAt: "t",
      sample: false,
      imageUrl: null,
      categoryId: null,
    });
    return snap;
  }

  it("★★ reads English copy that names the shop and its products as English, as the compiler does", async () => {
    const out = await run(
      plan([
        page("", [
          sec("n-h", "hero", {
            variant: "banner",
            heading: "Welcome to मिठाई घर",
          }),
          sec("n-m", "media_text", {
            heading: "Made fresh",
            body: "Our काजू कतली is made fresh.",
          }),
        ]),
      ]),
      hindiShop(),
    );
    const result = check(out, "language");
    expect(result.passed).toBe(true);
    expect(result.note).toBeNull();
  });

  it("still reports copy that is not English once the names are taken out", async () => {
    const out = await run(
      plan([
        page("", [
          sec("n-h", "hero", {
            variant: "banner",
            heading: "मिठाई घर में आपका स्वागत है",
          }),
        ]),
      ]),
      hindiShop(),
    );
    expect(check(out, "language").passed).toBe(false);
  });
});

describe("runRevampChecks: a product band with nothing featured to show (output-5)", () => {
  const feat = (over: Raw = {}) =>
    sec("n-feat", "featured_products", {
      heading: "Our oils",
      subheading: "",
      source: "featured",
      product_ids: [],
      category_id: null,
      limit: 4,
      ...over,
    });
  const created = {
    key: "p1",
    name: "Mustard Oil",
    slug: "mustard-oil",
    description: "Cold pressed.",
    categorySlug: null,
    imageUrl: null,
    sourceImageUrl: null,
    options: [],
    variants: [],
    price: 349,
    mrp: null,
  };

  it("★★ names the shop's own products when the redesign creates none and none is featured", async () => {
    const out = await run(plan([page("", [feat()])]));
    expect(conf(out.pages[0].sections[0])).toMatchObject({
      source: "manual",
      product_ids: ["x2"],
      category_id: null,
    });
    const result = check(out, "products");
    expect(result.passed).toBe(true);
    expect(result.note).toMatch(/your own products/);
  });

  it("leaves a featured band alone when the redesign creates products or one of the shop's own is featured", async () => {
    const withNew = await run(
      plan([page("", [feat()])], { products: { hide: [], create: [created] } }),
    );
    expect(conf(withNew.pages[0].sections[0]).source).toBe("featured");
    const snap = snapshot();
    snap.products[1] = { ...snap.products[1], featured: true };
    const featuredOwn = await run(plan([page("", [feat()])]), snap);
    expect(conf(featuredOwn.pages[0].sections[0]).source).toBe("featured");
    expect(check(featuredOwn, "products").note).toBeNull();
  });

  it("never names a theme sample, even a featured one", async () => {
    const snap = snapshot();
    snap.products[0] = { ...snap.products[0], featured: true };
    const out = await run(plan([page("", [feat()])]), snap);
    expect(conf(out.pages[0].sections[0])).toMatchObject({
      source: "manual",
      product_ids: ["x2"],
    });
  });
});

describe("runRevampChecks: links to the storefront's own pages (output-6)", () => {
  const footer = (links: Array<{ label: string; href: string }>) => ({
    ...sanitizeChromeForSave({}).footer,
    groups: [{ title: "Read", links }],
  });
  const OWN = [
    { label: "Blog", href: "/blogs" },
    { label: "Our first harvest", href: "/blogs/first-harvest" },
    { label: "Contact us", href: "/enquiries" },
    { label: "My orders", href: "/orders" },
  ];

  it("★★ keeps the store's own blog, post, enquiry and order links in a footer the plan kept", async () => {
    const snap = snapshot();
    snap.chrome = {
      ...snap.chrome,
      value: sanitizeChromeForSave({ footer: footer(OWN) }),
    };
    const out = await run(
      plan([page("", [])], {}, { footer: footer(OWN) }),
      snap,
    );
    expect(
      out.chrome!.next.footer.groups.flatMap((g) => g.links.map((l) => l.href)),
    ).toEqual(OWN.map((link) => link.href));
    expect(check(out, "links").note).toBeNull();
  });

  it("keeps the blog and the enquiry form wherever the plan links them", async () => {
    const out = await run(
      plan(
        [page("", [])],
        {},
        {
          header: {
            ...sanitizeChromeForSave({}).header,
            links: [
              { label: "Shop", href: "/shop" },
              { label: "Blogs", href: "/blogs" },
              { label: "Enquiries", href: "/enquiries" },
            ],
          },
        },
      ),
    );
    expect(out.chrome!.next.header.links.map((l) => l.href)).toEqual([
      "/shop",
      "/blogs",
      "/enquiries",
    ]);
    expect(check(out, "links").note).toBeNull();
  });

  it("still takes out a post the store does not link, and a sample's product page", async () => {
    const out = await run(
      plan(
        [page("", [])],
        {},
        {
          footer: footer([
            { label: "Made up", href: "/blogs/made-up" },
            { label: "Banana", href: "/shop/banana" },
            { label: "Blog", href: "/blogs" },
          ]),
        },
      ),
    );
    expect(
      out.chrome!.next.footer.groups.flatMap((g) => g.links.map((l) => l.href)),
    ).toEqual(["/blogs"]);
    expect(check(out, "links").note).toMatch(
      /2 links to a page that will not exist were taken out/,
    );
  });
});
