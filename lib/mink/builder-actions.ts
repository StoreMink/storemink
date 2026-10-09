import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  categories,
  stores,
  storeChrome,
  storeMenus,
  storePages,
  minkDrafts,
  minkActionToolAccess,
  minkActionApprovals,
  minkActionAudit,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { normalizeChrome, sanitizeChromeForSave } from "@/lib/chrome/types";
import { contrastIssuesFor } from "@/lib/chrome/design";
import { resolveInstalledThemeDefinitionWithDb } from "@/lib/themes/runtime-registry";
import { readThemeSelection } from "@/lib/themes/meta";
import { effectivePlan } from "@/lib/plans";
import { DEFAULT_PRIMARY } from "@/lib/store/brand";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { createMinkDraftProposal } from "./drafts";
import { MinkRequestError, MinkToolInputError } from "./errors";
import {
  builderDigest,
  builderPlan,
  readBuilderPatch,
  record,
  navigationIssues,
  assertSafeBuilderLinks,
  type BuilderOperation,
  type BuilderTarget,
  type BuilderPage,
  type BuilderPlan,
  type BuilderPatch,
} from "./builder-contract";
import {
  assertLayoutMediaIsOwned,
  collectSectionMediaUrls,
} from "./storefront-media-policy";
import { selectOwnedStorefrontImageUrls } from "./storefront-media-read";
import { validateMinkStorefrontBrowserValidation } from "./storefront-publication-validation";
import {
  HOMEPAGE_SECTION_TYPES,
  SECTION_TYPE_META,
  EMPTY_CONFIG,
  MAX_PAGE_SECTIONS,
  type PageSectionItem,
} from "@/lib/sections/registry";
import type { MinkActorContext, MinkArtifact } from "./types";

