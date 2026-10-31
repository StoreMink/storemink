import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import {
  themeCatalogAudit,
  themeCatalogEntries,
  themeReleases,
  themeStudioAcceptanceRuns,
  themeStudioAssets,
  themeStudioProjects,
  themeStudioPublications,
  themeStudioVersions,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { isBlockedUploadError } from "@/lib/moderation/upload-guard";
import { gcsConfigured, gcsPathFromUrl, gcsPublicUrl } from "@/lib/storage/gcs";
import { writeStoreObject } from "@/lib/storage/store-objects";
import { STORE_TAG } from "@/lib/store/resolve";
import { subdomainOrigin } from "@/lib/store/host";
import { TAGS } from "@/lib/storefront/tags";
import { applyThemeDefinition } from "@/lib/themes/apply";
import {
  NotADemoStoreError,
  upsertDemoStoreRow,
} from "@/lib/themes/demo-store";
import {
  THEME_REGISTRY_TAG,
  insertThemeReleaseWithDb,
  loadExactReleaseWithDb,
  type RuntimeThemeRelease,
} from "@/lib/themes/runtime-registry";
import type { ThemeCatalogVisibility } from "@/lib/themes/meta";
import type { ThemeStudioActor } from "./access";
import { renderedWithTheme } from "./acceptance-gates";
import { publishEvidenceWithDb, type PublishEvidenceGap } from "./acceptance";
import { fetchInternalPageWithRetry } from "./acceptance-http";
import { queueThemeStudioRecheck } from "./capture";
import { getThemeStudioConfig } from "./config";
import { validateThemePackageV2, type ThemePackageV2 } from "./contracts";
import { SEVERITY_RULES_VERSION } from "./finding-severity";
import {
  buildPublishedPackage,
  nextReleaseVersion,
  publicationBlockers,
  publicationWarningLog,
  releaseDate,
  validateCatalogChange,
  type PublicationWarning,
} from "./publication-core";
import { isUuid, recordThemeStudioEvent, ThemeStudioError } from "./repository";

export type { PublicationWarning } from "./publication-core";
export type { PublishEvidenceGap } from "./acceptance";

// ---------------------------------------------------------------------------
// Mink AI Theme Studio: publication and rollback.
//
// ONE STEP, NO SECOND PERSON. A superadmin publishes a theme that is Ready to
// publish (`candidate`): its checks and its design review passed, serious
// problems were fixed or stopped it on the way, and the warnings it still
// carries go live with it, recorded with the severity rule version on the
// publish events ("Fix it, then allow Publish", owner, 23 Oct 2026).
//
// Order of publication (docs/mink-ai-theme-studio-plan.md §8):
//   1. lock the project and the theme id; re-read the current version and
//      refuse a package that could never be published;
//   2. ask `publishEvidenceWithDb` (acceptance.ts) whether the newest check
//      run passed on TODAY's build with a passed design review bound to it.
//      If not, write nothing: once that read has committed,
//      `queueThemeStudioRecheck` (capture.ts) measures the design again on
//      today's build in the capture job, in its own short transaction, never
//      inside this one, and Publish answers `rechecking` (owner decision 4).
//      Old browser evidence never publishes, and nothing here writes an
//      acceptance row. "Try again" on a publish that did not finish follows
//      the same rule;
//   3. allocate a release version without overwriting (or resume the one a
//      failed attempt of the same version stored) and write the attempt row;
//   4. copy every slot image to the public release prefix, through
//      `writeStoreObject` (a release object belongs to no store), so bytes
//      StoreMink has blocked are refused here as everywhere else;
//   5. write the immutable theme_releases row;
//   6. seed demo-{theme} and render its surfaces, with zero errors;
//   7. only then point the catalog at the release, public, and mark the
//      project published, with an audit row, in one transaction;
//   8. invalidate the registry, store and storefront caches.
//
// ★ EXPOSURE IS THE LAST STEP. A release row nobody points at is invisible to
// signup and the public catalog, so a failed demo leaves nothing a merchant
// can see, and a retry resumes the same release instead of allocating a new
// one.
//
// ★ ROLLBACK NEVER TOUCHES AN INSTALLED STORE. Hiding or re-pointing changes
// only what NEW stores may install; every store pins its own theme id and
// version, and an exact pin keeps resolving while the release is published.
// ---------------------------------------------------------------------------

export interface PublicationDeps {
  /** Copy one image to public storage. Must be idempotent for a path. The
   * context names the operator publishing, for the record of a refusal. */
  storeObject(
    objectPath: string,
    bytes: Uint8Array,
    contentType: string,
    context?: { actor?: string | null },
  ): Promise<void>;
  publicUrl(objectPath: string): string;
  /** Render the demo's surfaces; returns what was wrong, empty when clean. */
  checkDemo(input: { host: string; paths: string[] }): Promise<string[]>;
  now(): Date;
}

const DEMO_PAGE_TIMEOUT_MS = 60_000;

async function defaultCheckDemo(input: {
  host: string;
  paths: string[];
}): Promise<string[]> {
  const problems: string[] = [];
  for (const path of input.paths) {
    const page = await fetchInternalPageWithRetry({
      host: input.host,
      path,
      cookies: {},
      timeoutMs: DEMO_PAGE_TIMEOUT_MS,
    });
    if (page.status !== 200) {
      problems.push(
        `${path} answered ${page.status ?? page.error ?? "nothing"}.`,
      );
    } else if (!renderedWithTheme(page.body)) {
      problems.push(`${path} did not render with the theme.`);
    }
  }
  return problems;
}

/**
 * The Cache-Control of a published release image (takedown decision D4).
 * The path names the release and the image's digest, so the bytes never
 * change while the image is allowed; but a block replaces the image at its
 * address, and a year in Google's storage cache would keep serving the
 * original to anyone who asks for that address. A minute bounds it.
 */
export const RELEASE_IMAGE_CACHE_CONTROL = "public, max-age=60";

const defaultDeps: PublicationDeps = {
  async storeObject(objectPath, bytes, contentType, context) {
    // A theme release belongs to no store: `storeId` is null, and the
    // re-upload guard refuses bytes StoreMink has blocked.
    await writeStoreObject(objectPath, bytes, contentType, {
      storeId: null,
      cacheControl: RELEASE_IMAGE_CACHE_CONTROL,
      via: "theme_studio_publication",
      actor: context?.actor ?? null,
    });
  },
  publicUrl: gcsPublicUrl,
  checkDemo: defaultCheckDemo,
  now: () => new Date(),
};

/** An attempt still `publishing` this long after its last write was
 * abandoned (the instance was recycled mid-publication) and may be retried. */
const ABANDONED_ATTEMPT_MINUTES = 15;

// ------------------------------------------------------------------ helpers

async function lockProject(db: Db, projectId: string) {
  const rows = await db
    .select()
    .from(themeStudioProjects)
    .where(eq(themeStudioProjects.id, projectId))
    .for("update")
    .limit(1);
  const project = rows[0];
  if (!project) {
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  }
  return project;
}

async function lockThemeId(db: Db, themeId: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`theme-publication:${themeId}`}))`,
  );
}

function expireCaches() {
  // Immediate expiry, not stale-while-revalidate: publication reads its own
  // writes (the demo check renders the release it just stored), and an
  // operator who hides a theme expects the next signup to stop offering it.
  for (const tag of [
    THEME_REGISTRY_TAG,
    STORE_TAG,
    TAGS.pages,
    TAGS.products,
    TAGS.categories,
    TAGS.chrome,
  ]) {
    revalidateTag(tag, { expire: 0 });
  }
}

// -------------------------------------------------------------- publication

interface BegunAttempt {
  attemptId: string;
  themeId: string;
  releaseVersion: string;
  versionId: string;
  versionNumber: number;
  draft: ThemePackageV2;
  resumedReleaseId: string | null;
  accepted: PublishAcceptance;
}

/**
 * What a publish went ahead on, as both publish events record it: the check
 * run, its design review (or that the automatic checks were off, the
 * labelled exception), the severity rules that decided what is a warning,
 * and the warnings it accepted. Small and content-free (an event's detail is
 * capped at 4 KiB): kinds and counts, never messages or places.
 */
interface PublishAcceptance {
  acceptanceRunId: string;
  /** The rules that decided which findings are warnings (this code's). */
  severityRules: string;
  /** The rules the run was measured under; null on a run from before them. */
  measuredUnder: string | null;
  designReview: "passed" | "not_configured";
  designReviewId: string | null;
  warnings: ReturnType<typeof publicationWarningLog>;
}

type BeginResult =
  | { kind: "attempt"; attempt: BegunAttempt }
  | {
      /** Nothing was written: the design must be measured again first. */
      kind: "recheck";
      versionId: string;
      revision: number;
      reason: PublishEvidenceGap;
    };

async function beginAttempt(
  actor: ThemeStudioActor,
  input: {
    projectId: string;
    expectedRevision: number;
  },
): Promise<BeginResult> {
  return withService(async (db): Promise<BeginResult> => {
    const project = await lockProject(db, input.projectId);
    if (project.revision !== input.expectedRevision) {
      throw new ThemeStudioError(
        "stale",
        "This project changed in another tab. Reload to see it.",
      );
    }
    // ONE STEP: a candidate (Ready to publish) is published directly.
    // `approved` remains only as the state a publish that did not finish
    // waits in, so "Try again" resumes it rather than starting over. The
    // database still refuses `approved` without passing evidence and
    // `published` without a publication (migration 0151).
    if (project.status !== "candidate" && project.status !== "approved") {
      throw new ThemeStudioError(
        "illegal_state",
        "Only a theme whose checks have passed can be published.",
      );
    }
    await lockThemeId(db, project.themeId);
    const fromCandidate = project.status === "candidate";

    const [version] = project.currentVersionId
      ? await db
          .select()
          .from(themeStudioVersions)
          .where(eq(themeStudioVersions.id, project.currentVersionId))
          .limit(1)
      : [];
    const parsed = validateThemePackageV2(version?.packageJson);
    if (!version || !parsed.ok) {
      throw new ThemeStudioError(
        "illegal_state",
        "The version being published no longer passes its contract.",
      );
    }
    // A package that could never be published is refused before anything
    // is measured again: a re-check cannot fix it.
    const refused = publicationBlockers(parsed.value).blocking;
    if (refused.length > 0) {
      throw new ThemeStudioError("illegal_state", refused[0]);
    }

    const attempts = await db
      .select()
      .from(themeStudioPublications)
      .where(eq(themeStudioPublications.projectId, project.id))
      .orderBy(desc(themeStudioPublications.createdAt));
    if (attempts.some((a) => a.status === "published")) {
      throw new ThemeStudioError(
        "illegal_state",
        "This project is already published.",
      );
    }
    const active = attempts.find((a) => a.status === "publishing");
    if (
      active &&
      Date.now() - Date.parse(active.updatedAt) <
        ABANDONED_ATTEMPT_MINUTES * 60_000
    ) {
      throw new ThemeStudioError(
        "illegal_state",
        "A publication is already in progress.",
      );
    }

    // Owner decision 4: only a check run from TODAY's build, with a passed
    // design review bound to that very run, publishes. A first publish and a
    // retry alike: old browser evidence is never published.
    const evidence = await publishEvidenceWithDb(db, project);
    if (!evidence.ok) {
      // With the automatic checks off (local development) nothing can
      // measure it again here; the in-browser runner is the way.
      if (!getThemeStudioConfig().autoQaEnabled) {
        throw new ThemeStudioError("stale", evidence.detail);
      }
      return {
        kind: "recheck",
        versionId: version.id,
        revision: project.revision,
        reason: evidence.reason,
      };
    }
    const { warnings } = publicationBlockers(parsed.value, {
      gates: evidence.gates,
      review: evidence.review?.severity ?? null,
    });
    const accepted: PublishAcceptance = {
      acceptanceRunId: evidence.acceptanceRunId,
      severityRules: SEVERITY_RULES_VERSION,
      measuredUnder: evidence.severityRules,
      designReview: evidence.review ? "passed" : "not_configured",
      designReviewId: evidence.review?.id ?? null,
      warnings: publicationWarningLog(warnings),
    };

    if (active) {
      await db
        .update(themeStudioPublications)
        .set({
          status: "failed",
          completedAt: sql`now()`,
          failure: ["The attempt was abandoned before it finished."],
        })
        .where(eq(themeStudioPublications.id, active.id));
    }
    if (fromCandidate) {
      // Freeze the version for publication. Same transaction as the attempt
      // row, so a refusal below leaves the project a candidate. No
      // `project_approved` event any more: one click is one Activity line,
      // `publication_started` (the events rule still allows old rows).
      await db
        .update(themeStudioProjects)
        .set({ status: "approved", revision: project.revision + 1 })
        .where(eq(themeStudioProjects.id, project.id));
    }

    // Resume the release an earlier attempt of THIS version already stored:
    // the row is immutable, and rebuilding it on another day would change its
    // release date, and so its digest, and collide with itself.
    const resumable = attempts.find(
      (a) => a.versionId === version.id && a.releaseId,
    );
    let releaseVersion: string;
    if (resumable) {
      releaseVersion = resumable.releaseVersion;
    } else {
      const existing = await db
        .select({ version: themeReleases.version })
        .from(themeReleases)
        .where(eq(themeReleases.themeId, project.themeId));
      releaseVersion = nextReleaseVersion(existing.map((r) => r.version));
    }

    const [attempt] = await db
      .insert(themeStudioPublications)
      .values({
        projectId: project.id,
        versionId: version.id,
        acceptanceRunId: evidence.acceptanceRunId,
        themeId: project.themeId,
        releaseVersion,
        releaseId: resumable?.releaseId ?? null,
        manifestDigest: resumable?.manifestDigest ?? null,
        createdBy: actor.id,
        createdByEmail: actor.email,
      })
      .returning({ id: themeStudioPublications.id });
    await recordThemeStudioEvent(db, {
      projectId: project.id,
      actor,
      eventType: "publication_started",
      detail: {
        publicationId: attempt.id,
        versionId: version.id,
        releaseVersion,
        resumed: Boolean(resumable),
        ...accepted,
      },
    });
    return {
      kind: "attempt",
      attempt: {
        attemptId: attempt.id,
        themeId: project.themeId,
        releaseVersion,
        versionId: version.id,
        versionNumber: version.versionNumber,
        draft: parsed.value,
        resumedReleaseId: resumable?.releaseId ?? null,
        accepted,
      },
    };
  });
}

class PublicationFailure extends Error {
  constructor(readonly problems: string[]) {
    super(problems[0] ?? "Publication failed.");
    this.name = "PublicationFailure";
  }
}

async function failAttempt(
  actor: ThemeStudioActor,
  attempt: BegunAttempt,
  projectId: string,
  problems: string[],
): Promise<void> {
  const failure = problems.slice(0, 20).map((p) => p.slice(0, 500));
  await withService(async (db) => {
    await db
      .update(themeStudioPublications)
      .set({ status: "failed", completedAt: sql`now()`, failure })
      .where(
        and(
          eq(themeStudioPublications.id, attempt.attemptId),
          eq(themeStudioPublications.status, "publishing"),
        ),
      );
    await recordThemeStudioEvent(db, {
      projectId,
      actor,
      eventType: "publication_failed",
      detail: { publicationId: attempt.attemptId, problems: failure },
    });
  });
}

/** Copy every image the release names to its public object, checking the
 * stored bytes against the digest the package declares. */
async function promoteImages(
  deps: PublicationDeps,
  projectId: string,
  pkg: ThemePackageV2,
  actor: ThemeStudioActor,
): Promise<void> {
  const wanted = pkg.assets.map((asset) => ({
    asset,
    objectPath: gcsPathFromUrl(asset.path) ?? objectPathFromUrl(asset.path),
  }));
  const digests = pkg.assets
    .map((a) => a.sha256)
    .filter((s): s is string => Boolean(s));
  const rows = await withService((db) =>
    db
      .select({
        sha256: themeStudioAssets.sha256,
        mediaType: themeStudioAssets.mediaType,
        bytes: themeStudioAssets.bytes,
      })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, projectId),
          eq(themeStudioAssets.purpose, "image"),
          inArray(themeStudioAssets.sha256, digests),
        ),
      ),
  );
  const bySha = new Map(rows.map((row) => [row.sha256, row]));
  const problems: string[] = [];
  for (const { asset, objectPath } of wanted) {
    const row = asset.sha256 ? bySha.get(asset.sha256) : undefined;
    if (!objectPath) {
      problems.push(`Image ${asset.id} has no release address.`);
      continue;
    }
    if (!row) {
      problems.push(`Image ${asset.id} has no stored operator image.`);
      continue;
    }
    const actual = createHash("sha256").update(row.bytes).digest("hex");
    if (actual !== asset.sha256) {
      problems.push(`Image ${asset.id}'s stored bytes do not match it.`);
      continue;
    }
    if (row.mediaType !== "image/webp") {
      problems.push(`Image ${asset.id} is not WebP.`);
      continue;
    }
    try {
      await deps.storeObject(objectPath, row.bytes, row.mediaType, {
        actor: actor.email,
      });
    } catch (error) {
      if (isBlockedUploadError(error)) {
        // The guard recorded the refusal. A theme release is never told
        // apart from any other refusal (told is false), and the merchant's
        // sentence sends them to support, which is us: the operator gets
        // the block itself to look up instead.
        problems.push(
          `Image ${asset.id} is a file StoreMink has blocked (block ${error.blockId}), so it can't be published. Replace the image, then publish again.`,
        );
        continue;
      }
      logError("theme studio: publishing an image failed", error, {
        assetId: asset.id,
      });
      problems.push(`Image ${asset.id} could not be copied to storage.`);
    }
  }
  if (problems.length > 0) throw new PublicationFailure(problems);
}

