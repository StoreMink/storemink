/**
 * The visual reviewer's fixture benchmark: can it SEE a defect?
 *
 *   npm run theme-studio:visual-fixtures
 *       Offline. Renders every fixture (lib/theme-studio/visual-fixtures.ts)
 *       in local Chrome at phone390 and desktop1440 with production CSS,
 *       runs the screenshots through the real evidence builder and the real
 *       request builder, and answers with the offline fake client. Proves
 *       the mechanism and writes the pages, screenshots and evidence sizes
 *       to --out; grades nothing (the fake always passes).
 *
 *   npm run theme-studio:visual-fixtures -- --live --yes
 *       Live. The same evidence goes to the production reviewer model on
 *       Vertex AI (HIGH effort, no output cap), once per fixture: twenty
 *       reviews, about $0.50 to $1.50 (estimate; the report records usage).
 *       Graded on findings, never on the verdict (fixtureBenchmarkSummary):
 *       every one of the 8 serious pages must produce its named serious
 *       finding, both warning pages at least a warning, and at least 9 of the
 *       10 clean pages no serious finding (VISUAL_FIXTURE_BAR), or the script
 *       exits 1. Needs ADC and THEME_STUDIO_GCP_PROJECT_ID (or
 *       GCP_PROJECT_ID). No database, no private theme data, no writes.
 *
 * Options: --out=<dir> (default: a new temp directory), --only=<id,id,…>,
 * --theme=<bundled theme id> (default: the first bundled theme). Chrome:
 * CHROME_EXECUTABLE_PATH, else /Applications/Google Chrome, else the capture
 * job's Playwright Chromium (install its dependencies first).
 */
import { loadEnvConfig } from "@next/env";
import type { FixtureResult } from "../lib/theme-studio/visual-fixtures";
import type { ThemeStudioModelClient } from "../lib/theme-studio/provider";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

loadEnvConfig(process.cwd(), true, { info: () => {}, error: () => {} });

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const VIEWPORTS = [
  { key: "phone390", width: 390, height: 844 },
  { key: "desktop1440", width: 1440, height: 900 },
] as const;

