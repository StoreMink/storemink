// ---------------------------------------------------------------------------
// Site chrome — the header and footer, as builder-editable content.
//
// One typed schema, normalised on read and sanitised on write, in the shape
// lib/homepage/section-types.ts already uses for page sections. Pure: no DB, no
// React, so the builder inspector, the storefront renderer and the server
// action all agree on what a header IS by importing the same file.
//
// Replaces lib/menus.ts, which only ever covered the LINKS. The rest of the
// chrome — newsletter, contact block, social row, badges — was hardcoded in
// Footer.jsx with no way for a merchant to touch it, and the logo/social URLs
// lived in stores.settings.brand behind a different dashboard page.
// ---------------------------------------------------------------------------

import {
  defaultTemplates,
  hasProductBlock,
  normalizeCollectionTemplate,
  normalizeProductTemplate,
  type CollectionTemplate,
  type ProductTemplate,
  type ThemeTemplates,
  normalizeBlogTemplate,
  normalizeAccountTemplate,
  type BlogTemplate,
  type AccountTemplate,
} from "@/lib/themes/templates";
import {
  EMPTY_DESIGN_OVERRIDES,
  validateStorefrontDesign,
  type StorefrontDesignOverrides,
} from "./design";
import { cleanNavLinks, cleanNavTree, type NavLink } from "./nav";
import { announcementHref } from "@/lib/themes/announcement";

/** A header link may nest (children, grandchildren, a mega-menu image); a
 * footer link never does. See lib/chrome/nav.ts. */
export type ChromeLink = NavLink;

export interface FooterGroup {
  title: string;
  links: ChromeLink[];
}

export interface HeaderConfig {
  links: ChromeLink[];
  /** Search box in the header. Off for stores that sell a handful of SKUs. */
  showSearch: boolean;
  /** Account / sign-in affordance. */
  showAccount: boolean;
  /** Cart icon. A catalogue-only store (enquiry-led B2B) turns this off. */
  showCart: boolean;
  /** Keep the bar pinned when the visitor scrolls. */
  sticky: boolean;
  /** The announcement bar: one line of copy above the header, the way
   *  Shopify themes carry a delivery promise or a sale. Enabled with empty
   *  text shows the pinned theme's announcement, when the theme has one
   *  (lib/themes/announcement.ts); text here is the merchant's own; disabled
   *  shows none. Every row saved before the field existed reads as enabled
   *  and empty, so a store inherits its theme's bar rather than losing it. */
  announcement: AnnouncementConfig;
}

export interface AnnouncementConfig {
  enabled: boolean;
  text: string;
  /** "" or a site path the bar links to. */
  href: string;
}

export interface FooterBlockToggle {
  enabled: boolean;
}

export interface NewsletterConfig extends FooterBlockToggle {
  heading: string;
  subtext: string;
  buttonLabel: string;
  consentText: string;
}

export type HeaderVariant =
  | "classic"
  | "market"
  | "centered"
  | "minimal"
  | "transparent"
  | "hamburger"
  | "stacked"
  | "utility";
export type CardVariant =
  | "classic"
  | "quick_add"
  | "overlay"
  | "framed"
  | "grocery"
  | "centered"
  | "soft"
  | "wide";
export type ProductDetailVariant =
  | "classic"
  | "grocery"
  | "editorial"
  | "stacked";
export type CartVariant = "classic" | "grocery" | "compact";
export type FooterVariant =
  | "rich"
  | "minimal"
  | "editorial"
  | "centered"
  | "compact";
/** The classic card's photo frame. Portrait (3:4) is the default; a store
 *  whose product photos are square picks square (1:1) so nothing is cropped. */
export type CardPhoto = "portrait" | "square";
/** Shop grid: one card per product, or one per colour (H&M). */
export type ProductCards = "product" | "colour";

/** `theme` means inherit the pinned preset; every explicit value is a
 * merchant-owned, published override edited in the visual builder. */