/** The in-bucket path of a published image URL, for any bucket host the
 * injected storage uses (the real parser only knows the configured bucket). */
function objectPathFromUrl(url: string): string | null {
  const match = /\/(theme-releases\/[^?#]+)$/.exec(url);
  return match && !match[1].split("/").includes("..") ? match[1] : null;
}

async function storeRelease(
  actor: ThemeStudioActor,
  deps: PublicationDeps,
  projectId: string,
  attempt: BegunAttempt,
): Promise<RuntimeThemeRelease> {
  if (attempt.resumedReleaseId) {
    const release = await withService((db) =>
      loadExactReleaseWithDb(db, attempt.themeId, attempt.releaseVersion),
    );
    if (!release || release.id !== attempt.resumedReleaseId) {
      throw new PublicationFailure([
        "The release an earlier attempt stored no longer validates.",
      ]);
    }
    await promoteImages(deps, projectId, release.package, actor);
    return release;
  }
  const built = buildPublishedPackage(attempt.draft, {
    version: attempt.releaseVersion,
    releasedAt: releaseDate(deps.now()),
    sourceVersionNumber: attempt.versionNumber,
    publicUrl: deps.publicUrl,
  });
  if (!built.ok) throw new PublicationFailure([built.error]);
  await promoteImages(deps, projectId, built.value.pkg, actor);
  return withService(async (db) => {
    const { release } = await insertThemeReleaseWithDb(db, {
      package: built.value.pkg,
      source: "theme-studio",
      actorId: actor.id,
    });
    await db
      .update(themeStudioPublications)
      .set({ releaseId: release.id, manifestDigest: release.manifestDigest })
      .where(eq(themeStudioPublications.id, attempt.attemptId));
    return release;
  });
}

/** Create or reset demo-{theme} and seed it from the exact release. */
async function seedDemo(
  release: RuntimeThemeRelease,
): Promise<{ storeId: string; slug: string }> {
  const definition = release.definition;
  const slug = definition.demo.slug;
  const storeId = await withService(async (db) => {
    try {
      return (await upsertDemoStoreRow(db, definition)).storeId;
    } catch (error) {
      if (error instanceof NotADemoStoreError) {
        throw new PublicationFailure([error.message]);
      }
      throw error;
    }
  });
  const seeded = await applyThemeDefinition(storeId, definition, {
    publish: true,
    reset: true,
    publishSampleProducts: true,
  });
  if (!seeded.success) {
    throw new PublicationFailure(
      seeded.errors.map((e) => `Demo seeding: ${e}`),
    );
  }
  return { storeId, slug };
}

function demoPaths(release: RuntimeThemeRelease): string[] {
  const product = release.definition.preset.sampleData?.products[0];
  return ["/", "/shop", ...(product ? [`/shop/${product.slug}`] : []), "/cart"];
}

async function exposeRelease(
  actor: ThemeStudioActor,
  input: { projectId: string },
  attempt: BegunAttempt,
  release: RuntimeThemeRelease,
  demoStoreId: string,
): Promise<void> {
  await withService(async (db) => {
    const project = await lockProject(db, input.projectId);
    await lockThemeId(db, attempt.themeId);
    if (
      project.status !== "approved" ||
      project.currentVersionId !== attempt.versionId
    ) {
      throw new PublicationFailure([
        "The project changed while it was being published.",
      ]);
    }
    const [previous] = await db
      .select()
      .from(themeCatalogEntries)
      .where(eq(themeCatalogEntries.themeId, attempt.themeId))
      .limit(1);
    await db
      .insert(themeCatalogEntries)
      .values({
        themeId: attempt.themeId,
        currentReleaseId: release.id,
        visibility: "public",
        updatedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: themeCatalogEntries.themeId,
        set: {
          currentReleaseId: release.id,
          visibility: "public",
          updatedBy: actor.id,
        },
      });
    await db.insert(themeCatalogAudit).values({
      themeId: attempt.themeId,
      action: "publish",
      releaseId: release.id,
      visibility: "public",
      previousReleaseId: previous?.currentReleaseId ?? null,
      previousVisibility: previous?.visibility ?? null,
      projectId: project.id,
      reason: `Published ${attempt.themeId}@${attempt.releaseVersion} from Theme Studio version ${attempt.versionNumber}.`,
      createdBy: actor.id,
      createdByEmail: actor.email,
    });
    await db
      .update(themeStudioPublications)
      .set({
        status: "published",
        completedAt: sql`now()`,
        demoStoreId,
        releaseId: release.id,
        manifestDigest: release.manifestDigest,
      })
      .where(eq(themeStudioPublications.id, attempt.attemptId));
    await db
      .update(themeStudioProjects)
      .set({ status: "published", revision: project.revision + 1 })
      .where(eq(themeStudioProjects.id, project.id));
    await recordThemeStudioEvent(db, {
      projectId: project.id,
      actor,
      eventType: "theme_published",
      detail: {
        publicationId: attempt.attemptId,
        releaseId: release.id,
        themeId: attempt.themeId,
        releaseVersion: attempt.releaseVersion,
        manifestDigest: release.manifestDigest,
        // What went live with it: the evidence and the warnings accepted.
        ...attempt.accepted,
      },
    });
  });
}

export type PublicationResult =
  | {
      ok: true;
      kind: "published";
      publicationId: string;
      themeId: string;
      releaseVersion: string;
      demoSlug: string;
    }
  | {
      /** The attempt failed after it was written; its reasons are recorded
       * on it, and the same button tries again. */
      ok: false;
      kind: "failed";
      publicationId: string;
      problems: string[];
    }
  | {
      /** Not published: the design is being measured again on today's build
       * first (owner decision 4). No attempt was written. */
      ok: false;
      kind: "rechecking";
      publicationId?: undefined;
      /** One plain sentence saying what happens now. */
      problems: string[];
      captureId: string;
      /** The same version is measured in place (no new design version). */
      inPlace: boolean;
      reason: PublishEvidenceGap;
    };

const RECHECK_STARTED: Record<PublishEvidenceGap, string> = {
  old_build: "StoreMink was updated since this design was checked",
  no_review: "The newest check of this design has no design review of its own",
  none: "No passing check covers this design as it stands",
};

/** What Publish says when it starts a re-check instead of publishing. */
export function recheckStartedMessage(reason: PublishEvidenceGap): string {
  return `${RECHECK_STARTED[reason]}, so it is being checked again on today's build first. That takes about 3 to 5 minutes, and you can leave this page. Publish again once it is ready.`;
}

/**
 * Publish a candidate, or try again on a publish that did not finish. Either
 * way the evidence must be today's (`publishEvidenceWithDb`): if it is not,
 * nothing is published or written here; the design is measured again on
 * today's build (`queueThemeStudioRecheck`, after the read has committed and
 * outside any publish transaction) and the answer is `rechecking`. A refusal
 * before anything is written throws a ThemeStudioError; a failure after the
 * attempt row exists is recorded on it and returned as `failed`, and the
 * project stays `approved` so the same button tries again.
 */
export async function publishThemeStudioProject(
  actor: ThemeStudioActor,
  input: {
    projectId: string;
    expectedRevision: number;
  },
  deps: PublicationDeps = defaultDeps,
): Promise<PublicationResult> {
  if (!isUuid(input.projectId)) {
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  }
  if (deps === defaultDeps && !gcsConfigured) {
    throw new ThemeStudioError(
      "illegal_state",
      "Media storage is not configured, so the theme's images cannot be published.",
    );
  }
  const begun = await beginAttempt(actor, {
    projectId: input.projectId,
    expectedRevision: Number(input.expectedRevision),
  });
  if (begun.kind === "recheck") {
    // Its own short transaction: it moves the project to `generating`
    // (0151 allows that from candidate and approved) and queues one
    // automatic final capture at the repair ceiling, so the design review
    // that follows can never buy a paid restyle. Its revision check refuses
    // it if anything changed since the read above.
    const queued = await queueThemeStudioRecheck(actor, {
      projectId: input.projectId,
      versionId: begun.versionId,
      expectedRevision: begun.revision,
      reason: "publish_recheck",
    });
    return {
      ok: false,
      kind: "rechecking",
      problems: [recheckStartedMessage(begun.reason)],
      captureId: queued.captureId,
      inPlace: queued.inPlace,
      reason: begun.reason,
    };
  }
  const attempt = begun.attempt;
  try {
    const release = await storeRelease(actor, deps, input.projectId, attempt);
    // The demo store renders the release by its exact pin; expire the
    // registry so no earlier miss for that pin is served.
    expireCaches();
    const demo = await seedDemo(release);
    expireCaches();
    const problems = await deps.checkDemo({
      host: new URL(subdomainOrigin(demo.slug)).host,
      paths: demoPaths(release),
    });
    if (problems.length > 0) {
      throw new PublicationFailure(problems.map((p) => `Demo: ${p}`));
    }
    await exposeRelease(actor, input, attempt, release, demo.storeId);
    expireCaches();
    return {
      ok: true,
      kind: "published",
      publicationId: attempt.attemptId,
      themeId: attempt.themeId,
      releaseVersion: attempt.releaseVersion,
      demoSlug: demo.slug,
    };
  } catch (error) {
    const problems =
      error instanceof PublicationFailure
        ? error.problems
        : ["Something went wrong while publishing. Nothing was exposed."];
    if (!(error instanceof PublicationFailure)) {
      logError("theme studio: publication failed", error, {
        publicationId: attempt.attemptId,
      });
    }
    await failAttempt(actor, attempt, input.projectId, problems);
    return {
      ok: false,
      kind: "failed",
      publicationId: attempt.attemptId,
      problems,
    };
  }
}

// ------------------------------------------------------------------ catalog

/**
 * Hide a published Studio theme from new installs, show it again, or point
 * the catalog at another of its published releases. Stores that installed it
 * keep their exact pinned release in every case.
 */
export async function changeThemeStudioCatalog(
  actor: ThemeStudioActor,
  input: { projectId: string; change: unknown },
): Promise<{ changed: boolean }> {
  if (!isUuid(input.projectId)) {
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  }
  const parsed = validateCatalogChange(input.change);
  if (!parsed.ok) throw new ThemeStudioError("invalid_input", parsed.error);
  const change = parsed.value;
  const result = await withService(async (db) => {
    const [publication] = await db
      .select()
      .from(themeStudioPublications)
      .where(
        and(
          eq(themeStudioPublications.projectId, input.projectId),
          eq(themeStudioPublications.status, "published"),
        ),
      )
      .limit(1);
    if (!publication) {
      throw new ThemeStudioError(
        "illegal_state",
        "This project has not published a theme.",
      );
    }
    const themeId = publication.themeId;
    await lockThemeId(db, themeId);
    const [entry] = await db
      .select()
      .from(themeCatalogEntries)
      .where(eq(themeCatalogEntries.themeId, themeId))
      .for("update")
      .limit(1);
    if (!entry) {
      throw new ThemeStudioError(
        "illegal_state",
        "The theme has no catalog entry.",
      );
    }
    let releaseId = entry.currentReleaseId;
    let visibility = entry.visibility as ThemeCatalogVisibility;
    if (change.action === "hide") visibility = "hidden";
    if (change.action === "show") visibility = "public";
    if (change.action === "select_release") {
      const release = await loadExactReleaseWithDb(db, themeId, change.version);
      if (!release || release.status !== "published") {
        throw new ThemeStudioError(
          "not_found",
          "That release does not exist or is not published.",
        );
      }
      releaseId = release.id;
    }
    if (
      releaseId === entry.currentReleaseId &&
      visibility === entry.visibility
    ) {
      return { changed: false };
    }
    if (visibility === "public") {
      const [current] = await db
        .select({ version: themeReleases.version })
        .from(themeReleases)
        .where(eq(themeReleases.id, releaseId))
        .limit(1);
      const release = current
        ? await loadExactReleaseWithDb(db, themeId, current.version)
        : null;
      if (!release || release.definition.demo.status !== "healthy") {
        throw new ThemeStudioError(
          "illegal_state",
          "Only a published release with a healthy demo can be public.",
        );
      }
    }
    await db
      .update(themeCatalogEntries)
      .set({ currentReleaseId: releaseId, visibility, updatedBy: actor.id })
      .where(eq(themeCatalogEntries.themeId, themeId));
    await db.insert(themeCatalogAudit).values({
      themeId,
      action: change.action,
      releaseId,
      visibility,
      previousReleaseId: entry.currentReleaseId,
      previousVisibility: entry.visibility,
      projectId: input.projectId,
      reason: change.reason,
      createdBy: actor.id,
      createdByEmail: actor.email,
    });
    await recordThemeStudioEvent(db, {
      projectId: input.projectId,
      actor,
      eventType:
        change.action === "select_release"
          ? "catalog_release_selected"
          : "catalog_visibility_changed",
      detail: {
        themeId,
        action: change.action,
        releaseId,
        visibility,
        previousVisibility: entry.visibility,
      },
    });
    return { changed: true };
  });
  if (result.changed) expireCaches();
  return result;
}

// --------------------------------------------------------------- read model

export interface ThemeStudioPublicationView {
  id: string;
  status: "publishing" | "published" | "failed";
  releaseVersion: string;
  versionId: string;
  failure: string[];
  createdByEmail: string;
  createdAt: string;
  completedAt: string | null;
}

export interface ThemeStudioCatalogAuditView {
  id: string;
  action: string;
  visibility: string;
  previousVisibility: string | null;
  releaseVersion: string | null;
  reason: string;
  createdByEmail: string;
  createdAt: string;
}

export interface ThemeStudioReleaseState {
  /** The check run Publish would publish on (`publishEvidenceWithDb`), or
   * why there is none on today's build. A published project shows the run
   * it published on. */
  evidence:
    | { ok: true; runId: string; evidenceDigest: string }
    | { ok: false; reason: string };
  /** Why the evidence is not today's (owner decision 4); null when it holds,
   * and for a published project. */
  evidenceGap: PublishEvidenceGap | null;
  /** Publish would measure the design again on today's build first and
   * answer `rechecking`, instead of publishing or refusing: Ready to publish
   * (or a publish that did not finish), automatic checks on, and the
   * evidence not today's. */
  recheckOnPublish: boolean;
  packageDigest: string | null;
  versionNumber: number | null;
  /** What refuses Publish in the package itself. */
  blockers: string[];
  /** The warnings it would go live with, from the check run and design
   * review Publish would use; empty while that evidence does not hold. */
  warnings: PublicationWarning[];
  publications: ThemeStudioPublicationView[];
  catalog: {
    visibility: ThemeCatalogVisibility;
    releaseVersion: string | null;
  } | null;
  publishedReleases: { version: string; createdAt: string }[];
  audit: ThemeStudioCatalogAuditView[];
}

export async function getThemeStudioReleaseState(
  projectId: string,
): Promise<ThemeStudioReleaseState | null> {
  if (!isUuid(projectId)) return null;
  return withService(async (db) => {
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, projectId))
      .limit(1);
    if (!project) return null;
    const [version] = project.currentVersionId
      ? await db
          .select()
          .from(themeStudioVersions)
          .where(eq(themeStudioVersions.id, project.currentVersionId))
          .limit(1)
      : [];
    // A published project's evidence is history: show the run it passed on.
    const evidence =
      project.status === "published"
        ? null
        : await publishEvidenceWithDb(db, project);
    const shownEvidence: ThemeStudioReleaseState["evidence"] = !evidence
      ? await latestPassedRun(db, project.currentVersionId)
      : evidence.ok
        ? {
            ok: true,
            runId: evidence.acceptanceRunId,
            evidenceDigest: evidence.evidenceDigest,
          }
        : { ok: false, reason: evidence.detail };
    const parsed = version ? validateThemePackageV2(version.packageJson) : null;
    const checked = parsed?.ok
      ? publicationBlockers(
          parsed.value,
          evidence?.ok
            ? {
                gates: evidence.gates,
                review: evidence.review?.severity ?? null,
              }
            : {},
        )
      : null;
    const publicationRows = await db
      .select()
      .from(themeStudioPublications)
      .where(eq(themeStudioPublications.projectId, project.id))
      .orderBy(desc(themeStudioPublications.createdAt));
    const [entry] = await db
      .select({
        visibility: themeCatalogEntries.visibility,
        version: themeReleases.version,
      })
      .from(themeCatalogEntries)
      .leftJoin(
        themeReleases,
        eq(themeReleases.id, themeCatalogEntries.currentReleaseId),
      )
      .where(eq(themeCatalogEntries.themeId, project.themeId))
      .limit(1);
    const releases = await db
      .select({
        id: themeReleases.id,
        version: themeReleases.version,
        status: themeReleases.releaseStatus,
        createdAt: themeReleases.createdAt,
      })
      .from(themeReleases)
      .where(eq(themeReleases.themeId, project.themeId))
      .orderBy(desc(themeReleases.createdAt));
    const versionById = new Map(releases.map((r) => [r.id, r.version]));
    const auditRows = await db
      .select()
      .from(themeCatalogAudit)
      .where(eq(themeCatalogAudit.themeId, project.themeId))
      .orderBy(desc(themeCatalogAudit.createdAt))
      .limit(50);
    // Publish refuses before it would re-check: a package that can never be
    // published, or a publish still running (beginAttempt's own order).
    const publishingNow = publicationRows.some(
      (row) =>
        row.status === "publishing" &&
        Date.now() - Date.parse(row.updatedAt) <
          ABANDONED_ATTEMPT_MINUTES * 60_000,
    );
    return {
      evidence: shownEvidence,
      evidenceGap: evidence && !evidence.ok ? evidence.reason : null,
      recheckOnPublish:
        (project.status === "candidate" || project.status === "approved") &&
        evidence !== null &&
        !evidence.ok &&
        getThemeStudioConfig().autoQaEnabled &&
        (checked?.blocking.length ?? 1) === 0 &&
        !publishingNow,
      packageDigest: version?.packageDigest ?? null,
      versionNumber: version?.versionNumber ?? null,
      blockers: checked?.blocking ?? [],
      warnings: checked?.warnings ?? [],
      publications: publicationRows.map((row) => ({
        id: row.id,
        status: row.status as ThemeStudioPublicationView["status"],
        releaseVersion: row.releaseVersion,
        versionId: row.versionId,
        failure: Array.isArray(row.failure) ? (row.failure as string[]) : [],
        createdByEmail: row.createdByEmail,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
      })),
      catalog: entry
        ? {
            visibility: entry.visibility as ThemeCatalogVisibility,
            releaseVersion: entry.version ?? null,
          }
        : null,
      publishedReleases: releases
        .filter((r) => r.status === "published")
        .map((r) => ({ version: r.version, createdAt: r.createdAt })),
      audit: auditRows.map((row) => ({
        id: row.id,
        action: row.action,
        visibility: row.visibility,
        previousVisibility: row.previousVisibility,
        releaseVersion: versionById.get(row.releaseId) ?? null,
        reason: row.reason,
        createdByEmail: row.createdByEmail,
        createdAt: row.createdAt,
      })),
    };
  });
}

async function latestPassedRun(
  db: Db,
  versionId: string | null,
): Promise<ThemeStudioReleaseState["evidence"]> {
  if (!versionId) return { ok: false, reason: "No current version." };
  const [run] = await db
    .select({
      id: themeStudioAcceptanceRuns.id,
      evidenceDigest: themeStudioAcceptanceRuns.evidenceDigest,
    })
    .from(themeStudioAcceptanceRuns)
    .where(
      and(
        eq(themeStudioAcceptanceRuns.versionId, versionId),
        eq(themeStudioAcceptanceRuns.status, "passed"),
      ),
    )
    .orderBy(
      desc(themeStudioAcceptanceRuns.completedAt),
      desc(themeStudioAcceptanceRuns.createdAt),
    )
    .limit(1);
  return run?.evidenceDigest
    ? { ok: true, runId: run.id, evidenceDigest: run.evidenceDigest }
    : { ok: false, reason: "No passing acceptance run." };
}
