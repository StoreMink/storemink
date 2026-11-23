/**
 * Copy a Theme Studio theme's published releases from one environment to
 * another (the decisions and the reasons are in theme-release-copy-core.ts).
 *
 *   # 1. Read the releases out of the database this shell points at (local):
 *   npm run theme-release:copy -- export roast volt --out /path/to/themes.json
 *
 *   # 2. Dry run against the target: prints what would happen, writes nothing.
 *   npm run theme-release:copy -- import /path/to/themes.json
 *
 *   # 3. Write. Needs the target's name twice and who is doing it.
 *   npm run theme-release:copy -- import /path/to/themes.json --commit \
 *     --confirm-database <DB_NAME> --by <your email> --root-domain storemink.com
 *
 * ★ DRY RUN BY DEFAULT. A write needs --commit AND --confirm-database naming
 *   the database it will change. Staging and production are two databases in
 *   one Cloud SQL instance, so the proxy being up says nothing about which
 *   one is read. A shell variable beats .env and .env.local, so with
 *   `npm run db:proxy` running, production is:
 *
 *   DB_HOST=127.0.0.1 DB_PORT=6543 DB_USER=app \
 *   DB_PASSWORD="$(gcloud secrets versions access latest \
 *     --secret=CLOUDSQL_PROD_APP_PW --project=storemink-prod)" \
 *   DB_NAME=storemink npm run theme-release:copy -- import themes.json
 *
 *   and staging the same with DB_NAME=storemink_staging.
 *
 * ★ THE TARGET MUST RUN CODE THAT UNDERSTANDS THE THEME. The package is
 *   checked here with THIS checkout's validator; a target still serving an
 *   older build would store the release and then refuse to render it.
 * ★ EXPOSURE IS LAST, as at Publish: releases, then the demo store, then
 *   (with --root-domain) the demo's pages are fetched, and only then does the
 *   catalogue point at the release. A theme whose demo does not render is not
 *   offered.
 * ★ `--visibility hidden` copies a theme without offering it to merchants.
 * ⚠ Revalidation is a no-op in a script (scripts/_stubs/next-cache.ts), so a
 *   running server may show the catalogue as it was for up to 300 seconds.
 *
 * Safe to run again: a release that is already there with the same content is
 * left alone, the demo store is reset and seeded again, and a catalogue that
 * already offers the same version is not touched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadEnvConfig } from "@next/env";
import {
  COPY_FORMAT,
  describePlan,
  parseExportFile,
  pictureUrls,
  planCopy,
  type CatalogVisibility,
  type ExportFile,
  type ExportedTheme,
  type TargetTheme,
} from "./theme-release-copy-core";

loadEnvConfig(process.cwd(), true, {
  info: () => {},
  error: () => {},
});

const args = process.argv.slice(2);
function option(name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}
const flag = (name: string) => args.includes(name);
const OPTIONS_WITH_VALUES = new Set([
  "--out",
  "--confirm-database",
  "--by",
  "--root-domain",
  "--visibility",
]);
/** The arguments that are not options or their values. */
function positionals(): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (OPTIONS_WITH_VALUES.has(args[i])) i += 1;
    else if (!args[i].startsWith("--")) out.push(args[i]);
  }
  return out;
}

const dbName = process.env.DB_NAME ?? "(unset)";