async function main() {
  const live = process.argv.includes("--live");
  if (live && !process.argv.includes("--yes")) {
    console.error(
      "A live run sends twenty reviews to the paid reviewer model. Re-run with --yes.",
    );
    process.exit(2);
  }
  const only = option("only")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out =
    option("out") ??
    mkdtempSync(join(tmpdir(), "theme-studio-visual-fixtures-"));
  mkdirSync(out, { recursive: true });

  const { THEME_DEFINITIONS } = await import("../lib/themes");
  const {
    VISUAL_FIXTURES,
    fixtureDocument,
    fixtureBenchmarkSummary,
    fixtureCaught,
  } = await import("../lib/theme-studio/visual-fixtures");
  const { buildVisualQaRequest, classifyVisualQaReport, parseVisualQaReport } =
    await import("../lib/theme-studio/visual-qa-request");
  const { buildVisualEvidence, prepareVisualScreenshot } =
    await import("../lib/theme-studio/visual-evidence");
  const { themeDefinitionToPackageV2 } =
    await import("../lib/theme-studio/contracts");
  const { resolveThemeStudioModel } =
    await import("../lib/theme-studio/models");

  const themeId = option("theme") ?? THEME_DEFINITIONS[0].id;
  const theme = THEME_DEFINITIONS.find((t) => t.id === themeId);
  if (!theme) throw new Error(`Unknown bundled theme ${themeId}`);
  const packageJson = themeDefinitionToPackageV2(theme);
  const fixtures = VISUAL_FIXTURES.filter((f) => !only || only.includes(f.id));
  if (fixtures.length === 0) throw new Error("No fixtures selected");

  // The reviewer, exactly as production builds it (visual-qa.ts qaClient).
  const modelKey = "gemini-3.8-flash" as const;
  let providerModel = "fake";
  let client: ThemeStudioModelClient;
  if (live) {
    const { createVertexModelClient, getVertexConfig } =
      await import("../lib/theme-studio/gemini-vertex");
    const config = getVertexConfig();
    if (!config) {
      console.error(
        "No Vertex configuration (ADC + THEME_STUDIO_GCP_PROJECT_ID / GCP_PROJECT_ID).",
      );
      process.exit(2);
    }
    client = createVertexModelClient(config);
    providerModel = resolveThemeStudioModel(modelKey).providerModel;
  } else {
    const { createFakeModelClient } =
      await import("../lib/theme-studio/fake-provider");
    client = createFakeModelClient({
      name: theme.name,
      brief: "visual fixture benchmark",
      industries: [],
      catalogSizes: [],
      requiredFeatures: [],
      referenceCount: 0,
      answered: true,
    });
  }

  // Production CSS. The footer module's `:global()` wrappers are stripped so
  // its selectors match the plain class names the fixture footer uses.
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const css = [
    read("../app/(storefront)/storefront-theme.css"),
    read("../app/(storefront)/components/homepage/homepage.css"),
    read("../app/(storefront)/(pages)/shop/shop.css"),
    read("../app/(storefront)/components/footer/Footer.module.css").replace(
      /:global\(([^)]+)\)/g,
      "$1",
    ),
  ].join("\n");

  const requireJob = createRequire(
    new URL("../jobs/theme-studio-capture/package.json", import.meta.url),
  );
  const { chromium } = requireJob("playwright-core");
  const macChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_EXECUTABLE_PATH ||
      (existsSync(macChrome) ? macChrome : chromium.executablePath()),
    headless: true,
  });

  const results: FixtureResult[] = [];
  const report: Record<string, unknown>[] = [];
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route: { abort: () => Promise<void> }) =>
      route.abort(),
    );
    for (const fixture of fixtures) {
      const started = Date.now();
      const html = fixtureDocument(fixture, theme, css);
      writeFileSync(join(out, `${fixture.id}.html`), html);
      const shots = new Map<string, Buffer>();
      const samples: {
        assetId: string;
        viewport: string;
        page: string;
        width: number;
        height: number;
      }[] = [];
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        await page.setContent(html, { waitUntil: "load" });
        const png = (await page.screenshot({
          fullPage: true,
          type: "png",
        })) as Buffer;
        const prepared = await prepareVisualScreenshot(png);
        const assetId = `${fixture.id}:${viewport.key}`;
        shots.set(assetId, prepared.bytes);
        writeFileSync(
          join(
            out,
            `${fixture.id}.${viewport.key}.${prepared.mediaType === "image/png" ? "png" : "webp"}`,
          ),
          prepared.bytes,
        );
        samples.push({
          assetId,
          viewport: viewport.key,
          page: "home /",
          width: prepared.width,
          height: prepared.height,
        });
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
      let parsed: ReturnType<typeof parseVisualQaReport> = null;
      let usage: unknown = null;
      let error: string | null = null;
      try {
        const evidence = await buildVisualEvidence(
          samples,
          async (id) => {
            const bytes = shots.get(id);
            if (!bytes) throw new Error(`missing screenshot ${id}`);
            return bytes;
          },
          controller.signal,
        );
        const request = buildVisualQaRequest({
          modelKey,
          providerModel,
          projectName: theme.name,
          originalBrief: fixture.brief,
          packageJson,
          browserReport: {
            gates: [],
            evidence: {
              samples: samples.map((s) => ({
                viewport: s.viewport,
                path: "/",
                surface: "home",
                width: s.width,
                height: s.height,
              })),
            },
          },
          issues: [],
          evidence,
          images: [],
        });
        const imageBlocks = request.content.filter(
          (b) => b.type === "image",
        ).length;
        if (imageBlocks < 4)
          throw new Error(`expected ≥4 evidence images, got ${imageBlocks}`);
        const result = await client.generate(request, controller.signal);
        if (result.kind !== "ok") throw new Error(`provider_${result.kind}`);
        usage = result.usage;
        parsed = parseVisualQaReport(result.value);
        if (!parsed) throw new Error("qa_output_invalid");
        report.push({
          id: fixture.id,
          expected: fixture.expected,
          finding: fixture.finding,
          defect: fixture.defect,
          verdict: parsed.verdict,
          reviewSeverity: classifyVisualQaReport(parsed, []),
          scores: parsed.scores,
          rejections: parsed.rejections,
          findings: parsed.findings,
          revisionBrief: parsed.revisionBrief,
          evidenceImages: imageBlocks,
          usage,
          ms: Date.now() - started,
        });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        report.push({
          id: fixture.id,
          expected: fixture.expected,
          finding: fixture.finding,
          defect: fixture.defect,
          verdict: null,
          error,
          ms: Date.now() - started,
        });
      } finally {
        clearTimeout(timeout);
      }
      const graded: FixtureResult = {
        id: fixture.id,
        expected: fixture.expected,
        finding: fixture.finding,
        report: parsed,
      };
      results.push(graded);
      const got = parsed
        ? classifyVisualQaReport(parsed, [])
        : { outcome: "none", serious: [] };
      const mark = error ? "ERR " : fixtureCaught(graded) ? " ok " : "MISS";
      console.log(
        `${mark} ${fixture.id.padEnd(30)} expected ${(fixture.finding ?? fixture.expected).padEnd(18)} got ${got.outcome}${got.serious.length ? ` (${got.serious.map((f) => f.code).join(", ")})` : ""}${error ? ` ${error}` : ""}`,
      );
    }
  } finally {
    await browser.close();
  }

  const summary = fixtureBenchmarkSummary(results);
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        live,
        theme: theme.id,
        providerModel,
        promptVersion: (await import("../lib/theme-studio/visual-qa-request"))
          .VISUAL_QA_PROMPT_VERSION,
        summary,
        fixtures: report,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${out}/report.json`);
  if (!live) {
    const failed = report.filter((r) => r.error);
    console.log(
      failed.length
        ? `Offline mechanism check FAILED for ${failed.length} fixture(s).`
        : `Offline mechanism check passed for ${report.length} fixtures (fake reviewer; nothing graded).`,
    );
    if (failed.length) process.exit(1);
    return;
  }
  console.log(
    `Serious pages with their finding ${summary.serious.caught}/${summary.serious.total}` +
      (summary.serious.missed.length
        ? ` (missed: ${summary.serious.missed.join(", ")})`
        : "") +
      `\nWarning pages with at least a warning ${summary.warnings.caught}/${summary.warnings.total}` +
      (summary.warnings.missed.length
        ? ` (missed: ${summary.warnings.missed.join(", ")})`
        : "") +
      `\nClean pages with no serious finding ${summary.clean.passed}/${summary.clean.total}` +
      (summary.clean.falseFails.length
        ? ` (false blocks: ${summary.clean.falseFails.join(", ")})`
        : "") +
      `\n${summary.ok ? "PASS" : "FAIL"}: the bar is 90% in every set.`,
  );
  if (!summary.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
