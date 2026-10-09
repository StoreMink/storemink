/**
 * The seven exemplar themes (lib/themes/exemplars/) through the acceptance
 * gates, offline and without a Studio project — plan Phase 2's exit evidence.
 *
 *   npm run theme-studio:exemplars
 *     The package stage for every exemplar: the real package gates
 *     (lib/theme-studio/acceptance-gates.ts, evaluatePackageGates) over a
 *     package whose asset manifest is built from the bundled image files
 *     themselves — digests, dimensions, bytes — exactly as the Studio builds
 *     one from stored assets. No database, no server, no network.
 *
 *   npm run theme-studio:exemplars -- --seed
 *     Also store each exemplar in the CURRENT database's runtime registry
 *     (a published release with no catalog pointer, versioned by content so
 *     an edited exemplar is a new immutable row) and seed it as its demo store
 *     (demo-<id>), the way scripts/seed-demo-store.ts seeds a bundled
 *     theme. Refused against production.
 *
 *   npm run theme-studio:exemplars -- --origin=http://127.0.0.1:3000
 *     Also the route stage: fetch the preview pages from a running local
 *     server with the demo store's Host header and run the same route,
 *     link and markup gates the Studio runs over its preview store.
 *
 *   npm run theme-studio:exemplars -- --origin=http://127.0.0.1:3000 --browser
 *     Also the browser stage, in local Chrome at the five QA widths: the
 *     deterministic rules of the acceptance probe (overflow, tap targets,
 *     image crops, broken images, axe WCAG 2.1 A/AA with contrast) on every
 *     page, and the header's chrome states (menu, search, cart, account,
 *     sign-in) opened and audited on the home page. ⚠ A mirror of the probe's
 *     rules, not the probe: the probe renders only on a Studio preview
 *     store, and LCP/CLS and the probe's clipped-text scan are the deployed
 *     run's to measure. Those two gates are reported as skipped.
 *
 *   --only=<id>  one exemplar.  --out=<file>  write the JSON report.
 *
 * Exit 1 when any required gate fails. `--tsconfig tsconfig.scripts.json`
 * is required (scripts/_stubs maps next/cache and server-only).
 */
import { loadEnvConfig } from "@next/env";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

loadEnvConfig(process.cwd(), true, { info: () => {}, error: () => {} });

const option = (name: string) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

