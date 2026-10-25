// ---------------------------------------------------------------------------
// Known-defect fixtures for the visual reviewer, with no I/O.
//
// The 2026-10-04 benchmark scored two themes 5/5 on every row while a human
// found duplicated newsletter forms, and never tested whether the reviewer
// could see a defect at all. A reviewer is only evidence once it has been
// shown pages with KNOWN faults and caught them. These fixtures are whole
// homepages in the storefront's own section markup, built from a bundled
// theme's catalogue (so the context the reviewer reads matches what it sees),
// rendered with production CSS by scripts/theme-studio-visual-fixtures.ts
// and pushed through the same evidence builder and request as a real run.
//
// Ten pages each carry ONE deliberate defect; ten are clean. Graded on the
// FINDINGS each page produces, never on the verdict ("Fix it, then allow
// Publish", TS-1B): a "revise" is only a warning under that rule. Eight
// defects are serious, and each page must produce its named serious finding;
// two are taste, and must produce at least a warning; a clean page must
// produce no serious finding. The bar is VISUAL_FIXTURE_BAR in every set, so
// all eight serious pages, both warning pages and nine of ten clean pages:
// a reviewer that blocks clean pages is as useless as one that passes broken
// ones, because every false block stops a theme from being published.
// ---------------------------------------------------------------------------

import { designToCssVars, type ThemeDefinition } from "@/lib/themes/types";
import type { RejectionCondition } from "./scorecard";
import {
  classifyVisualQaReport,
  type VisualQaReport,
} from "./visual-qa-request";

/** What the review must produce on a page: no serious finding (a clean
 * page), at least a warning, or its named serious finding. */
export type FixtureExpectation = "clean" | "warning" | "serious";

export interface VisualFixture {
  id: string;
  expected: FixtureExpectation;
  /** The serious finding a serious page must produce; null otherwise. */
  finding: RejectionCondition | null;
  /** The one defect on the page; null on a clean page. */
  defect: string | null;
  /** The operator brief the reviewer reads as the source of factual claims. */
  brief: string;
  /** What a human sees, for the report. */
  note: string;
  /** The page body inside `.home-sections`. */
  render: (theme: ThemeDefinition) => string;
}

export const VISUAL_FIXTURE_BAR = 0.9;

// ------------------------------------------------------------------ helpers

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A synthetic product photograph: a vessel on a seamless backdrop with a
 * soft shadow. Abstract, but unmistakably a staged object rather than a
 * blank tile, which is the difference the placeholder-art fixture tests. */
