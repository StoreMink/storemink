import "server-only";

import { stat } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { logWarn } from "@/lib/observability/logger";
import { salvageSections, type PageSectionItem } from "@/lib/sections/registry";
import { gcsObjectInfo, gcsPathFromUrl } from "@/lib/storage/gcs";
import {
  homepageEditedSinceSeed,
  SEED_WINDOW_MS,
} from "@/lib/themes/switch-rules";
import {
  MINK_GENERATED_MEDIA_FOLDER,
  MINK_GENERATED_PRODUCT_PHOTO_FOLDER,
} from "../media-generation-contract";
import { digestMinkStorefrontValue } from "../storefront-code-contract";
import {
  collectSectionMediaUrls,
  normalizeMediaUrl,
} from "../storefront-media-policy";
import { sectionContentDigest } from "../storefront-personalization-context";
import {
  isThemePhotoUrl,
  MINK_PERSONALIZATION_SCHEMA_VERSION,
} from "../storefront-personalization-contract";
import { REVAMP_SCHEMA_VERSION, type RevampOwner } from "./contract";

// ---------------------------------------------------------------------------
// Who wrote each section and each photo (docs/mink-storefront-revamp.md,
// section 9): the line between what a revamp replaces and what it keeps.
//
//   theme     still exactly as the installed theme made it: replaced;
//   mink      exactly as an earlier Mink approval wrote it: replaced;
//   merchant  anything else: kept by id, never rewritten or deleted.
//
// ★★ WHEN IN DOUBT, IT IS THE MERCHANT'S. Calling a merchant's section
//    "mink" deletes their own words; calling a Mink section "merchant" only
//    leaves an older Mink section on the page. So every rule below that cannot
//    prove Mink authored a section leaves it to the merchant.
//
// ★ BY CONTENT, NOT BY ID, for theme and mink alike: the digest is v1's
//   `sectionContentDigest` ({type, config}), so a merchant who changes one
//   character of a Mink section has made it theirs, and switching a section
//   off or restyling it does not.
// ---------------------------------------------------------------------------