const TOOL = "manage_website_builder";
const VERSION = 1;
function authority(actor: MinkActorContext, write: boolean) {
  if (
    (write && !actor.draftingEnabled) ||
    !can(
      actor.permissions,
      "builder",
      write ? "manage" : "view",
      actor.isSuperadmin,
    )
  )
    throw new MinkRequestError(
      "mink_builder_permission",
      "Website Builder permission is required.",
      403,
    );
}
async function state(
  db: Db,
  actor: MinkActorContext,
  operation: BuilderOperation,
  pageSlug: string,
) {
  const [store] = await db
    .select()
    .from(stores)
    .where(eq(stores.id, actor.storeId))
    .limit(1);
  if (!store)
    throw new MinkRequestError("mink_builder_store", "Store not found.", 404);
  const plan = effectivePlan({
    plan: store.plan,
    plan_expires_at: store.planExpiresAt,
    comp_plan: store.compPlan,
    comp_expires_at: store.compExpiresAt,
  });
  const settings = record(store.settings) ? store.settings : {};
  const customCode = Boolean(
    resolveStoreSettings(settings, plan)["pages.customCode"],
  );
  let target: BuilderTarget;
  if (operation.startsWith("chrome_")) {
    const [row] = await db
      .select()
      .from(storeChrome)
      .where(eq(storeChrome.storeId, actor.storeId))
      .limit(1);
    let liveChrome: ReturnType<typeof normalizeChrome>;
    if (row?.published) liveChrome = normalizeChrome(row.published);
    else {
      const [legacy] = await db
        .select({
          header: storeMenus.header,
          groups: storeMenus.footerGroups,
          legal: storeMenus.footerLegal,
        })
        .from(storeMenus)
        .where(eq(storeMenus.storeId, actor.storeId))
        .limit(1);
      liveChrome = normalizeChrome(
        legacy
          ? {
              header: { links: legacy.header },
              footer: { groups: legacy.groups, legal: legacy.legal },
            }
          : null,
      );
    }
    target = {
      operation,
      pageSlug: "home",
      exists: !!row,
      liveChrome,
      chrome: row
        ? sanitizeChromeForSave(row.draft)
        : sanitizeChromeForSave(liveChrome),
      publishedChrome: row?.published
        ? sanitizeChromeForSave(row.published)
        : null,
      version: row?.updatedAt ?? null,
    };
  } else if (operation === "brand_update") {
    const raw = record(settings.brand) ? settings.brand : {};
    target = {
      operation,
      pageSlug: "home",
      exists: true,
      brand: {
        primaryColor:
          typeof raw.primaryColor === "string" && raw.primaryColor.trim()
            ? raw.primaryColor.trim()
            : DEFAULT_PRIMARY,
        logoUrl:
          typeof raw.logoUrl === "string" && raw.logoUrl.trim()
            ? raw.logoUrl.trim()
            : null,
      },
      version: builderDigest({
        primaryColor: raw.primaryColor ?? null,
        logoUrl: raw.logoUrl ?? null,
      }),
    };
  } else if (operation === "settings_update") {
    target = {
      operation,
      pageSlug: "home",
      exists: true,
      customCode,
      version: builderDigest({
        plan,
        override: record(settings.features)
          ? (settings.features["pages.customCode"] ?? null)
          : null,
      }),
    };
  } else {
    const slug = pageSlug === "home" ? "" : pageSlug;
    const [row] = await db
      .select()
      .from(storePages)
      .where(
        and(eq(storePages.storeId, actor.storeId), eq(storePages.slug, slug)),
      )
      .limit(1);
    target = {
      operation,
      pageSlug,
      exists: !!row,
      page: row
        ? {
            id: row.id,
            slug: row.slug,
            title: row.title,
            status: row.status,
            seoTitle: row.seoTitle,
            seoDescription: row.seoDescription,
            seoNoindex: row.seoNoindex,
            sections: row.sections as PageSectionItem[],
            publishedSections: row.publishedSections as PageSectionItem[],
            updatedAt: row.updatedAt,
            publishedAt: row.publishedAt,
          }
        : null,
    };
  }
  return { target, store, settings, customCode, plan };
}
async function destinations(db: Db, storeId: string) {
  const cats = await db
    .select({
      slug: categories.slug,
      name: categories.name,
      status: categories.status,
    })
    .from(categories)
    .where(eq(categories.storeId, storeId))
    .limit(1001);
  const pages = await db
    .select({
      slug: storePages.slug,
      name: storePages.title,
      status: storePages.status,
    })
    .from(storePages)
    .where(eq(storePages.storeId, storeId))
    .limit(501);
  if (cats.length > 1000 || pages.length > 500)
    throw new MinkToolInputError(
      "This store has too many destinations for one Builder review. Narrow the catalogue before continuing.",
    );
  return { categories: cats, pages };
}
export async function readMinkBuilderContext(
  actor: MinkActorContext,
  operation: BuilderOperation,
  pageSlug = "home",
) {
  authority(actor, false);
  return withService(async (db) => {
    const s = await state(db, actor, operation, pageSlug);
    const known = await destinations(db, actor.storeId);
    const target = s.target;
    return {
      operation,
      pageSlug: target.pageSlug,
      targetDigest: builderDigest(target),
      exists: target.exists,
      chrome: target.chrome,
      publishedChrome: target.publishedChrome,
      liveChrome: target.liveChrome,
      draftMatchesLive: draftMatchesLive(target),
      page: target.page
        ? {
            ...target.page,
            sections: target.page.sections.map((section) =>
              section.type === "custom_code"
                ? {
                    id: section.id,
                    type: section.type,
                    enabled: section.enabled,
                    keep: true,
                    source:
                      "Use get_storefront_section_context to read or change this code; use {id,keep:true} to preserve it.",
                  }
                : section,
            ),
            publishedSections: undefined,
          }
        : null,
      settings: { "pages.customCode": s.customCode },
      brand: target.brand,
      plan: s.plan,
      destinations: known,
      navigationIssues: target.chrome
        ? navigationIssues(target.chrome, known.categories, known.pages)
        : [],
      liveNavigationIssues: target.liveChrome
        ? navigationIssues(target.liveChrome, known.categories, known.pages)
        : [],
      sectionCatalog: ["page_create", "page_update"].includes(operation)
        ? HOMEPAGE_SECTION_TYPES.map((type) => ({
            type,
            label: SECTION_TYPE_META[type].label,
            description: SECTION_TYPE_META[type].description,
            configExample: EMPTY_CONFIG[type],
            available: type !== "custom_code" || s.customCode,
          }))
        : undefined,
      maxPageSections: MAX_PAGE_SECTIONS,
      appearanceOptions: {
        header: [
          "theme",
          "classic",
          "market",
          "centered",
          "minimal",
          "transparent",
          "hamburger",
        ],
        card: [
          "theme",
          "classic",
          "quick_add",
          "overlay",
          "framed",
          "grocery",
          "centered",
          "soft",
          "wide",
        ],
        productDetail: ["theme", "classic", "grocery", "editorial"],
        cart: ["theme", "classic", "grocery", "compact"],
        footer: [
          "theme",
          "rich",
          "minimal",
          "editorial",
          "centered",
          "compact",
        ],
      },
      contentTrust: "untrusted_storefront_data",
      authority:
        "Read only. A separate proposal and human approval are required for every change.",
    };
  });
}

