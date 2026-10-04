import { sanitizeChromeForSave, type StoreChrome } from "@/lib/chrome/types";
import {
  validatePageSlug,
  RESERVED_PAGE_SLUGS,
  validateSections,
  type PageSectionItem,
  type CustomCodeConfig,
} from "@/lib/sections/registry";
import { sanitizeBlogContent } from "@/lib/sanitize";
import { planAllows, type Plan } from "@/lib/plans";
import { hashMinkActionPayload } from "./action-integrity";
import { validateMinkStorefrontCodePatch } from "./storefront-code-contract";
import { resolveKeptLayoutSections } from "./storefront-layout-contract";
import { validateMinkStorefrontPublicationStatic } from "./storefront-publication-validation";

export const BUILDER_OPERATIONS = [
  "chrome_update",
  "chrome_publish",
  "chrome_revert",
  "page_create",
  "page_update",
  "page_delete",
  "page_publish",
  "page_unpublish",
  "page_revert",
  "settings_update",
  "brand_update",
] as const;
export type BuilderOperation = (typeof BUILDER_OPERATIONS)[number];
export interface BuilderPage {
  id: string;
  slug: string;
  title: string;
  status: string;
  seoTitle: string;
  seoDescription: string;
  seoNoindex: boolean;
  sections: PageSectionItem[];
  publishedSections: PageSectionItem[];
  updatedAt: string;
  publishedAt: string | null;
}
export interface BuilderTarget {
  operation: BuilderOperation;
  pageSlug: string;
  exists: boolean;
  chrome?: StoreChrome;
  publishedChrome?: StoreChrome | null;
  liveChrome?: StoreChrome;
  page?: BuilderPage | null;
  customCode?: boolean;
  brand?: { primaryColor: string; logoUrl: string | null };
  version?: string | null;
}
export interface BuilderPatch {
  operation: BuilderOperation;
  pageSlug: string;
  expectedDigest: string;
  changes: Record<string, unknown>;
}
export interface BuilderChange {
  field: string;
  before: string;
  after: string;
}
export interface BuilderPlan {
  next: unknown;
  changes: BuilderChange[];
  live: boolean;
  codeChecks: { id: string; config: CustomCodeConfig }[];
}
export interface BuilderDestination {
  slug: string;
  name: string;
  status: string;
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function builderDigest(value: unknown): string {
  return hashMinkActionPayload(value);
}
function fail(message: string): never {
  throw new Error(message);
}
function only(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    fail("Unknown or unsupported Builder field.");
}
export function readBuilderPatch(value: unknown): BuilderPatch {
  if (!record(value)) fail("Builder proposal must be an object.");
  only(value, ["operation", "pageSlug", "expectedDigest", "changes"]);
  if (!BUILDER_OPERATIONS.includes(value.operation as BuilderOperation))
    fail("Unknown Builder operation.");
  if (
    typeof value.pageSlug !== "string" ||
    value.pageSlug.length > 60 ||
    !/^(?:home|[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(value.pageSlug)
  )
    fail("pageSlug must be home or an exact page slug.");
  if (!/^[a-f0-9]{64}$/.test(String(value.expectedDigest)))
    fail("Read the Builder context and use its exact targetDigest.");
  if (
    !record(value.changes) ||
    JSON.stringify(value.changes).length > 128 * 1024
  )
    fail("Builder changes must be a bounded object.");
  return value as unknown as BuilderPatch;
}

/** Apply only existing paths: no prototype keys, sparse arrays or implicit resets. */
export function patchChrome(current: StoreChrome, raw: unknown): StoreChrome {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50)
    fail("Provide 1–50 exact chrome field changes.");
  const next = structuredClone(current);
  for (const edit of raw) {
    if (!record(edit)) fail("Each chrome change needs path and value.");
    only(edit, ["path", "value"]);
    if (typeof edit.path !== "string" || !("value" in edit))
      fail("Each chrome change needs path and value.");
    const path = edit.path.split(".");
    if (
      !["header", "footer", "appearance"].includes(path[0]) ||
      path.length < 2 ||
      path.length > 10
    )
      fail(
        "Only header, footer and appearance fields can be changed here. Use the design tool for colours and fonts.",
      );
    let parent: Record<string, unknown> | unknown[] = next as unknown as Record<
      string,
      unknown
    >;
    for (const [index, key] of path.entries()) {
      if (
        ["__proto__", "prototype", "constructor"].includes(key) ||
        !Object.prototype.hasOwnProperty.call(parent, key)
      )
        fail(
          "The chrome field path does not exist. Read the current Builder context.",
        );
      if (index === path.length - 1)
        (parent as Record<string, unknown>)[key] = edit.value;
      else {
        const child: unknown = (parent as Record<string, unknown>)[key];
        if (!record(child) && !Array.isArray(child))
          fail("The chrome path is not a container.");
        parent = child;
      }
    }
  }
  const clean = sanitizeChromeForSave(next);
  if (builderDigest(clean) !== builderDigest(next))
    fail(
      "Invalid chrome values, navigation nesting, text length or layout variant. Use the exact fields and options from Builder context.",
    );
  return clean;
}
function text(
  value: unknown,
  name: string,
  max: number,
  required = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    fail(
      `${name} must be ${required ? "nonempty " : ""}text of at most ${max} characters.`,
    );
  return value.trim();
}
function sections(
  raw: unknown,
  current: PageSectionItem[],
  customCode: boolean,
  publish: boolean,
): PageSectionItem[] {
  const resolved = resolveKeptLayoutSections(raw, current);
  if (!resolved.ok) fail(resolved.issues.join(" "));
  const retained = new Set(
    current.filter((s) => s.type === "custom_code").map(builderDigest),
  );
  const lenientIds = new Set(
    current.filter((s) => retained.has(builderDigest(s))).map((s) => s.id),
  );
  const shaped = validateSections(resolved.sections, {
    mode: publish ? "publish" : "draft",
    lenientIds: publish && customCode ? undefined : lenientIds,
  });
  if ("error" in shaped) fail(shaped.error);
  return shaped.sections.map((section) => {
    if (section.type === "rich_text")
      return {
        ...section,
        config: {
          ...section.config,
          html: sanitizeBlogContent((section.config as { html: string }).html),
        },
      };
    if (section.type !== "custom_code" || retained.has(builderDigest(section)))
      return section;
    if (!customCode)
      fail("Custom code is disabled or unavailable on this store's plan.");
    const config = section.config as CustomCodeConfig;
    const checked = validateMinkStorefrontCodePatch({
      schemaVersion: 1,
      operation: "replace_custom_code",
      target: {
        pageSlug: "home",
        sectionId: section.id,
        expectedPageVersion: "2026-01-01T00:00:00.000000Z",
        expectedSectionDigest: "0".repeat(64),
      },
      code: {
        html: config.html,
        css: config.css,
        js: config.js,
        heightMode: config.height_mode,
        fixedHeight: config.fixed_height,
      },
    });
    if (!checked.ok) fail(checked.issues.join(" "));
    const staticChecks = validateMinkStorefrontPublicationStatic(config);
    if (!staticChecks.passed) fail(staticChecks.issues.join(" "));
    return section;
  });
}
export function builderPlan(
  patch: BuilderPatch,
  target: BuilderTarget,
  customCode: boolean,
  plan: Plan,
): BuilderPlan {
  if (
    target.operation !== patch.operation ||
    target.pageSlug !== patch.pageSlug ||
    builderDigest(target) !== patch.expectedDigest
  )
    fail(
      "Builder content changed. Read the current context and request a new proposal.",
    );
  const c = patch.changes;
  let next: unknown;
  let before: unknown;
  let live = false;
  let codeChecks: BuilderPlan["codeChecks"] = [];
  if (patch.operation.startsWith("chrome_")) {
    if (!target.chrome) fail("Header and footer are unavailable.");
    if (patch.operation === "chrome_publish" && !target.exists)
      fail("Save a header/footer draft before publishing.");
    before =
      patch.operation === "chrome_publish"
        ? (target.liveChrome ?? target.publishedChrome)
        : target.chrome;
    if (patch.operation === "chrome_update") {
      only(c, ["fields"]);
      next = patchChrome(target.chrome, c.fields);
    } else {
      only(c, []);
      next =
        patch.operation === "chrome_publish"
          ? target.chrome
          : target.publishedChrome;
      if (!next) fail("No published header/footer to restore.");
      live = patch.operation === "chrome_publish";
    }
  } else if (patch.operation === "brand_update") {
    only(c, ["primaryColor", "logoUrl"]);
    if (!target.brand) fail("Brand appearance is unavailable.");
    if (
      c.primaryColor !== undefined &&
      (typeof c.primaryColor !== "string" ||
        !/^#[a-f0-9]{6}$/i.test(c.primaryColor))
    )
      fail("Primary colour must be a six-digit hex colour.");
    if (
      c.logoUrl !== undefined &&
      c.logoUrl !== null &&
      (typeof c.logoUrl !== "string" ||
        !c.logoUrl.trim() ||
        c.logoUrl.length > 2000)
    )
      fail(
        "Logo must be an exact owned image URL or null to show the store name.",
      );
    before = target.brand;
    next = { ...target.brand, ...c };
    live = true;
  } else if (patch.operation === "settings_update") {
    only(c, ["pages.customCode"]);
    if (typeof c["pages.customCode"] !== "boolean")
      fail("pages.customCode must be true or false.");
    if (!planAllows(plan, "basic"))
      fail("Custom-code settings require Basic or Pro.");
    before = { "pages.customCode": target.customCode };
    next = c;
    live = true;
  } else if (
    patch.operation === "page_create" ||
    patch.operation === "page_update"
  ) {
    only(c, [
      "title",
      "slug",
      "seoTitle",
      "seoDescription",
      "seoNoindex",
      "sections",
    ]);
    if (patch.operation === "page_create" && target.exists)
      fail("A page already uses that slug.");
    if (patch.operation === "page_update" && !target.page)
      fail("Page not found.");
    before = target.page ?? null;
    const old = target.page;
    const slug =
      c.slug === undefined
        ? (old?.slug ?? patch.pageSlug)
        : text(c.slug, "Slug", 60, true);
    if (old?.slug === "" && slug !== "")
      fail("The homepage cannot be renamed.");
    if (slug !== "") {
      const valid = validatePageSlug(slug);
      if ("error" in valid || valid.slug !== slug)
        fail("Use an unused normalized page slug, not a reserved route.");
    } else if (!old)
      fail("Use the existing homepage instead of creating another.");
    next = {
      slug,
      title:
        c.title === undefined
          ? (old?.title ?? fail("Provide a title."))
          : text(c.title, "Title", 200, true),
      seoTitle:
        c.seoTitle === undefined
          ? (old?.seoTitle ?? "")
          : text(c.seoTitle, "SEO title", 70),
      seoDescription:
        c.seoDescription === undefined
          ? (old?.seoDescription ?? "")
          : text(c.seoDescription, "SEO description", 180),
      seoNoindex:
        c.seoNoindex === undefined ? (old?.seoNoindex ?? false) : c.seoNoindex,
      sections:
        c.sections === undefined
          ? (old?.sections ?? [])
          : sections(c.sections, old?.sections ?? [], customCode, false),
    };
    if (typeof (next as { seoNoindex: unknown }).seoNoindex !== "boolean")
      fail("seoNoindex must be boolean.");
    live =
      old?.status === "published" &&
      ["slug", "title", "seoTitle", "seoDescription", "seoNoindex"].some(
        (key) => key in c,
      );
    before = old
      ? {
          slug: old.slug,
          title: old.title,
          seoTitle: old.seoTitle,
          seoDescription: old.seoDescription,
          seoNoindex: old.seoNoindex,
          sections: old.sections,
        }
      : null;
  } else {
    only(c, []);
    const page = target.page;
    if (!page) fail("Page not found.");
    if (
      page.slug === "" &&
      ["page_delete", "page_unpublish"].includes(patch.operation)
    )
      fail("The homepage cannot be deleted or unpublished.");
    if (patch.operation === "page_delete") {
      before = page;
      next = null;
      live = page.status === "published";
    } else if (patch.operation === "page_unpublish") {
      before = page.status;
      next = "draft";
      live = true;
    } else if (patch.operation === "page_revert") {
      if (!page.publishedAt) fail("There is no published page to restore.");
      before = page.sections;
      next = page.publishedSections;
    } else {
      before = { status: page.status, sections: page.publishedSections };
      const clean = sections(
        page.sections,
        page.publishedSections,
        customCode,
        true,
      );
      next = { status: "published", sections: clean };
      live = true;
      codeChecks = clean
        .filter(
          (s) =>
            s.enabled &&
            s.type === "custom_code" &&
            !page.publishedSections.some(
              (old) => builderDigest(old) === builderDigest(s),
            ),
        )
        .map((s) => ({ id: s.id, config: s.config as CustomCodeConfig }));
      if (codeChecks.length > 8)
        fail("Publish at most eight changed custom-code sections at once.");
    }
  }
  if (builderDigest(before) === builderDigest(next))
    fail("This proposal would not change anything.");
  const changes = diffBuilder(before, next);
  if (changes.length > 2000 || JSON.stringify(changes).length > 2 * 1024 * 1024)
    fail(
      "This change is too large for one complete review. Request a smaller Builder change.",
    );
  return { next, changes, live, codeChecks };
}

/** Complete, deterministic review. Long values expand in the card rather than silently truncating. */
export function diffBuilder(
  before: unknown,
  after: unknown,
  path = "",
): BuilderChange[] {
  if (builderDigest(before ?? null) === builderDigest(after ?? null)) return [];
  if (
    (record(before) && (record(after) || after == null)) ||
    (record(after) && before == null)
  ) {
    const old = record(before) ? before : {};
    const next = record(after) ? after : {};
    return [...new Set([...Object.keys(old), ...Object.keys(next)])].flatMap(
      (key) => diffBuilder(old[key], next[key], path ? `${path}.${key}` : key),
    );
  }
  if (
    (Array.isArray(before) && (Array.isArray(after) || after == null)) ||
    (Array.isArray(after) && before == null)
  ) {
    const old = Array.isArray(before) ? before : [];
    const next = Array.isArray(after) ? after : [];
    return Array.from(
      { length: Math.max(old.length, next.length) },
      (_, index) => diffBuilder(old[index], next[index], `${path}.${index}`),
    ).flat();
  }
  return [
    {
      field: path || "Page",
      before: JSON.stringify(before ?? null),
      after: JSON.stringify(after ?? null),
    },
  ];
}

export function navigationIssues(
  chrome: StoreChrome,
  categories: BuilderDestination[],
  pages: BuilderDestination[],
) {
  const issues: {
    path: string;
    label: string;
    href: string;
    message: string;
    suggestedHref: string | null;
  }[] = [];
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}.${i}`));
      return;
    }
    if (!record(value)) return;
    if (
      typeof value.href === "string" &&
      value.href.startsWith("/") &&
      !value.href.startsWith("//")
    ) {
      const url = new URL(value.href, "https://store.invalid");
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        pathname = url.pathname;
      }
      const cat = pathname.startsWith("/collections/")
        ? pathname.slice(13)
        : url.pathname === "/shop"
          ? url.searchParams.get("category")
          : null;
      const missing =
        cat && !categories.some((c) => c.slug === cat && c.status === "active");
      const pageSlug = pathname.slice(1).replace(/\/$/, "");
      const hiddenPage =
        !cat &&
        pageSlug &&
        !RESERVED_PAGE_SLUGS.has(pageSlug.split("/")[0]) &&
        !pages.some((p) => p.slug === pageSlug && p.status === "published");
      if (missing || hiddenPage) {
        const matching = categories.filter(
          (c) =>
            c.status === "active" &&
            c.name.toLowerCase() === String(value.label).toLowerCase(),
        );
        issues.push({
          path: `${path}.href`,
          label: String(value.label ?? "Link"),
          href: value.href,
          message: missing
            ? "Category is missing or hidden; shoppers cannot open this collection."
            : "The linked page is missing or unpublished.",
          suggestedHref:
            missing && matching.length === 1
              ? `/collections/${encodeURIComponent(matching[0].slug)}`
              : null,
        });
      }
    }
    Object.entries(value).forEach(([key, child]) =>
      walk(child, path ? `${path}.${key}` : key),
    );
  };
  walk(chrome.header, "header");
  walk(chrome.footer, "footer");
  return issues;
}
export function assertSafeBuilderLinks(
  value: unknown,
  existing?: unknown,
): void {
  if (
    existing !== undefined &&
    builderDigest(value ?? null) === builderDigest(existing ?? null)
  )
    return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafeBuilderLinks(
        item,
        Array.isArray(existing) ? existing[index] : undefined,
      ),
    );
    return;
  }
  if (!record(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (
      (key === "href" || key.endsWith("_href")) &&
      typeof item === "string" &&
      item &&
      !(record(existing) && existing[key] === item) &&
      !/^(?:\/(?![/\\])|#|https:\/\/|mailto:|tel:)/i.test(item)
    )
      fail(
        "Links must use a safe store path, HTTPS URL, email, phone or anchor.",
      );
    assertSafeBuilderLinks(item, record(existing) ? existing[key] : undefined);
  }
}
