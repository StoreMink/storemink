import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { after } from "next/server";
import { can } from "@/app/dashboard/lib/permissions";
import {
  categories,
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkDrafts,
  products,
  storeChrome,
  storePages,
  stores,
} from "@/drizzle/schema";
import { EMPTY_DESIGN_OVERRIDES } from "@/lib/chrome/design";
import { sanitizeChromeForSave, type StoreChrome } from "@/lib/chrome/types";
import { withService, type Db } from "@/lib/db/client";
import { emitEvent } from "@/lib/notifications/record";
import { logWarn } from "@/lib/observability/logger";
import { notifyStoreContentPublished } from "@/lib/seo/store-indexing";
import {
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { hashMinkActionPayload } from "./action-integrity";
import { normalizeMinkDraftContent } from "./draft-types";
import { MinkRequestError } from "./errors";
import { digestMinkStorefrontValue } from "./storefront-code-contract";
import { digestMinkStorefrontDesign } from "./storefront-design-contract";
import {
  assertLayoutPreservesCustomCode,
  digestMinkStorefrontSections,
} from "./storefront-layout-contract";
import {
  assertLayoutMediaIsOwned,
  collectSectionMediaUrls,
} from "./storefront-media-policy";
import { selectOwnedStorefrontImageUrls } from "./storefront-media-read";
import {
  MINK_PERSONALIZATION_SCHEMA_VERSION,
  type PersonalizationStoredPlan,
} from "./storefront-personalization-contract";
import {
  chromeTextDigest,
  readMenusAsChrome,
} from "./storefront-personalization-context";
import type {
  MinkStorefrontPersonalizationActionApproval,
  MinkStorefrontPersonalizationActionResult,
  MinkStorefrontPersonalizationActionValues,
} from "./storefront-personalization-action-types";
import type { MinkActorContext } from "./types";
import { isRevampPlan, type RevampStoredPlan } from "./revamp/contract";
import {
  assertRevampPartAuthority,
  lockRevampJob,
  lockRevampTargets,
  readRevampStoredPlan,
  recordRevampApplied,
  rerunRevampGuards,
  revampAuditDetail,
  revampCapIssue,
  revampConflictDetail,
  revampCurrentValues,
  revampExpectedValues,
  revampProductCapConflict,
  revampProposedValues,
  revampTargetConflict,
  writeRevamp,
  type RevampJobLock,
} from "./revamp/apply-v2";

// ---------------------------------------------------------------------------
// Applying one approved personalisation.
//
// It mirrors 9B and 9C step for step: a fresh five-minute approval bound to
// the exact plan and the exact current state, then ONE transaction that
// re-checks everything and writes everything, with one audit row.
//
// ★★ EVERY TARGET IS LOCKED AND RE-CHECKED BEFORE THE FIRST WRITE. A plan
//    touches several pages, the header and footer row, the store's own
//    settings, categories and products. Checking one, writing it, then
//    finding the next one moved would leave half a storefront changed, so
//    the transaction locks every row first (FOR UPDATE), compares each to
//    the approved digests, and only then writes. A conflict anywhere writes
//    nothing and records the outcome.
//
// ★★ WHAT IS A DRAFT AND WHAT IS LIVE. Pages and the header, footer and look
//    land in the private Website Builder draft; publishing stays a separate
//    step, as in 9B. Categories, the theme's sample products and the store's
//    tagline and footer description have no draft layer, so they change on
//    the live store at once. The card lists those before the button.
//
// ★ CUSTOM CODE AND IMAGE OWNERSHIP ARE RE-CHECKED UNDER THE SAME LOCKS,
//   exactly as 9B's write path does: the digest proves a page has not moved,
//   so the only thing that can have changed is the Media Library.
//
// ★★ A REVAMP IS PLAN VERSION 2 ON THE SAME APPROVAL. The storefront
//    revamp's card is a personalisation draft whose plan carries
//    `schemaVersion: 2` (revamp/contract.ts). The approval, audit,
//    idempotency, expiry and draft lock below are shared; which rows are
//    locked, what they are compared with, the guards and the writes come
//    from revamp/apply-v2.ts. A version 1 plan takes exactly the path it
//    always took.
// ---------------------------------------------------------------------------

const APPROVAL_TTL_MS = 5 * 60 * 1_000;
const TOOL_NAME = "apply_storefront_personalization" as const;
const TOOL_VERSION = 1;
const NONE = "none";

type ApprovalRow = typeof minkActionApprovals.$inferSelect;

interface DraftBase {
  id: string;
  currentVersion: number;
  planDigest: string;
}

interface V1Draft extends DraftBase {
  plan: PersonalizationStoredPlan;
}

interface V2Draft extends DraftBase {
  plan: RevampStoredPlan;
}

type PersonalizationDraft = V1Draft | V2Draft;

function isRevampDraft(draft: PersonalizationDraft): draft is V2Draft {
  return isRevampPlan(draft.plan);
}

/** Read the latest completed apply, for a restored conversation card. */
export async function getLatestMinkStorefrontPersonalizationAction(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkStorefrontPersonalizationActionResult | null> {
  return withService(async (db) => {
    assertAuthority(actor);
    const rows = await db
      .select()
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.draftId, draftId),
          eq(minkActionApprovals.toolName, TOOL_NAME),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .orderBy(desc(minkActionApprovals.executedAt))
      .limit(1);
    if (!rows[0]) return null;
    const approval = validateApproval(rows[0]);
    const audit = await readAudit(db, actor.storeId, approval.id);
    if (!audit) throw invalidApproval();
    const draft = await readDraft(db, actor, approval.draftId);
    return {
      approval: toApproval(approval, draft.plan),
      auditId: audit.id,
      repeated: true,
    };
  });
}

/** Create a fresh, idempotent approval against the exact current store. */
export async function previewMinkStorefrontPersonalizationAction(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
}): Promise<MinkStorefrontPersonalizationActionApproval> {
  return withService(async (db) => {
    assertAuthority(input.actor);
    await lockDraft(db, input.actor, input.draftId);
    const draft = await readDraft(db, input.actor, input.draftId);
    if (draft.currentVersion !== input.expectedDraftVersion) {
      throw draftConflict();
    }
    await assertToolEnabled(db, input.actor.storeId);
    if (isRevampDraft(draft)) {
      assertRevampPartAuthority(input.actor, draft.plan);
      // ★ The same locks the write will take, as for version 1: the job
      //   first (a redesign already applied or undone is refused here), then
      //   every target.
      await lockRevampJob(db, input.actor, {
        revampId: draft.plan.revampId,
        draftId: draft.id,
      });
      const targets = await lockRevampTargets(db, input.actor, draft.plan);
      const capIssue = revampCapIssue(draft.plan, targets);
      return createApproval(db, {
        actor: input.actor,
        draft,
        before: revampCurrentValues(draft.planDigest, draft.plan, targets),
        after: revampProposedValues(draft.planDigest, draft.plan),
        expected: revampExpectedValues(draft.planDigest, draft.plan),
        mismatch: revampTargetConflict,
        blocked: capIssue ? revampProductCapConflict(capIssue) : null,
        idempotencyKey: input.idempotencyKey,
      });
    }
    assertPartAuthority(input.actor, draft.plan);
    // ★ The preview takes the same locks the write will: the transaction is
    //   short and writes nothing, and one read path cannot drift from the other.
    const targets = await lockTargets(db, input.actor, draft.plan);
    const before = currentValues(draft, targets);
    const after = proposedValues(draft);
    return createApproval(db, {
      actor: input.actor,
      draft,
      before,
      after,
      expected: expectedValues(draft),
      mismatch: targetConflict,
      blocked: null,
      idempotencyKey: input.idempotencyKey,
    });
  });
}