export interface StorefrontAppearance {
  header: "theme" | HeaderVariant;
  card: "theme" | CardVariant;
  productDetail: "theme" | ProductDetailVariant;
  cart: "theme" | CartVariant;
  footer: "theme" | FooterVariant;
  /** Merchant-only (no theme value): which frame the classic card uses. */
  cardPhoto: CardPhoto;
  /** Merchant-only: one shop-grid card per product, or per colour. */
  productCards: ProductCards;
  /**
   * Shopping extras every store has unless its merchant switches one off
   * (owner, 22 Nov 2026: "on for every store"). Merchant-only, no theme
   * value. Absent on every row saved before they existed, which reads as on.
   * - wishlist: a heart on product cards and the product page, and the
   *   "Saved items" page; the list lives on the shopper's device.
   * - recentlyViewed: the products a shopper looked at, under a product.
   * - storeLocator: the "Our stores" page and its footer link, when the
   *   store has at least one shop location.
   */
  wishlist: boolean;
  recentlyViewed: boolean;
  storeLocator: boolean;
  /** Page templates (plan Phase 2e): the product page's gallery and blocks
   *  and the collection page's filters, paging and promo tiles. `theme`
   *  inherits the pinned preset's (or the composition its layout implies). */
  templates: {
    product: "theme" | ProductTemplate;
    collection: "theme" | CollectionTemplate;
    blog: "theme" | BlogTemplate;
    account: "theme" | AccountTemplate;
  };
}

export interface ResolvedStorefrontAppearance {
  header: HeaderVariant;
  card: Exclude<CardVariant, "quick_add">;
  cardQuickAdd: boolean;
  cardPhoto: CardPhoto;
  productCards: ProductCards;
  /** The merchant's shopping extras (StorefrontAppearance). */
  wishlist: boolean;
  recentlyViewed: boolean;
  storeLocator: boolean;
  /** Theme-driven only: hover-swap is orthogonal to the merchant's card
   *  choice, so a `card` override neither enables nor cancels it. */
  cardHoverImage: boolean;
  /** Theme-driven, like cardHoverImage: shopping chrome the merchant cannot
   *  override yet. */
  stickyAddToCart: boolean;
  gridColumnsMobile: 1 | 2;
  gridColumnsDesktop: 3 | 4 | 5;
  /** Shared shopping controls, available for every theme. */
  shopFilters: boolean;
  /** Theme-driven: a collection page's image-and-description banner. */
  collectionBanner: boolean;
  productDetail: ProductDetailVariant;
  cart: CartVariant;
  footer: FooterVariant;
  /** The templates the pages render: the theme's, or the merchant's. */
  templates: ThemeTemplates;
}

export interface FooterConfig {
  groups: FooterGroup[];
  /** The legal row along the bottom (Privacy, Terms, …). */
  legal: ChromeLink[];
  newsletter: NewsletterConfig;
  /** Email/phone/hours strip. The VALUES come from brand (settings.brand). */
  contact: FooterBlockToggle;
  /** Social icon row. The URLs come from brand. */
  social: FooterBlockToggle;
  /** Trust badges. The badge list comes from brand. */
  badges: FooterBlockToggle;
  /** "Powered by StoreMink" — plan-gated elsewhere, see PLAN_LIMITS.removeBadge. */
  showCredit: boolean;
}

export interface StoreChrome {
  appearance: StorefrontAppearance;
  /**
   * Palette, type and shape the merchant owns, over the pinned theme.
   *
   * ★ IT RIDES HERE RATHER THAN IN A NEW TABLE because store_chrome already
   * has exactly the contract a design edit needs — one row per store, draft +
   * published jsonb, anon SELECT revoked on `draft` — so it inherits the
   * draft → publish safety and needs no migration. `appearance` above is the
   * LAYOUT axis (which header, which card); this is the SKIN.
   */
  design: StorefrontDesignOverrides;
  header: HeaderConfig;
  footer: FooterConfig;
}

// Caps: keep the payload small and the rendered chrome sane. A footer with 40
// columns is not a footer.
const MAX_LINKS = 12;
const MAX_GROUPS = 6;
const MAX_LABEL = 60;
const MAX_TEXT = 160;

/**
 * The out-of-the-box chrome.
 *
 * Every toggle defaults to what Footer.jsx / Header.jsx render TODAY, so a
 * store that has never opened the builder looks exactly as it did. A default
 * that changes a live storefront is a migration bug wearing a config hat.
 */