async function validatePlan(
  db: Db,
  actor: MinkActorContext,
  patch: BuilderPatch,
  s: Awaited<ReturnType<typeof state>>,
) {
  let plan: BuilderPlan;
  try {
    plan = builderPlan(patch, s.target, s.customCode, s.plan);
    const existing =
      patch.operation === "chrome_update"
        ? s.target.chrome
        : patch.operation === "page_update"
          ? s.target.page
          : undefined;
    assertSafeBuilderLinks(plan.next, existing);
  } catch (error) {
    throw new MinkToolInputError((error as Error).message);
  }
  if (patch.operation.startsWith("chrome_")) {
    const next = sanitizeChromeForSave(plan.next);
    if (patch.operation !== "chrome_revert") {
      const known = await destinations(db, actor.storeId);
      const prior = navigationIssues(
        s.target.chrome!,
        known.categories,
        known.pages,
      );
      const issues = navigationIssues(
        next,
        known.categories,
        known.pages,
      ).filter(
        (issue) =>
          patch.operation === "chrome_publish" ||
          !prior.some(
            (old) => old.path === issue.path && old.href === issue.href,
          ),
      );
      if (issues.length)
        throw new MinkToolInputError(
          issues
            .map(
              (i) =>
                `${i.label}: ${i.message}${i.suggestedHref ? ` Use ${i.suggestedHref}.` : ""}`,
            )
            .join(" "),
        );
    }
    if (patch.operation === "chrome_publish") {
      const theme = await resolveInstalledThemeDefinitionWithDb(
        db,
        readThemeSelection(s.settings),
      );
      const issues = contrastIssuesFor(
        next.design,
        theme?.preset.design ?? null,
      );
      if (issues.length) throw new MinkToolInputError(issues.join(" "));
    }
    // New menu tile media must be owned by this store, just like a page photo.
    const images = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.flatMap(images)
        : record(value)
          ? Object.entries(value).flatMap(([k, v]) =>
              k === "image_url" && typeof v === "string" && v ? [v] : images(v),
            )
          : [];
    const current = new Set(images(s.target.chrome));
    const candidates = images(next).filter((url) => !current.has(url));
    const owned = await selectOwnedStorefrontImageUrls(
      db,
      actor.storeId,
      candidates,
    );
    if (candidates.some((url) => !owned.has(url)))
      throw new MinkToolInputError(
        "A menu image does not belong to this store. Read Media or the product catalogue and use an exact returned image URL.",
      );
  }
  if (patch.operation === "brand_update" && record(plan.next)) {
    const logo = plan.next.logoUrl;
    if (typeof logo === "string" && logo !== s.target.brand?.logoUrl) {
      const owned = await selectOwnedStorefrontImageUrls(db, actor.storeId, [
        logo,
      ]);
      if (!owned.has(logo))
        throw new MinkToolInputError(
          "The logo must be an exact image from this store's Media Library or catalogue.",
        );
    }
  }
  if (
    ["page_create", "page_update", "page_publish"].includes(patch.operation) &&
    record(plan.next)
  ) {
    const proposed = plan.next.sections as PageSectionItem[];
    const current = s.target.page?.sections ?? [];
    const onPage = collectSectionMediaUrls(current);
    const candidates = collectSectionMediaUrls(proposed).filter(
      (url) => !onPage.includes(url),
    );
    const owned = await selectOwnedStorefrontImageUrls(
      db,
      actor.storeId,
      candidates,
    );
    const issues = assertLayoutMediaIsOwned(proposed, [...onPage, ...owned]);
    if (issues.length) throw new MinkToolInputError(issues.join(" "));
    if (typeof plan.next.slug === "string") {
      const [clash] = await db
        .select({ id: storePages.id })
        .from(storePages)
        .where(
          and(
            eq(storePages.storeId, actor.storeId),
            eq(storePages.slug, plan.next.slug),
          ),
        )
        .limit(1);
      if (clash && clash.id !== s.target.page?.id)
        throw new MinkToolInputError("Another page already uses that slug.");
    }
  }
  return plan;
}
export async function createMinkBuilderProposal(
  actor: MinkActorContext,
  raw: unknown,
  explanation: unknown,
): Promise<Extract<MinkArtifact, { type: "builder_proposal" }>> {
  authority(actor, true);
  if (
    typeof explanation !== "string" ||
    !explanation.trim() ||
    explanation.length > 1000
  )
    throw new MinkToolInputError(
      "Explain the requested Builder change in 1–1000 characters.",
    );
  let patch: BuilderPatch;
  try {
    patch = readBuilderPatch(raw);
  } catch (error) {
    throw new MinkToolInputError((error as Error).message);
  }
  const plan = await withService(async (db) => {
    const s = await state(db, actor, patch.operation, patch.pageSlug);
    return validatePlan(db, actor, patch, s);
  });
  const stored = await createMinkDraftProposal({
    actor,
    kind: "website_builder",
    title: "Website Builder changes",
    destinationType: "website_builder",
    destinationLabel: patch.operation.replaceAll("_", " "),
    destinationPath: "/dashboard/builder",
    before: {
      patch_digest: builderDigest(patch),
      patch_json: JSON.stringify(patch),
      explanation: "Exact Builder request before approval.",
    },
    content: {
      patch_digest: builderDigest(patch),
      patch_json: JSON.stringify(patch),
      explanation: explanation.trim(),
    },
  });
  if (stored.type !== "proposal")
    throw Error("Builder proposal persistence failed.");
  return {
    type: "builder_proposal",
    draftId: stored.draftId,
    title: stored.title,
    operation: patch.operation,
    pageSlug: patch.pageSlug,
    explanation: explanation.trim(),
    changes: plan.changes,
    live: plan.live,
    expectedCredits: stored.expectedCredits,
    chargedCredits: stored.chargedCredits,
    creditSource: stored.creditSource,
  };
}
async function ownedDraft(db: Db, actor: MinkActorContext, id: string) {
  const [draft] = await db
    .select()
    .from(minkDrafts)
    .where(
      and(
        eq(minkDrafts.id, id),
        eq(minkDrafts.storeId, actor.storeId),
        eq(minkDrafts.adminId, actor.adminId),
      ),
    )
    .limit(1);
  if (
    !draft ||
    draft.kind !== "website_builder" ||
    draft.currentVersion !== 0 ||
    draft.status !== "proposed"
  )
    throw new MinkRequestError(
      "mink_builder_draft",
      "This Builder proposal is unavailable.",
      404,
    );
  if (
    !record(draft.contentJson) ||
    typeof draft.contentJson.patch_json !== "string"
  )
    throw new MinkRequestError(
      "mink_builder_invalid",
      "This proposal is invalid.",
      400,
    );
  const patch = readBuilderPatch(JSON.parse(draft.contentJson.patch_json));
  if (builderDigest(patch) !== draft.contentJson.patch_digest)
    throw new MinkRequestError(
      "mink_builder_integrity",
      "This proposal failed integrity validation.",
      400,
    );
  return { draft, patch };
}
export async function readMinkBuilderReview(
  actor: MinkActorContext,
  id: string,
) {
  authority(actor, true);
  return withService(async (db) => {
    const { draft, patch } = await ownedDraft(db, actor, id);
    const [done] = await db
      .select({
        id: minkActionApprovals.id,
        outcome: minkActionApprovals.status,
        resultId: minkActionApprovals.resultId,
      })
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.draftId, id),
          eq(minkActionApprovals.toolName, TOOL),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .limit(1);
    if (done)
      return {
        executed: true as const,
        approvalId: done.id,
        operation: patch.operation,
        publication: await publicationStatus(db, actor, patch, done.resultId),
      };
    const s = await state(db, actor, patch.operation, patch.pageSlug);
    let plan: BuilderPlan;
    try {
      plan = await validatePlan(db, actor, patch, s);
    } catch (error) {
      throw new MinkRequestError(
        "mink_builder_conflict",
        (error as Error).message,
        409,
      );
    }
    return {
      executed: false as const,
      operation: patch.operation,
      changes: plan.changes,
      live: plan.live,
      explanation: record(draft.contentJson)
        ? String(draft.contentJson.explanation ?? "")
        : "",
      patchDigest: builderDigest(patch),
      codeChecks: plan.codeChecks,
    };
  });
}