async function exportThemes(themeIds: string[], out: string): Promise<number> {
  const { withService } = await import("@/lib/db/client");
  const { themeReleases, themeCatalogEntries } =
    await import("@/drizzle/schema");
  const { and, eq, inArray } = await import("drizzle-orm");
  const rows = await withService((db) =>
    db
      .select({
        id: themeReleases.id,
        themeId: themeReleases.themeId,
        version: themeReleases.version,
        manifestDigest: themeReleases.manifestDigest,
        packageJson: themeReleases.packageJson,
      })
      .from(themeReleases)
      .where(
        and(
          inArray(themeReleases.themeId, themeIds),
          eq(themeReleases.releaseStatus, "published"),
          // Bundled themes are copied from source control, by
          // theme-registry:import.
          eq(themeReleases.source, "theme-studio"),
        ),
      ),
  );
  const catalog = await withService((db) =>
    db
      .select({
        themeId: themeCatalogEntries.themeId,
        currentReleaseId: themeCatalogEntries.currentReleaseId,
        visibility: themeCatalogEntries.visibility,
      })
      .from(themeCatalogEntries)
      .where(inArray(themeCatalogEntries.themeId, themeIds)),
  );
  const themes: ExportedTheme[] = [];
  for (const themeId of themeIds) {
    const releases = rows.filter((row) => row.themeId === themeId);
    if (releases.length === 0) {
      console.error(
        `No published Theme Studio release of "${themeId}" in ${dbName}.`,
      );
      return 1;
    }
    const entry = catalog.find((row) => row.themeId === themeId);
    const current = releases.find((row) => row.id === entry?.currentReleaseId);
    themes.push({
      themeId,
      currentVersion: current?.version ?? null,
      visibility: (entry?.visibility as CatalogVisibility | undefined) ?? null,
      releases: releases.map((row) => ({
        version: row.version,
        manifestDigest: row.manifestDigest,
        package: row.packageJson,
      })),
    });
  }
  const file: ExportFile = {
    format: COPY_FORMAT,
    sourceDatabase: dbName,
    exportedAt: new Date().toISOString(),
    themes,
  };
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`Read from ${dbName}:`);
  for (const theme of themes) {
    console.log(
      `  ${theme.themeId}: ${theme.releases
        .map((r) => `v${r.version}`)
        .sort()
        .join(
          ", ",
        )}; offered at ${theme.currentVersion ? `v${theme.currentVersion} (${theme.visibility})` : "no version"}`,
    );
  }
  console.log(`Written to ${out}`);
  return 0;
}

/** Whether every picture a package names can be fetched. */
async function missingPictures(urls: string[]): Promise<string[]> {
  const missing: string[] = [];
  const queue = [...urls];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        try {
          const response = await fetch(url, {
            method: "HEAD",
            signal: AbortSignal.timeout(20_000),
          });
          if (!response.ok) missing.push(`${url} (${response.status})`);
        } catch (error) {
          missing.push(
            `${url} (${error instanceof Error ? error.message : "no answer"})`,
          );
        }
      }
    }),
  );
  return missing.sort();
}

/** The demo's pages, as Publish checks them. Empty when every one answers. */
async function demoProblems(
  origin: string,
  paths: string[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const path of paths) {
    let last = "no answer";
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 5_000));
      try {
        const response = await fetch(`${origin}${path}`, {
          redirect: "follow",
          signal: AbortSignal.timeout(60_000),
          headers: { "cache-control": "no-cache" },
        });
        last = `HTTP ${response.status}`;
        ok = response.ok;
      } catch (error) {
        last = error instanceof Error ? error.message : "no answer";
      }
    }
    if (!ok) problems.push(`${origin}${path}: ${last}`);
  }
  return problems;
}