export const DEFAULT_CHROME: StoreChrome = {
  // Empty means inherit the theme at every token — the same
  // default-changes-nothing rule the toggles below follow.
  design: EMPTY_DESIGN_OVERRIDES,
  appearance: {
    header: "theme",
    card: "theme",
    productDetail: "theme",
    cart: "theme",
    footer: "theme",
    cardPhoto: "portrait",
    productCards: "product",
    wishlist: true,
    recentlyViewed: true,
    storeLocator: true,
    templates: {
      product: "theme",
      collection: "theme",
      blog: "theme",
      account: "theme",
    },
  },
  header: {
    links: [
      { label: "Shop", href: "/shop" },
      { label: "Blogs", href: "/blogs" },
      { label: "Enquiries", href: "/enquiries" },
    ],
    showSearch: true,
    showAccount: true,
    showCart: true,
    sticky: true,
    announcement: { enabled: true, text: "", href: "" },
  },
  footer: {
    groups: [
      {
        title: "Shop",
        links: [{ label: "All Products", href: "/shop" }],
      },
      {
        title: "Company",
        links: [
          { label: "Our Story", href: "/our-story" },
          { label: "Blog", href: "/blogs" },
        ],
      },
      {
        title: "Support",
        links: [
          { label: "FAQs", href: "/faqs" },
          { label: "Track My Order", href: "/track-order" },
        ],
      },
    ],
    legal: [
      { label: "Privacy Policy", href: "/privacy-policy" },
      { label: "Terms of Use", href: "/terms" },
      { label: "Refund Policy", href: "/refund-policy" },
    ],
    newsletter: {
      enabled: true,
      heading: "Stay in the loop",
      subtext: "New arrivals, offers and stories - no spam.",
      buttonLabel: "Subscribe",
      consentText: "I agree to receive store news and offers by email.",
    },
    contact: { enabled: true },
    social: { enabled: true },
    badges: { enabled: true },
    showCredit: true,
  },
};

// ── coercion helpers ────────────────────────────────────────────────────────

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** Missing means "use the default", not "off" — see DEFAULT_CHROME. */
const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

const cleanLinks = (raw: unknown): ChromeLink[] =>
  cleanNavLinks(raw, MAX_LINKS);

function cleanGroups(raw: unknown): FooterGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((g): FooterGroup | null => {
      if (!g || typeof g !== "object") return null;
      const gr = g as Record<string, unknown>;
      const title = str(gr.title, MAX_LABEL);
      const links = cleanLinks(gr.links);
      // A group with neither a title nor links renders as a blank column.
      if (!title && links.length === 0) return null;
      return { title, links };
    })
    .filter((g): g is FooterGroup => g !== null)
    .slice(0, MAX_GROUPS);
}

function cleanHeader(raw: unknown, d: HeaderConfig): HeaderConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const links = cleanNavTree(r.links);
  return {
    links,
    showSearch: bool(r.showSearch, d.showSearch),
    showAccount: bool(r.showAccount, d.showAccount),
    showCart: bool(r.showCart, d.showCart),
    sticky: bool(r.sticky, d.sticky),
    announcement: cleanAnnouncement(r.announcement, d.announcement),
  };
}

/** The bar's copy is bounded like a footer line and its link is held to the
 *  same site-path rule a theme link is (never a script, never off-site). */
function cleanAnnouncement(
  raw: unknown,
  d: AnnouncementConfig,
): AnnouncementConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: bool(r.enabled, d.enabled),
    text: str(r.text, MAX_TEXT),
    href: announcementHref(r.href),
  };
}

function cleanFooter(raw: unknown, d: FooterConfig): FooterConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (r.newsletter ?? {}) as Record<string, unknown>;
  return {
    groups: cleanGroups(r.groups),
    legal: cleanLinks(r.legal),
    newsletter: {
      enabled: bool(n.enabled, d.newsletter.enabled),
      heading: str(n.heading, MAX_TEXT) || d.newsletter.heading,
      subtext: str(n.subtext, MAX_TEXT) || d.newsletter.subtext,
      buttonLabel: str(n.buttonLabel, MAX_LABEL) || d.newsletter.buttonLabel,
      consentText: str(n.consentText, MAX_TEXT) || d.newsletter.consentText,
    },
    contact: {
      enabled: bool(
        (r.contact as Record<string, unknown>)?.enabled,
        d.contact.enabled,
      ),
    },
    social: {
      enabled: bool(
        (r.social as Record<string, unknown>)?.enabled,
        d.social.enabled,
      ),
    },
    badges: {
      enabled: bool(
        (r.badges as Record<string, unknown>)?.enabled,
        d.badges.enabled,
      ),
    },
    showCredit: bool(r.showCredit, d.showCredit),
  };
}