function draftMatchesLive(target: BuilderTarget): boolean | null {
  if (target.chrome)
    return (
      !!target.liveChrome &&
      builderDigest(normalizeChrome(target.chrome)) ===
        builderDigest(target.liveChrome)
    );
  if (target.page)
    return (
      target.page.status === "published" &&
      builderDigest(target.page.sections) ===
        builderDigest(target.page.publishedSections)
    );
  return null;
}

/** Read-only handoff after a save. Publication still needs a fresh exact proposal. */
async function publicationStatus(
  db: Db,
  actor: MinkActorContext,
  saved: BuilderPatch,
  resultId: string | null,
) {
  const operation = ["chrome_update", "chrome_revert"].includes(saved.operation)
    ? "chrome_publish"
    : ["page_create", "page_update", "page_revert"].includes(saved.operation)
      ? "page_publish"
      : null;
  if (!operation) return null;
  let pageSlug =
    typeof saved.changes.slug === "string"
      ? saved.changes.slug || "home"
      : saved.pageSlug;
  // Follow the approved page's identity across later renames. Never mistake
  // a replacement page using the old slug for the page this card saved.
  if (operation === "page_publish") {
    const [page] = resultId
      ? await db
          .select({ slug: storePages.slug })
          .from(storePages)
          .where(
            and(
              eq(storePages.id, resultId),
              eq(storePages.storeId, actor.storeId),
            ),
          )
          .limit(1)
      : [];
    if (!page)
      return {
        operation,
        pageSlug,
        status: "blocked" as const,
        blockers: [
          "This page no longer exists. Choose the page you want to publish in Website Builder.",
        ],
      };
    pageSlug = page.slug || "home";
  }
  const s = await state(db, actor, operation, pageSlug);
  const target = s.target;
  const result = {
    operation,
    pageSlug: target.pageSlug,
    blockers: [] as string[],
  };
  if (draftMatchesLive(target)) return { ...result, status: "live" as const };
  if (target.chrome) {
    const known = await destinations(db, actor.storeId);
    const issues = navigationIssues(
      target.chrome,
      known.categories,
      known.pages,
    );
    if (issues.length)
      return {
        ...result,
        status: "blocked" as const,
        blockers: issues.map(
          (issue) =>
            `${issue.path.startsWith("header.") ? "Header" : "Footer"} link “${issue.label}” (${issue.href}): ${issue.message}${issue.suggestedHref ? ` Suggested destination: ${issue.suggestedHref}.` : ""}`,
        ),
      };
  }
  try {
    await validatePlan(
      db,
      actor,
      {
        operation,
        pageSlug: target.pageSlug,
        expectedDigest: builderDigest(target),
        changes: {},
      },
      s,
    );
    return { ...result, status: "ready" as const };
  } catch (error) {
    if (!(error instanceof MinkToolInputError)) throw error;
    return { ...result, status: "blocked" as const, blockers: [error.message] };
  }
}