async function importThemes(path: string): Promise<number> {
  const commit = flag("--commit");
  const confirm = option("--confirm-database");
  const by = option("--by");
  const rootDomain = option("--root-domain");
  const visibilityOption = option("--visibility");
  if (
    visibilityOption !== null &&
    !["public", "hidden", "legacy"].includes(visibilityOption)
  ) {
    console.error("--visibility must be public, hidden or legacy.");
    return 1;
  }
  if (commit && confirm !== dbName) {
    console.error(
      `A write needs --confirm-database ${dbName} (the database this shell points at).`,
    );
    return 1;
  }
  if (commit && (!by || !/^[^@\s]+@[^@\s]+$/.test(by))) {
    console.error("A write needs --by <your email>, for the catalogue's log.");
    return 1;
  }

  const parsed = parseExportFile(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.ok) {
    for (const problem of parsed.problems) console.error(problem);
    return 1;
  }
  const file = parsed.file;

  const { validateThemePackageV2 } =
    await import("@/lib/theme-studio/contracts");
  const {
    digestThemePackage,
    insertThemeReleaseWithDb,
    loadExactReleaseWithDb,
  } = await import("@/lib/themes/runtime-registry");
  const { withService } = await import("@/lib/db/client");
  const {
    stores,
    themeCatalogAudit,
    themeCatalogEntries,
    themeReleases,
    themeStudioDeletionAudit,
  } = await import("@/drizzle/schema");
  const { eq, inArray } = await import("drizzle-orm");

  // ── 1. Every package must be one THIS code accepts, unchanged. ───────────
  const problems: string[] = [];
  const demoSlugs = new Map<string, string>();
  const urls = new Set<string>();
  for (const theme of file.themes) {
    for (const release of theme.releases) {
      const at = `${theme.themeId}@${release.version}`;
      const checked = validateThemePackageV2(release.package);
      if (!checked.ok) {
        problems.push(
          `${at} is not a valid theme package: ${checked.issues.join(" ")}`,
        );
        continue;
      }
      const definition = checked.value.definition;
      if (
        definition.id !== theme.themeId ||
        definition.release.version !== release.version
      ) {
        problems.push(
          `${at} holds the package of ${definition.id}@${definition.release.version}.`,
        );
      }
      if (definition.release.status !== "published") {
        problems.push(`${at} is not a published release.`);
      }
      if (digestThemePackage(checked.value) !== release.manifestDigest) {
        problems.push(
          `${at} does not match its own content digest: this code reads the package differently from the code that stored it.`,
        );
      }
      demoSlugs.set(theme.themeId, definition.demo.slug);
      for (const url of pictureUrls(checked.value)) urls.add(url);
    }
  }
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    return 1;
  }

  // ── 2. Its pictures must be where the package says they are. ─────────────
  if (!flag("--skip-picture-check")) {
    const missing = await missingPictures([...urls]);
    if (missing.length) {
      console.error(
        `${missing.length} of ${urls.size} pictures cannot be fetched, so nothing is copied:`,
      );
      for (const line of missing.slice(0, 20)) console.error(`  ${line}`);
      return 1;
    }
    console.log(`Pictures: all ${urls.size} can be fetched.`);
  }

  // ── 3. What the target holds now. ────────────────────────────────────────
  const themeIds = file.themes.map((theme) => theme.themeId);
  const target = await withService(async (db) => {
    const releases = await db
      .select({
        id: themeReleases.id,
        themeId: themeReleases.themeId,
        version: themeReleases.version,
        manifestDigest: themeReleases.manifestDigest,
      })
      .from(themeReleases)
      .where(inArray(themeReleases.themeId, themeIds));
    const catalog = await db
      .select({
        themeId: themeCatalogEntries.themeId,
        currentReleaseId: themeCatalogEntries.currentReleaseId,
        visibility: themeCatalogEntries.visibility,
      })
      .from(themeCatalogEntries)
      .where(inArray(themeCatalogEntries.themeId, themeIds));
    const demos = await db
      .select({ slug: stores.slug, settings: stores.settings })
      .from(stores)
      .where(inArray(stores.slug, [...demoSlugs.values()]));
    const deleted = await db
      .select({ themeId: themeStudioDeletionAudit.themeId })
      .from(themeStudioDeletionAudit)
      .where(inArray(themeStudioDeletionAudit.themeId, themeIds));
    const state = new Map<string, TargetTheme>();
    for (const themeId of themeIds) {
      const mine = releases.filter((row) => row.themeId === themeId);
      const entry = catalog.find((row) => row.themeId === themeId);
      const current = mine.find((row) => row.id === entry?.currentReleaseId);
      const demo = demos.find((row) => row.slug === demoSlugs.get(themeId));
      state.set(themeId, {
        releases: new Map(mine.map((row) => [row.version, row.manifestDigest])),
        catalog:
          entry && current
            ? {
                version: current.version,
                visibility: entry.visibility as CatalogVisibility,
              }
            : null,
        demoStore: demo
          ? {
              isDemo:
                (demo.settings as Record<string, unknown> | null)?.demo ===
                true,
            }
          : null,
        deleted: deleted.some((row) => row.themeId === themeId),
      });
    }
    return state;
  });

  const plan = planCopy(file, target, {
    visibility: visibilityOption as CatalogVisibility | null,
  });
  console.log(`\nFrom ${file.sourceDatabase} (exported ${file.exportedAt})`);
  console.log(`Into ${dbName}\n`);
  if (!plan.ok) {
    for (const problem of plan.problems) console.error(problem);
    return 1;
  }
  for (const line of describePlan(plan.themes)) console.log(line);

  if (!commit) {
    console.log(
      `\nDry run only: nothing was written. To write, add --commit --confirm-database ${dbName} --by <your email>${rootDomain ? "" : " --root-domain <the target's domain>"}.`,
    );
    return 0;
  }

  // ── 4. Write, one theme at a time, exposure last. ────────────────────────
  const { upsertDemoStoreRow } = await import("@/lib/themes/demo-store");
  const { applyThemeDefinition } = await import("@/lib/themes/apply");
  let failed = 0;
  for (const step of plan.themes) {
    const theme = file.themes.find((t) => t.themeId === step.themeId)!;
    console.log(`\n${step.themeId}:`);
    for (const release of step.releases) {
      const source = theme.releases.find((r) => r.version === release.version)!;
      const stored = await withService((db) =>
        insertThemeReleaseWithDb(db, {
          package: source.package,
          source: "theme-studio",
        }),
      );
      console.log(
        `  release v${release.version}: ${stored.inserted ? "stored" : "already there"}`,
      );
    }
    if (!step.expose) continue;

    const release = await withService((db) =>
      loadExactReleaseWithDb(db, step.themeId, step.expose!.version),
    );
    if (!release) {
      console.error(
        `  v${step.expose.version} was stored but cannot be read back as a theme. Nothing is offered.`,
      );
      failed += 1;
      continue;
    }
    const definition = release.definition;
    const { storeId, created } = await withService((db) =>
      upsertDemoStoreRow(db, definition),
    );
    const seeded = await applyThemeDefinition(storeId, definition, {
      publish: true,
      reset: true,
      publishSampleProducts: true,
    });
    if (!seeded.success) {
      console.error(
        `  demo store ${definition.demo.slug}: seeding failed, so the theme is not offered: ${seeded.errors.join("; ")}`,
      );
      failed += 1;
      continue;
    }
    console.log(
      `  demo store ${definition.demo.slug}: ${created ? "created" : "reset"} and seeded`,
    );

    if (rootDomain) {
      const product = definition.preset.sampleData?.products[0];
      const origin = `https://${definition.demo.slug}.${rootDomain}`;
      const broken = await demoProblems(origin, [
        "/",
        "/shop",
        ...(product ? [`/shop/${product.slug}`] : []),
        "/cart",
      ]);
      if (broken.length) {
        console.error(
          "  the demo store does not render, so the theme is not offered:",
        );
        for (const line of broken) console.error(`    ${line}`);
        failed += 1;
        continue;
      }
      console.log(`  demo pages at ${origin}: all answer`);
    } else {
      console.log(
        "  demo pages: not checked (no --root-domain). Open the demo before relying on it.",
      );
    }

    if (step.catalog === "unchanged") {
      console.log(
        `  catalogue: already offers v${step.expose.version} as ${step.expose.visibility}`,
      );
      continue;
    }
    await withService(async (db) => {
      const [previous] = await db
        .select()
        .from(themeCatalogEntries)
        .where(eq(themeCatalogEntries.themeId, step.themeId))
        .limit(1);
      await db
        .insert(themeCatalogEntries)
        .values({
          themeId: step.themeId,
          currentReleaseId: release.id,
          visibility: step.expose!.visibility,
        })
        .onConflictDoUpdate({
          target: themeCatalogEntries.themeId,
          set: {
            currentReleaseId: release.id,
            visibility: step.expose!.visibility,
          },
        });
      await db.insert(themeCatalogAudit).values({
        themeId: step.themeId,
        action: "publish",
        releaseId: release.id,
        visibility: step.expose!.visibility,
        previousReleaseId: previous?.currentReleaseId ?? null,
        previousVisibility: previous?.visibility ?? null,
        projectId: null,
        reason: `Copied ${step.themeId}@${step.expose!.version} from ${file.sourceDatabase} with scripts/theme-release-copy.ts.`,
        createdBy: null,
        createdByEmail: by!,
      });
    });
    console.log(
      `  catalogue: now offers v${step.expose.version} as ${step.expose.visibility}`,
    );
  }
  console.log(
    failed
      ? `\n${failed} theme(s) were NOT offered. See the lines above.`
      : "\nDone. A running server may show the catalogue as it was for up to 300 seconds.",
  );
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  const [mode, ...rest] = positionals();
  if (mode === "export") {
    const out = option("--out");
    if (rest.length === 0 || !out) {
      console.error(
        "Usage: npm run theme-release:copy -- export <themeId...> --out <file>",
      );
      return 1;
    }
    return exportThemes(rest, out);
  }
  if (mode === "import" && rest.length === 1) return importThemes(rest[0]);
  console.error(
    "Usage: npm run theme-release:copy -- export <themeId...> --out <file>\n       npm run theme-release:copy -- import <file> [--commit --confirm-database <DB_NAME> --by <email>] [--root-domain <domain>] [--visibility public|hidden]",
  );
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The pool would otherwise keep the process open.
    await (await import("@/lib/db/client")).closePool().catch(() => {});
  });