const HEADER_VARIANTS: HeaderVariant[] = [
  "classic",
  "market",
  "centered",
  "minimal",
  "transparent",
  "hamburger",
  "stacked",
  "utility",
];
const CARD_VARIANTS: CardVariant[] = [
  "classic",
  "quick_add",
  "overlay",
  "framed",
  "grocery",
  "centered",
  "soft",
  "wide",
];
const PRODUCT_VARIANTS: ProductDetailVariant[] = [
  "classic",
  "grocery",
  "editorial",
  "stacked",
];
const CART_VARIANTS: CartVariant[] = ["classic", "grocery", "compact"];
const FOOTER_VARIANTS: FooterVariant[] = [
  "rich",
  "minimal",
  "editorial",
  "centered",
  "compact",
];

function appearanceValue<T extends string>(
  value: unknown,
  variants: readonly T[],
): "theme" | T {
  return value === "theme" || variants.includes(value as T)
    ? (value as "theme" | T)
    : "theme";
}

function cleanAppearance(raw: unknown): StorefrontAppearance {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    header: appearanceValue(r.header, HEADER_VARIANTS),
    card: appearanceValue(r.card, CARD_VARIANTS),
    productDetail: appearanceValue(r.productDetail, PRODUCT_VARIANTS),
    cart: appearanceValue(r.cart, CART_VARIANTS),
    footer: appearanceValue(r.footer, FOOTER_VARIANTS),
    // Absent on every row saved before this setting existed: portrait.
    cardPhoto: r.cardPhoto === "square" ? "square" : "portrait",
    productCards: r.productCards === "colour" ? "colour" : "product",
    // On unless the merchant switched it off: absent (every row saved before
    // 22 Nov 2026) is on.
    wishlist: r.wishlist !== false,
    recentlyViewed: r.recentlyViewed !== false,
    storeLocator: r.storeLocator !== false,
    templates: cleanTemplateOverrides(r.templates),
  };
}

/** A merchant's template overrides: "theme" (the default, and what every
 *  row saved before templates existed reads as) or a complete template,
 *  coerced the way the storefront will render it. */
function cleanTemplateOverrides(
  raw: unknown,
): StorefrontAppearance["templates"] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const neutral = defaultTemplates(undefined);
  return {
    product:
      r.product && typeof r.product === "object"
        ? normalizeProductTemplate(r.product, neutral.product)
        : "theme",
    collection:
      r.collection && typeof r.collection === "object"
        ? normalizeCollectionTemplate(r.collection, neutral.collection)
        : "theme",
    blog:
      r.blog && typeof r.blog === "object"
        ? normalizeBlogTemplate(r.blog, neutral.blog)
        : "theme",
    account:
      r.account && typeof r.account === "object"
        ? normalizeAccountTemplate(r.account, neutral.account)
        : "theme",
  };
}

/**
 * Coerce arbitrary jsonb (a store_chrome row, or a draft mid-edit) into usable
 * chrome, falling back to DEFAULT_CHROME per field.
 *
 * Empty link lists fall back to the defaults here because this feeds the
 * STOREFRONT: a store with no header links should show something navigable
 * rather than a bare logo. sanitizeChromeForSave is the counterpart that
 * preserves an explicit empty.
 */
export function normalizeChrome(raw: unknown): StoreChrome {
  const r = (raw ?? {}) as Record<string, unknown>;
  const header = cleanHeader(r.header, DEFAULT_CHROME.header);
  const footer = cleanFooter(r.footer, DEFAULT_CHROME.footer);
  return {
    appearance: cleanAppearance(r.appearance),
    // Read path: safety normalisation only. Contrast is judged at PUBLISH, so
    // a merchant mid-edit still sees their own draft in the preview.
    design: validateStorefrontDesign(r.design, null, "draft").design,
    header: {
      ...header,
      links: header.links.length ? header.links : DEFAULT_CHROME.header.links,
    },
    footer: {
      ...footer,
      groups: footer.groups.length
        ? footer.groups
        : DEFAULT_CHROME.footer.groups,
      legal: footer.legal.length ? footer.legal : DEFAULT_CHROME.footer.legal,
    },
  };
}

