import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { after } from "next/server";
import {
  categories,
  minkRevamps,
  products,
  storeChrome,
  storePages,
  stores,
} from "@/drizzle/schema";
import { can } from "@/app/dashboard/lib/permissions";
import { contrastIssuesFor } from "@/lib/chrome/design";
import { sanitizeChromeForSave, type StoreChrome } from "@/lib/chrome/types";
import { withService, type Db } from "@/lib/db/client";
import { emitEvent } from "@/lib/notifications/record";
import { logError, logWarn } from "@/lib/observability/logger";
import { effectivePlan } from "@/lib/plans";
import { sanitizeBlogContent } from "@/lib/sanitize";
import {
  validateSections,
  type PageSectionItem,
  type RichTextConfig,
} from "@/lib/sections/registry";
import { notifyStoreContentPublished } from "@/lib/seo/store-indexing";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { getStoreOriginById } from "@/lib/site";
import { STORE_TAG } from "@/lib/store/resolve";
import { TAGS } from "@/lib/storefront/tags";
import { readThemeSelection } from "@/lib/themes/meta";
import { resolveInstalledThemeDefinitionWithDb } from "@/lib/themes/runtime-registry";
import { MinkRequestError } from "../errors";
import type { MinkActorContext } from "../types";
import { REVAMP_LIMITS, type RevampStoredPlan } from "./contract";
import { revampChromeDigest, revampSectionsDigest } from "./digests";
import { readRevampForActor } from "./jobs";
import {
  REVAMP_LIFECYCLE_VERSION,
  type RevampApplySnapshot,
  type RevampApplySnapshotCategory,
  type RevampApplySnapshotPage,
  type RevampPageLiveFingerprint,
  type RevampPageMeta,
  type RevampPublishResult,
  type RevampPublishSnapshot,
  type RevampPublishSnapshotPage,
  type RevampUndoResult,
} from "./lifecycle-types";

// ---------------------------------------------------------------------------
// Publish and Undo for an applied storefront revamp
// (docs/mink-storefront-revamp.md, section 10). Apply (apply-v2.ts) writes
// the Builder drafts and the live catalogue changes and records
// `mink_revamps.apply_snapshot`; the card then offers "Publish to your store"
// and "Undo", which are these two functions, behind the revamps route.
//
// ★★ PUBLISH IS publishPage + publishChrome, FOR EVERY TARGET AT ONCE. The
//    same strict section validation (the custom-code lock included), the same
//    rich-text sanitising, the same contrast gate on the header and footer,
//    the same writes, the same cache tags, the same indexing hook and the
//    same `page.published` events. Those two are server actions that read
//    the request (`getManagerUserId`, the host store, one target each), so
//    the rules are restated here once, in one transaction, rather than called
//    eight times with eight partial failures. A page the merchant deleted, or
//    one that no longer passes the publish bar, is skipped and named; the
//    rest goes live.
// ★★ WHAT GOES LIVE IS EACH PAGE'S CURRENT DRAFT. Publish does not check
//    that a page's draft is still what Apply wrote: like the Builder's own
//    Publish button, it puts the page's whole draft live, edits made since
//    Apply included (the card says so). Only pages Apply wrote are touched.
// ★★ AND THE REDESIGN'S TITLE AND SEARCH TEXT GO LIVE HERE, NOT AT APPLY.
//    They have no draft layer, so Apply only recorded them (`proposed`).
//    Each field still exactly what Apply left gets the redesign's; a field
//    the merchant changed after Apply keeps theirs and is named. The values
//    before and after are recorded (`meta`) so Undo can put them back.
//
// ★★ UNDO RESTORES ONLY WHAT IS STILL THE REVAMP'S. Every target carries the
//    revamp's own result (a digest, an `updated_at`) in the snapshots, and a
//    target is put back only while it still equals that result. Anything the
//    merchant changed since is kept and named in plain words, because an Undo
//    that silently threw away an afternoon of their edits would be the worst
//    thing this card could do. One transaction for every database write; the
//    storefront caches are expired after it commits.
// ★★ AND IT DELETES ONLY WHAT NOTHING ELSE USES. A new product an order, an
//    offer or a review points at, and a new category with products or an
//    offer, stay (a product comes off the shop instead): the offer and review
//    rows CASCADE, so a delete nothing refuses would take them with it, and
//    an offer left with no scope covers every product in the store. Undo also
//    needs the Products, Categories and Branding permissions Apply needed for
//    the same rows (assertUndoPartAuthority).
//
// ★ BOTH ARE IDEMPOTENT ON THE REVAMP ROW, which is locked first in both, so
//   two clicks (or two tabs) cannot publish twice or undo twice. The answer
//   is stored with the snapshot it describes (`publish_snapshot.answer`,
//   `apply_snapshot.undo`: there is no undo column) and a repeat call returns
//   it unchanged.
//
// ★ THE DATABASE WORK SITS BEHIND `LifecycleTx`, implemented once over
//   Drizzle below. The unit tests drive the decisions through an in-memory
//   copy of it; apply.local.test.ts drives the real one against Postgres.
// ---------------------------------------------------------------------------

const CHROME_LABEL = "Header and footer";
const CHANGED = "You changed it after the redesign, so your version was kept.";

/** The page fields with no draft layer, in the merchant's words. */
const META_FIELDS = [
  ["title", "title"],
  ["seoTitle", "search title"],
  ["seoDescription", "search description"],
] as const satisfies ReadonlyArray<readonly [keyof RevampPageMeta, string]>;

/** The store text Apply writes live, in the merchant's words. */
const BRAND_FIELDS = [
  ["tagline", "Store tagline"],
  ["blurb", "Footer description"],
] as const;

/** A page entry in `publish_snapshot` (lifecycle-types.ts describes it). */
export type RevampPublishRecordPage = RevampPublishSnapshotPage;
/** What `publish_snapshot` holds, answer included. */
export type RevampPublishRecord = RevampPublishSnapshot;

export interface LockedRevamp {
  appliedAt: string | null;
  publishedAt: string | null;
  undoneAt: string | null;
  applySnapshot: unknown;
  publishSnapshot: unknown;
}

export interface LockedPage {
  id: string;
  slug: string;
  title: string;
  seoTitle: string;
  seoDescription: string;
  sections: unknown;
  publishedSections: unknown;
  status: string;
  publishedAt: string | null;
  /** True when `updated_at` equals the instant asked about (to the ms). */
  clockMatches: boolean;
}

export interface LockedChrome {
  draft: unknown;
  published: unknown;
  publishedAt: string | null;
}

export interface LockedProduct {
  name: string;
  status: string;
  /**
   * Nothing about the product changed since the instant asked about: not
   * the row (any field) and not its stock (any size's).
   */
  unchanged: boolean;
  ordered: boolean;
  /**
   * What else in the store points at it: an offer (scoped to it or one of
   * its sizes, or giving it away) or a shopper's review. ★ Those rows go with
   * the product when it is deleted, and an offer that loses its only scope
   * row covers every line in the store, so a used product is never deleted.
   */
  usedBy: "offer" | "review" | null;
}

export interface LockedCategory {
  name: string;
  unchanged: boolean;
  /** Products filed under it, or an offer scoped to it (which would cascade). */
  usedBy: "products" | "offer" | null;
}

export interface PagePatch {
  title?: string;
  seoTitle?: string;
  seoDescription?: string;
  sections?: PageSectionItem[];
  publishedSections?: PageSectionItem[];
  status?: string;
  publishedAt?: string | null;
}

export interface ChromePatch {
  draft?: StoreChrome;
  published?: StoreChrome | null;
  publishedAt?: string | null;
}

export interface CategoryPatch {
  name?: string;
  description?: string | null;
  imageUrl?: string | null;
  status?: string;
}

export type ThemeDesignForContrast = Parameters<typeof contrastIssuesFor>[1];

