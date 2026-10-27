// ---------------------------------------------------------------------------
// What Apply and Publish record so Undo can put the store back
// (docs/mink-storefront-revamp.md, section 10). Pure and client-safe types
// shared by apply-v2.ts (writes `mink_revamps.apply_snapshot`), publish.ts
// (writes `publish_snapshot`, reads both for Undo) and their tests.
//
// ★ EVERY "AFTER" FINGERPRINT IS WHAT MAKES UNDO SAFE. Undo restores a
//   target only while it is still exactly what the revamp wrote; anything the
//   merchant changed since is kept and named ("kept" in Undo's answer). So
//   each entry carries the revamp's own result (a digest or `updated_at`) to
//   compare with, as well as the state to restore.
// ★ THESE TYPES ARE WHAT THE COLUMNS REALLY HOLD. Publish's extra page fields
//   and its stored answer, and Undo's answer (kept inside `apply_snapshot`,
//   since there is no undo column), are described here rather than only in
//   the module that writes them, so a reader of the row is never surprised.
// ---------------------------------------------------------------------------

import type { PageSectionItem } from "@/lib/sections/registry";
import type { StoreChrome } from "@/lib/chrome/types";

export const REVAMP_LIFECYCLE_VERSION = 1 as const;

/**
 * A page's title and search text. ★ They have no draft layer (the Builder's
 * page settings save them straight to the row), so for a page that already
 * exists they wait for Publish rather than going live at Apply.
 */
export interface RevampPageMeta {
  title: string;
  seoTitle: string;
  seoDescription: string;
}

export interface RevampApplySnapshotPage {
  pageId: string;
  slug: string;
  /** True for a page the revamp created (Undo deletes it while unchanged). */
  created: boolean;
  /** The Builder draft before Apply; null for a created page. */
  before: {
    title: string;
    seoTitle: string;
    seoDescription: string;
    sections: PageSectionItem[];
  } | null;
  /** The page's `updated_at` and draft digest right after Apply. */
  afterUpdatedAt: string;
  afterDigest: string;
  /**
   * The redesign's title and search text for an existing page, which Apply
   * left alone and Publish writes. Null for a created page (a draft page that
   * already has its own); absent on a snapshot written while Apply still
   * wrote them, which Undo then restores with the draft as it always did.
   */
  proposed?: RevampPageMeta | null;
  /**
   * The live page as Apply found it (Apply never publishes): its status and
   * the digest of `published_sections`. ★ For an existing page, Undo and
   * Publish decide whether the draft is still Apply's by its sections plus
   * this, not by `updated_at`, which every title, search text, slug or
   * status write also moves. Absent on a snapshot that did not record it
   * (they then fall back to the page clock, which a created page always
   * uses: its title and address have no "before" to come back to).
   */
  live?: RevampPageLiveFingerprint;
}

/** What a page shows shoppers, as Undo compares it. */
export interface RevampPageLiveFingerprint {
  status: string;
  publishedDigest: string;
}

export interface RevampApplySnapshotCategory {
  action: "update" | "create" | "hide";
  id: string;
  slug: string;
  /** The category before Apply; null for a created one. */
  before: {
    name: string;
    description: string | null;
    imageUrl: string | null;
    status: string;
  } | null;
  /** `updated_at` right after Apply. */
  afterUpdatedAt: string;
}

export interface RevampApplySnapshot {
  version: typeof REVAMP_LIFECYCLE_VERSION;
  appliedAt: string;
  pages: RevampApplySnapshotPage[];
  chrome: {
    /** False when the store had no chrome row (Undo deletes the row). */
    rowExisted: boolean;
    /** The chrome draft before Apply; null when there was no row. */
    before: StoreChrome | null;
    /** Whole-draft digest right after Apply (digests.ts revampChromeDigest). */
    afterDigest: string;
  } | null;
  brand: {
    before: { tagline: string | null; blurb: string | null };
    after: { tagline: string | null; blurb: string | null };
  } | null;
  categories: RevampApplySnapshotCategory[];
  products: {
    /** Theme sample products Apply took off the shop. */
    hidden: Array<{
      id: string;
      statusBefore: string;
      afterUpdatedAt: string;
      /** When it was published before Apply; absent on an older snapshot. */
      publishedAtBefore?: string | null;
    }>;
    /** The merchant's products Apply created. */
    created: Array<{ id: string; slug: string; afterUpdatedAt: string }>;
  };
  /**
   * What Apply did differently from the plan, in the merchant's words (a
   * product filed without the category it named, because no such category
   * exists). Absent when there was nothing to say.
   */
  notes?: string[];
  /** Undo's answer, stored with the snapshot it undid (no undo column). */
  undo?: RevampUndoResult;
}

export interface RevampPublishSnapshotPage {
  pageId: string;
  /** The page's name in the merchant's words, for the answers. */
  label: string;
  /** The live page before Publish. */
  before: {
    status: string;
    publishedSections: PageSectionItem[];
    publishedAt: string | null;
  };
  /** Digest of `published_sections` right after Publish. */
  afterPublishedDigest: string;
  /**
   * ★ Publish moves `updated_at` (the row trigger) and may normalise the draft
   * (publish-mode validation), so Undo checks the draft against these instead
   * of Apply's values.
   */
  afterUpdatedAt: string | null;
  afterDraftDigest: string | null;
  /**
   * False when the merchant had already edited the draft before Publish: Undo
   * then keeps the draft, since what went live was theirs too.
   */
  draftWasApplied: boolean;
  /**
   * The page's title and search text just before Publish and just after it,
   * for an existing page whose apply recorded `proposed`. A field the
   * merchant changed after Apply keeps their value in `after`. Undo puts back
   * `before` for each field still equal to `after`.
   */
  meta?: { before: RevampPageMeta; after: RevampPageMeta } | null;
}

export interface RevampPublishSnapshot {
  version: typeof REVAMP_LIFECYCLE_VERSION;
  publishedAt: string;
  pages: RevampPublishSnapshotPage[];
  chrome: {
    /** The live chrome before Publish; null when nothing was published. */
    before: StoreChrome | null;
    beforePublishedAt: string | null;
    /** Digest of the published chrome right after Publish. */
    afterDigest: string;
  } | null;
  /** Publish's answer, returned unchanged to a repeated Publish. */
  answer: RevampPublishResult;
}

/** What Undo did, in the merchant's words, for the card and the chat. */
export interface RevampUndoResult {
  restored: string[];
  kept: Array<{ label: string; reason: string }>;
}

/** What Publish did, in the merchant's words. */
export interface RevampPublishResult {
  published: string[];
  skipped: Array<{ label: string; reason: string }>;
}