/** Executed approvals read per tool: a store's recent Mink writes. */
const MAX_APPROVALS_PER_TOOL = 50;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A video is media a page loads, but not a photograph a revamp redraws. */
const VIDEO_FILE_RE = /\.(?:mp4|webm|mov|m4v|ogv)(?:[?#]|$)/i;

/**
 * The owner of every section on one page, by id.
 *
 * ★ `custom_code` IS ALWAYS THE MERCHANT'S: it is their own HTML, CSS and
 *   JavaScript, behind its own entitlement and approval path, and no revamp
 *   writes or removes it (product spec, section 1).
 */
export function classifySectionOwners(input: {
  sections: PageSectionItem[];
  themeSectionIds: ReadonlySet<string>;
  minkDigests: ReadonlySet<string>;
}): Record<string, RevampOwner> {
  // `fromEntries` defines own properties, so no id (not even "__proto__")
  // can reach the object's prototype.
  return Object.fromEntries(
    input.sections.map((section) => [section.id, ownerOf(section, input)]),
  );
}

function ownerOf(
  section: PageSectionItem,
  input: {
    themeSectionIds: ReadonlySet<string>;
    minkDigests: ReadonlySet<string>;
  },
): RevampOwner {
  if (section.type === "custom_code") return "merchant";
  if (input.themeSectionIds.has(section.id)) return "theme";
  if (
    input.minkDigests.size > 0 &&
    input.minkDigests.has(sectionContentDigest(section))
  ) {
    return "mink";
  }
  return "merchant";
}

// ---------------------------------------------------------------------------
// Sections an executed Mink approval wrote.
// ---------------------------------------------------------------------------

interface PersonalizationRow {
  plan_json: unknown;
  plan_digest: unknown;
  revamp_pages: unknown;
}

interface LayoutRow {
  after_json: unknown;
  before_json: unknown;
}

interface PageRow {
  id: string;
  slug: string;
  created_at: string;
  settings: unknown;
}

/**
 * Content digests of every section an EXECUTED Mink approval wrote for this
 * store: personalisation plans of schema 1 and 2 (`pages[].sections` in the
 * draft's `plan_json`) and layout proposals (their stored section lists).
 * The newest 50 executed approvals per tool, store-scoped on every table.
 *
 * ★★ "WROTE" MEANS AUTHORED, NOT CARRIED. Both write paths store a page's
 *    WHOLE list after the change, and that list includes the merchant's own
 *    sections carried through untouched: a layout proposal resolves
 *    `{id, keep: true}` to the exact stored section, and a revamp keeps every
 *    merchant section by id. Counting those would classify the merchant's own
 *    words as Mink's, and the next revamp would replace them. So a section
 *    counts only when the write introduced its content:
 *      - layout: what the draft's `before` snapshot did not already hold;
 *      - revamp (schema 2): what the job's own snapshot of that page did not
 *        hold (a page the revamp created had nothing before it);
 *      - personalisation (schema 1): only pages that were still the theme's
 *        when it ran. v1 stored no "before", but it only rewrites the theme's
 *        own sections, so on a page nobody had edited every section it wrote
 *        is the theme's or its own; on an edited page it cannot be told from
 *        the merchant's, and nothing is counted.
 * ★ TOLERANT: a row that cannot be read, or whose plan fails its own digest,
 *   adds nothing (the safe direction above) and is counted in one warning.
 * ★ Custom code is never collected: it is always the merchant's.
 */
export async function readMinkWrittenSectionDigests(
  db: Db,
  storeId: string,
): Promise<Set<string>> {
  const digests = new Set<string>();
  let unreadable = 0;

  const personalization = await db.execute(sql`
    select
      d.content_json ->> 'plan_json' as plan_json,
      d.content_json ->> 'plan_digest' as plan_digest,
      (
        select r.snapshot -> 'pages'
        from public.mink_revamps r
        where r.draft_id = d.id
          and r.store_id = ${storeId}::uuid
        order by r.created_at desc
        limit 1
      ) as revamp_pages
    from public.mink_action_approvals a
    join public.mink_drafts d
      on d.id = a.draft_id and d.store_id = a.store_id
    where a.store_id = ${storeId}::uuid
      and d.store_id = ${storeId}::uuid
      and a.tool_name = 'apply_storefront_personalization'
      and a.status = 'executed'
      and d.kind = 'storefront_personalization'
    order by a.executed_at desc nulls last, a.id desc
    limit ${MAX_APPROVALS_PER_TOOL}
  `);

  const v1Plans: Array<Array<Record<string, unknown>>> = [];
  for (const row of personalization.rows as unknown as PersonalizationRow[]) {
    const plan = readStoredPlan(row);
    if (!plan) {
      unreadable += 1;
      continue;
    }
    if (plan.schemaVersion === REVAMP_SCHEMA_VERSION) {
      collectRevampPlan(plan.pages, row.revamp_pages, digests);
    } else {
      v1Plans.push(plan.pages);
    }
  }
  if (v1Plans.length) {
    await collectPersonalizationPlans(db, storeId, v1Plans, digests);
  }

  const layouts = await db.execute(sql`
    select
      d.content_json ->> 'sections_json' as after_json,
      d.before_json ->> 'sections_json' as before_json
    from public.mink_action_approvals a
    join public.mink_drafts d
      on d.id = a.draft_id and d.store_id = a.store_id
    where a.store_id = ${storeId}::uuid
      and d.store_id = ${storeId}::uuid
      and a.tool_name = 'apply_storefront_layout'
      and a.status = 'executed'
      and d.kind = 'storefront_layout'
    order by a.executed_at desc nulls last, a.id desc
    limit ${MAX_APPROVALS_PER_TOOL}
  `);
  for (const row of layouts.rows as unknown as LayoutRow[]) {
    const after = parseSectionList(row.after_json);
    const before = parseSectionList(row.before_json);
    if (!after || !before) {
      unreadable += 1;
      continue;
    }
    addAuthored(after, contentDigests(before), digests);
  }

  if (unreadable) {
    // Counts only: a plan is merchant content and never goes to a log.
    logWarn("mink.revamp: unreadable Mink writes skipped", {
      storeId,
      unreadable,
    });
  }
  return digests;
}

/** A stored personalisation plan, integrity-checked, or null. */
function readStoredPlan(
  row: PersonalizationRow,
): { schemaVersion: number; pages: Array<Record<string, unknown>> } | null {
  if (typeof row.plan_json !== "string" || typeof row.plan_digest !== "string")
    return null;
  let plan: unknown;
  try {
    plan = JSON.parse(row.plan_json);
  } catch {
    return null;
  }
  if (!isRecord(plan) || !Array.isArray(plan.pages)) return null;
  if (
    plan.schemaVersion !== MINK_PERSONALIZATION_SCHEMA_VERSION &&
    plan.schemaVersion !== REVAMP_SCHEMA_VERSION
  ) {
    return null;
  }
  // ★ The digest the approval was bound to: a plan that no longer matches it
  //   is not what was applied, so it proves nothing about authorship.
  if (digestMinkStorefrontValue(plan) !== row.plan_digest) return null;
  return {
    schemaVersion: plan.schemaVersion as number,
    pages: plan.pages.filter(isRecord),
  };
}

/** Schema 2: against the revamp job's own snapshot of each page. */
function collectRevampPlan(
  pages: Array<Record<string, unknown>>,
  rawSnapshotPages: unknown,
  digests: Set<string>,
): void {
  const before = new Map<string, Set<string>>();
  if (Array.isArray(rawSnapshotPages)) {
    for (const entry of rawSnapshotPages) {
      if (!isRecord(entry) || typeof entry.id !== "string") continue;
      const sections = salvage(entry.sections);
      if (sections) before.set(entry.id, contentDigests(sections));
    }
  }
  for (const page of pages) {
    const after = salvage(page.sections);
    if (!after) continue;
    const created = page.create === true || page.pageId === null;
    const prior = created
      ? new Set<string>()
      : typeof page.pageId === "string"
        ? before.get(page.pageId)
        : undefined;
    // An existing page whose "before" is unknown proves nothing.
    if (!prior) continue;
    addAuthored(after, prior, digests);
  }
}

/** Schema 1: only pages that were still the theme's when v1 ran. */
async function collectPersonalizationPlans(
  db: Db,
  storeId: string,
  plans: Array<Array<Record<string, unknown>>>,
  digests: Set<string>,
): Promise<void> {
  const ids = [
    ...new Set(
      plans.flatMap((pages) =>
        pages.flatMap((page) =>
          typeof page.pageId === "string" && UUID_RE.test(page.pageId)
            ? [page.pageId]
            : [],
        ),
      ),
    ),
  ];
  if (!ids.length) return;
  // ★ Ids are checked as uuids first: one malformed id in a stored plan
  //   would otherwise fail the cast and abort the caller's transaction.
  const result = await db.execute(sql`
    select page.id, page.slug, page.created_at, store.settings
    from public.store_pages page
    join public.stores store on store.id = page.store_id
    where page.store_id = ${storeId}::uuid
      and store.id = ${storeId}::uuid
      and page.id = any(${sql.param(ids)}::uuid[])
  `);
  const rows = new Map(
    (result.rows as unknown as PageRow[]).map((row) => [row.id, row]),
  );
  for (const pages of plans) {
    for (const page of pages) {
      if (typeof page.pageId !== "string") continue;
      const row = rows.get(page.pageId);
      if (!row || !untouchedWhenPersonalised(row, page.expectedVersion)) {
        continue;
      }
      const written = salvage(page.sections);
      if (written) addAuthored(written, new Set(), digests);
    }
  }
}

/**
 * Was this page still the theme's own when v1 wrote it? v1's own "edited"
 * rule (storefront-personalization-context.ts), asked of the version the plan
 * recorded rather than of the page today.
 *
 * ★ An unreadable time is "edited": nothing is proved, so nothing is counted
 *   (`homepageEditedSinceSeed` alone would call an unparseable time unedited).
 */
function untouchedWhenPersonalised(row: PageRow, expected: unknown): boolean {
  if (typeof expected !== "string") return false;
  const version = Date.parse(expected);
  const created = Date.parse(row.created_at);
  if (!Number.isFinite(version) || !Number.isFinite(created)) return false;
  if (row.slug === "") {
    return !homepageEditedSinceSeed(row.settings, {
      createdAt: row.created_at,
      updatedAt: expected,
    });
  }
  return Math.abs(version - created) <= SEED_WINDOW_MS;
}

function addAuthored(
  written: readonly PageSectionItem[],
  before: ReadonlySet<string>,
  digests: Set<string>,
): void {
  for (const section of written) {
    if (section.type === "custom_code") continue;
    const digest = sectionContentDigest(section);
    if (!before.has(digest)) digests.add(digest);
  }
}

function contentDigests(sections: readonly PageSectionItem[]): Set<string> {
  return new Set(sections.map(sectionContentDigest));
}

/** A stored section list (JSON text), in the draft-validated form the
 *  Builder reader compares in, or null when it is not a list at all. */
function parseSectionList(raw: unknown): PageSectionItem[] | null {
  if (typeof raw !== "string") return null;
  try {
    return salvage(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * ★ SALVAGED, NOT VALIDATED WHOLE: one section a later registry change
 *   refuses must not hide the rest of a write. Draft mode, the form the
 *   Builder reader stores and compares sections in.
 */
function salvage(raw: unknown): PageSectionItem[] | null {
  if (!Array.isArray(raw)) return null;
  return salvageSections(raw, { mode: "draft" }).sections;
}

// ---------------------------------------------------------------------------
// Photos.
// ---------------------------------------------------------------------------

/**
 * Every image URL a section list shows, in document order, without videos.
 * The `_url` suffix walk is 9D's (storefront-media-policy.ts), so a field
 * nested at any depth is found.
 */
export function collectRevampImageUrls(
  sections: readonly PageSectionItem[],
): string[] {
  return collectSectionMediaUrls(sections).filter(
    (url) => !VIDEO_FILE_RE.test(url),
  );
}

/**
 * May a revamp replace this picture?
 *
 * Yes for a theme file (a bundled `/themes/...` asset or a published Theme
 * Studio release's copy), for an object under THIS store's `mink-generated/`
 * folder (a picture an earlier Mink run drew, an earlier revamp's shoot
 * included), and for a URL that no longer loads.
 *
 * ★★ NEVER A WORKING MERCHANT UPLOAD OR A PRODUCT PHOTO. Anything else on a
 *    page is something a person chose, so it is kept. A Mink catalogue photo
 *    (`mink-generated/product-photos/`) is a photograph of a real product,
 *    so it is a product photo, not campaign art, and is kept too.
 * ★ A broken URL shows nothing, so replacing it destroys nothing, whoever
 *   uploaded it.
 */
export function isReplaceablePhotoUrl(
  url: string,
  options: { storeId: string; broken: ReadonlySet<string> },
): boolean {
  const value = normalizeMediaUrl(url);
  if (!value) return false;
  if (options.broken.has(value)) return true;
  if (isThemePhotoUrl(value)) return true;
  if (!options.storeId) return false;
  const objectPath = gcsPathFromUrl(value);
  if (!objectPath || objectPath.split("/").includes("..")) return false;
  const generated = `stores/${options.storeId}/${MINK_GENERATED_MEDIA_FOLDER}/`;
  const productPhotos = `stores/${options.storeId}/${MINK_GENERATED_PRODUCT_PHOTO_FOLDER}/`;
  return (
    objectPath.startsWith(generated) && !objectPath.startsWith(productPhotos)
  );
}

/** URLs checked by default; a large store's tail is left unchecked. */
const BROKEN_CHECK_DEFAULT_LIMIT = 80;
const BROKEN_CHECK_MAX_LIMIT = 400;
const BROKEN_CHECK_CONCURRENCY = 6;
/** One check: a bucket lookup is two round trips, a file stat far less. */
const BROKEN_CHECK_TIMEOUT_MS = 3_000;
/**
 * ★ The whole pass, inside the snapshot step's budget (under 10 s, product
 *   spec 4.3): once spent, no new check starts and the rest count as loading.
 */
const BROKEN_CHECK_BUDGET_MS = 6_000;

type BrokenCheckTarget =
  | { url: string; kind: "bucket"; objectPath: string }
  | { url: string; kind: "theme"; file: string };

/**
 * Which of these image URLs no longer load.
 *
 * Checked: objects in our own bucket (`gcsObjectInfo`: missing or empty is
 * broken) and bundled theme files (`/themes/...`, the file under `public/`).
 * ★★ ONLY A DEFINITE "IT IS NOT THERE" COUNTS. An external host is never
 *    counted broken (we cannot tell a slow CDN from a missing file), and a
 *    timeout or an error reads as loading: a false "broken" would make a
 *    merchant's own photo replaceable.
 * ★ Bounded: duplicates removed, at most `limit` (default 80) checkable URLs
 *   in the order given (callers put what matters most first), six at a time,
 *   each with its own timeout, the whole pass within a fixed budget.
 * ★ The signal is honoured: an abort stops new checks and rejects with the
 *   abort reason, which the runner reads (a hand-over, a cancel or a lost
 *   lease). It is never swallowed.
 */
export async function findBrokenImages(
  urls: readonly string[],
  options: { signal: AbortSignal; limit?: number },
): Promise<Set<string>> {
  const { signal } = options;
  signal.throwIfAborted();
  const limit = readLimit(options.limit);
  const targets: BrokenCheckTarget[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (targets.length >= limit) break;
    const url = normalizeMediaUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const target = brokenCheckTarget(url);
    if (target) targets.push(target);
  }
  const broken = new Set<string>();
  if (!targets.length) return broken;

  let next = 0;
  let budgetSpent = false;
  const budget = setTimeout(() => {
    budgetSpent = true;
  }, BROKEN_CHECK_BUDGET_MS);
  const worker = async () => {
    while (next < targets.length && !budgetSpent) {
      signal.throwIfAborted();
      const target = targets[next++];
      if ((await checkWithTimeout(target, signal)) === true) {
        broken.add(target.url);
      }
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(BROKEN_CHECK_CONCURRENCY, targets.length) },
        worker,
      ),
    );
  } finally {
    clearTimeout(budget);
  }
  signal.throwIfAborted();
  return broken;
}

function readLimit(value: unknown): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return BROKEN_CHECK_DEFAULT_LIMIT;
  return Math.min(parsed, BROKEN_CHECK_MAX_LIMIT);
}

function brokenCheckTarget(url: string): BrokenCheckTarget | null {
  if (url.startsWith("/themes/")) {
    const file = themeFilePath(url);
    return file ? { url, kind: "theme", file } : null;
  }
  const objectPath = gcsPathFromUrl(url);
  return objectPath ? { url, kind: "bucket", objectPath } : null;
}

/**
 * The file a `/themes/...` URL serves from `public/`, or null.
 * ★ Resolved and then checked to stay inside `public/themes/`, so a crafted
 *   URL can never make this stat a file anywhere else on the server.
 */
function themeFilePath(url: string): string | null {
  const pathname = url.split(/[?#]/, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/themes/") || decoded.includes("\0")) return null;
  const publicRoot = path.join(process.cwd(), "public");
  const themesRoot = path.join(publicRoot, "themes") + path.sep;
  const resolved = path.resolve(publicRoot, `.${decoded}`);
  return resolved.startsWith(themesRoot) ? resolved : null;
}

/** True: broken. False: loads. Null: unknown (timed out or failed). */
function checkWithTimeout(
  target: BrokenCheckTarget,
  signal: AbortSignal,
): Promise<boolean | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    const timer = setTimeout(
      () => finish(() => resolve(null)),
      BROKEN_CHECK_TIMEOUT_MS,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    probe(target).then(
      (verdict) => finish(() => resolve(verdict)),
      () => finish(() => resolve(null)),
    );
  });
}

async function probe(target: BrokenCheckTarget): Promise<boolean | null> {
  if (target.kind === "bucket") {
    const info = await gcsObjectInfo("public", target.objectPath);
    // An empty object cannot be an image either.
    return info === null || info.size === 0;
  }
  try {
    const info = await stat(target.file);
    return !info.isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // Only "there is no such file" is broken; a permission or I/O error is
    // not evidence about the picture.
    return code === "ENOENT" || code === "ENOTDIR" ? true : null;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("This operation was aborted", "AbortError")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
