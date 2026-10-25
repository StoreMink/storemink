import "server-only";

// ---------------------------------------------------------------------------
// Mink storefront revamp: the checks step (docs/mink-storefront-revamp.md,
// section 7). The assembled plan is checked the way a careful person would
// check it before showing it to the merchant, and every problem that has a
// mechanical fix is fixed FIRST: a photo that does not load is taken out, a
// link to a page that will not exist is dropped, an unreadable hero flips its
// text colour. What remains is reported on the card in plain words.
//
// ★★ A MISSING IMAGE OR A DEAD LINK IS NEVER LEFT FOR THE MERCHANT TO FIND.
//    Both always have a fix (clear the field, or remove the section that
//    cannot show without it), so those checks always end up passing, with a
//    note saying what was taken out. Only problems with no mechanical answer
//    (text in the wrong language, a merchant's own unfinished section) end as
//    passed: false.
// ★ The merchant's own sections are left as they are, except for photos this
//   revamp put into them: their words, links and layout are theirs.
// ---------------------------------------------------------------------------

import {
  contrastIssuesFor,
  EMPTY_DESIGN_OVERRIDES,
  validateStorefrontDesign,
  type StorefrontDesignOverrides,
} from "@/lib/chrome/design";
import type { NavLink } from "@/lib/chrome/nav";
import { sanitizeChromeForSave, type FooterGroup } from "@/lib/chrome/types";
import { IMAGE_SPECS } from "@/lib/media/image-specs";
import {
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { gcsObjectInfo, gcsPathFromUrl } from "@/lib/storage/gcs";
import { solidHeroContrast } from "@/lib/themes/hero-contrast";
import type { ThemeDefinition } from "@/lib/themes/types";
import {
  isRevampMerchantSection,
  isRevampSlotRef,
  revampCreditsFromCharges,
  revampMediaFields,
  revampPageChanges,
  revampPageName,
  revampSectionLabel,
  revampSectionRenders,
  revampSetValueAt,
  revampSnapshotPageFor,
  revampValueAt,
} from "./assemble";
import {
  countLabel,
  type RevampCheck,
  type RevampRequest,
  type RevampSnapshot,
  type RevampSnapshotPage,
  type RevampStoredPage,
  type RevampStoredPlan,
} from "./contract";
import {
  cleanRevampCopy,
  hasLongDash,
  isEnglish,
  readsAsLanguage,
  revampClaimEvidence,
  revampStoreNames,
  withoutStoreNames,
  withoutUnsupportedClaims,
} from "./copy-checks";
import { revampSectionsDigest } from "./digests";
import type { RevampCheckRun, RevampStepContext } from "./ports";
import {
  checkRevampLink,
  fallbackSeoDescription,
  revampAlwaysServedLink,
  isLightColour,
  normalizeRevampHex,
  REVAMP_MAX_HEADER_LINKS,
  revampCategoryBandAllowed,
  revampFeaturedBinding,
  revampFrameKeyFor,
  revampHasRealProducts,
  revampLinkTargets,
} from "./site-compiler";

type Path = Array<string | number>;

/** Storage reads in flight at once (a revamp can carry 30 photographs). */
const STORAGE_CONCURRENCY = 6;

/** The SEO description floor the compiler holds pages to. */
const SEO_DESCRIPTION_MIN = 20;

/** Wider than this, an opening photograph needs its own phone crop (the compiler's rule). */
const WIDE_ASPECT = 1.2;

const PRODUCT_SECTION_TYPES: ReadonlySet<string> = new Set([
  "featured_products",
  "product_spotlight",
]);

/** Config keys that hold settings, ids or code, never words a shopper reads. */
const NON_TEXT_KEY =
  /(^id$|_id$|_ids$|_url$|href$|^variant$|^theme$|^background$|^source$|^layout$|^alignment$|^align|ratio$|^height$|^width$|^padding|^scheme$|^style$|^icon$|position$|^display$|^html$|^css$|^js$|^ends_at$|^speed$|^columns$|^limit$|^type$|^span$|^tone$|^mode$|^focal_)/;

interface Tally {
  fixed: string[];
  open: string[];
}

function tally(): Tally {
  return { fixed: [], open: [] };
}

function toCheck(id: string, label: string, t: Tally): RevampCheck {
  const note = [...t.fixed, ...t.open].join(" ").trim();
  return { id, label, passed: t.open.length === 0, note: note || null };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Every string inside a section config, with its path and the key that holds it. */
function stringFields(
  config: unknown,
): Array<{ path: Path; key: string; value: string }> {
  const out: Array<{ path: Path; key: string; value: string }> = [];
  const walk = (node: unknown, path: Path, key: string, depth: number) => {
    if (depth > 8) return;
    if (typeof node === "string") {
      out.push({ path, key, value: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, i) => walk(entry, [...path, i], key, depth + 1));
      return;
    }
    if (!isRecord(node)) return;
    for (const [k, v] of Object.entries(node))
      walk(v, [...path, k], k, depth + 1);
  };
  walk(config, [], "", 0);
  return out;
}

function isLinkKey(key: string): boolean {
  return key === "href" || key.endsWith("_href");
}

function isTextField(key: string, value: string): boolean {
  if (NON_TEXT_KEY.test(key)) return false;
  if (/^#[0-9a-f]{3,8}$/i.test(value.trim())) return false;
  return /\p{L}/u.test(value);
}

/** An address the shopper leaves the shop for: not ours to judge. */
function isExternalLink(href: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(href.trim());
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      signal.throwIfAborted();
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/**
 * True only when our own bucket says the object is gone. ★ A storage error is
 * NOT a missing image: taking a good photograph out because a read timed out
 * would leave the merchant a worse page for nothing.
 */
async function objectMissing(
  url: string,
  signal: AbortSignal,
): Promise<boolean> {
  const path = gcsPathFromUrl(url);
  if (!path) return false;
  try {
    return (await gcsObjectInfo("public", path)) === null;
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

interface Working {
  plan: RevampStoredPlan;
  snapshot: RevampSnapshot;
  request: RevampRequest;
  snapOf: Map<RevampStoredPage, RevampSnapshotPage | null>;
}

function isMerchant(
  w: Working,
  page: RevampStoredPage,
  section: PageSectionItem,
): boolean {
  return isRevampMerchantSection(section, w.snapOf.get(page) ?? null);
}

/** Removes sections from a page and says how many went. */
function removeSections(
  page: RevampStoredPage,
  doomed: ReadonlySet<PageSectionItem>,
): number {
  if (!doomed.size) return 0;
  const before = page.sections.length;
  page.sections = page.sections.filter((s) => !doomed.has(s));
  return before - page.sections.length;
}

/** The photographs this revamp made, by URL. */
function newPhotoUrls(plan: RevampStoredPlan): Set<string> {
  return new Set(plan.photos.map((p) => p.url));
}

// ---------------------------------------------------------------------------
// The checks, each fixing what it can.
// ---------------------------------------------------------------------------

/** (1) No photo slot is left pointing at a photograph that was never made. */
function fixSlotReferences(w: Working, t: Tally): void {
  let cleared = 0;
  for (const page of w.plan.pages) {
    const doomed = new Set<PageSectionItem>();
    for (const section of page.sections) {
      let touched = false;
      for (const field of stringFields(section.config)) {
        if (!isRevampSlotRef(field.value)) continue;
        revampSetValueAt(section.config, field.path, "");
        touched = true;
        cleared += 1;
      }
      if (touched && !revampSectionRenders(section)) doomed.add(section);
    }
    removeSections(page, doomed);
  }
  const chrome = w.plan.chrome?.next;
  if (chrome) {
    const strip = (links: NavLink[]) => {
      for (const link of links) {
        if (isRevampSlotRef(link.image_url)) {
          delete link.image_url;
          cleared += 1;
        }
        if (link.children) strip(link.children);
      }
    };
    strip(chrome.header?.links ?? []);
  }
  for (const category of w.plan.categories) {
    if (category.action === "hide" || !isRevampSlotRef(category.imageUrl))
      continue;
    category.imageUrl =
      category.action === "update" ? category.before.imageUrl : null;
    cleared += 1;
  }
  for (const product of w.plan.products.create) {
    if (!isRevampSlotRef(product.imageUrl)) continue;
    product.imageUrl = product.sourceImageUrl;
    cleared += 1;
  }
  if (cleared) {
    t.fixed.push(`${countLabel(cleared, "unfinished photo")} taken out.`);
  }
}

/** (2) Every image on the new pages loads and is not a theme or broken one. */
async function fixImages(
  ctx: RevampStepContext,
  w: Working,
  t: Tally,
): Promise<void> {
  const ours = newPhotoUrls(w.plan);
  const stale = new Set([
    ...w.snapshot.photos.replaceable,
    ...w.snapshot.photos.broken,
  ]);
  const toVerify = new Set<string>();
  for (const page of w.plan.pages) {
    for (const section of page.sections) {
      const merchant = isMerchant(w, page, section);
      for (const field of revampMediaFields(section.config)) {
        if (merchant && !ours.has(field.url)) continue;
        if (!merchant && stale.has(field.url)) continue;
        toVerify.add(field.url);
      }
    }
  }
  for (const category of w.plan.categories) {
    if (
      category.action !== "hide" &&
      category.imageUrl &&
      ours.has(category.imageUrl)
    ) {
      toVerify.add(category.imageUrl);
    }
  }
  for (const product of w.plan.products.create) {
    if (product.imageUrl && product.imageUrl !== product.sourceImageUrl) {
      toVerify.add(product.imageUrl);
    }
  }
  const urls = [...toVerify];
  if (urls.length)
    await ctx.report(`Checking ${countLabel(urls.length, "photo")}`);
  const verdicts = await mapLimit(
    urls,
    STORAGE_CONCURRENCY,
    ctx.signal,
    (url) => objectMissing(url, ctx.signal),
  );
  const missing = new Set(urls.filter((_, i) => verdicts[i]));

  let gone = 0;
  let old = 0;
  for (const page of w.plan.pages) {
    const doomed = new Set<PageSectionItem>();
    for (const section of page.sections) {
      const merchant = isMerchant(w, page, section);
      let touched = false;
      for (const field of revampMediaFields(section.config)) {
        const isStale = !merchant && stale.has(field.url);
        if (!missing.has(field.url) && !isStale) continue;
        revampSetValueAt(section.config, field.path, "");
        touched = true;
        if (isStale) old += 1;
        else gone += 1;
      }
      if (touched && !revampSectionRenders(section)) doomed.add(section);
    }
    removeSections(page, doomed);
  }
  for (const category of w.plan.categories) {
    if (
      category.action === "hide" ||
      !category.imageUrl ||
      !missing.has(category.imageUrl)
    ) {
      continue;
    }
    category.imageUrl =
      category.action === "update" ? category.before.imageUrl : null;
    gone += 1;
  }
  for (const product of w.plan.products.create) {
    if (!product.imageUrl || !missing.has(product.imageUrl)) continue;
    product.imageUrl = product.sourceImageUrl;
    gone += 1;
  }
  if (gone) {
    t.fixed.push(
      `${countLabel(gone, "photo")} that did not load ${gone === 1 ? "was" : "were"} taken out.`,
    );
  }
  if (old) {
    t.fixed.push(
      `${countLabel(old, "old theme photo")} ${old === 1 ? "was" : "were"} taken out.`,
    );
  }
}

/**
 * (3) Every section on a page the revamp writes is new or the merchant's own.
 * A theme section left exactly as the theme seeded it is sample text.
 * ★ An earlier Mink section is kept on a refinement (it is the work being
 *   refined) and replaced on a full revamp.
 */
function fixLeftovers(w: Working, t: Tally): void {
  let removed = 0;
  for (const page of w.plan.pages) {
    const snap = w.snapOf.get(page) ?? null;
    if (!snap) continue;
    const doomed = new Set<PageSectionItem>();
    for (const section of page.sections) {
      if (isMerchant(w, page, section)) continue;
      const before = snap.sections.find((s) => s.id === section.id);
      if (!before) continue;
      const owner = snap.owners[section.id];
      const stale =
        owner === "theme" || (owner === "mink" && w.request.kind === "full");
      if (!stale) continue;
      if (revampSectionsDigest([section]) === revampSectionsDigest([before])) {
        doomed.add(section);
        continue;
      }
      // ★ New photos but the theme's own words: said, never removed, because
      //   the section may be the page's opening and a guess here costs more.
      const words = sectionWords(section);
      if (
        before.type === section.type &&
        words.length > 0 &&
        JSON.stringify(words) === JSON.stringify(sectionWords(before))
      ) {
        t.open.push(
          `The ${revampSectionLabel(section)} on the ${revampPageName(page.slug, page.title)} still shows the theme's sample words.`,
        );
      }
    }
    removed += removeSections(page, doomed);
  }
  if (removed) {
    t.fixed.push(
      `${countLabel(removed, "section")} that still showed the theme's sample text ${removed === 1 ? "was" : "were"} taken out.`,
    );
  }
}

/** (6) Product and category bands only where there is something real to show. */
function fixProductSections(w: Working, t: Tally): void {
  const hasProducts = revampHasRealProducts({
    request: w.request,
    snapshot: w.snapshot,
  });
  const bandAllowed = revampCategoryBandAllowed({
    request: w.request,
    snapshot: w.snapshot,
  });
  // ★★ A "featured" band shows products.featured, which defaults to false
  //    (output-5): with no product created by this plan (Apply features each
  //    one) and none of the shop's own featured, it publishes empty, so it is
  //    pointed at the shop's own products by name, as the compiler does.
  const createsProducts = w.plan.products.create.length > 0;
  let products = 0;
  let bands = 0;
  let named = 0;
  for (const page of w.plan.pages) {
    const doomed = new Set<PageSectionItem>();
    for (const section of page.sections) {
      if (isMerchant(w, page, section)) continue;
      if (PRODUCT_SECTION_TYPES.has(section.type) && !hasProducts) {
        doomed.add(section);
        products += 1;
      } else if (section.type === "shop_by_category" && !bandAllowed) {
        doomed.add(section);
        bands += 1;
      } else if (section.type === "featured_products") {
        const config = section.config as unknown as Record<string, unknown>;
        if (!isRecord(config) || config.source !== "featured") continue;
        const binding = revampFeaturedBinding(w.snapshot, {
          createsProducts,
          limit: Number(config.limit),
        });
        if (!binding) {
          doomed.add(section);
          products += 1;
        } else if (binding.source === "manual") {
          config.source = "manual";
          config.product_ids = binding.productIds;
          config.category_id = null;
          named += 1;
        }
      }
    }
    removeSections(page, doomed);
  }
  if (products) {
    t.fixed.push(
      `${countLabel(products, "product section")} taken out, as the shop has no products of its own yet.`,
    );
  }
  if (named) {
    t.fixed.push(
      `${countLabel(named, "product band")} set to show your own products, as none of them is marked featured.`,
    );
  }
  if (bands) {
    t.fixed.push(
      `${countLabel(bands, "category band")} taken out, as it would have shown the theme's sample categories.`,
    );
  }
}

/** The words a section shows, in order. */
function sectionWords(section: PageSectionItem): string[] {
  return stringFields(section.config)
    .filter((field) => isTextField(field.key, field.value))
    .map((field) => field.value.trim())
    .filter(Boolean);
}

/** Mink-written text fields: new sections, page text, header, footer, brand. */
interface TextSite {
  value: string;
  where: string;
  set(next: string): void;
  /** The section that must still render after the edit, if any. */
  section: { page: RevampStoredPage; item: PageSectionItem } | null;
  /** A label that cannot be blank (a menu link, the bar, the newsletter). */
  required?: boolean;
}

function textSites(w: Working): TextSite[] {
  const sites: TextSite[] = [];
  for (const page of w.plan.pages) {
    const name = revampPageName(page.slug, page.title);
    for (const section of page.sections) {
      if (isMerchant(w, page, section)) continue;
      for (const field of stringFields(section.config)) {
        if (!isTextField(field.key, field.value)) continue;
        sites.push({
          value: field.value,
          where: name,
          set: (next) => revampSetValueAt(section.config, field.path, next),
          section: { page, item: section },
        });
      }
    }
    for (const key of ["title", "seoTitle", "seoDescription"] as const) {
      if (!page[key]?.trim()) continue;
      sites.push({
        value: page[key],
        where: name,
        set: (next) => (page[key] = next),
        section: null,
      });
    }
  }
  const chrome = w.plan.chrome?.next;
  if (chrome) {
    const walkLinks = (links: NavLink[]) => {
      for (const link of links) {
        sites.push({
          value: link.label,
          where: "header",
          set: (next) => (link.label = next),
          section: null,
          required: true,
        });
        if (link.children) walkLinks(link.children);
      }
    };
    walkLinks(chrome.header?.links ?? []);
    for (const group of chrome.footer?.groups ?? []) {
      sites.push({
        value: group.title,
        where: "footer",
        set: (next) => (group.title = next),
        section: null,
        required: true,
      });
      for (const link of group.links) {
        sites.push({
          value: link.label,
          where: "footer",
          set: (next) => (link.label = next),
          section: null,
          required: true,
        });
      }
    }
    const bar = chrome.header?.announcement;
    if (bar?.text) {
      sites.push({
        value: bar.text,
        where: "announcement bar",
        set: (next) => (bar.text = next),
        section: null,
        required: true,
      });
    }
    const letter = chrome.footer?.newsletter;
    if (letter) {
      for (const key of ["heading", "subtext", "buttonLabel"] as const) {
        if (!letter[key]) continue;
        sites.push({
          value: letter[key],
          where: "newsletter",
          set: (next) => (letter[key] = next),
          section: null,
          required: true,
        });
      }
    }
  }
  const brand = w.plan.brand;
  if (brand) {
    for (const key of ["tagline", "blurb"] as const) {
      const value = brand[key];
      if (!value) continue;
      sites.push({
        value,
        where: "store description",
        set: (next) => (brand[key] = next || null),
        section: null,
      });
    }
  }
  const own = new Map(w.request.products.map((p) => [p.key, p.description]));
  for (const product of w.plan.products.create) {
    // ★ The merchant's own description is theirs; only Mink's copy is checked.
    if (!product.description || product.description === own.get(product.key))
      continue;
    sites.push({
      value: product.description,
      where: product.name,
      set: (next) => (product.description = next),
      section: null,
    });
  }
  return sites.filter((s) => s.value.trim() !== "");
}

/** (9) No long dash, and no claim the merchant did not make. */
function fixCopy(w: Working, t: Tally): void {
  // ★★ The compiler's own evidence (output-3): category changes, the
  //    merchant's catalogue names and the store's facts included, or copy
  //    the compiler accepted fails this check after the fact.
  const evidence = revampClaimEvidence(w.request, w.snapshot);
  const removedWords = new Set<string>();
  const emptied = new Set<{ page: RevampStoredPage; item: PageSectionItem }>();
  for (const site of textSites(w)) {
    let next = hasLongDash(site.value)
      ? cleanRevampCopy(site.value)
      : site.value;
    const { text, removed } = withoutUnsupportedClaims(next, evidence);
    if (removed.length && site.required && !text.trim()) {
      // ★ A menu link or the bar cannot go blank: kept, and said.
      const words = removed.map((word) => `"${word}"`).join(", ");
      t.open.push(
        `The ${site.where} says ${words}, which you have not said; change it before you publish.`,
      );
    } else if (removed.length) {
      next = text;
      for (const word of removed) removedWords.add(word);
    }
    if (next === site.value) continue;
    site.set(next);
    if (site.section && !next.trim()) emptied.add(site.section);
  }
  let dropped = 0;
  for (const { page, item } of emptied) {
    if (revampSectionRenders(item)) continue;
    dropped += removeSections(page, new Set([item]));
  }
  if (removedWords.size) {
    const words = [...removedWords].map((word) => `"${word}"`).join(", ");
    t.fixed.push(
      `Took out ${words} where you had not said ${removedWords.size === 1 ? "it" : "them"}.`,
    );
  }
  if (dropped) {
    t.fixed.push(
      `${countLabel(dropped, "section")} left with no words ${dropped === 1 ? "was" : "were"} taken out.`,
    );
  }
}

/** (5) Every link reaches something that will exist after Apply. */
function fixLinks(w: Working, t: Tally): void {
  const targets = revampLinkTargets({
    request: w.request,
    snapshot: w.snapshot,
    plan: { pages: w.plan.pages },
  });
  let dead = 0;
  for (const page of w.plan.pages) {
    const doomed = new Set<PageSectionItem>();
    for (const section of page.sections) {
      if (isMerchant(w, page, section)) continue;
      let touched = false;
      for (const field of stringFields(section.config)) {
        if (!isLinkKey(field.key) || isExternalLink(field.value)) continue;
        const checked = checkRevampLink(field.value, targets);
        if (checked === field.value) continue;
        if (checked !== null) {
          revampSetValueAt(section.config, field.path, checked);
          continue;
        }
        revampSetValueAt(section.config, field.path, "");
        const labelKey = field.key.replace(/_href$/, "_label");
        if (labelKey !== field.key) {
          const labelPath = [...field.path.slice(0, -1), labelKey];
          if (typeof revampValueAt(section.config, labelPath) === "string") {
            revampSetValueAt(section.config, labelPath, "");
          }
        }
        dead += 1;
        touched = true;
      }
      if (touched && !revampSectionRenders(section)) doomed.add(section);
    }
    removeSections(page, doomed);
  }

  const stored = w.plan.chrome;
  if (stored) {
    const next = stored.next;
    // ★★ A link the store already has to a route the storefront always
    //    serves (a post in its own footer, "/blogs/first-harvest", or "My
    //    orders") is left alone (output-6): the plan did not write it, the
    //    redesign does not touch what it names, and checkRevampLink cannot
    //    see posts. A link the plan wrote is still held to checkRevampLink.
    const own = ownChromeHrefs(w.snapshot.chrome?.value);
    const leaveAlone = (href: string) =>
      own.has(href.trim()) && revampAlwaysServedLink(href);
    const keepLinks = (links: NavLink[]): NavLink[] => {
      const kept: NavLink[] = [];
      for (const link of links) {
        const href = link.href ?? "";
        if (!isExternalLink(href) && !leaveAlone(href)) {
          const checked = checkRevampLink(href, targets);
          if (checked === null) {
            dead += 1;
            continue;
          }
          link.href = checked;
        }
        if (link.children) {
          const children = keepLinks(link.children);
          if (children.length) link.children = children;
          else delete link.children;
        }
        kept.push(link);
      }
      return kept;
    };
    if (next.header) next.header.links = keepLinks(next.header.links ?? []);
    if (next.footer) {
      next.footer.groups = (next.footer.groups ?? [])
        .map(
          (group): FooterGroup => ({ ...group, links: keepLinks(group.links) }),
        )
        .filter((group) => group.links.length > 0);
    }
    const bar = next.header?.announcement;
    if (bar?.href && !isExternalLink(bar.href) && !leaveAlone(bar.href)) {
      const checked = checkRevampLink(bar.href, targets);
      if (checked === null) {
        bar.href = "";
        dead += 1;
      } else {
        bar.href = checked;
      }
    }
    stored.next = sanitizeChromeForSave(next);
  }
  if (dead) {
    t.fixed.push(
      `${countLabel(dead, "link")} to a page that will not exist ${dead === 1 ? "was" : "were"} taken out.`,
    );
  }
}

/** Every link in the store's current header, footer and bar, trimmed. */
function ownChromeHrefs(
  chrome: RevampSnapshot["chrome"]["value"] | null | undefined,
): Set<string> {
  const out = new Set<string>();
  const walk = (links: NavLink[] | undefined) => {
    for (const link of links ?? []) {
      const href = (link.href ?? "").trim();
      if (href) out.add(href);
      walk(link.children);
    }
  };
  walk(chrome?.header?.links);
  for (const group of chrome?.footer?.groups ?? []) walk(group.links);
  const bar = (chrome?.header?.announcement?.href ?? "").trim();
  if (bar) out.add(bar);
  return out;
}

/** (4) Every page can be published: valid sections, a title, a search description. */
function fixPages(w: Working, t: Tally): void {
  let titled = 0;
  let described = 0;
  let unfinished = 0;
  for (const page of w.plan.pages) {
    const snap = w.snapOf.get(page) ?? null;
    const name = revampPageName(page.slug, page.title);
    if (!page.title.trim()) {
      page.title =
        snap?.title?.trim() ||
        (page.slug
          ? page.slug
              .replace(/[-_]+/g, " ")
              .replace(/^./, (c) => c.toUpperCase())
          : w.snapshot.storeName);
      titled += 1;
    }
    if (!page.seoTitle.trim()) page.seoTitle = page.title;
    if (page.seoDescription.trim().length < SEO_DESCRIPTION_MIN) {
      page.seoDescription = fallbackSeoDescription(
        page.title,
        w.snapshot.storeName,
      );
      described += 1;
    }
    if (!("error" in validateSections(page.sections, { mode: "publish" })))
      continue;
    const doomed = new Set<PageSectionItem>();
    let theirs = 0;
    for (const section of page.sections) {
      if (revampSectionRenders(section)) continue;
      if (isMerchant(w, page, section)) {
        theirs += 1;
        t.open.push(
          `Your own ${revampSectionLabel(section)} on the ${name} needs finishing before you publish.`,
        );
      } else {
        doomed.add(section);
      }
    }
    unfinished += removeSections(page, doomed);
    const again = validateSections(page.sections, { mode: "publish" });
    if ("error" in again && theirs === 0) {
      t.open.push(`The ${name} could not be checked: ${again.error}`);
    }
  }
  if (titled) t.fixed.push(`Gave ${countLabel(titled, "page")} a title.`);
  if (described) {
    t.fixed.push(
      `Wrote the search description for ${countLabel(described, "page")}.`,
    );
  }
  if (unfinished) {
    t.fixed.push(`${countLabel(unfinished, "unfinished section")} taken out.`);
  }
}

function sameDesign(
  a: StorefrontDesignOverrides,
  b: StorefrontDesignOverrides,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The theme's colours with the new design over them, as a full palette. */
function heroPalette(w: Working, design: StorefrontDesignOverrides) {
  const theme = w.snapshot.theme.palette;
  const pick = (value: string | undefined, fallback: string) =>
    normalizeRevampHex(value) ?? normalizeRevampHex(fallback) ?? fallback;
  const d = design.palette ?? {};
  const page = pick(d.cream, theme.page);
  const ink = pick(d.ink, theme.ink);
  const accent = pick(d.accent, theme.accent);
  return {
    cream: page,
    creamDeep: pick(d.creamDeep, page),
    surface: pick(d.surface, theme.surface),
    ink,
    inkSoft: pick(d.inkSoft, ink),
    inkFaint: pick(d.inkFaint, ink),
    border: pick(d.border, ink),
    // ★ The snapshot carries no on-ink colour: text on an ink-filled field
    //   reads against ink the way the page does, so the page colour stands in.
    onInk: page,
    onAccent: isLightColour(accent) ? ink : "#ffffff",
    accent,
  };
}

/** (7) The design and every solid hero are easy to read. */
function fixContrast(w: Working, t: Tally): void {
  const stored = w.plan.chrome;
  if (!stored) return;
  const themeTokens = {
    palette: {
      cream: w.snapshot.theme.palette.page,
      surface: w.snapshot.theme.palette.surface,
      ink: w.snapshot.theme.palette.ink,
      accent: w.snapshot.theme.palette.accent,
    },
  };
  const proposed = validateStorefrontDesign(
    stored.next.design,
    null,
    "draft",
  ).design;
  const current = validateStorefrontDesign(
    w.snapshot.chrome.value?.design ?? EMPTY_DESIGN_OVERRIDES,
    null,
    "draft",
  ).design;
  if (
    !sameDesign(proposed, current) &&
    contrastIssuesFor(proposed, themeTokens).length
  ) {
    stored.next.design = clone(current);
    // ★ The store keeps the look it has, so the new one is not charged.
    if (w.plan.charges) w.plan.charges.design = false;
    t.fixed.push(
      "The new colours were hard to read, so your current colours are kept.",
    );
  }

  const palette = heroPalette(w, stored.next.design);
  let flipped = 0;
  for (const page of w.plan.pages) {
    const name = revampPageName(page.slug, page.title);
    for (const section of page.sections) {
      if (section.type !== "hero" || section.enabled === false) continue;
      if (isMerchant(w, page, section)) continue;
      const judge = () =>
        solidHeroContrast({
          preset: {
            design: { palette, fonts: {}, shape: {} },
            brand: { primaryColor: palette.accent },
            pages: [{ slug: page.slug, sections: [section] }],
          },
        } as unknown as ThemeDefinition)[0];
      let evidence = judge();
      if (!evidence || evidence.passes) continue;
      const config = section.config as unknown as Record<string, unknown>;
      let alternative = evidence.alternatives.find(
        (a) => a.passes && a.theme !== evidence!.theme,
      );
      if (!alternative && config.background) {
        // ★ No text colour reads on this background: the theme's own field does.
        config.background = "";
        evidence = judge();
        if (!evidence || evidence.passes) {
          flipped += 1;
          continue;
        }
        alternative = evidence.alternatives.find((a) => a.passes);
      }
      if (alternative) {
        config.theme = alternative.theme;
        flipped += 1;
        continue;
      }
      t.open.push(
        `The ${revampSectionLabel(section)} on the ${name} is hard to read; choose another background for it.`,
      );
    }
  }
  if (flipped) {
    t.fixed.push(`Made the text readable on ${countLabel(flipped, "banner")}.`);
  }
}

/** (8) Written in English when the merchant's brief is in English. */
function checkLanguage(w: Working, t: Tally): void {
  const language = w.request.brief.language;
  // ★★ The compiler's own names (output-4): the shop's and its products' names
  //    are never translated, so they are taken out before the copy is read,
  //    exactly as the compiler read it. Otherwise "Welcome to मिठाई घर" passes
  //    the compiler and is reported here as not English.
  const names = revampStoreNames(w.request, w.snapshot);
  const places = new Set<string>();
  for (const site of textSites(w)) {
    if (!readsAsLanguage(withoutStoreNames(site.value, names), language)) {
      places.add(site.where);
    }
  }
  if (!places.size) return;
  const list = [...places].slice(0, 3).join(", ");
  t.open.push(
    `Some text is not in English (${list}). Read it before you publish.`,
  );
}

/** (10) Phones: the opening photograph has its phone crop, the header fits. */
function fixPhones(w: Working, t: Tally): void {
  const home = w.plan.pages.find((page) => page.slug === "");
  const opening = home?.sections.find((s) => s.enabled !== false);
  const ours = newPhotoUrls(w.plan);
  if (
    opening &&
    (opening.type === "hero" || opening.type === "hero_carousel")
  ) {
    const base: Path = opening.type === "hero" ? [] : ["slides", 0];
    const imagePath: Path = [...base, "image_url"];
    const image = revampValueAt(opening.config, imagePath);
    const key = revampFrameKeyFor(opening.type, opening.config, imagePath);
    const spec = key ? IMAGE_SPECS[key] : null;
    const wide = spec ? spec.width / spec.height > WIDE_ASPECT : false;
    const phone = revampValueAt(opening.config, [...base, "mobile_image_url"]);
    if (
      typeof image === "string" &&
      ours.has(image) &&
      wide &&
      !(typeof phone === "string" && phone.trim())
    ) {
      t.open.push(
        "The opening photograph has no phone crop, so phones show the wide photo cut to fit.",
      );
    }
  }
  const header = w.plan.chrome?.next.header;
  if (header && header.links.length > REVAMP_MAX_HEADER_LINKS) {
    header.links = header.links.slice(0, REVAMP_MAX_HEADER_LINKS);
    t.fixed.push(
      `Kept the first ${REVAMP_MAX_HEADER_LINKS} links in the header so it fits on phones.`,
    );
  }
}

/** Keeps the photo list to the photographs a page or category still shows. */
function prunePhotos(plan: RevampStoredPlan): void {
  const shown = new Set<string>();
  for (const page of plan.pages) {
    for (const section of page.sections) {
      for (const field of revampMediaFields(section.config))
        shown.add(field.url);
    }
  }
  for (const category of plan.categories) {
    if (category.action !== "hide" && category.imageUrl)
      shown.add(category.imageUrl);
  }
  plan.photos = plan.photos.filter((photo) => shown.has(photo.url));
}

/**
 * ★ THE CHARGE FOLLOWS WHAT IS LEFT (money-2): a photograph this step took
 *   out, a studio photo it put back to the merchant's own and a page that is
 *   gone are not charged, so the card never bills for something it does not
 *   show. Run after prunePhotos. A plan stored before the itemised charge
 *   existed keeps the credits it was given.
 */
function recountCharges(plan: RevampStoredPlan): void {
  const charges = plan.charges;
  if (!charges) return;
  const shown = new Set(plan.photos.map((photo) => photo.url));
  charges.photoUrls = charges.photoUrls.filter((url) => shown.has(url));
  const studio = new Set(
    plan.products.create
      .filter(
        (product) =>
          !!product.imageUrl && product.imageUrl !== product.sourceImageUrl,
      )
      .map((product) => product.key),
  );
  charges.productPhotoKeys = charges.productPhotoKeys.filter((key) =>
    studio.has(key),
  );
  const slugs = new Set(plan.pages.map((page) => page.slug));
  charges.pages = charges.pages.filter((slug) => slugs.has(slug));
  plan.credits = revampCreditsFromCharges(charges);
}

/**
 * The checks step: fixes what can be fixed, then reports every check in the
 * merchant's words. Never moves the plan's locks; recomputes each page's
 * proposed digest and change counts after the fixes.
 */
export async function runRevampChecks(
  ctx: RevampStepContext,
  input: {
    plan: RevampStoredPlan;
    snapshot: RevampSnapshot;
    request: RevampRequest;
  },
): Promise<RevampCheckRun> {
  const plan = clone(input.plan);
  const w: Working = {
    plan,
    snapshot: input.snapshot,
    request: input.request,
    snapOf: new Map(
      plan.pages.map((page) => [
        page,
        revampSnapshotPageFor(input.snapshot, page),
      ]),
    ),
  };

  const photos = tally();
  const leftovers = tally();
  const pages = tally();
  const links = tally();
  const products = tally();
  const contrast = tally();
  const language = tally();
  const copy = tally();
  const phones = tally();

  ctx.signal.throwIfAborted();
  fixSlotReferences(w, photos);
  await fixImages(ctx, w, photos);
  fixLeftovers(w, leftovers);
  fixProductSections(w, products);
  fixCopy(w, copy);
  fixLinks(w, links);
  fixPages(w, pages);
  fixContrast(w, contrast);
  const english = isEnglish(input.request.brief.language);
  if (english) checkLanguage(w, language);
  fixPhones(w, phones);

  if (plan.chrome) plan.chrome.next = sanitizeChromeForSave(plan.chrome.next);
  prunePhotos(plan);
  recountCharges(plan);
  const ours = newPhotoUrls(plan);
  for (const page of plan.pages) {
    page.proposedDigest = revampSectionsDigest(page.sections);
    page.changes = revampPageChanges(
      page.sections,
      w.snapOf.get(page) ?? null,
      ours,
    );
  }

  plan.checks = [
    toCheck("photos", "Every photo is new and loads", photos),
    toCheck("theme_text", "No sample text from the theme is left", leftovers),
    toCheck("pages", "Every page is ready to publish", pages),
    toCheck("links", "Every link goes somewhere real", links),
    toCheck("products", "Product sections show your own products", products),
    toCheck("contrast", "Text is easy to read", contrast),
    ...(english ? [toCheck("language", "Written in English", language)] : []),
    toCheck("claims", "No claims you did not make", copy),
    toCheck("phones", "Looks right on phones", phones),
  ];
  return { plan };
}