/** Human-only approval: exact stored proposal, resource lock, fresh permissions, atomic audit/write. */
export async function approveMinkBuilderProposal(
  actor: MinkActorContext,
  id: string,
  idempotencyKey: string,
  browserChecks: unknown,
) {
  authority(actor, true);
  return withService(async (db) => {
    // Serialize approvals and settings changes; lock existing domain rows too.
    // Inserts use conflict rejection because ordinary Builder saves may create
    // an absent page/chrome row without taking the store lock.
    await db.execute(
      sql`select id from stores where id=${actor.storeId}::uuid for update`,
    );
    await db.execute(
      sql`select id from mink_drafts where id=${id}::uuid and store_id=${actor.storeId}::uuid and admin_id=${actor.adminId} for update`,
    );
    const { draft, patch } = await ownedDraft(db, actor, id);
    const [done] = await db
      .select({
        id: minkActionApprovals.id,
        resultId: minkActionApprovals.resultId,
      })
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.draftId, id),
          eq(minkActionApprovals.toolName, TOOL),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .limit(1);
    if (done)
      return {
        approvalId: done.id,
        operation: patch.operation,
        pageSlug: patch.pageSlug,
        resultId: done.resultId,
        repeated: true,
      };
    const [gate] = await db
      .select({ enabled: minkActionToolAccess.enabled })
      .from(minkActionToolAccess)
      .where(
        and(
          eq(minkActionToolAccess.storeId, actor.storeId),
          eq(minkActionToolAccess.toolName, TOOL),
        ),
      )
      .for("update")
      .limit(1);
    if (!gate?.enabled)
      throw new MinkRequestError(
        "mink_builder_disabled",
        "Website Builder actions are unavailable.",
        403,
      );
    await db.execute(
      sql`select store_id from store_menus where store_id=${actor.storeId}::uuid for update`,
    );
    await db.execute(
      sql`select store_id from store_chrome where store_id=${actor.storeId}::uuid for update`,
    );
    await db.execute(
      sql`select id from store_pages where store_id=${actor.storeId}::uuid and slug=${patch.pageSlug === "home" ? "" : patch.pageSlug} for update`,
    );
    const s = await state(db, actor, patch.operation, patch.pageSlug);
    let plan: BuilderPlan;
    try {
      plan = await validatePlan(db, actor, patch, s);
    } catch (error) {
      throw new MinkRequestError(
        "mink_builder_conflict",
        (error as Error).message,
        409,
      );
    }
    if (plan.codeChecks.length) {
      if (!record(browserChecks))
        throw new MinkRequestError(
          "mink_builder_checks",
          "Complete desktop and mobile code checks before publishing.",
          400,
        );
      try {
        for (const code of plan.codeChecks)
          validateMinkStorefrontBrowserValidation({
            value: browserChecks[code.id],
            patchDigest: builderDigest(patch),
          });
      } catch (error) {
        throw new MinkRequestError(
          "mink_builder_checks",
          (error as Error).message,
          400,
        );
      }
    }
    const [usedKey] = await db
      .select({ id: minkActionApprovals.id })
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (usedKey)
      throw new MinkRequestError(
        "mink_builder_reused_key",
        "This approval key was already used for another change. Reload the card.",
        409,
      );
    const now = new Date().toISOString();
    const approvalId = crypto.randomUUID();
    const beforeJson = { target: s.target };
    const afterJson = {
      patch,
      next: plan.next,
      browserChecks: plan.codeChecks.length ? browserChecks : null,
    };
    const requestHash = builderDigest({
      storeId: actor.storeId,
      adminId: actor.adminId,
      draftId: id,
      draftVersion: 0,
      beforeJson,
      afterJson,
      toolVersion: VERSION,
    });
    await db.insert(minkActionApprovals).values({
      id: approvalId,
      storeId: actor.storeId,
      adminId: actor.adminId,
      draftId: id,
      resourceType: "website_builder",
      resourceId: actor.storeId,
      toolName: TOOL,
      operation: "apply",
      draftVersion: 0,
      beforeJson,
      afterJson,
      requestHash,
      idempotencyKey,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    });
    const resultId = await writePlan(db, actor, patch, s, plan, now);
    await db
      .update(minkActionApprovals)
      .set({
        status: "executed",
        approvedAt: now,
        executedAt: now,
        resultId,
        resultVersion: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkActionApprovals.id, approvalId),
          eq(minkActionApprovals.storeId, actor.storeId),
        ),
      );
    await db.insert(minkActionAudit).values({
      approvalId,
      storeId: actor.storeId,
      adminId: actor.adminId,
      draftId: draft.id,
      resourceType: "website_builder",
      resourceId: actor.storeId,
      resultId,
      toolName: TOOL,
      operation: "apply",
      outcome: "executed",
      beforeJson,
      afterJson,
      requestHash,
      toolVersion: VERSION,
      detail: `Approved Website Builder ${patch.operation} (${plan.live ? "live storefront" : "private draft"}).`,
    });
    return {
      approvalId,
      operation: patch.operation,
      pageSlug: patch.pageSlug,
      resultId,
      repeated: false,
    };
  });
}
async function writePlan(
  db: Db,
  actor: MinkActorContext,
  patch: BuilderPatch,
  s: Awaited<ReturnType<typeof state>>,
  plan: BuilderPlan,
  now: string,
): Promise<string> {
  const op = patch.operation;
  if (op.startsWith("chrome_")) {
    const value = sanitizeChromeForSave(plan.next);
    if (op === "chrome_publish")
      await db
        .update(storeChrome)
        .set({ published: value, publishedAt: now, updatedAt: now })
        .where(eq(storeChrome.storeId, actor.storeId));
    else if (s.target.exists)
      await db
        .update(storeChrome)
        .set({ draft: value, updatedAt: now })
        .where(eq(storeChrome.storeId, actor.storeId));
    else {
      const inserted = await db
        .insert(storeChrome)
        .values({ storeId: actor.storeId, draft: value, updatedAt: now })
        .onConflictDoNothing({ target: storeChrome.storeId })
        .returning({ storeId: storeChrome.storeId });
      if (!inserted.length)
        throw new MinkRequestError(
          "mink_builder_conflict",
          "A header/footer draft was created while approving. Request a fresh proposal.",
          409,
        );
    }
    return actor.storeId;
  }
  if (op === "brand_update") {
    const brand = record(s.settings.brand) ? s.settings.brand : {};
    await db
      .update(stores)
      .set({
        settings: { ...s.settings, brand: { ...brand, ...patch.changes } },
      })
      .where(eq(stores.id, actor.storeId));
    return actor.storeId;
  }
  if (op === "settings_update") {
    const features = record(s.settings.features) ? s.settings.features : {};
    await db
      .update(stores)
      .set({
        settings: {
          ...s.settings,
          features: {
            ...features,
            "pages.customCode": patch.changes["pages.customCode"],
          },
        },
      })
      .where(eq(stores.id, actor.storeId));
    return actor.storeId;
  }
  if (op === "page_create") {
    const value = plan.next as Pick<
      BuilderPage,
      | "slug"
      | "title"
      | "seoTitle"
      | "seoDescription"
      | "seoNoindex"
      | "sections"
    >;
    const [created] = await db
      .insert(storePages)
      .values({
        storeId: actor.storeId,
        ...value,
        createdBy: actor.adminId,
        updatedBy: actor.adminId,
      })
      .onConflictDoNothing({ target: [storePages.storeId, storePages.slug] })
      .returning({ id: storePages.id });
    if (!created)
      throw new MinkRequestError(
        "mink_builder_conflict",
        "Another page already uses that slug. Request a fresh proposal.",
        409,
      );
    return created.id;
  }
  const page = s.target.page!;
  const where = and(
    eq(storePages.storeId, actor.storeId),
    eq(storePages.id, page.id),
  );
  if (op === "page_delete") await db.delete(storePages).where(where);
  else {
    const data =
      op === "page_update"
        ? (plan.next as Record<string, unknown>)
        : op === "page_publish"
          ? {
              publishedSections: (plan.next as { sections: unknown }).sections,
              sections: (plan.next as { sections: unknown }).sections,
              status: "published",
              publishedAt: now,
            }
          : op === "page_unpublish"
            ? { status: "draft" }
            : { sections: plan.next };
    await db
      .update(storePages)
      .set({ ...data, updatedAt: now, updatedBy: actor.adminId })
      .where(where);
  }
  return page.id;
}
