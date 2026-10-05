/** Complete-theme benchmark against the actual deployed worker/capture/QA
 * pipeline. Default is READ ONLY: --projects=<ids> collects existing runs.
 *
 * Screenshot-led mode: --references=<dir> (from
 * scripts/theme-studio-benchmark-references.mjs) with --create queues the
 * eight cases in evals/theme-studio/reference-benchmark.json, each with its
 * own screenshots attached exactly as an operator would upload them.
 * --score-fidelity --yes then asks a vision model how closely each FINISHED
 * theme follows its screenshots (lib/theme-studio/reference-fidelity.ts) and
 * saves the scores in the report; a project already scored is not re-scored.
 * --create --actor-id=<superadmin UUID> --yes queues four isolated unpublished
 * themes. --repeats=2 --concurrency=2 queues eight with at most two unfinished.
 * --wait-minutes=120 bounds the entire batch and saves the report every 15s.
 * Resume after interruption with --projects=<ids>; never re-create the batch.
 * Requires service DB credentials pointing at the same deployment as workers.
 * No publication, retries, edits to existing themes or hidden quality bypass.
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

const option = (key: string) =>
  process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);

async function main() {
  const { writeFile, mkdir, rename } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { eq, inArray } = await import("drizzle-orm");
  const schema = await import("@/drizzle/schema");
  const { withService } = await import("@/lib/db/client");
  const { themeBenchmarkReport, THEME_BENCHMARK_CASES } =
    await import("@/lib/theme-studio/benchmark");
  const { runThemeBenchmarkBatch } =
    await import("@/lib/theme-studio/benchmark-batch");
  const {
    isUuid,
    createThemeStudioProject,
    queueThemeStudioGeneration,
    validateProjectInput,
  } = await import("@/lib/theme-studio/repository");
  const { getThemeStudioConfig } = await import("@/lib/theme-studio/config");
  const { currentAcceptanceBuildId } =
    await import("@/lib/theme-studio/acceptance");
  const out = option("out") ?? "/tmp/theme-studio-benchmark.json";
  const minutes = Number(option("wait-minutes") ?? 0);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 120)
    throw new Error("--wait-minutes must be 0..120.");
  const repeats = Number(option("repeats") ?? 1);
  const concurrency = Number(option("concurrency") ?? 1);
  if (![1, 2].includes(repeats) || (concurrency !== 1 && concurrency !== 2))
    throw new Error("--repeats and --concurrency must be 1 or 2.");
  const deadlineAt = Date.now() + Math.max(1, minutes) * 60_000;
  const ids = (option("projects") ?? "").split(",").filter(Boolean);
  if (ids.some((id) => !isUuid(id)))
    throw new Error("--projects requires UUIDs.");
  const created: string[] = [];
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const referencesDir = option("references");
  const previous = existsSync(out)
    ? (JSON.parse(readFileSync(out, "utf8")) as {
        caseByProject?: Record<string, string>;
        fidelity?: Record<string, unknown>;
      })
    : null;
  /** projectId → reference case id; carried across resumed reports. */
  const caseByProject: Record<string, string> = {
    ...(previous?.caseByProject ?? {}),
  };
  const fidelity: Record<string, unknown> = { ...(previous?.fidelity ?? {}) };
  const {
    REFERENCE_BENCHMARK_CASES,
    fidelityPairs,
    meanFidelity,
    themeShotsFromQa,
  } = await import("@/lib/theme-studio/reference-benchmark");
  const manifest = referencesDir
    ? (JSON.parse(
        readFileSync(join(referencesDir, "manifest.json"), "utf8"),
      ) as {
        cases: Record<string, { shots: { file: string; page: string }[] }>;
      })
    : null;
  const persist = async (results: unknown[]) => {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(
      `${out}.tmp`,
      JSON.stringify(
        {
          version: 1,
          measuredAt: new Date().toISOString(),
          reporterBuildId: currentAcceptanceBuildId(),
          projectIds: ids,
          createdProjectIds: created,
          ...(Object.keys(caseByProject).length ? { caseByProject } : {}),
          ...(Object.keys(fidelity).length
            ? {
                fidelity,
                fidelityMean: meanFidelity(
                  Object.values(fidelity).flatMap((f) => {
                    const scores = (f as { scores?: Record<string, number> })
                      ?.scores;
                    return scores ? [scores] : [];
                  }),
                ),
              }
            : {}),
          ...(process.argv.includes("--create")
            ? {
                plannedThemes: manifest
                  ? REFERENCE_BENCHMARK_CASES.length
                  : THEME_BENCHMARK_CASES.length * repeats,
                concurrency,
              }
            : {}),
          results,
        },
        null,
        2,
      ),
    );
    await rename(`${out}.tmp`, out);
  };
  const collect = async () => {
    const data = await withService(async (db) => ({
      projects: await db
        .select()
        .from(schema.themeStudioProjects)
        .where(inArray(schema.themeStudioProjects.id, ids)),
      runs: await db
        .select()
        .from(schema.themeStudioRuns)
        .where(inArray(schema.themeStudioRuns.projectId, ids)),
      captures: await db
        .select()
        .from(schema.themeStudioCaptures)
        .where(inArray(schema.themeStudioCaptures.projectId, ids)),
      qa: await db
        .select()
        .from(schema.themeStudioVisualQaRuns)
        .where(inArray(schema.themeStudioVisualQaRuns.projectId, ids)),
      versions: await db
        .select({
          id: schema.themeStudioVersions.id,
          projectId: schema.themeStudioVersions.projectId,
        })
        .from(schema.themeStudioVersions)
        .where(inArray(schema.themeStudioVersions.projectId, ids)),
    }));
    if (data.projects.length !== new Set(ids).size)
      throw new Error("A requested benchmark project was not found.");
    const results = data.projects.map((project) =>
      themeBenchmarkReport({
        project,
        runs: data.runs.filter((r) => r.projectId === project.id),
        captures: data.captures.filter((r) => r.projectId === project.id),
        qa: data.qa.filter((r) => r.projectId === project.id),
        versions: data.versions.filter((r) => r.projectId === project.id),
        measuredAt: new Date().toISOString(),
      }),
    );
    await persist(results);
    return results;
  };
  if (process.argv.includes("--create")) {
    if (ids.length) throw new Error("Use --create or --projects, separately.");
    const config = getThemeStudioConfig();
    if (
      !process.argv.includes("--yes") ||
      !config.generationEnabled ||
      !config.autoQaEnabled ||
      config.provider !== "vertex-gemini"
    )
      throw new Error(
        "Complete live benchmarks require --yes and deployed Vertex generation, capture and automatic QA enabled.",
      );
    const actorId = option("actor-id");
    if (!isUuid(actorId))
      throw new Error("--actor-id requires a superadmin UUID.");
    const [actor] = await withService((db) =>
      db
        .select()
        .from(schema.platformAdmins)
        .where(eq(schema.platformAdmins.id, actorId))
        .limit(1),
    );
    if (actor?.role !== "superadmin")
      throw new Error("Benchmark actor must be a current superadmin.");
    if (manifest && repeats !== 1)
      throw new Error("Screenshot-led cases run once each; omit --repeats.");
    const cases: {
      name: string;
      industry: string;
      brief: string;
      referenceCase?: string;
    }[] = manifest
      ? REFERENCE_BENCHMARK_CASES.map((c) => {
          if (!manifest.cases[c.id]?.shots.length)
            throw new Error(
              `No screenshots for ${c.id}; run scripts/theme-studio-benchmark-references.mjs first.`,
            );
          return {
            name: c.id,
            industry: c.industry,
            brief: c.brief,
            referenceCase: c.id,
          };
        })
      : Array.from({ length: repeats }, () => THEME_BENCHMARK_CASES).flat();
    const { sanitizeReferenceImage } =
      await import("@/lib/theme-studio/references");
    const { addThemeStudioReference } =
      await import("@/lib/theme-studio/repository");
    const modelKey = option("model") ?? "gemini-3.8-flash";
    const batch = await runThemeBenchmarkBatch({
      cases,
      concurrency,
      deadlineAt,
      collect,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 15000)),
      createAndQueue: async (entry) => {
        const suffix = randomUUID().slice(0, 8);
        const project = await createThemeStudioProject(
          actor,
          validateProjectInput({
            name: `Benchmark ${entry.name} ${suffix}`,
            themeId: `benchmark-${entry.name.toLowerCase()}-${suffix}`,
            brief: entry.brief,
            industries: [entry.industry],
            catalogSizes: ["small"],
            requiredFeatures: ["category-navigation"],
            baseThemeId: null,
            modelKey,
          }),
        );
        ids.push(project.id);
        created.push(project.id);
        // Screenshots go in exactly as an operator's upload would: through the
        // same sanitiser (re-encoded WebP, metadata stripped) and the same
        // per-project reference limits, then cited by the brief message.
        const referenceAssetIds: string[] = [];
        if (entry.referenceCase && manifest && referencesDir) {
          caseByProject[project.id] = entry.referenceCase;
          for (const shot of manifest.cases[entry.referenceCase].shots) {
            const clean = await sanitizeReferenceImage(
              readFileSync(join(referencesDir, entry.referenceCase, shot.file)),
            );
            if (!clean.ok)
              throw new Error(
                `${entry.referenceCase}/${shot.file} was refused: ${clean.code}`,
              );
            const added = await addThemeStudioReference(
              actor,
              project.id,
              clean.value,
            );
            referenceAssetIds.push(added.id);
          }
        }
        await persist([]);
        const [{ revision }] = await withService((db) =>
          db
            .select({ revision: schema.themeStudioProjects.revision })
            .from(schema.themeStudioProjects)
            .where(eq(schema.themeStudioProjects.id, project.id)),
        );
        await queueThemeStudioGeneration(actor, {
          projectId: project.id,
          expectedRevision: revision,
          ...(referenceAssetIds.length ? { referenceAssetIds } : {}),
          idempotencyKey: `benchmark_${randomUUID()}`,
        });
        console.log(`Queued ${entry.name}: ${project.id}`);
        return project.id;
      },
    });
    if (batch.timedOut)
      console.log(
        "Benchmark still running; resume reporting with --projects. No further themes queued.",
      );
  }
  if (!ids.length)
    throw new Error(
      "Provide --projects=<UUIDs>, or explicitly queue a batch with --create --actor-id=<UUID> --yes --wait-minutes=60.",
    );
  const until = process.argv.includes("--create")
    ? deadlineAt
    : Date.now() + minutes * 60_000;
  for (;;) {
    const results = await collect();
    if (results.every((r) => r.terminal) || Date.now() >= until) {
      console.log(
        JSON.stringify(
          results.map((r) => ({
            projectId: r.projectId,
            status: r.status,
            wallMs: r.wallMs,
            firstFinalQaPassed: r.firstFinalQaPassed,
            firstPassQaPassed: r.firstPassQaPassed,
            designRevisions: r.designRevisions,
          })),
          null,
          2,
        ),
      );
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  if (process.argv.includes("--score-fidelity")) {
    if (!process.argv.includes("--yes"))
      throw new Error("--score-fidelity makes paid model calls; add --yes.");
    if (!referencesDir || !manifest)
      throw new Error("--score-fidelity needs --references=<dir>.");
    const { getVertexConfig, createVertexModelClient } =
      await import("@/lib/theme-studio/gemini-vertex");
    const { sharedProviderCapacity } =
      await import("@/lib/theme-studio/provider-capacity-store");
    const { resolveThemeStudioModel } =
      await import("@/lib/theme-studio/models");
    const { scoreReferenceFidelity } =
      await import("@/lib/theme-studio/reference-fidelity");
    const vertex = getVertexConfig();
    if (!vertex) throw new Error("Fidelity scoring needs a Vertex project.");
    const client = createVertexModelClient(vertex, {
      capacity: (model) =>
        sharedProviderCapacity(vertex.projectId, vertex.region, model),
    });
    const judge = resolveThemeStudioModel("gemini-3.8-flash");
    const finished = (await collect()).filter((r) => r.terminal);
    for (const result of finished) {
      const projectId = String(result.projectId);
      const caseId = caseByProject[projectId];
      if (!caseId || fidelity[projectId]) continue;
      const data = await withService(async (db) => {
        const [project] = await db
          .select({ current: schema.themeStudioProjects.currentVersionId })
          .from(schema.themeStudioProjects)
          .where(eq(schema.themeStudioProjects.id, projectId));
        const qa = (
          await db
            .select()
            .from(schema.themeStudioVisualQaRuns)
            .where(eq(schema.themeStudioVisualQaRuns.projectId, projectId))
        )
          .filter(
            (r) =>
              (r.browserReport as { phase?: string } | null)?.phase !==
                "layout" && r.screenshotAssetIds.length > 0,
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        // The version the operator would publish; otherwise the newest.
        const chosen =
          qa.find((r) => r.versionId === project?.current) ?? qa[0];
        if (!chosen) return null;
        const shots = themeShotsFromQa(chosen);
        const assets = await db
          .select({
            id: schema.themeStudioAssets.id,
            bytes: schema.themeStudioAssets.bytes,
          })
          .from(schema.themeStudioAssets)
          .where(
            inArray(
              schema.themeStudioAssets.id,
              shots.map((s) => s.assetId),
            ),
          );
        return {
          versionId: chosen.versionId,
          shots,
          bytes: new Map(assets.map((a) => [a.id, a.bytes])),
        };
      });
      if (!data) {
        fidelity[projectId] = {
          case: caseId,
          error: "no_final_qa_screenshots",
        };
        continue;
      }
      const pairs = fidelityPairs(manifest.cases[caseId].shots, data.shots);
      const scored = await scoreReferenceFidelity(
        client,
        {
          modelKey: judge.key,
          providerModel: judge.providerModel,
          pairs: pairs.map((pair) => {
            const kind = pair.page.includes("phone") ? "phone" : "desktop";
            return {
              page: pair.page,
              reference: pair.reference.map((shot) => ({
                label: shot.page,
                kind,
                bytes: readFileSync(join(referencesDir, caseId, shot.file)),
              })),
              theme: pair.theme.flatMap((shot) => {
                const bytes = data.bytes.get(shot.assetId);
                return bytes
                  ? [{ label: `${shot.surface} ${shot.viewport}`, kind, bytes }]
                  : [];
              }),
            };
          }),
        },
        AbortSignal.timeout(300_000),
      );
      fidelity[projectId] = scored.ok
        ? {
            case: caseId,
            versionId: data.versionId,
            pages: pairs.map((p) => p.page),
            ...scored.score,
            estimatedCostMicroUsd: scored.costMicroUsd,
          }
        : { case: caseId, versionId: data.versionId, error: scored.reason };
      console.log(
        `${caseId}: ${scored.ok ? JSON.stringify(scored.score.scores) : scored.reason}`,
      );
      await persist(finished);
    }
  }
  console.log(`Saved ${out}`);
  // DB pools are intentionally process-lifetime in the app; this CLI exits.
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Benchmark failed");
    process.exit(1);
  });