/**
 * Sanitise for saving. Same cleaning, but an empty list STAYS empty — deleting
 * every footer column is a decision, and normalizeChrome silently restoring the
 * defaults would make that edit impossible to perform.
 */
export function sanitizeChromeForSave(raw: unknown): StoreChrome {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    appearance: cleanAppearance(r.appearance),
    design: validateStorefrontDesign(r.design, null, "draft").design,
    header: cleanHeader(r.header, DEFAULT_CHROME.header),
    footer: cleanFooter(r.footer, DEFAULT_CHROME.footer),
  };
}

/** Resolve a preset's layout with published merchant overrides. Legacy
 * `storefront:grocery` remains a fallback so pinned Basket 1.0 stores do not
 * change merely because the richer Phase 3 contract shipped. */
export function resolveStorefrontAppearance(
  theme: import("@/lib/themes/types").ThemeLayout | undefined,
  overrides: StorefrontAppearance = DEFAULT_CHROME.appearance,
  /** The preset's own templates; absent = what its layout implies. */
  themeTemplates?: ThemeTemplates,
): ResolvedStorefrontAppearance {
  const base = themeTemplates ?? defaultTemplates(theme);
  // Older callers (and rows saved before templates existed) carry no key.
  const chosen = overrides.templates ?? DEFAULT_CHROME.appearance.templates;
  const templates: ThemeTemplates = {
    product: chosen.product === "theme" ? base.product : chosen.product,
    collection:
      chosen.collection === "theme" ? base.collection : chosen.collection,
    // Rows saved between the first two templates and these carry no key.
    blog: !chosen.blog || chosen.blog === "theme" ? base.blog : chosen.blog,
    account:
      !chosen.account || chosen.account === "theme"
        ? base.account
        : chosen.account,
  };
  const legacyGrocery = theme?.storefront === "grocery";
  const themeCard = legacyGrocery ? "grocery" : (theme?.card ?? "classic");
  const overrideCard = overrides.card;
  const cardQuickAdd =
    overrideCard === "theme"
      ? theme?.card === "quick_add"
      : overrideCard === "quick_add";
  const card =
    overrideCard === "theme"
      ? themeCard === "quick_add"
        ? "classic"
        : themeCard
      : overrideCard === "quick_add"
        ? "classic"
        : overrideCard;

  return {
    header:
      overrides.header === "theme"
        ? (theme?.header ?? "classic")
        : overrides.header,
    card,
    cardQuickAdd,
    cardPhoto: overrides.cardPhoto === "square" ? "square" : "portrait",
    productCards: overrides.productCards === "colour" ? "colour" : "product",
    wishlist: overrides.wishlist !== false,
    recentlyViewed: overrides.recentlyViewed !== false,
    storeLocator: overrides.storeLocator !== false,
    cardHoverImage: theme?.cardHoverImage === true,
    // One truth: the phone sticky bar is a product-page block (the default
    // blocks carry it exactly when the layout asked for it).
    stickyAddToCart: hasProductBlock(templates.product, "sticky_bar"),
    gridColumnsMobile: theme?.gridColumnsMobile === 2 ? 2 : 1,
    gridColumnsDesktop:
      theme?.gridColumnsDesktop === 3 || theme?.gridColumnsDesktop === 5
        ? theme.gridColumnsDesktop
        : 4,
    // Existing pinned themes may omit this flag or store false. Discovery
    // controls are core storefront behaviour, independent of theme styling.
    shopFilters: true,
    collectionBanner: theme?.collectionBanner === true,
    productDetail:
      overrides.productDetail === "theme"
        ? (theme?.productDetail ?? (legacyGrocery ? "grocery" : "classic"))
        : overrides.productDetail,
    cart:
      overrides.cart === "theme"
        ? (theme?.cart ?? (legacyGrocery ? "grocery" : "classic"))
        : overrides.cart,
    footer:
      overrides.footer === "theme"
        ? (theme?.footer ?? "rich")
        : overrides.footer,
    templates,
  };
}
