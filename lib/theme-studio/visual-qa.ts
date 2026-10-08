import "server-only";
import { readDistinctnessReport } from "./fingerprint";

import { randomUUID } from "node:crypto";
import { and, count, eq, gt, inArray, like, sql } from "drizzle-orm";
import { buildVisualEvidence } from "./visual-evidence";
import { startWorkerLease, WORKER_LEASE_SECONDS } from "./worker-lease";
import { renewStudioLease } from "./worker-lease-store";
import {
  qaImageIssues,
  imageAssessmentsComplete,
  type QaImageIssue,
} from "./qa-image-issues";
import {
  buildVisualQaRequest,
  parseVisualQaReport,
  VISUAL_QA_PROMPT_VERSION,
  type VisualQaReport,
} from "./visual-qa-request";
import {
  themeStudioAssets,
  themeStudioMessages,
  themeStudioProjects,
  themeStudioRuns,
  themeStudioVersions,
  themeStudioVisualQaRuns,
  themeStudioAcceptanceRuns,
  themeStudioCaptures,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { getThemeStudioConfig, type ThemeStudioProvider } from "./config";
import { createFakeModelClient } from "./fake-provider";
import { createVertexModelClient, getVertexConfig } from "./gemini-vertex";
import { sharedProviderCapacity } from "./provider-capacity-store";
import { resolveThemeStudioModel, type ThemeStudioModelKey } from "./models";
import { THEME_STUDIO_PROMPT_VERSION } from "./prompts";
import type {
  ProviderUsage,
  ThemeStudioContentBlock,
  ThemeStudioModelClient,
} from "./provider";
import { recordThemeStudioEvent } from "./repository";
import {
  currentAcceptanceBuildId,
  verifyCandidateEvidenceWithDb,
} from "./acceptance";
import { readAcceptanceReport, type GateResult } from "./acceptance-gates";
import {
  automaticQaDecision,
  automaticAcceptanceFailures,
} from "./automatic-qa-policy";
import { AUTOMATIC_CAPTURE_MAX_ATTEMPTS } from "./capture-core";
import { repairTargets } from "./targeted-repair";
import { describeSlots } from "./slot-images-core";
import {
  validateThemeIntent,
  validateThemePackageV2,
  type ThemePackageV2,
} from "./contracts";
import {
  automaticImageProvider,
  queueAutomaticImages,
  queueAutomaticCapture,
} from "./automatic-work";
import { generatableSlots } from "./image-generation-core";
import {
  deterministicRepairs,
  qaProgress,
  qaImproved,
  type QaProgress,
} from "./qa-diagnosis";
import { scorecardClearsBar } from "./scorecard";

const QA_LEASE_SECONDS = WORKER_LEASE_SECONDS;
/** Recaptures one version may take because a deploy outdated its evidence.
 * Deploys are finite, but a busy day of them must not keep a project cycling
 * through full browser captures without ever reaching a verdict. */
export const MAX_BUILD_RECAPTURES = 2;
const QA_TIMEOUT_MS = 4 * 60_000;
export {
  VISUAL_QA_PROMPT_VERSION,
  VISUAL_QA_SCHEMA,
  parseVisualQaReport,
  visualQaContext,
  type VisualQaReport,
} from "./visual-qa-request";

type QaRow = typeof themeStudioVisualQaRuns.$inferSelect;

type ClaimedQa = QaRow & {
  projectName: string;
  modelKey: ThemeStudioModelKey;
  packageJson: unknown;
  distinctnessReport: unknown;
  originalBrief: string;
  screenshotAssets: { id: string }[];
};

async function revealFailed(
  db: Db,
  qa: Pick<QaRow, "id" | "projectId" | "versionId">,
  errorCode: string,
  report: Record<string, unknown> = {},
) {
  await db
    .update(themeStudioVisualQaRuns)
    .set({
      status: "failed",
      errorCode,
      visionReport: report,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: sql`now()`,
    })
    .where(eq(themeStudioVisualQaRuns.id, qa.id));
  await db
    .update(themeStudioVersions)
    .set({ visibility: "operator", qaStatus: "failed" })
    .where(eq(themeStudioVersions.id, qa.versionId));
  await db
    .update(themeStudioProjects)
    .set({
      status: "ready",
      currentVersionId: qa.versionId,
      revision: sql`${themeStudioProjects.revision} + 1`,
    })
    .where(
      and(
        eq(themeStudioProjects.id, qa.projectId),
        eq(themeStudioProjects.status, "generating"),
      ),
    );
  await recordThemeStudioEvent(db, {
    projectId: qa.projectId,
    actor: "worker",
    eventType: "auto_qa_failed",
    detail: { qaRunId: qa.id, versionId: qa.versionId, errorCode },
  });
}

/**
 * Close a run whose project stopped generating (cancelled, archived, or moved
 * on by an operator). Only the run is touched: the project is no longer this
 * worker's to change, and revealing its version would contradict whatever the
 * operator did. Releasing the lease is what stops the run being re-claimed and
 * re-judged by a paid vision call on every lease expiry.
 */
async function closeAbandoned(db: Db, qaRunId: string) {
  await db
    .update(themeStudioVisualQaRuns)
    .set({
      status: "failed",
      errorCode: "project_state_changed",
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: sql`now()`,
    })
    .where(eq(themeStudioVisualQaRuns.id, qaRunId));
}

async function projectIsGenerating(db: Db, projectId: string) {
  const [project] = await db
    .select({ status: themeStudioProjects.status })
    .from(themeStudioProjects)
    .where(eq(themeStudioProjects.id, projectId))
    .limit(1);
  return project?.status === "generating";
}

async function claimQa(db: Db, workerId: string): Promise<ClaimedQa | null> {
  const exhausted = await db
    .select()
    .from(themeStudioVisualQaRuns)
    .where(
      sql`${themeStudioVisualQaRuns.status} = 'running'
          AND ${themeStudioVisualQaRuns.leaseExpiresAt} <= now()
          AND ${themeStudioVisualQaRuns.attemptCount} >= ${themeStudioVisualQaRuns.maxAttempts}`,
    )
    .for("update", { skipLocked: true });
  for (const row of exhausted) {
    if (await projectIsGenerating(db, row.projectId)) {
      await revealFailed(db, row, "qa_lease_expired");
    } else {
      await closeAbandoned(db, row.id);
    }
  }

  const [next] = await db
    .select()
    .from(themeStudioVisualQaRuns)
    .where(
      sql`${themeStudioVisualQaRuns.status} = 'queued'
          OR (${themeStudioVisualQaRuns.status} = 'running'
              AND ${themeStudioVisualQaRuns.leaseExpiresAt} <= now()
              AND ${themeStudioVisualQaRuns.attemptCount} < ${themeStudioVisualQaRuns.maxAttempts})`,
    )
    .orderBy(themeStudioVisualQaRuns.createdAt)
    .for("update", { skipLocked: true })
    .limit(1);
  if (!next) return null;
  await db
    .update(themeStudioVisualQaRuns)
    .set({
      status: "running",
      leaseOwner: workerId,
      leaseExpiresAt: sql`now() + (${QA_LEASE_SECONDS}::int * interval '1 second')`,
      attemptCount: next.attemptCount + 1,
      startedAt: sql`coalesce(${themeStudioVisualQaRuns.startedAt}, now())`,
    })
    .where(eq(themeStudioVisualQaRuns.id, next.id));
  const [project] = await db
    .select({
      name: themeStudioProjects.name,
      modelKey: themeStudioProjects.modelKey,
      status: themeStudioProjects.status,
      brief: sql<string>`(SELECT m.body FROM theme_studio_messages m WHERE m.project_id=${next.projectId}::uuid AND m.kind='brief' ORDER BY m.created_at LIMIT 1)`,
    })
    .from(themeStudioProjects)
    .where(eq(themeStudioProjects.id, next.projectId))
    .limit(1);
  // Never pay for a vision call on a project nobody is generating any more.
  if (project && project.status !== "generating") {
    await closeAbandoned(db, next.id);
    return null;
  }
  const [version] = await db
    .select({
      packageJson: themeStudioVersions.packageJson,
      distinctnessReport: themeStudioVersions.distinctnessReport,
    })
    .from(themeStudioVersions)
    .where(eq(themeStudioVersions.id, next.versionId))
    .limit(1);
  const assets = await db
    .select({
      id: themeStudioAssets.id,
      purpose: themeStudioAssets.purpose,
    })
    .from(themeStudioAssets)
    .where(
      and(
        eq(themeStudioAssets.projectId, next.projectId),
        inArray(themeStudioAssets.id, next.screenshotAssetIds),
      ),
    );
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const ordered = next.screenshotAssetIds
    .map((id) => byId.get(id))
    .filter((asset): asset is (typeof assets)[number] =>
      Boolean(asset && asset.purpose === "qa_screenshot"),
    )
    .map(({ id }) => ({ id }));
  if (
    !project ||
    !version ||
    ordered.length !== next.screenshotAssetIds.length
  ) {
    await revealFailed(db, next, "qa_input_missing");
    return null;
  }
  return {
    ...next,
    projectName: project.name,
    modelKey: project.modelKey as ThemeStudioModelKey,
    packageJson: version.packageJson,
    distinctnessReport: version.distinctnessReport,
    originalBrief: (project.brief ?? "").slice(0, 12_000),
    screenshotAssets: ordered,
  };
}

async function contactSheets(
  qa: ClaimedQa,
  signal: AbortSignal,
): Promise<ThemeStudioContentBlock[]> {
  const evidence = (qa.browserReport as { evidence?: { samples?: unknown[] } })
    .evidence;
  const samples = Array.isArray(evidence?.samples) ? evidence.samples : [];
  return buildVisualEvidence(
    qa.screenshotAssets.map((asset, index) => {
      const sample = samples[index] as
        | { viewport?: string; path?: string; surface?: string }
        | undefined;
      return {
        assetId: asset.id,
        viewport: sample?.viewport ?? "unknown",
        page: `${sample?.surface ?? "page"} ${sample?.path ?? ""}`,
      };
    }),
    async (id) => {
      const [asset] = await withService((db) =>
        db
          .select({ bytes: themeStudioAssets.bytes })
          .from(themeStudioAssets)
          .where(
            and(
              eq(themeStudioAssets.id, id),
              eq(themeStudioAssets.projectId, qa.projectId),
              eq(themeStudioAssets.purpose, "qa_screenshot"),
            ),
          )
          .limit(1),
      );
      if (!asset) throw new Error("qa_input_missing");
      return asset.bytes;
    },
    signal,
  );
}

function qaClient(provider: ThemeStudioProvider, qa: ClaimedQa) {
  if (provider === "fake") {
    return createFakeModelClient({
      name: qa.projectName,
      brief: "automatic visual QA",
      industries: [],
      catalogSizes: [],
      requiredFeatures: [],
      referenceCount: 0,
      answered: true,
    });
  }
  const vertex = getVertexConfig();
  return vertex
    ? createVertexModelClient(vertex, {
        capacity: (model) =>
          sharedProviderCapacity(vertex.projectId, vertex.region, model),
      })
    : null;
}

async function evaluateQa(
  qa: ClaimedQa,
  provider: ThemeStudioProvider,
  leaseSignal: AbortSignal,
): Promise<{
  report: VisualQaReport;
  usage: ProviderUsage;
  provider: ThemeStudioProvider;
  providerModel: string;
}> {
  const client: ThemeStudioModelClient | null = qaClient(provider, qa);
  if (!client) throw new Error("provider_unavailable");
  const model = resolveThemeStudioModel(qa.modelKey);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, leaseSignal]);
  const timeout = setTimeout(() => controller.abort(), QA_TIMEOUT_MS);
  try {
    const history = await withService(async (db) => {
      const rows = await db.execute(sql`
        WITH RECURSIVE chain(id, parent, run_id, depth) AS (
          SELECT v.id, v.parent_version_id, v.run_id, 0 FROM theme_studio_versions v
           WHERE v.id=${qa.versionId}::uuid AND v.project_id=${qa.projectId}::uuid
          UNION ALL
          SELECT v.id, v.parent_version_id, v.run_id, c.depth+1 FROM theme_studio_versions v
           JOIN chain c ON v.id=c.parent WHERE c.depth<50 AND v.project_id=${qa.projectId}::uuid
        )
        SELECT DISTINCT ON (asset->>'sha256') asset->>'sha256' AS "sha256",
          outcome->>'review' AS "review", outcome->>'note' AS "note"
          FROM chain c JOIN theme_studio_versions v ON v.id=c.id
          JOIN theme_studio_runs r ON r.id=c.run_id AND r.project_id=${qa.projectId}::uuid AND r.kind='images'
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.outcome_detail->'outcomes', '[]'::jsonb)) outcome
          CROSS JOIN LATERAL jsonb_array_elements(v.package_json->'assets') asset
         WHERE outcome->>'status'='generated' AND asset->>'id'=outcome->>'slotId'
         ORDER BY asset->>'sha256', c.depth
      `);
      return rows.rows as {
        sha256: string;
        review: string;
        note: string | null;
      }[];
    });
    const issues = qaImageIssues(qa.packageJson as ThemePackageV2, history);
    const imageBlocks: { issue: QaImageIssue; base64: string }[] = [];
    for (const issue of issues) {
      signal.throwIfAborted();
      const [asset] = await withService((db) =>
        db
          .select({
            bytes: themeStudioAssets.bytes,
            mediaType: themeStudioAssets.mediaType,
          })
          .from(themeStudioAssets)
          .where(
            and(
              eq(themeStudioAssets.projectId, qa.projectId),
              eq(themeStudioAssets.purpose, "image"),
              eq(themeStudioAssets.sha256, issue.sha256),
            ),
          )
          .limit(1),
      );
      if (!asset || asset.mediaType !== "image/webp")
        throw new Error("qa_image_input_missing");
      imageBlocks.push({ issue, base64: asset.bytes.toString("base64") });
    }
    const result = await client.generate(
      buildVisualQaRequest({
        modelKey: qa.modelKey,
        providerModel: provider === "fake" ? "fake" : model.providerModel,
        projectName: qa.projectName,
        originalBrief: qa.originalBrief,
        packageJson: qa.packageJson,
        browserReport: qa.browserReport,
        issues,
        evidence: await contactSheets(qa, signal),
        images: imageBlocks,
      }),
      signal,
    );
    if (result.kind !== "ok") throw new Error(`provider_${result.kind}`);
    const report = parseVisualQaReport(result.value);
    if (!report || !imageAssessmentsComplete(issues, report))
      throw new Error("qa_output_invalid");
    return {
      report,
      usage: result.usage,
      provider: client.provider,
      providerModel: provider === "fake" ? "fake" : model.providerModel,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function settleQa(
  workerId: string,
  qa: ClaimedQa,
  evaluated: {
    report: VisualQaReport | null;
    usage: ProviderUsage | null;
    provider?: ThemeStudioProvider;
    providerModel?: string;
  },
) {
  return withService(async (db) => {
    const [held] = await db
      .select()
      .from(themeStudioVisualQaRuns)
      .where(
        and(
          eq(themeStudioVisualQaRuns.id, qa.id),
          eq(themeStudioVisualQaRuns.status, "running"),
          eq(themeStudioVisualQaRuns.leaseOwner, workerId),
          gt(themeStudioVisualQaRuns.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .for("update")
      .limit(1);
    if (!held) return "lost" as const;
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, qa.projectId))
      .for("update")
      .limit(1);
    if (!project || project.status !== "generating") {
      // The run is still ours (locked above): close it rather than leave it
      // leased, or it is re-claimed after every expiry until it exhausts.
      await closeAbandoned(db, qa.id);
      return "failed" as const;
    }
    const binding = qa.browserReport as {
      acceptanceRunId?: string;
      buildId?: string;
      phase?: "layout" | "final";
      gates?: GateResult[];
    };
    const phase = binding.phase === "layout" ? "layout" : "final";
    const [acceptance] =
      phase === "layout"
        ? [
            {
              id: null,
              packageDigest: qa.packageDigest,
              buildId: binding.buildId,
              status: "layout",
              serverReport: { gates: binding.gates ?? [] },
              browserReport: { gates: [] },
            },
          ]
        : binding.acceptanceRunId
          ? await db
              .select()
              .from(themeStudioAcceptanceRuns)
              .where(
                and(
                  eq(themeStudioAcceptanceRuns.id, binding.acceptanceRunId),
                  eq(themeStudioAcceptanceRuns.projectId, qa.projectId),
                  eq(themeStudioAcceptanceRuns.versionId, qa.versionId),
                ),
              )
              .limit(1)
          : [];
    if (!acceptance || acceptance.packageDigest !== qa.packageDigest) {
      await revealFailed(db, qa, "automatic_acceptance_missing");
      return "failed" as const;
    }
    if (acceptance.buildId !== currentAcceptanceBuildId()) {
      // A deploy invalidates old rendering evidence. Recapture this same
      // immutable version instead of paying to regenerate its design/images.
      const [{ n: recaptures }] = await db
        .select({ n: count() })
        .from(themeStudioCaptures)
        .where(
          and(
            eq(themeStudioCaptures.versionId, qa.versionId),
            like(themeStudioCaptures.idempotencyKey, "auto\\_recapture\\_%"),
          ),
        );
      if (Number(recaptures) >= MAX_BUILD_RECAPTURES) {
        await revealFailed(db, qa, "acceptance_build_unstable");
        return "failed" as const;
      }
      await db.insert(themeStudioCaptures).values({
        projectId: qa.projectId,
        versionId: qa.versionId,
        packageDigest: qa.packageDigest,
        previousStatus: "generating",
        automatic: true,
        phase,
        qaIteration: qa.qaIteration,
        maxAttempts: AUTOMATIC_CAPTURE_MAX_ATTEMPTS,
        idempotencyKey: `auto_recapture_${qa.id}`,
        createdBy: qa.createdBy,
      });
      await db
        .update(themeStudioVisualQaRuns)
        .set({
          status: "failed",
          errorCode: "acceptance_build_changed",
          leaseOwner: null,
          leaseExpiresAt: null,
          finishedAt: sql`now()`,
        })
        .where(eq(themeStudioVisualQaRuns.id, qa.id));
      await recordThemeStudioEvent(db, {
        projectId: qa.projectId,
        actor: "worker",
        eventType: "capture_requested",
        detail: { versionId: qa.versionId, reason: "acceptance_build_changed" },
      });
      return "recapture_queued" as const;
    }
    const gates: GateResult[] = [
      ...readAcceptanceReport(acceptance.serverReport).gates,
      ...readAcceptanceReport(acceptance.browserReport).gates,
    ];
    const failures = automaticAcceptanceFailures(gates);
    const modelPass =
      evaluated.report?.verdict === "pass" &&
      !evaluated.report.repairs?.length &&
      scorecardClearsBar(evaluated.report.scores, evaluated.report.rejections);
    const distinctness = readDistinctnessReport(qa.distinctnessReport);
    const report = {
      phase,
      ...(distinctness ? { distinctness } : {}),
      progress: qaProgress(gates, evaluated.report),
      promptVersion: VISUAL_QA_PROMPT_VERSION,
      usage: evaluated.usage,
      ...evaluated.report,
      provider: evaluated.provider ?? null,
      providerModel: evaluated.providerModel ?? null,
      repairs: [
        ...deterministicRepairs(gates),
        ...(evaluated.report?.repairs ?? []),
      ],
      acceptanceFailures: failures,
      acceptanceRunId: acceptance.id,
    };
    const decision = automaticQaDecision(
      gates,
      phase === "layout" || modelPass,
      qa.qaIteration,
      phase,
    );
    if (decision === "pass" && phase === "layout") {
      const pkg = validateThemePackageV2(qa.packageJson);
      const [version] = await db
        .select({
          intentJson: themeStudioVersions.intentJson,
          packageDigest: themeStudioVersions.packageDigest,
        })
        .from(themeStudioVersions)
        .where(
          and(
            eq(themeStudioVersions.id, qa.versionId),
            eq(themeStudioVersions.projectId, qa.projectId),
          ),
        )
        .limit(1);
      const intent = validateThemeIntent(version?.intentJson);
      const config = getThemeStudioConfig();
      if (
        !pkg.ok ||
        !intent.ok ||
        version?.packageDigest !== qa.packageDigest ||
        !config.provider
      ) {
        await revealFailed(db, qa, "qa_input_missing", report);
        return "failed" as const;
      }
      const work = {
        id: qa.id,
        projectId: qa.projectId,
        provider: config.provider,
        modelKey: qa.modelKey,
        qaIteration: qa.qaIteration,
        createdBy: qa.createdBy,
      };
      const slots = generatableSlots(pkg.value, intent.value).length;
      // Queue the next stage and close this QA row in the same transaction.
      if (slots > 0) {
        if (
          !(await queueAutomaticImages(
            db,
            work,
            { id: qa.versionId },
            qa.packageDigest,
            slots,
          ))
        ) {
          await revealFailed(db, qa, "image_provider_unavailable", report);
          return "failed" as const;
        }
      } else
        await queueAutomaticCapture(
          db,
          work,
          { id: qa.versionId },
          qa.packageDigest,
        );
      await db
        .update(themeStudioVisualQaRuns)
        .set({
          status: "passed",
          visionReport: report,
          finishedAt: sql`now()`,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        .where(eq(themeStudioVisualQaRuns.id, qa.id));
      // Deliberately keep the version internal/pending and project generating.
      return "layout_passed" as const;
    }
    if (decision === "pass" && acceptance.status !== "passed") {
      // The stored outcome and the re-read gates disagree. Paying for a
      // revision of a theme whose every gate passed would be wrong, and so
      // would delivering a candidate the database will refuse: stop here.
      logError(
        "theme studio: acceptance outcome disagrees with its gates",
        undefined,
        { qaRunId: qa.id, acceptanceRunId: acceptance.id },
      );
      await revealFailed(db, qa, "acceptance_outcome_mismatch", report);
      return "failed" as const;
    }
    if (decision === "pass") {
      // Verify asset/build bindings before marking visible or ready. The
      // verifier is read-only; this row is still generating until settlement.
      const verified = await verifyCandidateEvidenceWithDb(db, {
        id: qa.projectId,
        status: "candidate",
        currentVersionId: qa.versionId,
      });
      if (!verified.ok) {
        await revealFailed(db, qa, "acceptance_evidence_stale", {
          reason: verified.reason,
        });
        return "failed" as const;
      }
      await db
        .update(themeStudioVisualQaRuns)
        .set({
          status: "passed",
          visionReport: report,
          leaseOwner: null,
          leaseExpiresAt: null,
          finishedAt: sql`now()`,
        })
        .where(eq(themeStudioVisualQaRuns.id, qa.id));
      await db
        .update(themeStudioVersions)
        .set({ visibility: "operator", qaStatus: "passed" })
        .where(eq(themeStudioVersions.id, qa.versionId));
      await db
        .update(themeStudioProjects)
        .set({
          status: "ready",
          currentVersionId: qa.versionId,
          revision: sql`${themeStudioProjects.revision} + 1`,
        })
        .where(eq(themeStudioProjects.id, qa.projectId));
      // Keep the database state machine: generating -> ready -> candidate.
      // Both updates commit atomically after the passing acceptance exists.
      await db
        .update(themeStudioProjects)
        .set({ status: "candidate" })
        .where(eq(themeStudioProjects.id, qa.projectId));
      await recordThemeStudioEvent(db, {
        projectId: qa.projectId,
        actor: "worker",
        eventType: "auto_qa_passed",
        detail: { qaRunId: qa.id, versionId: qa.versionId },
      });
      return "passed" as const;
    }
    if (decision === "attention" || decision === "blocked") {
      await revealFailed(
        db,
        qa,
        decision === "blocked"
          ? "acceptance_security_failed"
          : "quality_bar_not_met",
        {
          ...report,
          diagnosis:
            decision === "blocked"
              ? "Required security checks failed. Resolve the listed security findings before retrying."
              : qa.qaIteration >= 3
                ? "Automatic QA reached its three-repair limit. Review the remaining findings before retrying."
                : "Required evidence is incomplete or a runtime fault prevents automatic repair. Review the listed findings before retrying.",
        },
      );
      if (decision === "blocked")
        await db
          .update(themeStudioProjects)
          .set({ status: "blocked" })
          .where(eq(themeStudioProjects.id, qa.projectId));
      return "failed" as const;
    }
    const config = getThemeStudioConfig();
    if (!config.autoQaEnabled || !config.provider) {
      await revealFailed(db, qa, "auto_qa_disabled", report);
      return "failed" as const;
    }
    const pkg = validateThemePackageV2(qa.packageJson);
    if (!pkg.ok) {
      await revealFailed(db, qa, "qa_input_missing", report);
      return "failed" as const;
    }
    const repairs = report.repairs;
    const settings = new Set(repairTargets(pkg.value).map((t) => t.path));
    const imageSlots = new Set(
      describeSlots(pkg.value)
        .filter(
          (s) =>
            s.source === "generated" &&
            !s.catalogPreview &&
            !s.catalogScreenshot,
        )
        .map((s) => s.id),
    );
    const invalidTarget = repairs.some(
      (r) =>
        (r.kind === "settings" &&
          r.target !== null &&
          !settings.has(r.target)) ||
        (r.kind === "image" && (!r.target || !imageSlots.has(r.target))),
    );
    const renderer =
      repairs.some((r) => r.kind === "renderer") ||
      evaluated.report?.rejections.includes("needs_custom_code");
    // Legacy visual evidence cannot silently route explicit platform work to a
    // settings repair merely because it predates structured repairs.
    const legacyRenderer =
      !evaluated.report?.repairs &&
      /(?:renderer|custom code|\bCSS\b|JavaScript|preload|srcset)/i.test(
        evaluated.report?.revisionBrief ?? "",
      );
    if (renderer || legacyRenderer || invalidTarget) {
      await revealFailed(
        db,
        qa,
        invalidTarget ? "repair_not_supported" : "renderer_fix_required",
        {
          ...report,
          repairs,
          diagnosis: invalidTarget
            ? "The required repair has no supported setting or generated image slot. Review the platform implementation."
            : "These findings require a platform renderer fix. Further theme revisions cannot resolve them.",
        },
      );
      return "failed" as const;
    }
    if (qa.qaIteration > 0) {
      // Follow only this immutable version's ancestry. Unrelated branches,
      // explicit retries and older builds must not stop a fresh attempt.
      const previous = await db
        .select({ visionReport: themeStudioVisualQaRuns.visionReport })
        .from(themeStudioVisualQaRuns)
        .where(
          and(
            eq(themeStudioVisualQaRuns.projectId, qa.projectId),
            eq(themeStudioVisualQaRuns.status, "revision_queued"),
            sql`coalesce(${themeStudioVisualQaRuns.browserReport}->>'phase','final') = ${phase}`,
            sql`${themeStudioVisualQaRuns.browserReport}->>'buildId' = ${acceptance.buildId}`,
            sql`${themeStudioVisualQaRuns.versionId} IN (WITH RECURSIVE ancestry AS (
            SELECT id,parent_version_id,0 AS depth FROM theme_studio_versions WHERE id=${qa.versionId}::uuid AND project_id=${qa.projectId}::uuid
            UNION ALL SELECT v.id,v.parent_version_id,a.depth+1 FROM theme_studio_versions v JOIN ancestry a ON v.id=a.parent_version_id
            WHERE v.project_id=${qa.projectId}::uuid AND a.depth<50) SELECT id FROM ancestry WHERE depth>0)`,
          ),
        )
        .orderBy(sql`${themeStudioVisualQaRuns.createdAt} DESC`)
        .limit(12);
      const history = previous
        .map((p) => (p.visionReport as { progress?: QaProgress })?.progress)
        .filter((p): p is QaProgress =>
          Boolean(p && Array.isArray(p.patterns)),
        );
      const current = report.progress;
      if (
        history.length &&
        (!qaImproved(current, history[0]) ||
          history.some((p) => JSON.stringify(p) === JSON.stringify(current)))
      ) {
        await revealFailed(db, qa, "qa_no_progress", {
          ...report,
          repairs,
          diagnosis:
            "Automatic QA stopped because the same findings did not improve after a repair, or a previous failure pattern returned. Review the listed defects before retrying.",
        });
        return "failed" as const;
      }
    }
    const redrawIds = [
      ...new Set(
        repairs.filter((r) => r.kind === "image").map((r) => r.target!),
      ),
    ];
    const settingRepairs = repairs.filter((r) => r.kind === "settings");
    // Stabilize layout first when both settings and artwork need changes. The
    // next final review will route any remaining artwork defect to its slot.
    if (redrawIds.length && !settingRepairs.length) {
      if (
        !automaticImageProvider({
          provider: config.provider,
          modelKey: qa.modelKey,
          id: qa.id,
          projectId: qa.projectId,
          qaIteration: qa.qaIteration,
          createdBy: qa.createdBy,
        })
      ) {
        await revealFailed(db, qa, "image_provider_unavailable", report);
        return "failed" as const;
      }
      const imageRunId = await queueAutomaticImages(
        db,
        {
          id: qa.id,
          projectId: qa.projectId,
          provider: config.provider,
          modelKey: qa.modelKey,
          qaIteration: qa.qaIteration + 1,
          createdBy: qa.createdBy,
        },
        { id: qa.versionId },
        qa.packageDigest,
        redrawIds.length,
        redrawIds,
        Object.fromEntries(
          repairs
            .filter((r) => r.kind === "image")
            .map((r) => [r.target!, r.reason]),
        ),
      );
      if (!imageRunId) {
        await revealFailed(db, qa, "image_provider_unavailable", report);
        return "failed" as const;
      }
      await db
        .update(themeStudioVisualQaRuns)
        .set({
          status: "revision_queued",
          revisionRunId: imageRunId,
          visionReport: { ...report, repairs },
          finishedAt: sql`now()`,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        .where(eq(themeStudioVisualQaRuns.id, qa.id));
      return "revision_queued" as const;
    }
    const model = resolveThemeStudioModel(qa.modelKey);
    const brief = redrawIds.length
      ? [
          "Revise only the following supported theme settings. Artwork changes are deferred until these settings are stable.",
          ...settingRepairs.map(
            (r) =>
              `Setting ${r.target ?? "(choose a supported path)"}: ${r.reason}`,
          ),
          "Preserve all artwork, content, product identity and other settings. Do not hide content or disable checks.",
        ]
          .join("\n")
          .slice(0, 12_000)
      : [
          "Revise this theme to clear automatic pre-review QA.",
          ...failures.map((finding) => `Acceptance: ${finding}`),
          ...(evaluated.report
            ? [
                `Visual scores: ${JSON.stringify(evaluated.report.scores)}. Raise every row to at least 4 and the total to at least 34.`,
                ...evaluated.report.rejections.map(
                  (reason) => `Visual rejection: ${reason}`,
                ),
              ]
            : []),
          ...(evaluated.report?.findings ?? []).map(
            (finding) => `Visual: ${finding}`,
          ),
          evaluated.report?.revisionBrief
            ? `Required changes: ${evaluated.report.revisionBrief}`
            : "Fix every reported acceptance finding using the theme's supported settings. Preserve existing artwork; do not hide content or disable checks.",
          "Preserve the product identity and any strong choices that already work. Do not ask questions; use stated assumptions.",
        ]
          .join("\n")
          .slice(0, 12_000);
    const [message] = await db
      .insert(themeStudioMessages)
      .values({
        projectId: qa.projectId,
        kind: "revision",
        body: brief,
        referenceAssetIds: [],
        createdBy: qa.createdBy,
      })
      .returning({ id: themeStudioMessages.id });
    const [revision] = await db
      .insert(themeStudioRuns)
      .values({
        projectId: qa.projectId,
        messageId: message.id,
        kind: "revise",
        baseVersionId: qa.versionId,
        basePackageDigest: qa.packageDigest,
        contextMessageIds: [message.id],
        provider: config.provider,
        modelKey: qa.modelKey,
        providerModel:
          config.provider === "fake" ? "fake" : model.providerModel,
        promptVersion:
          config.provider === "fake"
            ? "theme-studio-fake-v1"
            : THEME_STUDIO_PROMPT_VERSION,
        idempotencyKey: `auto_revision_${qa.id}`,
        maxAttempts: 3,
        automatic: true,
        qaIteration: qa.qaIteration + 1,
        createdBy: qa.createdBy,
      })
      .returning({ id: themeStudioRuns.id });
    await db
      .update(themeStudioVisualQaRuns)
      .set({
        status: "revision_queued",
        visionReport: { ...report, repairs },
        revisionRunId: revision.id,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: sql`now()`,
      })
      .where(eq(themeStudioVisualQaRuns.id, qa.id));
    await db
      .update(themeStudioProjects)
      .set({ revision: sql`${themeStudioProjects.revision} + 1` })
      .where(eq(themeStudioProjects.id, qa.projectId));
    await recordThemeStudioEvent(db, {
      projectId: qa.projectId,
      runId: revision.id,
      actor: "worker",
      eventType: "auto_qa_revision_queued",
      detail: {
        qaRunId: qa.id,
        fromVersionId: qa.versionId,
        qaIteration: qa.qaIteration + 1,
      },
    });
    return "revision_queued" as const;
  });
}

export interface VisualQaWorkerResult {
  claimed: number;
  passed: number;
  revisionQueued: number;
  /** Same version re-measured after a deploy; no design revision. */
  recaptureQueued: number;
  failed: number;
  layoutPassed: number;
}

/** Drain at most one expensive visual verdict per invocation. */
export async function runThemeStudioVisualQaWorker(options: {
  providers: readonly ThemeStudioProvider[];
}): Promise<VisualQaWorkerResult> {
  const result: VisualQaWorkerResult = {
    claimed: 0,
    passed: 0,
    revisionQueued: 0,
    recaptureQueued: 0,
    layoutPassed: 0,
    failed: 0,
  };
  const config = getThemeStudioConfig();
  if (!config.provider || !options.providers.includes(config.provider)) {
    return result;
  }
  const workerId = randomUUID();
  const claimStarted = Date.now();
  const qa = await withService((db) => claimQa(db, workerId));
  if (!qa) return result;
  result.claimed = 1;
  const lease = startWorkerLease(
    () => withService((db) => renewStudioLease(db, "qa", qa.id, workerId)),
    undefined,
    WORKER_LEASE_SECONDS * 1000 - (Date.now() - claimStarted),
  );
  try {
    if (!config.autoQaEnabled) throw new Error("auto_qa_disabled");
    if (config.disabledModels.has(qa.modelKey))
      throw new Error("model_disabled");
    const binding = qa.browserReport as {
      buildId?: string;
      acceptanceRunId?: string;
      gates?: GateResult[];
    };
    // Deterministic failures already contain a repair brief. Avoid an expensive
    // vision call until they pass, and never judge screenshots from old builds.
    const needsVision =
      binding.buildId === currentAcceptanceBuildId() &&
      Boolean(binding.acceptanceRunId) &&
      automaticQaDecision(binding.gates ?? [], true, qa.qaIteration) === "pass";
    const evaluated = needsVision
      ? await evaluateQa(qa, config.provider, lease.signal)
      : { report: null, usage: null };
    lease.signal.throwIfAborted();
    const settled = await settleQa(workerId, qa, evaluated);
    if (settled === "passed") result.passed = 1;
    if (settled === "layout_passed") result.layoutPassed = 1;
    if (settled === "revision_queued") result.revisionQueued = 1;
    if (settled === "recapture_queued") result.recaptureQueued = 1;
    if (settled === "failed") result.failed = 1;
  } catch (error) {
    logError("theme studio: visual QA execution failed", error, {
      qaRunId: qa.id,
    });
    await withService(async (db) => {
      const [held] = await db
        .select()
        .from(themeStudioVisualQaRuns)
        .where(
          and(
            eq(themeStudioVisualQaRuns.id, qa.id),
            eq(themeStudioVisualQaRuns.status, "running"),
            eq(themeStudioVisualQaRuns.leaseOwner, workerId),
            gt(themeStudioVisualQaRuns.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .for("update")
        .limit(1);
      if (!held) return;
      if (held.attemptCount < held.maxAttempts) {
        await db
          .update(themeStudioVisualQaRuns)
          .set({ status: "queued", leaseOwner: null, leaseExpiresAt: null })
          .where(eq(themeStudioVisualQaRuns.id, qa.id));
      } else {
        await revealFailed(db, qa, "qa_provider_failed");
        result.failed = 1;
      }
    });
  } finally {
    await lease.stop();
  }
  return result;
}