/** A newer version of the redesign: one of its refinements, any generation. */
export interface NewerRevampVersion {
  appliedAt: string | null;
  undoneAt: string | null;
}

/** Everything Publish and Undo read or write, inside one transaction. */
export interface LifecycleTx {
  lockRevamp(): Promise<LockedRevamp | null>;
  /**
   * The redesign's newer versions (its refinements, every generation under
   * it), read after `lockRevamp` and never locked (refuseWhileNewerApplied
   * says why).
   */
  newerVersions(): Promise<NewerRevampVersion[]>;
  storeFacts(): Promise<{
    customCode: boolean;
    themeDesign: ThemeDesignForContrast;
  } | null>;
  lockPage(
    pageId: string,
    expectedUpdatedAt: string | null,
  ): Promise<LockedPage | null>;
  /**
   * Returns the row's `updated_at` after the write. `meta` holds the title
   * and search text fields to write in the same statement (none by default).
   */
  publishPage(
    pageId: string,
    sections: PageSectionItem[],
    now: string,
    meta?: Partial<RevampPageMeta>,
  ): Promise<string | null>;
  lockChrome(): Promise<LockedChrome | null>;
  publishChrome(published: StoreChrome, now: string): Promise<void>;
  markPublished(record: RevampPublishRecord, now: string): Promise<void>;
  updatePage(pageId: string, patch: PagePatch): Promise<void>;
  deletePage(pageId: string): Promise<void>;
  updateChrome(patch: ChromePatch): Promise<void>;
  deleteChrome(): Promise<void>;
  lockBrand(): Promise<Record<string, unknown> | null>;
  writeBrand(brand: Record<string, unknown>): Promise<void>;
  lockProduct(
    id: string,
    afterUpdatedAt: string,
  ): Promise<LockedProduct | null>;
  /** False when the database refuses (something still references it). */
  deleteProduct(id: string): Promise<boolean>;
  /** `publishedAt`, when given, is written too (null clears it). */
  setProductStatus(
    id: string,
    status: string,
    publishedAt?: string | null,
  ): Promise<void>;
  lockCategory(
    id: string,
    afterUpdatedAt: string,
  ): Promise<LockedCategory | null>;
  deleteCategory(id: string): Promise<void>;
  updateCategory(id: string, patch: CategoryPatch): Promise<void>;
  markUndone(
    applySnapshot: Record<string, unknown>,
    now: string,
  ): Promise<void>;
}

export interface RevampLifecycleDeps {
  transaction<T>(
    actor: MinkActorContext,
    revampId: string,
    run: (tx: LifecycleTx) => Promise<T>,
  ): Promise<T>;
}

const DEFAULT_DEPS: RevampLifecycleDeps = {
  transaction: (actor, revampId, run) =>
    withService((db) => run(databaseTx(db, actor, revampId))),
};

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

interface PublishWrote {
  pages: Array<{ pageId: string; slug: string }>;
  chrome: boolean;
}

export async function publishRevamp(
  actor: MinkActorContext,
  revampId: string,
  deps: RevampLifecycleDeps = DEFAULT_DEPS,
): Promise<RevampPublishResult> {
  assertBuilderManage(actor);
  const row = await readRevampForActor(actor, revampId);
  if (!row) throw notFound();
  if (row.undoneAt) throw undone();
  if (!row.appliedAt) throw notApplied();
  if (row.publishedAt) return publishAnswerOf(row.publishSnapshot);
  const stored = row.result?.stored ?? null;
  const now = new Date().toISOString();

  const outcome = await deps.transaction(actor, revampId, async (tx) => {
    const locked = await tx.lockRevamp();
    if (!locked) throw notFound();
    if (locked.undoneAt) throw undone();
    if (!locked.appliedAt) throw notApplied();
    // ★ Another tab won the lock: its answer is this one too.
    if (locked.publishedAt) {
      return {
        answer: publishAnswerOf(locked.publishSnapshot),
        wrote: null,
      };
    }
    const apply = readApplySnapshot(locked.applySnapshot);
    if (!apply) throw unreadable("published from here");
    return publishInside(tx, apply, stored, now);
  });

  if (outcome.wrote) await afterPublish(actor, outcome.wrote);
  return outcome.answer;
}

async function publishInside(
  tx: LifecycleTx,
  apply: RevampApplySnapshot,
  stored: RevampStoredPlan | null,
  now: string,
): Promise<{ answer: RevampPublishResult; wrote: PublishWrote | null }> {
  const published: string[] = [];
  const skipped: RevampPublishResult["skipped"] = [];
  const pages: RevampPublishRecordPage[] = [];
  const wrote: PublishWrote = { pages: [], chrome: false };
  const facts = await tx.storeFacts();
  if (!facts) throw notFound();

  for (const target of publishTargets(apply, stored)) {
    if ("skip" in target) {
      skipped.push(target.skip);
      continue;
    }
    const { entry, label } = target;
    const row = await tx.lockPage(entry.pageId, entry.afterUpdatedAt);
    if (!row) {
      skipped.push({
        label,
        reason: "You deleted this page, so it was not published.",
      });
      continue;
    }
    const checked = publishableSections(row.sections, facts.customCode);
    if ("error" in checked) {
      skipped.push({ label, reason: checked.error });
      continue;
    }
    // The same test Undo uses (draftStillRevamps): a title edit since Apply
    // does not make the draft the merchant's, a publish of their own does.
    // Where the title rides with the draft (a page the redesign made, or an
    // older snapshot), the clock still decides, as in Undo.
    const draftWasApplied =
      entry.created || entry.proposed === undefined
        ? row.clockMatches &&
          sectionsDigestOf(row.sections) === entry.afterDigest
        : draftStillRevamps(
            row,
            entry.afterDigest,
            entry.live?.publishedDigest ?? null,
          );
    // The live state is read before the write that replaces it.
    const before = {
      status: row.status,
      publishedSections: sectionList(row.publishedSections),
      publishedAt: row.publishedAt,
    };
    const meta =
      entry.proposed && entry.before
        ? publishMeta(row, entry.before, entry.proposed)
        : null;
    if (meta?.kept.length) {
      skipped.push({
        label: `${label} ${metaWords(meta.kept)}`,
        reason: CHANGED,
      });
    }
    const afterUpdatedAt = await tx.publishPage(
      row.id,
      checked.sections,
      now,
      meta?.write,
    );
    const digest = revampSectionsDigest(checked.sections);
    pages.push({
      pageId: row.id,
      label,
      before,
      afterPublishedDigest: digest,
      afterUpdatedAt,
      afterDraftDigest: digest,
      draftWasApplied,
      meta: meta ? { before: meta.before, after: meta.after } : null,
    });
    wrote.pages.push({ pageId: row.id, slug: row.slug });
    published.push(label);
  }

  let chrome: RevampPublishSnapshot["chrome"] = null;
  if (apply.chrome) {
    const row = await tx.lockChrome();
    if (!row) {
      skipped.push({
        label: CHROME_LABEL,
        reason: "There is no header and footer draft to publish.",
      });
    } else {
      // publishChrome's rules: re-sanitise on the way out, then the
      // legibility gate, judged against the store's own theme.
      const next = sanitizeChromeForSave(row.draft);
      const issues = contrastIssuesFor(next.design, facts.themeDesign);
      if (issues.length > 0) {
        skipped.push({
          label: CHROME_LABEL,
          reason: `The colour scheme is not readable, so it can't go live yet. ${issues.join(" ")}`,
        });
      } else {
        chrome = {
          before: (row.published ?? null) as StoreChrome | null,
          beforePublishedAt: row.publishedAt,
          afterDigest: revampChromeDigest(next),
        };
        await tx.publishChrome(next, now);
        wrote.chrome = true;
        published.push(CHROME_LABEL);
      }
    }
  } else if (stored?.chrome) {
    skipped.push({
      label: CHROME_LABEL,
      reason: "They were not changed when the redesign was applied.",
    });
  }

  const answer: RevampPublishResult = { published, skipped };
  // ★ Nothing went live, so nothing is recorded: the card can offer Publish
  //   again once the merchant fixes what the reasons name.
  if (pages.length === 0 && chrome === null) return { answer, wrote: null };
  await tx.markPublished(
    {
      version: REVAMP_LIFECYCLE_VERSION,
      publishedAt: now,
      pages,
      chrome,
      answer,
    },
    now,
  );
  return { answer, wrote };
}