export function subjectImage(
  width: number,
  height: number,
  hue: number,
  dark = false,
): string {
  const bg = dark ? `hsl(${hue} 18% 18%)` : `hsl(${hue} 30% 90%)`;
  const bg2 = dark ? `hsl(${hue} 18% 10%)` : `hsl(${hue} 25% 80%)`;
  const body = dark ? `hsl(${hue} 35% 55%)` : `hsl(${hue} 40% 42%)`;
  const cx = width / 2;
  const w = Math.min(width, height) * 0.34;
  const h = Math.min(width, height) * 0.58;
  const top = height / 2 - h / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><ellipse cx="${cx}" cy="${top + h + 10}" rx="${w * 0.7}" ry="${w * 0.14}" fill="rgba(0,0,0,0.18)"/><rect x="${cx - w / 2}" y="${top}" width="${w}" height="${h}" rx="${w * 0.22}" fill="${body}"/><rect x="${cx - w * 0.42}" y="${top + h * 0.42}" width="${w * 0.84}" height="${h * 0.2}" rx="${w * 0.04}" fill="rgba(255,255,255,0.78)"/><rect x="${cx - w * 0.18}" y="${top - h * 0.09}" width="${w * 0.36}" height="${h * 0.1}" rx="${w * 0.05}" fill="${body}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** A flat single-colour tile: what an unfinished artwork slot looks like. */
export function placeholderImage(width: number, height: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#d9d2c8"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const FILL =
  'style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"';

interface Catalogue {
  name: string;
  products: { name: string; category: string; price: string }[];
  categories: string[];
  footerGroups: { title: string; links: string[] }[];
  tagline: string;
}

function money(amount: number | undefined): string {
  return `₹${Math.round(amount ?? 499).toLocaleString("en-IN")}`;
}

/** What the fixtures say, taken from the theme so the reviewer's context
 * (products, categories, menus) agrees with the page it is shown. */
export function catalogueOf(theme: ThemeDefinition): Catalogue {
  const sample = theme.preset.sampleData;
  const categories = (sample?.categories ?? []).map((c) => c.name);
  const products = (sample?.products ?? []).slice(0, 8).map((p, i) => ({
    name: p.name.replace(/\s*\((?:sample|demo)\)\s*$/i, ""),
    category: categories[i % Math.max(1, categories.length)] ?? "",
    price: money(p.variants?.[0]?.selling_price),
  }));
  return {
    name: theme.name,
    products,
    categories,
    footerGroups: theme.preset.menus.footerGroups.map((g) => ({
      title: g.title,
      links: g.links.map((l) => l.label),
    })),
    tagline: theme.preset.brand.tagline ?? "",
  };
}

const copy = {
  heroA: "Everyday essentials, chosen with care",
  heroB: "Fresh from the market, delivered by evening",
  heroC: "Pantry staples your kitchen will reach for daily",
  subA: "Small-batch favourites and weekly staples from makers we know by name.",
  subB: "Order before noon and collect from the counter the same day.",
  storyA:
    "We buy little and often, so what reaches your shelf was picked this week rather than stored for a season.",
  storyB:
    "Every label tells you who made it and where. If a maker changes a recipe, we tell you before you reorder.",
  usp: [
    ["Same-day collection", "Order before noon"],
    ["Honest pricing", "No membership, no markups"],
    ["Easy returns", "Within 7 days, no questions"],
  ],
  quotes: [
    [
      "The granola is the best I have had. Reorders every fortnight.",
      "Priya N.",
    ],
    [
      "Collection took two minutes and everything was packed with care.",
      "Tom A.",
    ],
    ["Finally a grocer that lists where things come from.", "Meera K."],
  ],
};

// ----------------------------------------------------------------- sections

function section(inner: string, extra = ""): string {
  return `<section class="home-section${extra ? ` ${extra}` : ""}">${inner}</section>`;
}

function head(title: string, sub?: string, styleAttr = ""): string {
  return `<div class="home-section-head"><h2 class="home-section-title"${styleAttr}>${esc(title)}</h2>${sub ? `<p class="home-section-sub"${styleAttr}>${esc(sub)}</p>` : ""}</div>`;
}

function hero(opts: {
  variant: "split" | "banner";
  theme: "dark" | "light";
  heading: string;
  sub: string;
  cta?: string;
  badge?: string;
  image?: string;
  background?: string;
  headingStyle?: string;
  subStyle?: string;
  ctaStyle?: string;
}): string {
  const cta = `<a class="home-hero-cta sm-btn-primary" href="/shop"${opts.ctaStyle ? ` style="${opts.ctaStyle}"` : ""}>${esc(opts.cta ?? "Shop the range")}</a>`;
  const media = opts.image
    ? `<img class="home-hero-img" alt="" src="${opts.image}" ${FILL}>`
    : "";
  const bg = opts.background ? ` style="background:${opts.background}"` : "";
  if (opts.variant === "banner") {
    return section(
      `<div class="home-hero variant-banner theme-${opts.theme} align-center"${bg}>${media ? `<div class="home-hero-bgmedia">${media}</div>` : ""}<div class="home-hero-copy">${opts.badge ? `<span class="home-hero-badge">${esc(opts.badge)}</span>` : ""}<h1 class="home-hero-heading"${opts.headingStyle ? ` style="${opts.headingStyle}"` : ""}>${esc(opts.heading)}</h1><p class="home-hero-sub"${opts.subStyle ? ` style="${opts.subStyle}"` : ""}>${esc(opts.sub)}</p>${cta}</div></div>`,
    );
  }
  return section(
    `<div class="home-hero variant-split theme-${opts.theme} align-left"${bg}><div class="home-hero-copy">${opts.badge ? `<span class="home-hero-badge">${esc(opts.badge)}</span>` : ""}<h1 class="home-hero-heading"${opts.headingStyle ? ` style="${opts.headingStyle}"` : ""}>${esc(opts.heading)}</h1><p class="home-hero-sub"${opts.subStyle ? ` style="${opts.subStyle}"` : ""}>${esc(opts.sub)}</p>${cta}</div>${media ? `<div class="home-hero-media">${media}</div>` : ""}</div>`,
  );
}

function usp(items: readonly (readonly string[])[], theme = "dark"): string {
  return section(
    `<div class="home-usp theme-${theme}">${items.map(([title, sub]) => `<div class="home-usp-item"><span class="home-usp-icon" aria-hidden="true"></span><span class="home-usp-text"><span class="home-usp-title">${esc(title)}</span><span class="home-usp-sub">${esc(sub)}</span></span></div>`).join("")}</div>`,
  );
}

function card(
  p: Catalogue["products"][number],
  index: number,
  opts: { placeholder?: boolean; nameStyle?: string } = {},
): string {
  const image = opts.placeholder
    ? placeholderImage(600, 800)
    : subjectImage(600, 800, (index * 47) % 360);
  return `<a href="/shop/item-${index + 1}" class="shop-card" style="--card-bg:#f6f2ec"><div class="shop-card-img"><img class="shop-card-img-el" alt="${esc(p.name)}" src="${image}" ${FILL}></div><div class="shop-card-body"><div class="shop-card-head">${p.category ? `<span class="shop-card-cat">${esc(p.category)}</span>` : ""}<h3 class="shop-card-name"${opts.nameStyle ? ` style="${opts.nameStyle}"` : ""}>${esc(p.name)}</h3></div><div class="shop-card-price"><span class="shop-card-current"><span class="shop-card-sell">${esc(p.price)}</span></span></div></div></a>`;
}

function products(
  cat: Catalogue,
  title: string,
  opts: {
    count?: number;
    empty?: boolean;
    placeholder?: boolean;
    nameStyle?: string;
    sub?: string;
    rename?: (name: string, i: number) => string;
  } = {},
): string {
  const items = opts.empty
    ? []
    : cat.products
        .slice(0, opts.count ?? 6)
        .map((p, i) =>
          card(
            opts.rename ? { ...p, name: opts.rename(p.name, i) } : p,
            i,
            opts,
          ),
        );
  return section(
    `${head(title, opts.sub)}<div class="home-product-carousel"><div class="home-product-scroll">${items.join("")}</div></div>`,
  );
}

function categories(
  cat: Catalogue,
  title: string,
  opts: { cards?: boolean; empty?: boolean; placeholder?: boolean } = {},
): string {
  const tiles = opts.empty
    ? []
    : cat.categories.slice(0, 6).map((name, i) => {
        const image = opts.placeholder
          ? placeholderImage(600, 600)
          : subjectImage(600, 600, (i * 71 + 20) % 360);
        return `<a href="/collections/${i}" class="home-cat-tile"><div class="home-cat-img"><img class="home-cat-img-el" alt="" src="${image}" ${FILL}></div><span class="home-cat-name">${esc(name)}</span></a>`;
      });
  return section(
    `${head(title)}<div class="home-cat-grid${opts.cards ? " is-cards" : ""}">${tiles.join("")}</div>`,
  );
}

function mediaText(opts: {
  heading: string;
  body: string;
  position?: "left" | "right";
  align?: "left" | "center";
  hue?: number;
  bodyStyle?: string;
  eyebrow?: string;
}): string {
  return section(
    `<div class="home-media-text media-${opts.position ?? "left"} align-${opts.align ?? "left"}"><div class="home-media-text-media ratio-portrait"><img class="home-media-text-image" alt="" src="${subjectImage(1200, 1500, opts.hue ?? 30)}" ${FILL}></div><div class="home-media-text-copy">${opts.eyebrow ? `<p class="home-section-eyebrow">${esc(opts.eyebrow)}</p>` : ""}<h2 class="home-media-text-heading">${esc(opts.heading)}</h2><p class="home-media-text-body"${opts.bodyStyle ? ` style="${opts.bodyStyle}"` : ""}>${esc(opts.body)}</p><a href="/shop" class="home-media-text-cta sm-btn-primary">Read our story</a></div></div>`,
  );
}

function testimonials(
  quotes: readonly (readonly string[])[],
  opts: { layout?: "cards" | "editorial"; empty?: boolean } = {},
): string {
  const items = opts.empty
    ? []
    : quotes.map(
        ([quote, author]) =>
          `<figure class="home-testimonial"><blockquote class="home-testimonial-quote">${esc(quote)}</blockquote><figcaption class="home-testimonial-attribution"><cite>${esc(author)}</cite> Verified customer</figcaption></figure>`,
      );
  return section(
    `${head("What customers say")}<div class="home-testimonials layout-${opts.layout ?? "cards"} cols-3">${items.join("")}</div>`,
  );
}

function newsletter(opts: {
  heading: string;
  sub: string;
  theme?: "dark" | "light";
  align?: "left" | "center";
}): string {
  return section(
    `<div class="home-newsletter theme-${opts.theme ?? "dark"} align-${opts.align ?? "center"}"><div class="home-newsletter-copy"><h2 class="home-newsletter-heading">${esc(opts.heading)}</h2><p class="home-newsletter-sub">${esc(opts.sub)}</p></div><form class="home-newsletter-form"><div class="home-newsletter-fields"><input class="home-newsletter-input" type="email" placeholder="you@example.com" aria-label="Email"><button class="home-newsletter-button sm-btn-primary" type="button">Subscribe</button></div><label class="home-newsletter-consent"><input type="checkbox"> I agree to receive store news and offers by email.</label></form></div>`,
  );
}

function promo(heading: string, sub: string, hue = 200): string {
  return section(
    `<div class="home-banner align-center theme-light"><img class="home-banner-img" alt="" src="${subjectImage(2400, 1000, hue, true)}" ${FILL}><div class="home-banner-overlay"></div><div class="home-banner-content"><h2 class="home-banner-heading">${esc(heading)}</h2><p class="home-banner-subtext">${esc(sub)}</p><a class="home-banner-cta sm-btn-primary" href="/shop">See the offer</a></div></div>`,
  );
}

/** The storefront footer in its module's own class names (the fixture
 * inlines Footer.module.css with its `:global()` wrappers stripped). The
 * signup bar carries the same `data-sm="footer-newsletter"` hook the real
 * footer does, so the one-form-per-page rule applies here too. */
export function fixtureFooter(
  cat: Catalogue,
  opts: { textStyle?: string } = {},
): string {
  const groups = cat.footerGroups.length
    ? cat.footerGroups
    : [{ title: "Shop", links: ["All products", "New in"] }];
  return `<footer class="footer"><div class="newsletterBar" data-sm="footer-newsletter"><div class="newsletterInner"><div class="newsletterText"><span class="newsletterLabel">Stay in the loop</span><p class="newsletterSub">New arrivals, offers and stories - no spam.</p></div><form class="newsletterForm"><div class="newsletterFields"><input class="newsletterInput" type="email" placeholder="you@example.com" aria-label="Email"><button class="newsletterBtn" type="button">Subscribe</button></div></form></div></div><div class="footerMain"><div class="mainGrid"><div class="brandCol"><a href="/" class="logo"><span class="brandNameText">${esc(cat.name)}</span></a>${cat.tagline ? `<p class="tagline"${opts.textStyle ? ` style="${opts.textStyle}"` : ""}>${esc(cat.tagline)}</p>` : ""}</div>${groups
    .slice(0, 3)
    .map(
      (g) =>
        `<div class="linkCol"><h2 class="columnTitle">${esc(g.title)}</h2><nav class="linkList">${g.links
          .slice(0, 5)
          .map(
            (l) =>
              `<a href="/${esc(l.toLowerCase().replace(/\s+/g, "-"))}"${opts.textStyle ? ` style="${opts.textStyle}"` : ""}>${esc(l)}</a>`,
          )
          .join("")}</nav></div>`,
    )
    .join(
      "",
    )}</div><div class="bottomSection"><div class="legalRow"><p class="copyright">© 2026 ${esc(cat.name)}. All rights reserved.</p><div class="legalLinks"><span><a href="/privacy-policy">Privacy</a></span><span><span class="legalDivider">·</span><a href="/terms">Terms</a></span></div></div></div></div></footer>`;
}

// ---------------------------------------------------------------- fixtures

const BRIEF =
  "A neighbourhood grocer and pantry store. Warm, plain-spoken and trustworthy; fresh produce, small-batch staples and same-day collection. No awards, press coverage or ratings to mention.";

const LUXURY_BRIEF =
  "A restrained luxury skincare store. Ivory, charcoal and a single muted clay accent; generous whitespace, quiet typography, no bright colour anywhere. No awards, press coverage or ratings to mention.";

const cleanPage = (cat: Catalogue, i: number): string[] => {
  const hueA = 25 + i * 9;
  const hero1 = hero({
    variant: "split",
    theme: "dark",
    heading: copy.heroA,
    sub: copy.subA,
    image: subjectImage(1200, 1500, hueA),
  });
  const story = mediaText({
    heading: "Bought little and often",
    body: copy.storyA,
    hue: hueA + 40,
  });
  const signup = newsletter({
    heading: "Fresh arrivals, once a week",
    sub: "One email on Thursdays. Unsubscribe any time.",
  });
  return [
    hero1,
    usp(copy.usp),
    products(cat, "This week's picks", { sub: "Chosen by the counter team" }),
    categories(cat, "Shop by aisle"),
    story,
    signup,
  ];
};

export const VISUAL_FIXTURES: readonly VisualFixture[] = [
  // ----------------------------------------------------------- clean pages
  {
    id: "clean-baseline",
    expected: "clean",
    finding: null,
    defect: null,
    brief: BRIEF,
    note: "Split hero, USP strip, products, aisles, story, dark signup band.",
    render: (theme) => cleanPage(catalogueOf(theme), 0).join(""),
  },
  {
    id: "clean-banner-hero",
    expected: "clean",
    finding: null,
    defect: null,
    brief: BRIEF,
    note: "Photographic banner hero with light copy on a dark image.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "banner",
          theme: "light",
          heading: copy.heroB,
          sub: copy.subB,
          image: subjectImage(2400, 1200, 210, true),
        }),
        categories(cat, "Shop by aisle"),
        products(cat, "Back in stock"),
        testimonials(copy.quotes),
        newsletter({
          heading: "Market days, in your inbox",
          sub: "What's arriving and what's nearly gone.",
        }),
      ].join("");
    },
  },
  {
    id: "clean-promo",
    expected: "clean",
    finding: null,
    defect: null,
    brief: BRIEF,
    note: "Story band on the right, a promo banner, signup mid-page.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading: copy.heroC,
          sub: copy.subA,
          image: subjectImage(1200, 1500, 60),
        }),
        products(cat, "Pantry favourites"),
        promo(
          "Weekend bundle: three staples for ₹999",
          "Until Sunday, in store and online.",
          160,
        ),
        mediaText({
          heading: "Labels that say who made it",
          body: copy.storyB,
          position: "right",
          hue: 100,
        }),
        newsletter({
          heading: "Join the Thursday list",
          sub: "One email a week. No spam.",
          theme: "light",
        }),
        categories(cat, "Browse the aisles", { cards: true }),
      ].join("");
    },
  },
  {
    id: "clean-cards-testimonials",
    expected: "clean",
    finding: null,
    defect: null,
    brief: BRIEF,
    note: "Category cards and editorial testimonials.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading: copy.heroA,
          sub: copy.subB,
          image: subjectImage(1200, 1500, 340),
        }),
        products(cat, "New this week"),
        categories(cat, "Shop by aisle", { cards: true }),
        testimonials(copy.quotes, { layout: "editorial" }),
        newsletter({
          heading: "Fresh arrivals, once a week",
          sub: "One email on Thursdays. Unsubscribe any time.",
        }),
      ].join("");
    },
  },
  {
    id: "clean-compact",
    expected: "clean",
    finding: null,
    defect: null,
    brief: BRIEF,
    note: "A short page: hero, products, aisles, signup.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading: copy.heroB,
          sub: copy.subA,
          image: subjectImage(1200, 1500, 15),
        }),
        products(cat, "This week's picks", { count: 8 }),
        categories(cat, "Shop by aisle"),
        usp(copy.usp),
        newsletter({
          heading: "Market days, in your inbox",
          sub: "What's arriving and what's nearly gone.",
        }),
      ].join("");
    },
  },
  {
    id: "clean-two-rows",
    expected: "clean",
    finding: null,
    defect: null,
    brief: BRIEF,
    note: "Two distinct product rows with different headings and selections.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading: copy.heroC,
          sub: copy.subB,
          image: subjectImage(1200, 1500, 120),
        }),
        mediaText({
          heading: "Bought little and often",
          body: copy.storyA,
          hue: 80,
        }),
        products(cat, "New arrivals", { count: 4 }),
        usp(copy.usp),
        newsletter({
          heading: "Join the Thursday list",
          sub: "One email a week. No spam.",
        }),
        products(cat, "Back in stock", {
          count: 4,
          rename: (name, i) =>
            cat.products[(i + 4) % cat.products.length]?.name ?? name,
        }),
        categories(cat, "Browse the aisles"),
      ].join("");
    },
  },
  {
    id: "clean-banner-usp",
    expected: "clean",
    finding: null,
    defect: null,
    brief: BRIEF,
    note: "Banner hero, USP strip, aisles, story on the right, products, signup.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "banner",
          theme: "light",
          heading: copy.heroA,
          sub: copy.subA,
          image: subjectImage(2400, 1200, 270, true),
        }),
        usp(copy.usp),
        categories(cat, "Shop by aisle"),
        mediaText({
          heading: "Labels that say who made it",
          body: copy.storyB,
          position: "right",
          align: "center",
          hue: 300,
        }),
        products(cat, "Pantry favourites"),
        newsletter({
          heading: "Fresh arrivals, once a week",
          sub: "One email on Thursdays. Unsubscribe any time.",
        }),
      ].join("");
    },
  },
  {
    id: "clean-long-heading",
    expected: "clean",
    finding: null,
    defect: null,
    brief: BRIEF,
    note: "A long hero heading that wraps cleanly; nothing clipped.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading:
            "Fresh produce, small-batch staples and the people who make them",
          sub: copy.subB,
          image: subjectImage(1200, 1500, 190),
        }),
        products(cat, "This week's picks"),
        testimonials(copy.quotes),
        categories(cat, "Shop by aisle", { cards: true }),
        newsletter({
          heading: "Join the Thursday list",
          sub: "One email a week. No spam.",
        }),
      ].join("");
    },
  },
  {
    id: "clean-eight-products",
    expected: "clean",
    finding: null,
    defect: null,
    brief: BRIEF,
    note: "A full eight-card row and a promo banner.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading: copy.heroB,
          sub: copy.subA,
          image: subjectImage(1200, 1500, 45),
        }),
        categories(cat, "Shop by aisle"),
        products(cat, "Everything new this week", { count: 8 }),
        mediaText({
          heading: "Bought little and often",
          body: copy.storyA,
          hue: 20,
        }),
        promo(
          "Collection is free, always",
          "Order by noon, collect by five.",
          40,
        ),
        newsletter({
          heading: "Market days, in your inbox",
          sub: "What's arriving and what's nearly gone.",
        }),
      ].join("");
    },
  },
  {
    id: "clean-light-signup",
    expected: "clean",
    finding: null,
    defect: null,
    brief: BRIEF,
    note: "Light signup band, story, aisles, testimonials.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading: copy.heroA,
          sub: copy.subA,
          image: subjectImage(1200, 1500, 320),
        }),
        products(cat, "Pantry favourites"),
        mediaText({
          heading: "Labels that say who made it",
          body: copy.storyB,
          eyebrow: "Our promise",
          hue: 250,
        }),
        categories(cat, "Browse the aisles"),
        testimonials(copy.quotes),
        newsletter({
          heading: "Fresh arrivals, once a week",
          sub: "One email on Thursdays. Unsubscribe any time.",
          theme: "light",
          align: "left",
        }),
      ].join("");
    },
  },
  // ---------------------------------------------------------- defect pages
  {
    id: "defect-duplicate-newsletter",
    expected: "warning",
    finding: null,
    defect: "duplicate_newsletter",
    brief: BRIEF,
    note: "The same full newsletter module twice, back to back, at the end of the page.",
    render: (theme) => {
      const page = cleanPage(catalogueOf(theme), 1);
      return [...page, page[page.length - 1]].join("");
    },
  },
  {
    id: "defect-placeholder-copy",
    expected: "serious",
    finding: "placeholder_copy",
    defect: "placeholder_copy",
    brief: BRIEF,
    note: "Lorem ipsum in the hero and story; a product named 'Product name here'.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading: copy.heroA,
          sub: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.",
          image: subjectImage(1200, 1500, 25),
        }),
        usp(copy.usp),
        products(cat, "This week's picks", {
          rename: (name, i) => (i === 1 ? "Product name here" : name),
        }),
        categories(cat, "Shop by aisle"),
        mediaText({
          heading: "Lorem ipsum dolor sit amet",
          body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.",
          hue: 65,
        }),
        newsletter({
          heading: "Fresh arrivals, once a week",
          sub: "One email on Thursdays. Unsubscribe any time.",
        }),
      ].join("");
    },
  },
  {
    id: "defect-invented-claims",
    expected: "serious",
    finding: "unsupported_claim",
    defect: "invented_claims",
    brief: BRIEF,
    note: "Awards, press and a rating the brief never mentioned.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading: copy.heroA,
          sub: copy.subA,
          badge: "Award-winning grocer · As seen in Vogue",
          image: subjectImage(1200, 1500, 25),
        }),
        usp([
          ["Rated 4.9/5", "By over 40,000 customers"],
          ["Dermatologist recommended", "Clinically proven freshness"],
          ["Voted best grocer 2025", "Three years running"],
        ]),
        products(cat, "This week's picks"),
        categories(cat, "Shop by aisle"),
        mediaText({
          heading: "Bought little and often",
          body: copy.storyA,
          hue: 65,
        }),
        newsletter({
          heading: "Fresh arrivals, once a week",
          sub: "One email on Thursdays. Unsubscribe any time.",
        }),
      ].join("");
    },
  },
  {
    id: "defect-hero-contrast",
    expected: "serious",
    finding: "inaccessible_copy",
    defect: "hero_contrast",
    brief: BRIEF,
    note: "White hero copy on a pale gold field (about 1.5:1), the Bubble defect.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "banner",
          theme: "light",
          heading: copy.heroB,
          sub: copy.subB,
          background: "#f5d061",
        }),
        usp(copy.usp),
        products(cat, "This week's picks"),
        categories(cat, "Shop by aisle"),
        mediaText({
          heading: "Bought little and often",
          body: copy.storyA,
          hue: 65,
        }),
        newsletter({
          heading: "Fresh arrivals, once a week",
          sub: "One email on Thursdays. Unsubscribe any time.",
        }),
      ].join("");
    },
  },
  {
    id: "defect-placeholder-art",
    expected: "serious",
    finding: "unfinished_surface",
    defect: "placeholder_art",
    brief: BRIEF,
    note: "Every product and aisle image is a flat beige block: unfinished artwork.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading: copy.heroA,
          sub: copy.subA,
          image: placeholderImage(1200, 1500),
        }),
        usp(copy.usp),
        products(cat, "This week's picks", { placeholder: true }),
        categories(cat, "Shop by aisle", { placeholder: true }),
        mediaText({
          heading: "Bought little and often",
          body: copy.storyA,
          hue: 65,
        }),
        newsletter({
          heading: "Fresh arrivals, once a week",
          sub: "One email on Thursdays. Unsubscribe any time.",
        }),
      ].join("");
    },
  },
  {
    id: "defect-empty-sections",
    expected: "serious",
    finding: "unfinished_surface",
    defect: "empty_sections",
    brief: BRIEF,
    note: "Headed product, aisle and testimonial sections with nothing under them.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading: copy.heroA,
          sub: copy.subA,
          image: subjectImage(1200, 1500, 25),
        }),
        products(cat, "This week's picks", { empty: true }),
        categories(cat, "Shop by aisle", { empty: true }),
        testimonials(copy.quotes, { empty: true }),
        mediaText({
          heading: "Bought little and often",
          body: copy.storyA,
          hue: 65,
        }),
        newsletter({
          heading: "Fresh arrivals, once a week",
          sub: "One email on Thursdays. Unsubscribe any time.",
        }),
      ].join("");
    },
  },
  {
    id: "defect-overlapping-copy",
    expected: "serious",
    finding: "inaccessible_copy",
    defect: "overlapping_copy",
    brief: BRIEF,
    note: "The hero heading sits on top of its subheading and button.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading: copy.heroA,
          sub: copy.subA,
          image: subjectImage(1200, 1500, 25),
          headingStyle: "position:relative;top:64px;z-index:2",
          subStyle: "position:relative;top:-8px",
        }),
        usp(copy.usp),
        products(cat, "This week's picks"),
        categories(cat, "Shop by aisle"),
        mediaText({
          heading: "Bought little and often",
          body: copy.storyA,
          hue: 65,
        }),
        newsletter({
          heading: "Fresh arrivals, once a week",
          sub: "One email on Thursdays. Unsubscribe any time.",
        }),
      ].join("");
    },
  },
  {
    id: "defect-illegible-text",
    expected: "serious",
    finding: "inaccessible_copy",
    defect: "illegible_text",
    brief: BRIEF,
    note: "Story copy, product names and footer links at 9px in pale grey.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      const tiny = "font-size:9px;color:#c4c4c4;line-height:1.1";
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading: copy.heroA,
          sub: copy.subA,
          image: subjectImage(1200, 1500, 25),
          subStyle: tiny,
        }),
        usp(copy.usp),
        products(cat, "This week's picks", { nameStyle: tiny }),
        categories(cat, "Shop by aisle"),
        mediaText({
          heading: "Bought little and often",
          body: copy.storyA,
          hue: 65,
          bodyStyle: tiny,
        }),
        newsletter({
          heading: "Fresh arrivals, once a week",
          sub: "One email on Thursdays. Unsubscribe any time.",
        }),
      ].join("");
    },
  },
  {
    id: "defect-off-brief-palette",
    expected: "warning",
    finding: null,
    defect: "off_brief_palette",
    brief: LUXURY_BRIEF,
    note: "The brief asks for ivory and charcoal; the page is neon green with hot-pink buttons.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      return [
        `<style>.storefront-root{--sm-cream:#39ff14;--sm-cream-deep:#b6ff9e;--sm-surface:#ccff33;--sm-accent:#ff1493;--sm-on-accent:#ffff00;--brand-primary:#ff1493}</style>`,
        hero({
          variant: "split",
          theme: "dark",
          heading: "Quiet rituals for considered skin",
          sub: "Three steps, no noise. Formulated to be forgotten about.",
          image: subjectImage(1200, 1500, 110),
        }),
        usp([
          ["Fragrance free", "Every formula"],
          ["Refillable", "Glass, not plastic"],
          ["Easy returns", "Within 30 days"],
        ]),
        products(cat, "The routine"),
        categories(cat, "Shop by step"),
        mediaText({
          heading: "Less, chosen well",
          body: "We make eleven things and change them slowly. What is on the shelf is what we use ourselves.",
          hue: 110,
        }),
        newsletter({
          heading: "Occasional notes",
          sub: "A few times a year, when something changes.",
        }),
      ].join("");
    },
  },
  {
    id: "defect-clipped-copy",
    expected: "serious",
    finding: "inaccessible_copy",
    defect: "clipped_copy",
    brief: BRIEF,
    note: "The hero heading and button are cut off mid-word; product names end in a hard clip.",
    render: (theme) => {
      const cat = catalogueOf(theme);
      const clip = "overflow:hidden;white-space:nowrap;display:block";
      return [
        hero({
          variant: "split",
          theme: "dark",
          heading:
            "Fresh produce, small-batch staples and the people who make them",
          sub: copy.subA,
          image: subjectImage(1200, 1500, 25),
          headingStyle: `${clip};max-width:62%`,
          ctaStyle: `${clip};max-width:96px`,
        }),
        usp(copy.usp),
        products(cat, "This week's picks", {
          nameStyle: `${clip};max-width:70%`,
          rename: (name) => `${name} in a reusable glass jar with a wooden lid`,
        }),
        categories(cat, "Shop by aisle"),
        mediaText({
          heading: "Bought little and often",
          body: copy.storyA,
          hue: 65,
        }),
        newsletter({
          heading: "Fresh arrivals, once a week",
          sub: "One email on Thursdays. Unsubscribe any time.",
        }),
      ].join("");
    },
  },
];