const MAC_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function main() {
  const { EXEMPLAR_THEMES } = await import("@/lib/themes/exemplars");
  const { collectThemeImageUrls, MERCHANT_AUTHORED_SLUGS } =
    await import("@/lib/themes/validation");
  const { themeDefinitionToPackageV2 } =
    await import("@/lib/theme-studio/contracts");
  const gatesModule = await import("@/lib/theme-studio/acceptance-gates");
  const {
    evaluatePackageGates,
    gate,
    routeRenderFindings,
    renderedWithTheme,
    linkFindings,
    internalLinks,
    markupFindings,
    THEME_STUDIO_QA_VIEWPORTS,
  } = gatesModule;
  const { previewPagesFor } = await import("@/lib/theme-studio/preview");
  const sharp = (await import("sharp")).default;

  const only = option("only");
  const origin = option("origin")?.replace(/\/$/, "");
  const browser = flag("browser");
  const seed = flag("seed");
  const out = option("out");
  const themes = EXEMPLAR_THEMES.filter((t) => !only || t.id === only);
  if (!themes.length) throw new Error(`No exemplar named ${only}.`);
  if (browser && !origin) throw new Error("--browser needs --origin.");

  if (seed) {
    const dbName = process.env.DB_NAME ?? "";
    if (dbName === "storemink")
      throw new Error("Refusing to seed exemplar stores into production.");
    const { withService } = await import("@/lib/db/client");
    const { upsertDemoStoreRow } = await import("@/lib/themes/demo-store");
    const { applyThemeDefinition } = await import("@/lib/themes/apply");
    const { digestThemePackage, insertThemeReleaseWithDb } =
      await import("@/lib/themes/runtime-registry");
    for (const theme of themes) {
      // The storefront renders an installed theme from the runtime registry
      // (an exact id + version), else a bundled definition, else nothing: an
      // exemplar is neither, so a store pinned to the definition alone renders
      // UN-THEMED and every browser measurement would be of the bare
      // storefront. The seed therefore stores the exemplar as a release the
      // registry will serve (only a published row renders) with no catalog
      // pointer, so it never reaches the public catalogue or signup. Release
      // rows are immutable, so an edited exemplar gets a NEW patch version
      // derived from its content digest rather than a rewritten row; the
      // store is re-pinned to it below. Local only (the script refuses prod).
      const digest = digestThemePackage(themeDefinitionToPackageV2(theme));
      const [major, minor] = theme.release.version.split(".");
      const version = `${major}.${minor}.${parseInt(digest.slice(0, 6), 16)}`;
      const stored = {
        ...theme,
        release: { ...theme.release, status: "published" as const, version },
      };
      const { inserted } = await withService((db) =>
        insertThemeReleaseWithDb(db, {
          package: themeDefinitionToPackageV2(stored),
          source: "bundled-import",
        }),
      );
      const { storeId, created } = await withService((db) =>
        upsertDemoStoreRow(db, stored),
      );
      const result = await applyThemeDefinition(storeId, stored, {
        publish: true,
        reset: true,
        publishSampleProducts: true,
      });
      console.log(
        `seed ${theme.demo.slug} (${dbName}): ${created ? "created" : "reset"}, registry ${theme.id}@${version} ${inserted ? "inserted" : "present"}${result.errors?.length ? `, ${result.errors.length} warning(s): ${result.errors.join("; ")}` : ""}`,
      );
    }
    console.log(
      "seed: a running dev server caches store rows for up to 300s; restart it (or wait) before the route stage.",
    );
  }

  type Report = {
    id: string;
    gates: ReturnType<typeof gate>[];
    browser?: unknown;
  };
  const reports: Report[] = [];
  let failed = false;

  for (const theme of themes) {
    const gates: ReturnType<typeof gate>[] = [];

    // ---- package stage: the real gates over a real manifest ----------------
    // The package is judged in the Studio's own form: every picture a
    // `theme-asset://<slot>` reference (the security gate refuses any other
    // address) backed by a declared asset with its digest, and the preview
    // store seeded from the resolved definition — the same split the Studio
    // makes between a stored package and the store it materialises.
    const slotRe = new RegExp(`/themes/${theme.id}/([a-z0-9-]+)\\.webp`, "g");
    const slotted = JSON.parse(
      JSON.stringify(theme).replace(slotRe, "theme-asset://$1"),
    ) as typeof theme;
    const base = themeDefinitionToPackageV2(slotted);
    const rows: import("@/lib/theme-studio/acceptance-gates").AcceptanceAssetRow[] =
      [];
    const assets: typeof base.assets = [];
    // The bundled set the exemplar's folder links to (public/themes/README.md).
    const folder = join(process.cwd(), "public", "themes", theme.id);
    const borrowed = lstatSync(folder).isSymbolicLink()
      ? readlinkSync(folder)
      : theme.id;
    let index = 0;
    for (const path of [...collectThemeImageUrls(theme)].sort()) {
      const slot = `theme-asset://${path
        .split("/")
        .pop()!
        .replace(/\.webp$/, "")}`;
      const file = join(process.cwd(), "public", path);
      if (!existsSync(file)) {
        gates.push(
          gate("assets.integrity", [
            {
              code: "missing",
              message: `No file at public${path}.`,
              where: path,
            },
          ]),
        );
        continue;
      }
      const bytes = readFileSync(file);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const meta = await sharp(bytes).metadata();
      const id = `img-${String(++index).padStart(2, "0")}`;
      const preview = path === theme.catalog.previewImage;
      rows.push({
        id,
        purpose: "image",
        mediaType: `image/${meta.format ?? "webp"}`,
        byteSize: bytes.byteLength,
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        sha256,
      });
      assets.push({
        id,
        path: slot,
        kind: preview ? "preview" : "content",
        source: "operator-owned",
        sha256,
        width: meta.width ?? null,
        height: meta.height ?? null,
        alt:
          theme.catalog.screenshots.find((s) => s.src === path)?.alt ??
          `${theme.name} ${path
            .split("/")
            .pop()
            ?.replace(/\.webp$/, "")
            .replace(/-/g, " ")}`,
        licenseNote: `Bundled StoreMink theme photography reused by the exemplar (${borrowed}; provenance in docs/theme-assets.md).`,
      });
    }
    const pkg = { ...base, assets };
    const packageStage = evaluatePackageGates(pkg, rows);
    gates.push(...packageStage.gates);

    // ---- route stage: the preview pages from a running server --------------
    const pages = packageStage.pkg ? previewPagesFor(packageStage.pkg) : [];
    const host = `${theme.demo.slug}.localhost${origin ? `:${new URL(origin).port || "80"}` : ""}`;
    const fetched: { path: string; html: string }[] = [];
    if (origin && packageStage.pkg) {
      process.env.THEME_STUDIO_ACCEPTANCE_ORIGIN = origin;
      const { fetchInternalPageWithRetry: fetchOnce } =
        await import("@/lib/theme-studio/acceptance-http");
      // A development server drops sockets while it compiles a page; three
      // refusals in a row is the server being down, one is not.
      const fetchInternalPageWithRetry = async (
        input: Parameters<typeof fetchOnce>[0],
      ) => {
        let response = await fetchOnce(input);
        for (let attempt = 0; attempt < 3; attempt++) {
          if (
            !/ECONNREFUSED|ECONNRESET|socket hang up/.test(response.error ?? "")
          )
            break;
          await new Promise((resolve) =>
            setTimeout(resolve, 2_000 * (attempt + 1)),
          );
          response = await fetchOnce(input);
        }
        return response;
      };
      const routes = [];
      for (const page of pages) {
        const response = await fetchInternalPageWithRetry({
          host,
          path: page.path,
          cookies: {},
          timeoutMs: 180_000,
        });
        const robots = String(response.headers["x-robots-tag"] ?? "");
        routes.push({
          surface: page.surface,
          path: page.path,
          status: response.status,
          themed: renderedWithTheme(response.body),
          noindex:
            /noindex/i.test(robots) ||
            /<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(
              response.body,
            ),
          error: response.error,
        });
        if (response.status === 200)
          fetched.push({ path: page.path, html: response.body });
        process.stdout.write(
          `  ${theme.id} ${page.path}: ${response.status ?? response.error}\n`,
        );
      }
      gates.push(gate("demo.materialize", []));
      gates.push(gate("routes.render", routeRenderFindings(routes)));
      // The Studio's own crawl filter (lib/theme-studio/acceptance.ts): the
      // preview pages themselves, the policy pages a merchant writes (a theme
      // cannot fix a missing one) and the signed-in surfaces are not crawled.
      const skippedPrefixes = [
        "/auth",
        "/checkout",
        "/profile",
        "/orders",
        "/notifications",
        "/blogs/write",
        "/blogs/my-submissions",
      ];
      const links = [
        ...new Set(fetched.flatMap((page) => internalLinks(page.html))),
      ].filter(
        (path) =>
          !pages.some((page) => page.path === path) &&
          !MERCHANT_AUTHORED_SLUGS.has(path.slice(1).split(/[?#]/)[0]) &&
          !skippedPrefixes.some(
            (prefix) =>
              path === prefix ||
              path.startsWith(`${prefix}/`) ||
              path.startsWith(`${prefix}?`),
          ),
      );
      const checked = [];
      for (const path of links.slice(0, 60)) {
        const response = await fetchInternalPageWithRetry({
          host,
          path,
          cookies: {},
          timeoutMs: 120_000,
        });
        checked.push({ path, status: response.status, error: response.error });
      }
      gates.push(gate("routes.links", linkFindings(checked)));
      gates.push(
        gate("routes.markup", markupFindings(fetched, `http://${host}`)),
      );
    }

    // ---- browser stage: the probe's deterministic rules, in local Chrome ---
    let browserReport: unknown;
    if (browser && origin && packageStage.pkg) {
      const requireJob = createRequire(
        new URL("../jobs/theme-studio-capture/package.json", import.meta.url),
      );
      const { chromium } = requireJob("playwright-core");
      const axe = readFileSync(
        createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
        "utf8",
      );
      // The in-page measurement, evaluated as text: see the probe file.
      const probeSource = readFileSync(
        new URL("./theme-studio-exemplar-probe.js", import.meta.url),
        "utf8",
      )
        .replace(/^\/\*[\s\S]*?\*\/\s*/, "")
        .replace(/^(\/\/.*\n)+/, "")
        // Prettier ends the file's one expression with a semicolon, which
        // cannot sit inside the call the string is wrapped in.
        .replace(/;\s*$/, "");
      const instance = await chromium.launch({
        executablePath:
          process.env.CHROME_EXECUTABLE_PATH ||
          (existsSync(MAC_CHROME) ? MAC_CHROME : chromium.executablePath()),
        headless: true,
      });
      const findings = {
        overflow: [] as { code: string; message: string; where: string }[],
        targets: [] as { code: string; message: string; where: string }[],
        crops: [] as { code: string; message: string; where: string }[],
        media: [] as { code: string; message: string; where: string }[],
        a11y: [] as { code: string; message: string; where: string }[],
        coverage: [] as { code: string; message: string; where: string }[],
      };
      const samples: Record<string, unknown>[] = [];
      try {
        for (const [name, size] of Object.entries(THEME_STUDIO_QA_VIEWPORTS)) {
          const context = await instance.newContext({
            viewport: size,
            isMobile: size.width < 800,
            hasTouch: size.width < 800,
            deviceScaleFactor: 1,
            // As the capture job measures (capture-job.mjs): no autoplay
            // and no fades, so axe never samples a carousel slide mid-fade.
            // Under "no-preference" the soft-and-natural re-run (2026-10-10)
            // reported its second slide's CTA at 4.33:1 in blended colours
            // (#f7f8f6 on #627b67) while the settled button is 5.7:1.
            reducedMotion: "reduce",
          });
          let page = await context.newPage();
          for (const preview of pages) {
            if (preview.surface === "not_found") continue;
            const url = `http://${host}${preview.path}`;
            const where = `${preview.path} @ ${name}`;
            try {
              await page.goto(url, { waitUntil: "load", timeout: 180_000 });
            } catch (error) {
              findings.coverage.push({
                code: "fetch",
                message: `Could not load: ${String(error).slice(0, 120)}`,
                where,
              });
              continue;
            }
            await page.addScriptTag({ content: axe });
            // The probe is evaluated as text, so the call and its argument
            // are part of the expression (a string expression gets no arg).
            // Raced in Node as well: page.evaluate has no timeout of its
            // own, and a hung measurement must become a coverage finding,
            // never a run that waits for ever.
            const sample = await Promise.race([
              page.evaluate(
                `(${probeSource})(${JSON.stringify({ home: preview.path === "/" })})`,
              ),
              new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), 150_000),
              ),
            ]);
            if (!sample) {
              findings.coverage.push({
                code: "timeout",
                message: "The measurement did not finish within 150 s.",
                where,
              });
              await page.close();
              page = await context.newPage();
              continue;
            }
            samples.push({
              theme: theme.id,
              viewport: name,
              path: preview.path,
              ...sample,
            });
            const s = sample as {
              overflowPx: number;
              offenders: string[];
              targets: { target: string; w: number; h: number }[];
              crops: { target: string; retained: number }[];
              broken: number;
              violations: {
                id: string;
                impact: string | null;
                nodes: { target: string; summary: string }[];
              }[];
              states: Record<string, unknown>[];
            };
            if (s.overflowPx > 1)
              findings.overflow.push({
                code: "overflow",
                message: `The page is ${s.overflowPx}px wider than the viewport${s.offenders.length ? ` (${s.offenders.join(", ")})` : ""}.`,
                where,
              });
            for (const t of s.targets.slice(0, 8))
              findings.targets.push({
                code: "target",
                message: `${t.target} is ${t.w}x${t.h}px (needs 24x24).`,
                where,
              });
            for (const c of s.crops.slice(0, 5))
              findings.crops.push({
                code: "crop",
                message: `${c.target} keeps only ${Math.round(c.retained * 100)}% of its picture.`,
                where,
              });
            if (s.broken)
              findings.media.push({
                code: "broken",
                message: `${s.broken} image(s) failed to load.`,
                where,
              });
            for (const v of s.violations)
              findings.a11y.push({
                code: v.id,
                message: `${v.impact}: ${v.nodes.map((n) => `${n.target} ${n.summary}`).join(" | ")}`,
                where,
              });
            for (const state of s.states) {
              const label = `${where} / ${String(state.state)}`;
              if (state.reason === "unopened" || state.reason === "stuck")
                findings.coverage.push({
                  code: String(state.reason),
                  message: `The ${String(state.state)} state was ${String(state.reason)}.`,
                  where: label,
                });
              for (const v of (state.violations as typeof s.violations) ?? [])
                findings.a11y.push({
                  code: v.id,
                  message: `${v.impact}: ${v.nodes.map((n) => `${n.target} ${n.summary}`).join(" | ")}`,
                  where: label,
                });
              for (const t of (state.smallTargets as string[]) ?? [])
                findings.targets.push({
                  code: "target",
                  message: `${t} (needs 24x24).`,
                  where: label,
                });
            }
            process.stdout.write(
              `  ${theme.id} ${preview.path} @ ${name}: overflow ${s.overflowPx}px, ${s.targets.length} small target(s), ${s.violations.length} axe, ${s.broken} broken, states ${s.states.map((st) => `${st.state}:${st.reason ?? "ok"}`).join(" ")}\n`,
            );
          }
          await context.close();
        }
      } finally {
        await instance.close();
      }
      gates.push(
        gate("browser.coverage", findings.coverage),
        gate("browser.overflow", findings.overflow),
        gate(
          "browser.clipped_text",
          [
            {
              code: "skipped",
              message:
                "The probe's clipped-text scan runs only on a Studio preview store; the deployed acceptance run measures it.",
            },
          ],
          { status: "skipped" },
        ),
        gate("browser.tap_targets", findings.targets),
        gate("browser.image_crops", findings.crops),
        gate("browser.accessibility", findings.a11y),
        gate("browser.media", findings.media),
        gate(
          "browser.performance",
          [
            {
              code: "skipped",
              message:
                "LCP and CLS are frozen by the probe on a Studio preview store; the deployed acceptance run measures them.",
            },
          ],
          { status: "skipped", required: false },
        ),
      );
      browserReport = { samples };
    }

    reports.push({ id: theme.id, gates, browser: browserReport });
    const bad = gates.filter((g) => g.status === "fail" && g.required);
    if (bad.length) failed = true;
    console.log(
      `\n${theme.id}: ${bad.length ? "FAIL" : "pass"}  ${gates
        .map((g) => `${g.id}=${g.status}`)
        .join("  ")}`,
    );
    for (const g of gates)
      for (const f of g.findings)
        if (g.status !== "skipped")
          console.log(
            `    ${g.id} ${f.code}${f.where ? ` [${f.where}]` : ""}: ${f.message}`,
          );
  }

  if (out) writeFileSync(out, JSON.stringify({ reports }, null, 2));
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