/**
 * What Publish does with an existing page's title and search text, field by
 * field. ★ "Changed after Apply" is measured against what Apply left, which is
 * the page's own value before the redesign (Apply no longer writes them): a
 * field still equal to it gets the redesign's, a field the merchant changed
 * keeps theirs and is named. A field the redesign leaves as it is needs no
 * write either way.
 */
export function publishMeta(
  live: RevampPageMeta,
  applied: RevampPageMeta,
  proposed: RevampPageMeta,
): {
  before: RevampPageMeta;
  after: RevampPageMeta;
  write: Partial<RevampPageMeta>;
  kept: Array<keyof RevampPageMeta>;
} {
  const before: RevampPageMeta = {
    title: live.title,
    seoTitle: live.seoTitle,
    seoDescription: live.seoDescription,
  };
  const write: Partial<RevampPageMeta> = {};
  const kept: Array<keyof RevampPageMeta> = [];
  for (const [field] of META_FIELDS) {
    if (proposed[field] === before[field]) continue;
    if (before[field] === applied[field]) write[field] = proposed[field];
    else kept.push(field);
  }
  return { before, after: { ...before, ...write }, write, kept };
}

/** "title", "title and search title", "title, search title and …". */
function metaWords(fields: ReadonlyArray<keyof RevampPageMeta>): string {
  const words = META_FIELDS.filter(([field]) => fields.includes(field)).map(
    ([, word]) => word,
  );
  return words.length <= 1
    ? words.join("")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

type PublishTarget =
  | { entry: RevampApplySnapshotPage; label: string }
  | { skip: { label: string; reason: string } };

/** The stored plan's pages, each resolved to the page Apply wrote. */
export function publishTargets(
  apply: RevampApplySnapshot,
  stored: RevampStoredPlan | null,
): PublishTarget[] {
  const targets: PublishTarget[] = [];
  const used = new Set<string>();
  for (const page of stored?.pages ?? []) {
    const label = pageLabel(page.slug, page.title);
    // A created page has no id in the plan; Apply recorded the one it made.
    const entry = page.pageId
      ? apply.pages.find((candidate) => candidate.pageId === page.pageId)
      : apply.pages.find(
          (candidate) => candidate.created && candidate.slug === page.slug,
        );
    if (!entry) {
      // ★ Publishing a page Apply did not write would push the merchant's
      //   own unpublished edits live under the redesign's name.
      targets.push({
        skip: {
          label,
          reason: page.create
            ? "It was not created when the redesign was applied."
            : "It was not changed when the redesign was applied.",
        },
      });
      continue;
    }
    used.add(entry.pageId);
    targets.push({ entry, label });
  }
  // A page Apply wrote is the redesign's even if the plan lost track of it.
  for (const entry of apply.pages) {
    if (!used.has(entry.pageId))
      targets.push({ entry, label: pageLabel(entry.slug, null) });
  }
  return targets;
}

/**
 * publishPage's processSections(raw, "publish", raw): the publish bar, with a
 * custom-code section the plan has locked held to the bar it was saved under
 * (the stored copy IS the copy being published, so every one is unchanged),
 * then rich text sanitised.
 */
export function publishableSections(
  raw: unknown,
  customCodeAllowed: boolean,
): { sections: PageSectionItem[] } | { error: string } {
  const shaped = validateSections(raw, { mode: "draft" });
  const codeIds =
    "sections" in shaped
      ? shaped.sections
          .filter((section) => section.type === "custom_code")
          .map((section) => section.id)
      : [];
  const lenientIds =
    !customCodeAllowed && codeIds.length > 0 ? new Set(codeIds) : undefined;
  const result = validateSections(raw, { mode: "publish", lenientIds });
  if ("error" in result) return result;
  return {
    sections: result.sections.map((section) => {
      if (section.type !== "rich_text") return section;
      const config = section.config as RichTextConfig;
      return {
        ...section,
        config: { ...config, html: sanitizeBlogContent(config.html) },
      };
    }),
  };
}

async function afterPublish(
  actor: MinkActorContext,
  wrote: PublishWrote,
): Promise<void> {
  // ★ The writes have committed: nothing below may turn that into a failure.
  try {
    revalidatePath("/dashboard/builder");
    for (const page of wrote.pages)
      revalidatePath(page.slug ? `/${page.slug}` : "/");
    if (wrote.pages.length) revalidateTag(TAGS.pages, "max");
    if (wrote.chrome) revalidateTag(TAGS.chrome, "max");
  } catch (error) {
    logError("mink.revamp: publish revalidation failed", error, {
      storeId: actor.storeId,
    });
  }
  try {
    const base = await getStoreOriginById(actor.storeId).catch(() => null);
    const paths = wrote.pages.map((page) =>
      page.slug ? `/${page.slug}` : "/",
    );
    if (paths.length) {
      after(() =>
        notifyStoreContentPublished({
          storeId: actor.storeId,
          paths: [...new Set([...paths, "/"])],
        }),
      );
    }
    for (const page of wrote.pages) {
      const path = page.slug ? `/${page.slug}` : "/";
      emitEvent({
        type: "page.published",
        storeId: actor.storeId,
        actor: { type: "admin", id: actor.adminId },
        subject: { type: "page", id: page.pageId, label: page.slug || "Home" },
        payload: {
          page: page.slug || "Home",
          url: base ? `${base}${path}` : path,
        },
      });
    }
    if (wrote.chrome) {
      emitEvent({
        type: "page.published",
        storeId: actor.storeId,
        actor: { type: "admin", id: actor.adminId },
        subject: { type: "page", id: "chrome", label: "Header & footer" },
        payload: { page: "Header & footer" },
      });
    }
  } catch (error) {
    logError("mink.revamp: publish follow-up failed", error, {
      storeId: actor.storeId,
    });
  }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export async function undoRevamp(
  actor: MinkActorContext,
  revampId: string,
  deps: RevampLifecycleDeps = DEFAULT_DEPS,
): Promise<RevampUndoResult> {
  assertBuilderManage(actor);
  const row = await readRevampForActor(actor, revampId);
  if (!row) throw notFound();
  if (row.undoneAt) return undoAnswerOf(row.applySnapshot);
  if (!row.appliedAt) throw notApplied();
  const stored = row.result?.stored ?? null;
  const now = new Date().toISOString();

  const outcome = await deps.transaction(actor, revampId, async (tx) => {
    const locked = await tx.lockRevamp();
    if (!locked) throw notFound();
    if (locked.undoneAt) {
      return { answer: undoAnswerOf(locked.applySnapshot), slugs: null };
    }
    if (!locked.appliedAt) throw notApplied();
    const apply = readApplySnapshot(locked.applySnapshot);
    if (!apply) throw unreadable("undone automatically");
    // ★ Before any write: refusing here rolls back nothing but the lock.
    assertUndoPartAuthority(actor, apply);
    refuseWhileNewerApplied(await tx.newerVersions());
    const publish = locked.publishedAt
      ? readPublishRecord(locked.publishSnapshot)
      : null;
    // ★ Without the publish record Undo cannot tell the live pages it
    //   published from the merchant's, so it refuses rather than guess.
    if (locked.publishedAt && !publish)
      throw unreadable("undone automatically");
    const undoneNow = await undoInside(tx, apply, publish, stored);
    await tx.markUndone(
      { ...(record(locked.applySnapshot) ?? {}), undo: undoneNow.answer },
      now,
    );
    return undoneNow;
  });

  if (outcome.slugs) afterUndo(actor, outcome.slugs);
  return outcome.answer;
}

async function undoInside(
  tx: LifecycleTx,
  apply: RevampApplySnapshot,
  publish: RevampPublishRecord | null,
  stored: RevampStoredPlan | null,
): Promise<{ answer: RevampUndoResult; slugs: string[] }> {
  const restored: string[] = [];
  const kept: RevampUndoResult["kept"] = [];
  const slugs: string[] = [];

  // Pages.
  for (const page of apply.pages) {
    const live = publish?.pages.find((entry) => entry.pageId === page.pageId);
    const expectedUpdatedAt = live?.afterUpdatedAt ?? page.afterUpdatedAt;
    const expectedDigest = live?.afterDraftDigest ?? page.afterDigest;
    const row = await tx.lockPage(page.pageId, expectedUpdatedAt);
    const label = labelOfPage(stored, page, row?.title ?? null);
    if (!row) {
      kept.push({
        label,
        reason: "You deleted this page, so there was nothing to put back.",
      });
      continue;
    }
    slugs.push(row.slug);
    // ★ A snapshot that recorded `proposed` comes from an Apply that left the
    //   title and search text alone, so only Publish's record can put them
    //   back. An older snapshot's Apply wrote them, and they come back with
    //   the draft as they always did.
    const metaWaited = page.proposed !== undefined;
    // ★★ An existing page's draft is decided by its sections and what is
    //    live (draftStillRevamps), not the page clock: page settings save
    //    the title and search text straight to the row, and those come back
    //    field by field below. Where the title rides with the draft instead
    //    (a page the redesign MADE has no "before" for its title or address,
    //    and an older snapshot restores them with the draft), any write to
    //    the page is the merchant's, so the clock still decides.
    const draftIsRevamps =
      page.created || !metaWaited
        ? (live ? live.draftWasApplied : true) &&
          row.clockMatches &&
          sectionsDigestOf(row.sections) === expectedDigest
        : live
          ? live.draftWasApplied &&
            draftStillRevamps(row, expectedDigest, live.afterPublishedDigest)
          : draftStillRevamps(
              row,
              page.afterDigest,
              page.live?.publishedDigest ?? null,
            );
    // ★★ What Publish left is a PUBLISHED page with those sections. The
    //    Builder's Unpublish sets the status alone and keeps
    //    published_sections, so the digest by itself would put back live a
    //    page the merchant deliberately took off their store.
    const liveIsRevamps =
      !live ||
      (row.status === "published" &&
        sectionsDigestOf(row.publishedSections) === live.afterPublishedDigest);
    const unpublishedSince =
      !!live &&
      row.status !== "published" &&
      sectionsDigestOf(row.publishedSections) === live.afterPublishedDigest;

    if (page.created) {
      // ★ A page the redesign made is removed only while nothing about it is
      //   the merchant's: not its draft, and not what is live.
      if (
        draftIsRevamps &&
        liveIsRevamps &&
        (live || row.status !== "published")
      ) {
        await tx.deletePage(row.id);
        restored.push(`Removed the new ${label}`);
      } else {
        kept.push({
          label,
          reason:
            "You changed this new page after the redesign, so it was kept.",
        });
      }
      continue;
    }

    const patch: PagePatch = {};
    if (!draftIsRevamps) kept.push({ label, reason: CHANGED });
    else if (page.before) {
      if (!metaWaited) {
        patch.title = page.before.title;
        patch.seoTitle = page.before.seoTitle;
        patch.seoDescription = page.before.seoDescription;
      }
      patch.sections = page.before.sections;
    }
    const draftBack = patch.sections !== undefined;
    if (live) {
      if (liveIsRevamps) {
        patch.publishedSections = live.before.publishedSections;
        patch.status = live.before.status;
        patch.publishedAt = live.before.publishedAt;
      } else {
        kept.push({
          label: `${label} (live)`,
          reason: unpublishedSince
            ? "You unpublished it after the redesign, so it was left unpublished."
            : "It was published again after the redesign, so the live page was kept.",
        });
      }
    }
    const metaBack: Array<keyof RevampPageMeta> = [];
    if (live?.meta) {
      // ★ Field by field, each while it is still what Publish left: they are
      //   live values with no draft, so they follow neither the draft's nor
      //   the live sections' fate.
      const { before, after } = live.meta;
      const changed: Array<keyof RevampPageMeta> = [];
      for (const [field] of META_FIELDS) {
        if (before[field] === after[field]) continue;
        if (row[field] === after[field]) {
          patch[field] = before[field];
          metaBack.push(field);
        } else changed.push(field);
      }
      if (changed.length) {
        kept.push({ label: `${label} ${metaWords(changed)}`, reason: CHANGED });
      }
    }
    if (Object.keys(patch).length > 0) {
      await tx.updatePage(row.id, patch);
      // Name what came back: the page (its draft), only the live page, or
      // only the title and search text Publish wrote.
      restored.push(
        draftBack
          ? label
          : patch.publishedSections !== undefined || !metaBack.length
            ? `${label} (live)`
            : `${label} ${metaWords(metaBack)}`,
      );
    }
  }

  // Header and footer.
  if (apply.chrome) {
    const liveChrome = publish?.chrome ?? null;
    const row = await tx.lockChrome();
    if (!row) {
      if (apply.chrome.rowExisted) {
        kept.push({
          label: CHROME_LABEL,
          reason:
            "They were removed after the redesign, so there was nothing to put back.",
        });
      }
    } else {
      const draftIsRevamps =
        chromeDigestOf(row.draft) === apply.chrome.afterDigest;
      // ★ With no row before Apply and no Publish by the redesign, anything
      //   live on this row was published by the merchant.
      const liveIsRevamps = liveChrome
        ? row.published != null &&
          chromeDigestOf(row.published) === liveChrome.afterDigest
        : apply.chrome.rowExisted || row.published == null;
      if (!apply.chrome.rowExisted) {
        // ★ No row before Apply: deleting it restores the store's own menus.
        if (draftIsRevamps && liveIsRevamps) {
          await tx.deleteChrome();
          restored.push(CHROME_LABEL);
        } else if (liveChrome && liveIsRevamps) {
          // ★★ The draft is the merchant's, but what is live is still what
          //    the redesign's Publish put there: take it off on its own, as
          //    the pages and a store with a row do. Nothing was live before
          //    (`before` is null), and a row with nothing published shows the
          //    store's own menus again.
          await tx.updateChrome({
            published: liveChrome.before,
            publishedAt: liveChrome.beforePublishedAt,
          });
          kept.push({ label: CHROME_LABEL, reason: CHANGED });
          restored.push(`${CHROME_LABEL} (live)`);
        } else {
          kept.push({ label: CHROME_LABEL, reason: CHANGED });
        }
      } else {
        const patch: ChromePatch = {};
        if (!draftIsRevamps)
          kept.push({ label: CHROME_LABEL, reason: CHANGED });
        else if (apply.chrome.before) patch.draft = apply.chrome.before;
        if (liveChrome) {
          if (liveIsRevamps) {
            patch.published = liveChrome.before;
            patch.publishedAt = liveChrome.beforePublishedAt;
          } else {
            kept.push({
              label: `${CHROME_LABEL} (live)`,
              reason:
                "They were published again after the redesign, so the live version was kept.",
            });
          }
        }
        if (Object.keys(patch).length > 0) {
          await tx.updateChrome(patch);
          // Only the live header came back when the draft was the merchant's.
          restored.push(
            patch.draft !== undefined ? CHROME_LABEL : `${CHROME_LABEL} (live)`,
          );
        }
      }
    }
  }

  // Tagline and footer description, each on its own.
  if (apply.brand) {
    const brand = await tx.lockBrand();
    if (brand) {
      const next = { ...brand };
      let changed = false;
      for (const [field, label] of BRAND_FIELDS) {
        if (!brandFieldChanged(apply.brand, field)) continue;
        const before = textOrNull(apply.brand.before[field]);
        const afterValue = textOrNull(apply.brand.after[field]);
        const current = textOrNull(next[field]);
        if (current === before) continue;
        if (current !== afterValue) {
          kept.push({ label, reason: CHANGED });
          continue;
        }
        const original = apply.brand.before[field];
        if (before === null) delete next[field];
        else next[field] = original;
        changed = true;
        restored.push(label);
      }
      if (changed) await tx.writeBrand(next);
    }
  }

  // ★ Products before categories: a new category the redesign made holds
  //   the new products, and is free to remove only once they are gone.
  for (const created of apply.products.created) {
    const product = await tx.lockProduct(created.id, created.afterUpdatedAt);
    if (!product) continue;
    if (!product.unchanged) {
      kept.push({ label: product.name, reason: CHANGED });
      continue;
    }
    // ★ An ordered product stays: order lines, invoices and refunds point at
    //   it. It comes off the shop instead.
    // ★★ So does one an offer or a review uses. No foreign key refuses that
    //    delete: offer_products and product_reviews CASCADE, so the delete
    //    would succeed and silently take them with it, and an offer left with
    //    no scope row discounts EVERY product in the store.
    if (
      !product.ordered &&
      !product.usedBy &&
      (await tx.deleteProduct(created.id))
    ) {
      restored.push(`Removed ${product.name}`);
      continue;
    }
    if (product.status !== "draft")
      await tx.setProductStatus(created.id, "draft");
    kept.push({
      label: product.name,
      reason: product.ordered
        ? "It already has orders, so it was taken off your shop instead of deleted."
        : product.usedBy === "offer"
          ? "An offer uses it, so it was taken off your shop instead of deleted."
          : product.usedBy === "review"
            ? "Customers have reviewed it, so it was taken off your shop instead of deleted."
            : "It could not be deleted, so it was taken off your shop instead.",
    });
  }
  for (const hidden of apply.products.hidden) {
    // ★ Only a sample that was on the shop before goes back on it.
    if (hidden.statusBefore !== "published") continue;
    const product = await tx.lockProduct(hidden.id, hidden.afterUpdatedAt);
    if (!product || product.status === hidden.statusBefore) continue;
    if (!product.unchanged) {
      kept.push({ label: product.name, reason: CHANGED });
      continue;
    }
    // Hiding cleared the date it was published; it comes back with it.
    await tx.setProductStatus(
      hidden.id,
      hidden.statusBefore,
      hidden.publishedAtBefore,
    );
    restored.push(`${product.name} is back on your shop`);
  }

  for (const category of apply.categories) {
    const current = await tx.lockCategory(category.id, category.afterUpdatedAt);
    if (!current) continue;
    const label = `${current.name} category`;
    if (!current.unchanged) {
      kept.push({ label, reason: CHANGED });
      continue;
    }
    if (category.action === "create") {
      // ★★ An offer scoped to it keeps it too: offer_products.category_id
      //    CASCADEs, and an offer whose last scope row goes covers every line.
      if (current.usedBy) {
        kept.push({
          label,
          reason:
            current.usedBy === "offer"
              ? "An offer uses it, so it was kept."
              : "Products are filed under it, so it was kept.",
        });
        continue;
      }
      await tx.deleteCategory(category.id);
      restored.push(`Removed the new ${label}`);
      continue;
    }
    if (!category.before) continue;
    if (category.action === "update") {
      await tx.updateCategory(category.id, {
        name: category.before.name,
        description: category.before.description,
        imageUrl: category.before.imageUrl,
        status: category.before.status,
      });
      restored.push(`${category.before.name} category`);
    } else {
      await tx.updateCategory(category.id, { status: category.before.status });
      restored.push(`${category.before.name} category is shown again`);
    }
  }

  return { answer: { restored, kept }, slugs };
}

function afterUndo(actor: MinkActorContext, slugs: string[]): void {
  try {
    revalidatePath("/dashboard/builder");
    revalidatePath("/dashboard/categories");
    revalidatePath("/dashboard/products");
    for (const slug of new Set(slugs)) revalidatePath(slug ? `/${slug}` : "/");
    for (const tag of [
      TAGS.pages,
      TAGS.chrome,
      TAGS.categories,
      TAGS.products,
      STORE_TAG,
    ]) {
      revalidateTag(tag, { expire: 0 });
    }
  } catch (error) {
    logError("mink.revamp: undo revalidation failed", error, {
      storeId: actor.storeId,
    });
  }
}

// ---------------------------------------------------------------------------
// Answers, labels and guards
// ---------------------------------------------------------------------------

function assertBuilderManage(actor: MinkActorContext): void {
  if (!can(actor.permissions, "builder", "manage", actor.isSuperadmin)) {
    throw new MinkRequestError(
      "mink_revamp_access_denied",
      "Your role cannot change the Website Builder.",
      403,
    );
  }
}

/**
 * ★★ Undo writes the same live rows Apply did, so it needs the permissions
 * Apply needed for them (apply-v2's assertRevampPartAuthority, in its order):
 * a role that lost Products, Categories or Branding manage since must not
 * delete products, put samples back on the shop, rename categories or put
 * the old tagline and footer description back on the live store through
 * this card. It REFUSES rather than undoing only the Builder half, because
 * an Undo cannot be repeated: the rest could never be undone once the role
 * is given back. Only what Undo would actually write counts (a sample that
 * was not on the shop before, or a tagline Apply left as it was, is never
 * touched).
 */
function assertUndoPartAuthority(
  actor: MinkActorContext,
  apply: RevampApplySnapshot,
): void {
  if (
    apply.categories.length > 0 &&
    !can(actor.permissions, "categories", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_revamp_access_denied",
      "Undoing this redesign changes categories, which needs Categories manage permission.",
      403,
    );
  }
  if (
    (apply.products.created.length > 0 ||
      apply.products.hidden.some(
        (hidden) => hidden.statusBefore === "published",
      )) &&
    !can(actor.permissions, "products", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_revamp_access_denied",
      "Undoing this redesign removes or brings back products, which needs Products manage permission.",
      403,
    );
  }
  // ★ Outside the Builder, only saveStoreBranding saves these two, behind
  //   Branding manage; Builder manage alone covers the colour and logo.
  const brand = apply.brand;
  if (
    brand &&
    BRAND_FIELDS.some(([field]) => brandFieldChanged(brand, field)) &&
    !can(actor.permissions, "branding", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_revamp_access_denied",
      "Undoing this redesign changes your store's tagline or footer description, which needs Branding manage permission.",
      403,
    );
  }
}

export const REVAMP_NEWER_VERSION_APPLIED_MESSAGE =
  "A newer version of this redesign is applied and builds on this one. Undo the newer version on its card first, then undo this one.";

/**
 * ★★ An earlier version is not undone while a newer one is applied (U-1). A
 * refinement asked for while this version was on the store carries none of
 * its products and categories (revampChainCarry: they were on the store), so
 * the newer version's pages and menus show the ones this version created.
 * Undoing this one first would delete them under those pages (dead links,
 * empty product bands), and the newer version's own Undo would then put back
 * pages pointing at nothing. So the merchant undoes the newest first, as the
 * card's sentence says; Undo of the newest applied version is unchanged.
 * ★★ THE NEWER VERSIONS ARE READ, NEVER LOCKED, the lock order Apply takes
 *    (apply-v2's lockRevampJob, then refuseStaleRefinement): a version's own
 *    job first, then its earlier versions nearest first. A newer version's
 *    Apply therefore locks this job too, so one being applied now waits for
 *    this Undo and is then refused as undone after it was asked for, while
 *    locking the newer versions here would take the two in the opposite order.
 */
function refuseWhileNewerApplied(versions: NewerRevampVersion[]): void {
  if (versions.some((version) => version.appliedAt && !version.undoneAt)) {
    throw new MinkRequestError(
      "mink_revamp_newer_version_applied",
      REVAMP_NEWER_VERSION_APPLIED_MESSAGE,
      409,
    );
  }
}

function notFound(): MinkRequestError {
  return new MinkRequestError(
    "mink_revamp_not_found",
    "That redesign is not available.",
    404,
  );
}

function notApplied(): MinkRequestError {
  return new MinkRequestError(
    "mink_revamp_not_applied",
    "Apply this redesign to your Website Builder draft first.",
    409,
  );
}

function undone(): MinkRequestError {
  return new MinkRequestError(
    "mink_revamp_undone",
    "This redesign was undone, so there is nothing to publish.",
    409,
  );
}

function unreadable(what: string): MinkRequestError {
  return new MinkRequestError(
    "mink_revamp_record_unreadable",
    `The record of what this redesign changed could not be read, so it can't be ${what}. Use the Website Builder instead.`,
    409,
  );
}

function pageLabel(slug: string, title: string | null): string {
  if (slug === "") return "Homepage";
  const name = title?.trim();
  return name ? `${name} page` : `The /${slug} page`;
}

function labelOfPage(
  stored: RevampStoredPlan | null,
  page: RevampApplySnapshotPage,
  rowTitle: string | null,
): string {
  const planned = stored?.pages.find((entry) =>
    entry.pageId ? entry.pageId === page.pageId : entry.slug === page.slug,
  );
  return pageLabel(page.slug, planned?.title ?? rowTitle);
}

/** The stored answer of a publish, or one rebuilt from its record. */
export function publishAnswerOf(value: unknown): RevampPublishResult {
  const answer = record(record(value)?.answer);
  if (answer && Array.isArray(answer.published)) {
    return {
      published: strings(answer.published),
      skipped: labelled(answer.skipped),
    };
  }
  const fallback = readPublishRecord(value);
  return {
    published: [
      ...(fallback?.pages.map((page) => page.label) ?? []),
      ...(fallback?.chrome ? [CHROME_LABEL] : []),
    ],
    skipped: [],
  };
}

/** The stored answer of an undo. */
export function undoAnswerOf(value: unknown): RevampUndoResult {
  const answer = record(record(value)?.undo);
  return {
    restored: strings(answer?.restored),
    kept: labelled(answer?.kept),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function labelled(value: unknown): Array<{ label: string; reason: string }> {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const entry = record(item);
        return entry &&
          typeof entry.label === "string" &&
          typeof entry.reason === "string"
          ? [{ label: entry.label, reason: entry.reason }]
          : [];
      })
    : [];
}

// ---------------------------------------------------------------------------
// Reading the snapshots. ★ STRICT: a malformed apply snapshot refuses the
// whole Undo, because restoring half of what a redesign changed, silently,
// leaves a store nobody can reason about.
// ---------------------------------------------------------------------------

class Unreadable extends Error {}

function need<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Unreadable();
  return value;
}

/** Text Postgres casts to timestamptz without error (the SQL compares it). */
const STAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

function stamp(value: unknown): string | null {
  return typeof value === "string" && STAMP.test(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nullableText(value: unknown): string | null {
  if (value !== null && typeof value !== "string") throw new Unreadable();
  return value;
}

function list(value: unknown): unknown[] {
  return need(Array.isArray(value) ? value : null);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function object<T>(value: unknown): T {
  return need(record(value)) as T;
}

export function readApplySnapshot(value: unknown): RevampApplySnapshot | null {
  try {
    const row = need(record(value));
    if (row.version !== REVAMP_LIFECYCLE_VERSION) return null;
    const pages = list(row.pages).map((item): RevampApplySnapshotPage => {
      const page = need(record(item));
      const before =
        page.before === null
          ? null
          : (() => {
              const draft = need(record(page.before));
              return {
                title: need(str(draft.title)),
                seoTitle: need(str(draft.seoTitle)),
                seoDescription: need(str(draft.seoDescription)),
                sections: list(draft.sections) as PageSectionItem[],
              };
            })();
      return {
        pageId: need(id(page.pageId)),
        slug: need(str(page.slug)),
        created: need(bool(page.created)),
        before,
        afterUpdatedAt: need(stamp(page.afterUpdatedAt)),
        afterDigest: need(id(page.afterDigest)),
        // ★ Absent stays absent: it marks an older Apply that wrote the
        //   title and search text itself (see undoInside).
        ...(page.proposed === undefined
          ? {}
          : {
              proposed: page.proposed === null ? null : pageMeta(page.proposed),
            }),
        // ★ Absent stays absent: Undo then falls back to the page clock.
        ...(page.live === undefined
          ? {}
          : { live: liveFingerprint(page.live) }),
      };
    });
    const chromeRow = row.chrome === null ? null : need(record(row.chrome));
    const chrome = chromeRow
      ? {
          rowExisted: need(bool(chromeRow.rowExisted)),
          before:
            chromeRow.before === null
              ? null
              : object<StoreChrome>(chromeRow.before),
          afterDigest: need(id(chromeRow.afterDigest)),
        }
      : null;
    const brandRow = row.brand === null ? null : need(record(row.brand));
    const brand = brandRow
      ? {
          before: brandPair(brandRow.before),
          after: brandPair(brandRow.after),
        }
      : null;
    const categoryList = list(row.categories).map(
      (item): RevampApplySnapshotCategory => {
        const category = need(record(item));
        const action = category.action;
        if (action !== "update" && action !== "create" && action !== "hide")
          throw new Unreadable();
        const beforeRow =
          category.before === null ? null : need(record(category.before));
        return {
          action,
          id: need(id(category.id)),
          slug: need(str(category.slug)),
          before: beforeRow
            ? {
                name: need(str(beforeRow.name)),
                description: nullableText(beforeRow.description ?? null),
                imageUrl: nullableText(beforeRow.imageUrl ?? null),
                status: need(id(beforeRow.status)),
              }
            : null,
          afterUpdatedAt: need(stamp(category.afterUpdatedAt)),
        };
      },
    );
    const productRow = need(record(row.products));
    return {
      version: REVAMP_LIFECYCLE_VERSION,
      appliedAt: need(str(row.appliedAt)),
      pages,
      chrome,
      brand,
      categories: categoryList,
      products: {
        hidden: list(productRow.hidden).map((item) => {
          const entry = need(record(item));
          return {
            id: need(id(entry.id)),
            statusBefore: need(id(entry.statusBefore)),
            afterUpdatedAt: need(stamp(entry.afterUpdatedAt)),
            ...(entry.publishedAtBefore === undefined
              ? {}
              : {
                  publishedAtBefore:
                    entry.publishedAtBefore === null
                      ? null
                      : need(stamp(entry.publishedAtBefore)),
                }),
          };
        }),
        created: list(productRow.created).map((item) => {
          const entry = need(record(item));
          return {
            id: need(id(entry.id)),
            slug: need(str(entry.slug)),
            afterUpdatedAt: need(stamp(entry.afterUpdatedAt)),
          };
        }),
      },
      ...(Array.isArray(row.notes) ? { notes: strings(row.notes) } : {}),
    };
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

function liveFingerprint(value: unknown): RevampPageLiveFingerprint {
  const live = need(record(value));
  return {
    status: need(id(live.status)),
    publishedDigest: need(id(live.publishedDigest)),
  };
}

function pageMeta(value: unknown): RevampPageMeta {
  const meta = need(record(value));
  return {
    title: need(str(meta.title)),
    seoTitle: need(str(meta.seoTitle)),
    seoDescription: need(str(meta.seoDescription)),
  };
}

function brandPair(value: unknown): {
  tagline: string | null;
  blurb: string | null;
} {
  const pair = need(record(value));
  return {
    tagline: nullableText(pair.tagline ?? null),
    blurb: nullableText(pair.blurb ?? null),
  };
}

export function readPublishRecord(value: unknown): RevampPublishRecord | null {
  try {
    const row = need(record(value));
    if (row.version !== REVAMP_LIFECYCLE_VERSION) return null;
    const pages = list(row.pages).map((item): RevampPublishRecordPage => {
      const page = need(record(item));
      const before = need(record(page.before));
      return {
        pageId: need(id(page.pageId)),
        label: str(page.label) ?? "A page",
        before: {
          status: need(id(before.status)),
          publishedSections: list(
            before.publishedSections,
          ) as PageSectionItem[],
          publishedAt: nullableText(before.publishedAt ?? null),
        },
        afterPublishedDigest: need(id(page.afterPublishedDigest)),
        afterUpdatedAt: stamp(page.afterUpdatedAt),
        afterDraftDigest: id(page.afterDraftDigest),
        // ★ A record without the flag cannot vouch for the draft: keep it.
        draftWasApplied: page.draftWasApplied === true,
        meta:
          page.meta === undefined || page.meta === null
            ? null
            : (() => {
                const pair = need(record(page.meta));
                return {
                  before: pageMeta(pair.before),
                  after: pageMeta(pair.after),
                };
              })(),
      };
    });
    const chromeRow = row.chrome === null ? null : need(record(row.chrome));
    return {
      version: REVAMP_LIFECYCLE_VERSION,
      publishedAt: need(str(row.publishedAt)),
      pages,
      chrome: chromeRow
        ? {
            before:
              chromeRow.before === null || chromeRow.before === undefined
                ? null
                : object<StoreChrome>(chromeRow.before),
            beforePublishedAt: nullableText(
              chromeRow.beforePublishedAt ?? null,
            ),
            afterDigest: need(id(chromeRow.afterDigest)),
          }
        : null,
      answer: {
        published: strings(record(row.answer)?.published),
        skipped: labelled(record(row.answer)?.skipped),
      },
    };
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

function sectionList(value: unknown): PageSectionItem[] {
  return Array.isArray(value) ? (value as PageSectionItem[]) : [];
}

/**
 * ★★ Is an existing page's Builder draft still what the redesign left? Its
 * sections against the digest the redesign left, and what is live against
 * what the redesign last knew was live: a merchant who published a version
 * of their own since owns the draft too. NOT the page clock, which every
 * title, search text, slug and status write moves without touching the
 * draft. With no record of what was live (an Apply that did not record it),
 * the clock is all there is.
 */
function draftStillRevamps(
  row: LockedPage,
  draftDigest: string,
  livePublishedDigest: string | null,
): boolean {
  if (sectionsDigestOf(row.sections) !== draftDigest) return false;
  return livePublishedDigest === null
    ? row.clockMatches
    : sectionsDigestOf(row.publishedSections) === livePublishedDigest;
}

function sectionsDigestOf(value: unknown): string {
  return revampSectionsDigest(sectionList(value));
}

function chromeDigestOf(value: unknown): string {
  return revampChromeDigest(sanitizeChromeForSave(value));
}

/** The brand digest's reading of a value: trimmed text, blank as null. */
function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * ★ Did Apply change this field? Undo's Branding check and its write ask the
 * same question, so Undo never asks for Branding manage over a field it will
 * not touch, nor writes one the check did not ask about.
 */
function brandFieldChanged(
  brand: NonNullable<RevampApplySnapshot["brand"]>,
  field: (typeof BRAND_FIELDS)[number][0],
): boolean {
  return textOrNull(brand.before[field]) !== textOrNull(brand.after[field]);
}

// ---------------------------------------------------------------------------
// The database side
// ---------------------------------------------------------------------------

/** Same instant to the millisecond: a snapshot may hold a JavaScript ISO
 *  string (milliseconds) of a microsecond timestamp. */
function sameInstant(column: unknown, value: string) {
  return sql<boolean>`date_trunc('milliseconds', ${column}) = date_trunc('milliseconds', ${value}::timestamptz)`;
}

function pgCode(error: unknown): string | null {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function databaseTx(
  db: Db,
  actor: MinkActorContext,
  revampId: string,
): LifecycleTx {
  const storeId = actor.storeId;
  const pageWhere = (pageId: string) =>
    and(eq(storePages.storeId, storeId), eq(storePages.id, pageId));

  return {
    async lockRevamp() {
      const [row] = await db
        .select({
          appliedAt: minkRevamps.appliedAt,
          publishedAt: minkRevamps.publishedAt,
          undoneAt: minkRevamps.undoneAt,
          applySnapshot: minkRevamps.applySnapshot,
          publishSnapshot: minkRevamps.publishSnapshot,
        })
        .from(minkRevamps)
        .where(
          and(
            eq(minkRevamps.id, revampId),
            eq(minkRevamps.storeId, storeId),
            eq(minkRevamps.adminId, actor.adminId),
          ),
        )
        .for("update");
      return row ?? null;
    },

    async newerVersions() {
      // ★ Every generation under this version, not only its children: a
      //   grandchild applied after a child nobody applied builds on this one
      //   just the same. Store-scoped on every row, never admin-scoped (a
      //   newer version changes the same store whoever asked for it), bounded
      //   like apply-v2's walk of the other direction (REVAMP_LIMITS), and the
      //   version itself is left out so a chain broken into a loop cannot
      //   refuse its own Undo.
      const result = await db.execute(sql`
        with recursive newer as (
          select r.id, r.applied_at, r.undone_at, 1 as depth
            from public.mink_revamps r
           where r.store_id = ${storeId}::uuid
             and r.parent_id = ${revampId}::uuid
             and r.id <> ${revampId}::uuid
          union all
          select r.id, r.applied_at, r.undone_at, newer.depth + 1
            from public.mink_revamps r
            join newer on r.parent_id = newer.id
           where r.store_id = ${storeId}::uuid
             and r.id <> ${revampId}::uuid
             and newer.depth <= ${REVAMP_LIMITS.maxRefinements}
        )
        select distinct id, applied_at, undone_at from newer`);
      return (
        result.rows as Array<{ applied_at: unknown; undone_at: unknown }>
      ).map((row) => ({
        appliedAt: row.applied_at == null ? null : String(row.applied_at),
        undoneAt: row.undone_at == null ? null : String(row.undone_at),
      }));
    },

    async storeFacts() {
      const [row] = await db
        .select({
          plan: stores.plan,
          planExpiresAt: stores.planExpiresAt,
          compPlan: stores.compPlan,
          compExpiresAt: stores.compExpiresAt,
          settings: stores.settings,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      if (!row) return null;
      const plan = effectivePlan({
        plan: row.plan,
        plan_expires_at: row.planExpiresAt,
        comp_plan: row.compPlan,
        comp_expires_at: row.compExpiresAt,
      });
      const settings = record(row.settings) ?? {};
      let themeDesign: ThemeDesignForContrast = null;
      try {
        themeDesign =
          (
            await resolveInstalledThemeDefinitionWithDb(
              db,
              readThemeSelection(settings),
            )
          )?.preset.design ?? null;
      } catch (error) {
        logWarn("mink.revamp: theme could not be read for the contrast check", {
          storeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        customCode: Boolean(
          resolveStoreSettings(settings, plan)["pages.customCode"],
        ),
        themeDesign,
      };
    },

    async lockPage(pageId, expectedUpdatedAt) {
      const [row] = await db
        .select({
          id: storePages.id,
          slug: storePages.slug,
          title: storePages.title,
          seoTitle: storePages.seoTitle,
          seoDescription: storePages.seoDescription,
          sections: storePages.sections,
          publishedSections: storePages.publishedSections,
          status: storePages.status,
          publishedAt: storePages.publishedAt,
          clockMatches: expectedUpdatedAt
            ? sameInstant(storePages.updatedAt, expectedUpdatedAt)
            : sql<boolean>`false`,
        })
        .from(storePages)
        .where(pageWhere(pageId))
        .for("update");
      return row ? { ...row, clockMatches: row.clockMatches === true } : null;
    },

    async publishPage(pageId, sections, now, meta) {
      const [saved] = await db
        .update(storePages)
        .set({
          ...meta,
          publishedSections: sections,
          sections,
          status: "published",
          publishedAt: now,
          updatedBy: actor.adminId,
        })
        .where(pageWhere(pageId))
        .returning({ updatedAt: storePages.updatedAt });
      return saved?.updatedAt ?? null;
    },

    async lockChrome() {
      const [row] = await db
        .select({
          draft: storeChrome.draft,
          published: storeChrome.published,
          publishedAt: storeChrome.publishedAt,
        })
        .from(storeChrome)
        .where(eq(storeChrome.storeId, storeId))
        .for("update");
      return row ?? null;
    },

    async publishChrome(published, now) {
      await db
        .update(storeChrome)
        .set({ published, publishedAt: now })
        .where(eq(storeChrome.storeId, storeId));
    },

    async markPublished(publishRecord, now) {
      await db
        .update(minkRevamps)
        .set({
          publishSnapshot: publishRecord,
          publishedAt: now,
          updatedAt: now,
        })
        .where(
          and(eq(minkRevamps.id, revampId), eq(minkRevamps.storeId, storeId)),
        );
    },

    async updatePage(pageId, patch) {
      await db
        .update(storePages)
        .set({ ...patch, updatedBy: actor.adminId })
        .where(pageWhere(pageId));
    },

    async deletePage(pageId) {
      await db.delete(storePages).where(pageWhere(pageId));
    },

    async updateChrome(patch) {
      await db
        .update(storeChrome)
        .set(patch)
        .where(eq(storeChrome.storeId, storeId));
    },

    async deleteChrome() {
      await db.delete(storeChrome).where(eq(storeChrome.storeId, storeId));
    },

    async lockBrand() {
      const result = await db.execute(sql`
        select settings from public.stores where id = ${storeId} for update`);
      const row = result.rows[0] as { settings?: unknown } | undefined;
      if (!row) return null;
      return { ...(record(record(row.settings)?.brand) ?? {}) };
    },

    async writeBrand(brand) {
      await db.execute(sql`
        update public.stores
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{brand}', ${JSON.stringify(brand)}::jsonb, true)
         where id = ${storeId}`);
    },

    async lockProduct(productId, afterUpdatedAt) {
      // ★★ "Unchanged" reads `updated_at`, which every write to the row moves
      //    (tracking, weight, cost, barcode and sizes saved in the editor
      //    included), NOT `content_updated_at`, which moves only for what a
      //    shopper sees: a product the merchant set up after Apply looked
      //    untouched and was deleted with its stock. A size's stock lives on
      //    the size and never moves the product row, so the stock ledger is
      //    read too (Apply writes none). A system write (a stock recompute)
      //    can only make Undo keep the product, which is the safe side.
      // ★ "Used" is every row that CASCADEs from the product and is not the
      //   product's own (sizes, stock levels and its ledger are its own): an
      //   offer scoped to it or to one of its sizes, an offer giving it away
      //   (a jsonb id, so no foreign key at all), and a shopper's review.
      const result = await db.execute(sql`
        select p.name, p.status,
               date_trunc('milliseconds', p.updated_at)
                 <= date_trunc('milliseconds', ${afterUpdatedAt}::timestamptz)
               and not exists (
                 select 1 from public.stock_movements sm
                  where sm.product_id = p.id
                    and date_trunc('milliseconds', sm.created_at)
                      > date_trunc('milliseconds', ${afterUpdatedAt}::timestamptz)
               ) as unchanged,
               exists (select 1 from public.order_items oi where oi.product_id = p.id) as ordered,
               case
                 when exists (
                   select 1 from public.offer_products op
                    where op.store_id = p.store_id
                      and (op.product_id = p.id
                           or op.variant_id in (
                             select v.id from public.product_variants v
                              where v.product_id = p.id))
                 ) or exists (
                   select 1 from public.offers o
                    where o.store_id = p.store_id
                      and o.reward_config ->> 'giftProductId' = p.id::text
                 ) then 'offer'
                 when exists (
                   select 1 from public.product_reviews r where r.product_id = p.id
                 ) then 'review'
               end as used_by
          from public.products p
         where p.store_id = ${storeId} and p.id = ${productId}
         for update of p`);
      const row = result.rows[0] as
        | {
            name: string;
            status: string;
            unchanged: boolean;
            ordered: boolean;
            used_by: string | null;
          }
        | undefined;
      return row
        ? {
            name: row.name,
            status: row.status,
            unchanged: row.unchanged === true,
            ordered: row.ordered === true,
            usedBy:
              row.used_by === "offer" || row.used_by === "review"
                ? row.used_by
                : null,
          }
        : null;
    },

    async deleteProduct(productId) {
      // ★ An explicit savepoint, not db.transaction(): a refused delete must
      //   not abort the rest of the Undo, and a nested transaction() on the
      //   outer handle is not a savepoint everywhere this runs.
      await db.execute(sql`savepoint revamp_undo_product`);
      try {
        await db
          .delete(products)
          .where(
            and(eq(products.storeId, storeId), eq(products.id, productId)),
          );
        await db.execute(sql`release savepoint revamp_undo_product`);
        return true;
      } catch (error) {
        await db.execute(sql`rollback to savepoint revamp_undo_product`);
        await db.execute(sql`release savepoint revamp_undo_product`);
        if (pgCode(error) !== "23503") throw error;
        return false;
      }
    },

    async setProductStatus(productId, status, publishedAt) {
      await db
        .update(products)
        .set(publishedAt === undefined ? { status } : { status, publishedAt })
        .where(and(eq(products.storeId, storeId), eq(products.id, productId)));
    },

    async lockCategory(categoryId, afterUpdatedAt) {
      const result = await db.execute(sql`
        select c.name,
               date_trunc('milliseconds', c.updated_at)
                 = date_trunc('milliseconds', ${afterUpdatedAt}::timestamptz) as unchanged,
               case
                 when exists (
                   select 1 from public.products p where p.category_id = c.id
                 ) then 'products'
                 when exists (
                   select 1 from public.offer_products op
                    where op.store_id = c.store_id and op.category_id = c.id
                 ) then 'offer'
               end as used_by
          from public.categories c
         where c.store_id = ${storeId} and c.id = ${categoryId}
         for update of c`);
      const row = result.rows[0] as
        | { name: string; unchanged: boolean; used_by: string | null }
        | undefined;
      return row
        ? {
            name: row.name,
            unchanged: row.unchanged === true,
            usedBy:
              row.used_by === "products" || row.used_by === "offer"
                ? row.used_by
                : null,
          }
        : null;
    },

    async deleteCategory(categoryId) {
      await db
        .delete(categories)
        .where(
          and(eq(categories.storeId, storeId), eq(categories.id, categoryId)),
        );
    },

    async updateCategory(categoryId, patch) {
      await db
        .update(categories)
        .set(patch)
        .where(
          and(eq(categories.storeId, storeId), eq(categories.id, categoryId)),
        );
    },

    async markUndone(applySnapshot, now) {
      await db
        .update(minkRevamps)
        .set({ applySnapshot, undoneAt: now, updatedAt: now })
        .where(
          and(eq(minkRevamps.id, revampId), eq(minkRevamps.storeId, storeId)),
        );
    },
  };
}