// ---------------------------------------------------------------- document

/** Does the page close on a newsletter section? Mirrors the renderer's
 * `data-sm-closing` so the footer's own form stands down, as in production. */
function closesOnNewsletter(body: string): boolean {
  const last = body.lastIndexOf('<section class="home-section');
  return last >= 0 && body.slice(last).includes('class="home-newsletter ');
}

/** The whole document the benchmark renders: the theme's own CSS variables
 * on `.storefront-root` (exactly what the storefront layout writes inline),
 * production stylesheets passed in by the script, the page and the footer. */
export function fixtureDocument(
  fixture: VisualFixture,
  theme: ThemeDefinition,
  css: string,
): string {
  const vars = designToCssVars(
    theme.preset.design,
    theme.preset.brand.primaryColor,
  );
  const style = [
    ...Object.entries(vars).map(([k, v]) => `${k}:${v}`),
    "--font-outfit:Georgia,'Times New Roman',serif",
    "--font-roboto:Helvetica,Arial,sans-serif",
    "--font-inter:Helvetica,Arial,sans-serif",
    "--font-dash:Helvetica,Arial,sans-serif",
  ].join(";");
  const body = fixture.render(theme);
  const closing = closesOnNewsletter(body)
    ? ' data-sm-closing="newsletter"'
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(theme.name)}</title><style>*{box-sizing:border-box}html,body{margin:0}body{font:16px/1.5 Helvetica,Arial,sans-serif;background:var(--sm-cream)}img{display:block}
${css}
</style></head><body><div class="storefront-root sm-themed-type sm-page-width sm-card-classic" style="${style}"><main><div class="home-sections"${closing}>${body}</div></main>${fixtureFooter(catalogueOf(theme))}</div></body></html>`;
}

// ----------------------------------------------------------------- summary

export interface FixtureResult {
  id: string;
  expected: FixtureExpectation;
  /** The serious finding a serious page must produce; null otherwise. */
  finding: RejectionCondition | null;
  /** The parsed review; null when the reviewer gave no usable answer, which
   * counts as a miss in every set. */
  report: VisualQaReport | null;
}

export interface FixtureBenchmarkSummary {
  serious: { total: number; caught: number; missed: string[] };
  warnings: { total: number; caught: number; missed: string[] };
  clean: { total: number; passed: number; falseFails: string[] };
  unanswered: string[];
  /** Serious pages that produced their named serious finding. */
  catchRate: number;
  /** Warning pages that produced at least a warning. */
  warningRate: number;
  /** Clean pages with no serious finding. */
  passRate: number;
  ok: boolean;
}

/** Did this page's review produce what the page must produce? Graded on the
 * findings, through the same rules production settles a review with. */
export function fixtureCaught(result: FixtureResult): boolean {
  if (!result.report) return false;
  const severity = classifyVisualQaReport(result.report, []);
  if (result.expected === "clean") return severity.serious.length === 0;
  if (result.expected === "warning") return severity.outcome !== "pass";
  return severity.serious.some((f) => f.code === result.finding);
}

/** Each set must reach VISUAL_FIXTURE_BAR: every serious page its serious
 * finding, every warning page at least a warning, nine of ten clean pages no
 * serious finding. */
export function fixtureBenchmarkSummary(
  results: readonly FixtureResult[],
): FixtureBenchmarkSummary {
  const of = (expected: FixtureExpectation) =>
    results.filter((r) => r.expected === expected);
  const serious = of("serious");
  const warnings = of("warning");
  const clean = of("clean");
  const missed = serious.filter((r) => !fixtureCaught(r)).map((r) => r.id);
  const quiet = warnings.filter((r) => !fixtureCaught(r)).map((r) => r.id);
  const falseFails = clean.filter((r) => !fixtureCaught(r)).map((r) => r.id);
  const rate = (total: number, failed: number) =>
    total ? (total - failed) / total : 0;
  const catchRate = rate(serious.length, missed.length);
  const warningRate = rate(warnings.length, quiet.length);
  const passRate = rate(clean.length, falseFails.length);
  return {
    serious: {
      total: serious.length,
      caught: serious.length - missed.length,
      missed,
    },
    warnings: {
      total: warnings.length,
      caught: warnings.length - quiet.length,
      missed: quiet,
    },
    clean: {
      total: clean.length,
      passed: clean.length - falseFails.length,
      falseFails,
    },
    unanswered: results.filter((r) => r.report === null).map((r) => r.id),
    catchRate,
    warningRate,
    passRate,
    ok:
      serious.length > 0 &&
      warnings.length > 0 &&
      clean.length > 0 &&
      catchRate >= VISUAL_FIXTURE_BAR &&
      warningRate >= VISUAL_FIXTURE_BAR &&
      passRate >= VISUAL_FIXTURE_BAR,
  };
}