/**
 * Apply the approved plan. Every recheck 9B performs is performed here, for
 * every target in the plan, under locks taken before the first write. A
 * replay of an executed approval returns the original result; anything that
 * moved underneath finalizes without a write.
 */
export async function executeMinkStorefrontPersonalizationAction(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkStorefrontPersonalizationActionResult> {
  const outcome = await withService(async (db) => {
    assertAuthority(input.actor);
    await lockApproval(db, input.actor, input.approvalId);
    const approval = await readApproval(db, input.actor, input.approvalId);
    if (approval.draftId !== input.draftId) throw approvalNotFound();

    if (approval.status === "executed") {
      const audit = await readAudit(db, input.actor.storeId, approval.id);
      if (!audit) throw invalidApproval();
      const executedDraft = await readDraft(db, input.actor, approval.draftId);
      return {
        result: {
          approval: toApproval(approval, executedDraft.plan),
          auditId: audit.id,
          repeated: true,
        },
        // A replay created nothing, so it announces nothing.
        created: [] as Array<{ id: string; name: string; slug: string }>,
      };
    }
    if (approval.status !== "pending") {
      throw conflict(
        "mink_personalization_approval_terminal",
        "This approval is no longer available.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId, true);
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      await finalizeWithoutWrite(
        db,
        approval,
        "expired",
        "Approval expired before the storefront was personalised.",
      );
      return {
        error: conflict(
          "mink_personalization_approval_expired",
          "This approval expired. Apply the card again.",
        ),
      };
    }

    await lockDraft(db, input.actor, approval.draftId);
    let draft: PersonalizationDraft;
    try {
      draft = await readDraft(db, input.actor, approval.draftId);
    } catch (error) {
      if (!(error instanceof MinkRequestError)) throw error;
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The saved personalisation failed integrity validation.",
      );
      return { error: draftConflict() };
    }
    if (isRevampDraft(draft)) {
      assertRevampPartAuthority(input.actor, draft.plan);
    } else {
      assertPartAuthority(input.actor, draft.plan);
    }

    const approvedBefore = valuesFromJson(approval.beforeJson);
    const approvedAfter = valuesFromJson(approval.afterJson);
    if (
      approval.requestHash !==
      requestHash(approval, approvedBefore, approvedAfter)
    ) {
      throw invalidApproval();
    }
    if (
      draft.currentVersion !== approval.draftVersion ||
      hashMinkActionPayload(proposedFor(draft)) !==
        hashMinkActionPayload(approvedAfter)
    ) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The saved personalisation changed after approval preview.",
      );
      return { error: draftConflict() };
    }

    let writtenAt: string;
    let created: Array<{ id: string; name: string; slug: string }> = [];
    if (isRevampDraft(draft)) {
      writtenAt = new Date().toISOString();
      const applied = await executeRevamp(
        db,
        input.actor,
        approval,
        draft,
        approvedBefore,
        writtenAt,
      );
      if ("error" in applied) return { error: applied.error };
      created = applied.created;
    } else {
      // ★★ LOCK EVERYTHING, THEN COMPARE, THEN WRITE.
      const locked = await lockTargets(db, input.actor, draft.plan);
      const now = currentValues(draft, locked);
      if (
        hashMinkActionPayload(now) !== hashMinkActionPayload(approvedBefore)
      ) {
        await finalizeWithoutWrite(
          db,
          approval,
          "conflicted",
          "Part of the storefront changed after the approval preview.",
        );
        return { error: targetConflict() };
      }
      const guardIssue = await rerunGuards(db, input.actor, draft.plan, locked);
      if (guardIssue) {
        await finalizeWithoutWrite(db, approval, "conflicted", guardIssue);
        return { error: targetConflict() };
      }

      writtenAt = new Date().toISOString();
      await writePages(db, input.actor, draft.plan);
      await writeChrome(db, input.actor, draft.plan, locked.chrome, writtenAt);
      await writeBrand(db, input.actor, draft.plan, locked.storeSettings);
      await writeCategories(db, input.actor, draft.plan, writtenAt);
      await writeProducts(db, input.actor, draft.plan);
    }

    const finalized = await db
      .update(minkActionApprovals)
      .set({
        status: "executed",
        approvedAt: writtenAt,
        executedAt: writtenAt,
        resultId: input.actor.storeId,
        resultVersion: writtenAt,
        updatedAt: writtenAt,
      })
      .where(
        and(
          eq(minkActionApprovals.id, approval.id),
          eq(minkActionApprovals.storeId, input.actor.storeId),
          eq(minkActionApprovals.status, "pending"),
        ),
      )
      .returning({ id: minkActionApprovals.id });
    if (!finalized[0]) throw invalidApproval();

    const auditId = crypto.randomUUID();
    await db.insert(minkActionAudit).values({
      id: auditId,
      approvalId: approval.id,
      storeId: approval.storeId,
      adminId: approval.adminId,
      draftId: approval.draftId,
      productId: null,
      resourceType: "storefront",
      resourceId: approval.resourceId,
      locationId: null,
      variantId: null,
      resourceVersionBefore: approval.resourceVersion,
      resourceVersionAfter: writtenAt,
      resultId: input.actor.storeId,
      toolName: TOOL_NAME,
      operation: "apply",
      outcome: "executed",
      beforeJson: approvedBefore,
      afterJson: approvedAfter,
      productVersionBefore: null,
      productVersionAfter: null,
      requestHash: approval.requestHash,
      toolVersion: TOOL_VERSION,
      detail: isRevampDraft(draft)
        ? revampAuditDetail(draft.plan)
        : auditDetail(draft.plan),
    });

    return {
      result: {
        approval: toApproval(
          {
            ...approval,
            status: "executed",
            approvedAt: writtenAt,
            executedAt: writtenAt,
            resultId: input.actor.storeId,
            resultVersion: writtenAt,
          },
          draft.plan,
        ),
        auditId,
        repeated: false,
      },
      created,
    };
  });
  if ("error" in outcome) throw outcome.error;
  // ★ A revamp's new products are announced only once they committed: an
  //   event raised inside the transaction would survive its rollback.
  for (const product of outcome.created) {
    emitEvent({
      type: "product.created",
      storeId: input.actor.storeId,
      actor: {
        type: "admin",
        id: input.actor.adminId,
        label: input.actor.email,
      },
      subject: { type: "product", id: product.id, label: product.name },
      payload: { status: "published" },
    });
  }
  // ★ And offered to search engines, as the product editor offers a product it
  //   publishes: the same hook, after the response, never a failure the
  //   merchant sees (it submits nothing for a store that has not opened).
  if (outcome.created.length) {
    const storeId = input.actor.storeId;
    const paths = [
      ...outcome.created.map((product) => `/shop/${product.slug}`),
      "/shop",
      "/",
    ];
    try {
      after(() => notifyStoreContentPublished({ storeId, paths }));
    } catch (error) {
      logWarn("mink.personalization_action: search engine notice skipped", {
        storeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome.result;
}

/** A version 1 or version 2 plan's proposed values. */
function proposedFor(
  draft: PersonalizationDraft,
): MinkStorefrontPersonalizationActionValues {
  return isRevampDraft(draft)
    ? revampProposedValues(draft.planDigest, draft.plan)
    : proposedValues(draft);
}

/**
 * A revamp's half of execute: lock every target, compare it with what was
 * approved, run the guards, and only then write and record the snapshot on
 * the revamp's job, all inside the caller's transaction. A conflict writes
 * nothing and finalises the approval without a write.
 */
async function executeRevamp(
  db: Db,
  actor: MinkActorContext,
  approval: ApprovalRow,
  draft: V2Draft,
  approvedBefore: MinkStorefrontPersonalizationActionValues,
  writtenAt: string,
): Promise<
  | { error: MinkRequestError }
  | { created: Array<{ id: string; name: string; slug: string }> }
> {
  const plan = draft.plan;
  // ★ The job before any store row (Publish and Undo take that order). A
  //   redesign applied or undone since this approval was made is refused,
  //   and the approval is finalised so it cannot be tried again.
  let job: RevampJobLock;
  try {
    job = await lockRevampJob(db, actor, {
      revampId: plan.revampId,
      draftId: draft.id,
    });
  } catch (error) {
    if (!(error instanceof MinkRequestError)) throw error;
    await finalizeWithoutWrite(db, approval, "conflicted", error.message);
    return { error };
  }
  const locked = await lockRevampTargets(db, actor, plan);
  const now = revampCurrentValues(draft.planDigest, plan, locked);
  if (hashMinkActionPayload(now) !== hashMinkActionPayload(approvedBefore)) {
    await finalizeWithoutWrite(
      db,
      approval,
      "conflicted",
      revampConflictDetail(approvedBefore, now),
    );
    return { error: revampTargetConflict() };
  }
  const capIssue = revampCapIssue(plan, locked);
  if (capIssue) {
    await finalizeWithoutWrite(
      db,
      approval,
      "conflicted",
      "The redesign's new products would pass the plan's product limit.",
    );
    return { error: revampProductCapConflict(capIssue) };
  }
  const guardIssue = await rerunRevampGuards(db, actor, plan, locked);
  if (guardIssue) {
    await finalizeWithoutWrite(db, approval, "conflicted", guardIssue);
    return { error: revampTargetConflict() };
  }
  const snapshot = await writeRevamp(db, actor, plan, locked, writtenAt);
  await recordRevampApplied(db, actor, {
    revampId: plan.revampId,
    draftId: draft.id,
    snapshot,
    job,
  });
  const names = new Map(
    plan.products.create.map((product) => [product.slug, product.name.trim()]),
  );
  return {
    created: snapshot.products.created.map((product) => ({
      id: product.id,
      name: names.get(product.slug) ?? product.slug,
      slug: product.slug,
    })),
  };
}

// ---------------------------------------------------------------------------
// Targets.
// ---------------------------------------------------------------------------

/**
 * ★ CONTENT, NOT ONLY THE CLOCK. A conflict is decided on what a shopper
 * would see (the name, description and photo) as well as `updated_at`, so a
 * writer that does not move the timestamp, or two writes inside one
 * transaction, cannot slip an edit past the approval.
 */
interface LockedCategory {
  updatedAt: string;
  status: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
}

interface LockedTargets {
  pages: Map<
    string,
    { slug: string; updatedAt: string; sections: PageSectionItem[] | null }
  >;
  chrome: { exists: boolean; value: StoreChrome } | null;
  storeSettings: Record<string, unknown> | null;
  categories: Map<string, LockedCategory>;
  takenSlugs: Set<string>;
  products: Map<string, { updatedAt: string; status: string; name: string }>;
}

async function lockTargets(
  db: Db,
  actor: MinkActorContext,
  plan: PersonalizationStoredPlan,
): Promise<LockedTargets> {
  const pageIds = plan.pages.map((page) => page.pageId);
  const pages = new Map<
    string,
    { slug: string; updatedAt: string; sections: PageSectionItem[] | null }
  >();
  if (pageIds.length) {
    const rows = await db.execute(sql`
      select id, slug, updated_at, sections from public.store_pages
      where store_id = ${actor.storeId}::uuid
        and id = any(${sql.param(pageIds)}::uuid[])
      order by id
      for update
    `);
    for (const row of rows.rows as Array<{
      id: string;
      slug: string;
      updated_at: string;
      sections: unknown;
    }>) {
      const validated = validateSections(row.sections, { mode: "draft" });
      pages.set(row.id, {
        slug: row.slug === "" ? "home" : row.slug,
        updatedAt: normalizeTimestamp(row.updated_at),
        sections: "error" in validated ? null : validated.sections,
      });
    }
  }

  let chrome: LockedTargets["chrome"] = null;
  if (plan.chrome) {
    const rows = await db.execute(sql`
      select draft from public.store_chrome
      where store_id = ${actor.storeId}::uuid
      for update
    `);
    const row = rows.rows[0] as { draft: unknown } | undefined;
    // ★ With no row yet, the store's own menus are the starting point, as in
    //   the context read: DEFAULT_CHROME here would publish StoreMink's stock
    //   links over the theme's navigation.
    chrome = {
      exists: Boolean(row),
      value: row
        ? sanitizeChromeForSave(row.draft)
        : await readMenusAsChrome(db, actor.storeId, { forUpdate: true }),
    };
  }

  let storeSettings: Record<string, unknown> | null = null;
  if (plan.brand) {
    const rows = await db.execute(sql`
      select settings from public.stores
      where id = ${actor.storeId}::uuid
      for update
    `);
    storeSettings = asRecord(
      (rows.rows[0] as { settings?: unknown })?.settings,
    );
  }

  const categoryIds = plan.categories.flatMap((change) =>
    change.action === "create" ? [] : [change.id],
  );
  const categoryRows = new Map<string, LockedCategory>();
  if (categoryIds.length) {
    const rows = await db.execute(sql`
      select id, updated_at, status, name, description, image_url
      from public.categories
      where store_id = ${actor.storeId}::uuid
        and id = any(${sql.param(categoryIds)}::uuid[])
      order by id
      for update
    `);
    for (const row of rows.rows as Array<{
      id: string;
      updated_at: string;
      status: string;
      name: string;
      description: string | null;
      image_url: string | null;
    }>) {
      categoryRows.set(row.id, {
        updatedAt: normalizeTimestamp(row.updated_at),
        status: row.status,
        name: row.name,
        description: row.description ?? null,
        imageUrl: row.image_url ?? null,
      });
    }
  }
  const takenSlugs = new Set<string>();
  const createSlugs = plan.categories.flatMap((change) =>
    change.action === "create" ? [change.slug] : [],
  );
  for (const slug of createSlugs) {
    // ★ The category path's own lock, so a category editor or another Mink
    //   approval creating the same address cannot race past this check.
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`mink-category-slug:${actor.storeId}:${slug}`}, 0)
      )
    `);
  }
  if (createSlugs.length) {
    const rows = await db
      .select({ slug: categories.slug })
      .from(categories)
      .where(
        and(
          eq(categories.storeId, actor.storeId),
          inArray(categories.slug, createSlugs),
        ),
      );
    for (const row of rows) takenSlugs.add(row.slug);
  }

  const productIds = plan.products.map((product) => product.id);
  const productRows = new Map<
    string,
    { updatedAt: string; status: string; name: string }
  >();
  if (productIds.length) {
    const rows = await db.execute(sql`
      select id, updated_at, status, name from public.products
      where store_id = ${actor.storeId}::uuid
        and id = any(${sql.param(productIds)}::uuid[])
      order by id
      for update
    `);
    for (const row of rows.rows as Array<{
      id: string;
      updated_at: string;
      status: string;
      name: string;
    }>) {
      productRows.set(row.id, {
        updatedAt: normalizeTimestamp(row.updated_at),
        status: row.status,
        name: row.name,
      });
    }
  }
  return {
    pages,
    chrome,
    storeSettings,
    categories: categoryRows,
    takenSlugs,
    products: productRows,
  };
}

/** The store as it is now, in the approval's vocabulary. */
function currentValues(
  draft: V1Draft,
  targets: LockedTargets,
): MinkStorefrontPersonalizationActionValues {
  const plan = draft.plan;
  const pagesDigest = digestMinkStorefrontValue(
    plan.pages.map((page) => {
      const current = targets.pages.get(page.pageId);
      return {
        id: page.pageId,
        version: current?.updatedAt ?? null,
        digest: current?.sections
          ? digestMinkStorefrontSections(current.sections)
          : null,
      };
    }),
  );
  const chromeDigest = plan.chrome
    ? digestMinkStorefrontValue({
        text: targets.chrome ? chromeTextDigest(targets.chrome.value) : null,
        design: targets.chrome
          ? digestMinkStorefrontDesign(
              targets.chrome.value.design ?? EMPTY_DESIGN_OVERRIDES,
            )
          : null,
      })
    : NONE;
  const brandDigest = plan.brand ? brandDigestOf(targets.storeSettings) : NONE;
  const categoriesDigest = plan.categories.length
    ? digestMinkStorefrontValue({
        rows: plan.categories.flatMap((change) => {
          if (change.action === "create") return [];
          const current = targets.categories.get(change.id);
          return [
            categoryCheckpoint(change, {
              version: current?.updatedAt ?? null,
              name: current?.name ?? null,
              description: current?.description ?? null,
              imageUrl: current?.imageUrl ?? null,
            }),
          ];
        }),
        taken: [...targets.takenSlugs].sort(),
      })
    : NONE;
  const productsDigest = plan.products.length
    ? digestMinkStorefrontValue(
        plan.products.map((product) => {
          const current = targets.products.get(product.id);
          return {
            id: product.id,
            version: current?.updatedAt ?? null,
            status: current?.status ?? null,
            name: current?.name ?? null,
          };
        }),
      )
    : NONE;
  return {
    plan_digest: draft.planDigest,
    pages_digest: pagesDigest,
    chrome_digest: chromeDigest,
    brand_digest: brandDigest,
    categories_digest: categoriesDigest,
    products_digest: productsDigest,
    page_count: String(plan.pages.length),
    photo_count: String(plan.photos.length),
  };
}

/**
 * What the plan expects to find: the same vocabulary as `currentValues`, built
 * from the versions the proposal recorded. ★ The preview compares the two and
 * refuses a store that already moved, before any approval exists.
 */
function expectedValues(
  draft: V1Draft,
): MinkStorefrontPersonalizationActionValues {
  const plan = draft.plan;
  return {
    plan_digest: draft.planDigest,
    pages_digest: digestMinkStorefrontValue(
      plan.pages.map((page) => ({
        id: page.pageId,
        version: normalizeTimestamp(page.expectedVersion),
        digest: page.expectedDigest,
      })),
    ),
    chrome_digest: plan.chrome
      ? digestMinkStorefrontValue({
          text: plan.chrome.expectedTextDigest,
          design: plan.chrome.expectedDesignDigest,
        })
      : NONE,
    brand_digest: plan.brand ? plan.brand.expectedDigest : NONE,
    categories_digest: plan.categories.length
      ? digestMinkStorefrontValue({
          rows: plan.categories.flatMap((change) => {
            if (change.action === "create") return [];
            const version = normalizeTimestamp(change.expectedUpdatedAt);
            return [
              change.action === "update"
                ? categoryCheckpoint(change, { version, ...change.before })
                : categoryCheckpoint(change, {
                    version,
                    name: change.name,
                    description: null,
                    imageUrl: null,
                  }),
            ];
          }),
          taken: [],
        })
      : NONE,
    products_digest: plan.products.length
      ? digestMinkStorefrontValue(
          plan.products.map((product) => ({
            id: product.id,
            version: normalizeTimestamp(product.expectedUpdatedAt),
            status: "published",
            name: product.name,
          })),
        )
      : NONE,
    page_count: String(plan.pages.length),
    photo_count: String(plan.photos.length),
  };
}

/** What the store will hold once the plan is written. */
function proposedValues(
  draft: V1Draft,
): MinkStorefrontPersonalizationActionValues {
  const plan = draft.plan;
  return {
    plan_digest: draft.planDigest,
    pages_digest: digestMinkStorefrontValue(
      plan.pages.map((page) => ({
        id: page.pageId,
        digest: page.proposedDigest,
      })),
    ),
    chrome_digest: plan.chrome ? digestMinkStorefrontValue(plan.chrome) : NONE,
    brand_digest: plan.brand ? digestMinkStorefrontValue(plan.brand) : NONE,
    categories_digest: plan.categories.length
      ? digestMinkStorefrontValue(plan.categories)
      : NONE,
    products_digest: plan.products.length
      ? digestMinkStorefrontValue(plan.products.map((product) => product.id))
      : NONE,
    page_count: String(plan.pages.length),
    photo_count: String(plan.photos.length),
  };
}

/**
 * What a category is checked on. A hidden category only needs to be the
 * same category (its name and version); one being renamed must also still
 * say what the proposal was written against, or the merchant's own edit
 * would be overwritten.
 */
function categoryCheckpoint(
  change: Exclude<
    PersonalizationStoredPlan["categories"][number],
    { action: "create" }
  >,
  values: {
    version: string | null;
    name: string | null;
    description: string | null;
    imageUrl: string | null;
  },
) {
  return change.action === "hide"
    ? { id: change.id, version: values.version, name: values.name }
    : {
        id: change.id,
        version: values.version,
        name: values.name,
        description: values.description,
        imageUrl: values.imageUrl,
      };
}

async function rerunGuards(
  db: Db,
  actor: MinkActorContext,
  plan: PersonalizationStoredPlan,
  locked: LockedTargets,
): Promise<string | null> {
  for (const page of plan.pages) {
    const current = locked.pages.get(page.pageId);
    if (!current?.sections) return "A Website Builder page is no longer valid.";
    if (
      assertLayoutPreservesCustomCode(page.sections, current.sections).length
    ) {
      return "The approved pages no longer preserve the custom code on them.";
    }
    const onPage = new Set(collectSectionMediaUrls(current.sections));
    const candidates = collectSectionMediaUrls(page.sections).filter(
      (url) => !onPage.has(url),
    );
    const owned = await selectOwnedStorefrontImageUrls(
      db,
      actor.storeId,
      candidates,
    );
    if (assertLayoutMediaIsOwned(page.sections, [...onPage, ...owned]).length) {
      return "A new photo is no longer in this store's Media Library.";
    }
  }
  const categoryImages = plan.categories.flatMap((change) =>
    change.action !== "hide" && change.imageUrl ? [change.imageUrl] : [],
  );
  if (categoryImages.length) {
    const owned = await selectOwnedStorefrontImageUrls(
      db,
      actor.storeId,
      categoryImages,
    );
    if (categoryImages.some((url) => !owned.has(url))) {
      return "A category photo is no longer in this store's Media Library.";
    }
  }
  for (const change of plan.categories) {
    if (change.action === "create" && locked.takenSlugs.has(change.slug)) {
      return "A category with one of the new addresses was created in the meantime.";
    }
  }
  for (const product of plan.products) {
    const current = locked.products.get(product.id);
    if (!current || current.status !== "published") {
      return "A sample product changed after the approval preview.";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writes. Every precondition was checked under lock before the first one.
// ---------------------------------------------------------------------------

async function writePages(
  db: Db,
  actor: MinkActorContext,
  plan: PersonalizationStoredPlan,
) {
  for (const page of plan.pages) {
    const updated = await db
      .update(storePages)
      .set({ sections: page.sections, updatedBy: actor.adminId })
      .where(
        and(
          eq(storePages.id, page.pageId),
          eq(storePages.storeId, actor.storeId),
        ),
      )
      .returning({ id: storePages.id });
    // Rows are locked; a missing one means the transaction must not commit.
    if (!updated[0]) throw targetConflict();
  }
}

async function writeChrome(
  db: Db,
  actor: MinkActorContext,
  plan: PersonalizationStoredPlan,
  locked: LockedTargets["chrome"],
  now: string,
) {
  if (!plan.chrome || !locked) return;
  const current = locked.value;
  // ★★ ONLY THE KEYS THE PLAN NAMES ARE REPLACED, the rest of the chrome is
  //    carried through (9C's rule): the row also holds navigation, footer
  //    columns and layout variants the merchant may have edited.
  const next: StoreChrome = {
    ...current,
    design: plan.chrome.design ?? current.design,
    header: {
      ...current.header,
      announcement:
        plan.chrome.announcementText !== null
          ? {
              ...current.header.announcement,
              text: plan.chrome.announcementText,
            }
          : current.header.announcement,
    },
    footer: {
      ...current.footer,
      newsletter: plan.chrome.newsletter
        ? {
            ...current.footer.newsletter,
            heading: plan.chrome.newsletter.heading,
            subtext: plan.chrome.newsletter.subtext,
            buttonLabel: plan.chrome.newsletter.buttonLabel,
          }
        : current.footer.newsletter,
    },
  };
  const sanitized = sanitizeChromeForSave(next);
  if (locked.exists) {
    // The row was locked FOR UPDATE, so this always updates it.
    await db
      .insert(storeChrome)
      .values({ storeId: actor.storeId, draft: sanitized, updatedAt: now })
      .onConflictDoUpdate({
        target: storeChrome.storeId,
        set: { draft: sanitized, updatedAt: now },
      });
    return;
  }
  // ★★ With no row there was nothing to lock, so the Builder's autosave can
  //    insert the store's first chrome draft meanwhile; updating that row
  //    would lose the edit. A row found now rolls the whole apply back.
  const inserted = await db
    .insert(storeChrome)
    .values({ storeId: actor.storeId, draft: sanitized, updatedAt: now })
    .onConflictDoNothing()
    .returning({ storeId: storeChrome.storeId });
  if (!inserted.length) throw targetConflict();
}

async function writeBrand(
  db: Db,
  actor: MinkActorContext,
  plan: PersonalizationStoredPlan,
  settings: Record<string, unknown> | null,
) {
  if (!plan.brand || !settings) return;
  const brand = { ...asRecord(settings.brand) };
  if (plan.brand.tagline !== null) brand.tagline = plan.brand.tagline;
  if (plan.brand.blurb !== null) brand.blurb = plan.brand.blurb;
  await db
    .update(stores)
    .set({ settings: { ...settings, brand } })
    .where(eq(stores.id, actor.storeId));
}

async function writeCategories(
  db: Db,
  actor: MinkActorContext,
  plan: PersonalizationStoredPlan,
  now: string,
) {
  let nextSort: number | null = null;
  for (const change of plan.categories) {
    if (change.action === "hide") {
      await db
        .update(categories)
        .set({ status: "hidden", updatedAt: now })
        .where(
          and(
            eq(categories.id, change.id),
            eq(categories.storeId, actor.storeId),
          ),
        );
      continue;
    }
    if (change.action === "update") {
      await db
        .update(categories)
        .set({
          name: change.name,
          description: change.description,
          imageUrl: change.imageUrl,
          updatedAt: now,
        })
        .where(
          and(
            eq(categories.id, change.id),
            eq(categories.storeId, actor.storeId),
          ),
        );
      continue;
    }
    if (nextSort === null) {
      const rows = await db.execute(sql`
        select coalesce(max(sort_order), 0)::int as sort from public.categories
        where store_id = ${actor.storeId}::uuid
      `);
      nextSort = Number((rows.rows[0] as { sort?: number })?.sort ?? 0);
    }
    nextSort += 1;
    await db.insert(categories).values({
      storeId: actor.storeId,
      name: change.name,
      slug: change.slug,
      description: change.description,
      imageUrl: change.imageUrl,
      status: "active",
      sortOrder: nextSort,
    });
  }
}

async function writeProducts(
  db: Db,
  actor: MinkActorContext,
  plan: PersonalizationStoredPlan,
) {
  if (!plan.products.length) return;
  await db
    .update(products)
    .set({ status: "draft", publishedAt: null, updatedBy: actor.adminId })
    .where(
      and(
        eq(products.storeId, actor.storeId),
        inArray(
          products.id,
          plan.products.map((product) => product.id),
        ),
      ),
    );
}

// ---------------------------------------------------------------------------
// The approval row.
// ---------------------------------------------------------------------------

async function createApproval(
  db: Db,
  input: {
    actor: MinkActorContext;
    draft: PersonalizationDraft;
    before: MinkStorefrontPersonalizationActionValues;
    after: MinkStorefrontPersonalizationActionValues;
    /** What the proposal was made against, in the same vocabulary. */
    expected: MinkStorefrontPersonalizationActionValues;
    /** The refusal when the store already moved (each plan version words its own). */
    mismatch: () => MinkRequestError;
    /** A refusal the digests cannot express (a revamp's product cap), or null. */
    blocked: MinkRequestError | null;
    idempotencyKey: string;
  },
): Promise<MinkStorefrontPersonalizationActionApproval> {
  // ★ A STORE THAT ALREADY MOVED IS REFUSED BEFORE AN APPROVAL EXISTS: the
  //   current state must match what the proposal was made against.
  if (
    hashMinkActionPayload(input.before) !==
    hashMinkActionPayload(input.expected)
  ) {
    throw input.mismatch();
  }
  if (input.blocked) throw input.blocked;
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const hash = hashMinkActionPayload({
    storeId: input.actor.storeId,
    adminId: input.actor.adminId,
    draftId: input.draft.id,
    draftVersion: input.draft.currentVersion,
    resourceId: input.actor.storeId,
    resourceVersion: null,
    before: input.before,
    after: input.after,
    toolVersion: TOOL_VERSION,
  });
  const inserted = await db
    .insert(minkActionApprovals)
    .values({
      id,
      storeId: input.actor.storeId,
      adminId: input.actor.adminId,
      draftId: input.draft.id,
      productId: null,
      resourceType: "storefront",
      resourceId: input.actor.storeId,
      resourceVersion: null,
      resourceLabel: "Whole storefront",
      locationId: null,
      variantId: null,
      resultId: null,
      sourceApprovalId: null,
      toolName: TOOL_NAME,
      operation: "apply",
      draftVersion: input.draft.currentVersion,
      productVersion: null,
      beforeJson: input.before,
      afterJson: input.after,
      requestHash: hash,
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0]
    ? validateApproval(inserted[0])
    : await readByIdempotency(db, input.actor, input.idempotencyKey);
  if (row.requestHash !== hash) {
    throw conflict(
      "mink_personalization_idempotency_conflict",
      "This approval request key was already used for a different preview.",
    );
  }
  return toApproval(row, input.draft.plan);
}

async function readDraft(
  db: Db,
  actor: MinkActorContext,
  draftId: string,
): Promise<PersonalizationDraft> {
  const rows = await db
    .select({
      id: minkDrafts.id,
      kind: minkDrafts.kind,
      status: minkDrafts.status,
      content: minkDrafts.contentJson,
      currentVersion: minkDrafts.currentVersion,
    })
    .from(minkDrafts)
    .where(
      and(
        eq(minkDrafts.id, draftId),
        eq(minkDrafts.storeId, actor.storeId),
        eq(minkDrafts.adminId, actor.adminId),
      ),
    )
    .limit(1);
  const draft = rows[0];
  if (
    !draft ||
    draft.kind !== "storefront_personalization" ||
    draft.status !== "proposed" ||
    draft.currentVersion !== 0
  ) {
    throw new MinkRequestError(
      "mink_personalization_draft_unavailable",
      "This personalisation is not available for approval.",
      409,
    );
  }
  try {
    const content = normalizeMinkDraftContent(
      "storefront_personalization",
      draft.content,
    );
    const plan = readAnyStoredPlan(content.plan_json);
    const planDigest = digestMinkStorefrontValue(plan);
    if (planDigest !== content.plan_digest) {
      throw new Error("The saved personalisation does not match its digest.");
    }
    const base = {
      id: draft.id,
      currentVersion: draft.currentVersion,
      planDigest,
    };
    return isRevampPlan(plan) ? { ...base, plan } : { ...base, plan };
  } catch (error) {
    throw new MinkRequestError(
      "mink_personalization_draft_invalid",
      error instanceof Error ? error.message : "Invalid personalisation.",
      400,
    );
  }
}

/**
 * ★ THE SCHEMA VERSION IS READ FIRST: version 2 is a revamp's plan, read and
 * validated by revamp/apply-v2.ts; anything else is read exactly as version 1
 * always was, its errors included.
 */
function readAnyStoredPlan(
  raw: string | undefined,
): PersonalizationStoredPlan | RevampStoredPlan {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    parsed = null;
  }
  return isRevampPlan(parsed) ? readRevampStoredPlan(raw) : readStoredPlan(raw);
}

/**
 * The stored plan, re-validated. ★ Every page's sections pass the same
 * draft-mode registry check the layout path's stored proposal does, so a
 * row edited by hand cannot carry a section the renderer would refuse.
 */
export function readStoredPlan(
  raw: string | undefined,
): PersonalizationStoredPlan {
  const plan = JSON.parse(raw ?? "") as PersonalizationStoredPlan;
  if (
    !plan ||
    plan.schemaVersion !== MINK_PERSONALIZATION_SCHEMA_VERSION ||
    !Array.isArray(plan.pages) ||
    !Array.isArray(plan.categories) ||
    !Array.isArray(plan.products) ||
    !Array.isArray(plan.photos)
  ) {
    throw new Error("The saved personalisation is not readable.");
  }
  for (const page of plan.pages) {
    const validated = validateSections(page.sections, { mode: "draft" });
    if ("error" in validated) {
      throw new Error(
        `The saved page "${page.title}" is not valid: ${validated.error}`,
      );
    }
    if (digestMinkStorefrontSections(page.sections) !== page.proposedDigest) {
      throw new Error("A saved page does not match its digest.");
    }
  }
  return plan;
}

function toApproval(
  row: ApprovalRow,
  plan: PersonalizationStoredPlan | RevampStoredPlan,
): MinkStorefrontPersonalizationActionApproval {
  // ★ A page a revamp creates has no id until Apply writes it; its card
  //   publishes from the revamp's own snapshot, never from this list.
  const pages: ReadonlyArray<{
    pageId: string | null;
    slug: string;
    title: string;
  }> = plan.pages;
  return {
    id: row.id,
    toolName: TOOL_NAME,
    operation: "apply",
    status: row.status as MinkStorefrontPersonalizationActionApproval["status"],
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    resource: {
      type: "storefront",
      id: row.resourceId ?? "",
      label: row.resourceLabel ?? "Whole storefront",
      dashboardPath: "/dashboard/builder",
    },
    before: valuesFromJson(row.beforeJson),
    after: valuesFromJson(row.afterJson),
    pages: pages.map((page) => ({
      id: page.pageId ?? "",
      slug: page.slug,
      title: page.title,
    })),
    chromeChanged: plan.chrome !== null,
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function validateApproval(row: ApprovalRow): ApprovalRow {
  if (
    row.toolName !== TOOL_NAME ||
    row.operation !== "apply" ||
    !["pending", "executed", "conflicted", "expired", "cancelled"].includes(
      row.status,
    ) ||
    row.resourceType !== "storefront" ||
    row.resourceId !== row.storeId ||
    row.draftVersion !== 0 ||
    row.productId ||
    row.locationId ||
    row.variantId ||
    row.sourceApprovalId ||
    (row.status === "executed" &&
      (!row.resultId ||
        !row.resultVersion ||
        !row.approvedAt ||
        !row.executedAt)) ||
    (row.status !== "executed" && (row.resultId || row.resultVersion))
  ) {
    throw invalidApproval();
  }
  valuesFromJson(row.beforeJson);
  valuesFromJson(row.afterJson);
  return row;
}

const VALUE_KEYS = [
  "plan_digest",
  "pages_digest",
  "chrome_digest",
  "brand_digest",
  "categories_digest",
  "products_digest",
  "page_count",
  "photo_count",
] as const;

function valuesFromJson(
  value: unknown,
): MinkStorefrontPersonalizationActionValues {
  const digest = (text: unknown) =>
    typeof text === "string" && (text === NONE || /^[a-f0-9]{64}$/.test(text));
  if (
    !isRecord(value) ||
    Object.keys(value).length !== VALUE_KEYS.length ||
    VALUE_KEYS.some((key) => typeof value[key] !== "string") ||
    !/^[a-f0-9]{64}$/.test(String(value.plan_digest)) ||
    !digest(value.pages_digest) ||
    !digest(value.chrome_digest) ||
    !digest(value.brand_digest) ||
    !digest(value.categories_digest) ||
    !digest(value.products_digest) ||
    !/^(?:0|[1-9][0-9]{0,2})$/.test(String(value.page_count)) ||
    !/^(?:0|[1-9][0-9]{0,2})$/.test(String(value.photo_count))
  ) {
    throw invalidApproval();
  }
  return value as unknown as MinkStorefrontPersonalizationActionValues;
}

function requestHash(
  approval: ApprovalRow,
  before: MinkStorefrontPersonalizationActionValues,
  after: MinkStorefrontPersonalizationActionValues,
) {
  return hashMinkActionPayload({
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    draftVersion: approval.draftVersion,
    resourceId: approval.resourceId,
    resourceVersion: approval.resourceVersion,
    before,
    after,
    toolVersion: TOOL_VERSION,
  });
}

/** One sentence for the append-only audit row; never model-authored text. */
function auditDetail(plan: PersonalizationStoredPlan): string {
  const parts = [
    `${plan.pages.length} page${plan.pages.length === 1 ? "" : "s"} saved to the private Website Builder draft`,
    `${plan.photos.length} new photo${plan.photos.length === 1 ? "" : "s"}`,
  ];
  if (plan.chrome) parts.push("header, footer or look saved to the draft");
  if (plan.categories.length)
    parts.push(
      `${plan.categories.length} category change${plan.categories.length === 1 ? "" : "s"}`,
    );
  if (plan.products.length)
    parts.push(
      `${plan.products.length} sample product${plan.products.length === 1 ? "" : "s"} unpublished`,
    );
  if (plan.brand) parts.push("store tagline or description updated");
  return `Approved storefront personalisation applied: ${parts.join("; ")}. No page was published.`;
}

function assertAuthority(actor: MinkActorContext) {
  if (
    !actor.draftingEnabled ||
    !can(actor.permissions, "builder", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_personalization_access_denied",
      "You do not have permission to apply a storefront personalisation.",
      403,
    );
  }
}

/** The parts outside the Builder keep their own permission. */
function assertPartAuthority(
  actor: MinkActorContext,
  plan: PersonalizationStoredPlan,
) {
  if (
    plan.categories.length &&
    !can(actor.permissions, "categories", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_personalization_access_denied",
      "This personalisation changes categories, which needs Categories manage permission.",
      403,
    );
  }
  if (
    plan.products.length &&
    !can(actor.permissions, "products", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_personalization_access_denied",
      "This personalisation unpublishes products, which needs Products manage permission.",
      403,
    );
  }
  // ★ The tagline and footer description go live at Apply, and everywhere
  //   else only saveStoreBranding saves them, behind Branding manage.
  if (
    plan.brand &&
    !can(actor.permissions, "branding", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_personalization_access_denied",
      "This personalisation changes your store's tagline or footer description, which needs Branding manage permission.",
      403,
    );
  }
}

async function assertToolEnabled(db: Db, storeId: string, lock = false) {
  if (lock) {
    const result = await db.execute(sql`
      select enabled from public.mink_action_tool_access
      where store_id = ${storeId}::uuid
        and tool_name = 'apply_storefront_personalization'
      for update
    `);
    if ((result.rows[0] as { enabled?: boolean } | undefined)?.enabled) return;
  } else {
    const rows = await db
      .select({ enabled: minkActionToolAccess.enabled })
      .from(minkActionToolAccess)
      .where(
        and(
          eq(minkActionToolAccess.storeId, storeId),
          eq(minkActionToolAccess.toolName, TOOL_NAME),
        ),
      )
      .limit(1);
    if (rows[0]?.enabled) return;
  }
  throw new MinkRequestError(
    "mink_personalization_tool_disabled",
    "StoreMink support has not enabled storefront personalisation for this store.",
    403,
  );
}

async function lockDraft(db: Db, actor: MinkActorContext, draftId: string) {
  await db.execute(sql`
    select id from public.mink_drafts
    where id = ${draftId}::uuid and store_id = ${actor.storeId}::uuid
      and admin_id = ${actor.adminId}
    for update
  `);
}

async function lockApproval(
  db: Db,
  actor: MinkActorContext,
  approvalId: string,
) {
  await db.execute(sql`
    select id from public.mink_action_approvals
    where id = ${approvalId}::uuid and store_id = ${actor.storeId}::uuid
      and admin_id = ${actor.adminId}
    for update
  `);
}

async function readApproval(db: Db, actor: MinkActorContext, id: string) {
  const rows = await db
    .select()
    .from(minkActionApprovals)
    .where(
      and(
        eq(minkActionApprovals.id, id),
        eq(minkActionApprovals.storeId, actor.storeId),
        eq(minkActionApprovals.adminId, actor.adminId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw approvalNotFound();
  return validateApproval(rows[0]);
}

async function readByIdempotency(
  db: Db,
  actor: MinkActorContext,
  idempotencyKey: string,
) {
  const rows = await db
    .select()
    .from(minkActionApprovals)
    .where(
      and(
        eq(minkActionApprovals.storeId, actor.storeId),
        eq(minkActionApprovals.adminId, actor.adminId),
        eq(minkActionApprovals.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!rows[0]) throw approvalNotFound();
  return validateApproval(rows[0]);
}

async function readAudit(db: Db, storeId: string, approvalId: string) {
  const rows = await db
    .select({ id: minkActionAudit.id })
    .from(minkActionAudit)
    .where(
      and(
        eq(minkActionAudit.storeId, storeId),
        eq(minkActionAudit.approvalId, approvalId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function finalizeWithoutWrite(
  db: Db,
  approval: ApprovalRow,
  status: "conflicted" | "expired",
  detail: string,
) {
  await db
    .update(minkActionApprovals)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(minkActionApprovals.id, approval.id),
        eq(minkActionApprovals.storeId, approval.storeId),
      ),
    );
  await db.insert(minkActionAudit).values({
    id: crypto.randomUUID(),
    approvalId: approval.id,
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    productId: null,
    resourceType: "storefront",
    resourceId: approval.resourceId,
    locationId: null,
    variantId: null,
    resourceVersionBefore: approval.resourceVersion,
    resourceVersionAfter: null,
    resultId: null,
    toolName: TOOL_NAME,
    operation: "apply",
    outcome: status,
    beforeJson: valuesFromJson(approval.beforeJson),
    afterJson: valuesFromJson(approval.afterJson),
    productVersionBefore: null,
    productVersionAfter: null,
    requestHash: approval.requestHash,
    toolVersion: TOOL_VERSION,
    detail,
  });
}

function brandDigestOf(settings: Record<string, unknown> | null): string {
  const brand = asRecord(settings?.brand);
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  return digestMinkStorefrontValue({
    tagline: text(brand.tagline),
    blurb: text(brand.blurb),
  });
}

/**
 * ★ ONE SHAPE FOR EVERY VERSION COMPARED. The proposal recorded versions
 *   through Drizzle and the locks read them with raw SQL; both are normalised
 *   to one ISO form with every microsecond kept (never through `Date`, which
 *   drops them), so equal timestamps compare equal whichever path read them.
 */
function normalizeTimestamp(value: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      String(value).trim(),
    );
  if (!match) return String(value);
  const fraction = (match[3] ?? "").padEnd(7, "0").slice(0, 7);
  let zone = match[4] ?? "Z";
  if (zone === "+00" || zone === "+00:00" || zone === "+0000") zone = "Z";
  return `${match[1]}T${match[2]}${fraction}${zone}`;
}

function invalidApproval() {
  return new MinkRequestError(
    "mink_personalization_approval_invalid",
    "This approval failed integrity validation. Apply the card again.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_personalization_approval_not_found",
    "This approval is unavailable.",
    404,
  );
}

function draftConflict() {
  return conflict(
    "mink_personalization_draft_conflict",
    "The saved personalisation changed. Ask Mink for a fresh one.",
  );
}

function targetConflict() {
  return conflict(
    "mink_personalization_target_conflict",
    "Part of your storefront changed since Mink prepared this. Nothing was saved; ask Mink to personalise it again from the latest version.",
  );
}

function conflict(code: string, message: string) {
  return new MinkRequestError(code, message, 409);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
