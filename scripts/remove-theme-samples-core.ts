// ---------------------------------------------------------------------------
// The testable half of scripts/remove-theme-samples.ts: argument parsing, the
// safety gate, which stores are cleaned, the report and the whole run with
// its database work injected, so "nothing is written without --commit" is
// pinned by tests rather than trusted. The script file only wires the real
// store read and lib/themes/sample-cleanup.ts into `runRemoveThemeSamples`.
// ---------------------------------------------------------------------------

import { isDemoStore } from "@/lib/store/launch-state";
import { studioPreviewMarker } from "@/lib/theme-studio/preview-store";
import type {
  SampleCleanupReport,
  SampleCleanupStore,
} from "@/lib/themes/sample-cleanup";
import type { SampleSeeds } from "@/lib/themes/sample-cleanup-rules";

export const USAGE = [
  "Usage:",
  "  npm run themes:remove-samples                 dry run: print what would go, write nothing",
  "  npm run themes:remove-samples -- --store <slug>   one store only",
  "  npm run themes:remove-samples -- --commit --confirm-database <DB_NAME>",
].join("\n");

export interface RemoveSamplesArgs {
  commit: boolean;
  confirmDatabase: string | null;
  store: string | null;
  help: boolean;
}

function valueOf(
  argv: readonly string[],
  i: number,
  flag: string,
): { value: string; next: number } | { error: string } {
  const arg = argv[i];
  const value = arg.includes("=")
    ? arg.slice(arg.indexOf("=") + 1)
    : argv[i + 1];
  if (!value || value.startsWith("-")) {
    return { error: `${flag} needs a value.` };
  }
  return { value: value.trim(), next: arg.includes("=") ? i : i + 1 };
}

/**
 * Unknown arguments are refused rather than ignored: a mistyped flag must not
 * quietly turn a run the operator meant as a write into something else.
 */
export function parseRemoveSamplesArgs(
  argv: readonly string[],
): RemoveSamplesArgs | { error: string } {
  const args: RemoveSamplesArgs = {
    commit: false,
    confirmDatabase: null,
    store: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--commit") args.commit = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (
      arg === "--confirm-database" ||
      arg.startsWith("--confirm-database=")
    ) {
      const read = valueOf(argv, i, "--confirm-database");
      if ("error" in read) return read;
      args.confirmDatabase = read.value;
      i = read.next;
    } else if (arg === "--store" || arg.startsWith("--store=")) {
      const read = valueOf(argv, i, "--store");
      if ("error" in read) return read;
      args.store = read.value;
      i = read.next;
    } else {
      return { error: `Unknown argument: ${arg}` };
    }
  }
  return args;
}

/**
 * Why a store is not cleaned, or null when it is. Demo and Theme Studio
 * preview stores exist to show a theme's samples off.
 */
export function skipReason(
  store: Pick<SampleCleanupStore, "settings">,
): "demo" | "preview" | null {
  const settings =
    store.settings && typeof store.settings === "object"
      ? (store.settings as Record<string, unknown>)
      : {};
  if (studioPreviewMarker(settings) !== null) return "preview";
  if (isDemoStore({ settings })) return "demo";
  return null;
}

function list(items: { slug: string }[]): string {
  return items.map((item) => item.slug).join(", ");
}

/** The lines one store's report prints. */
export function reportLines(report: SampleCleanupReport): string[] {
  if (report.skipped === "legal_hold") {
    return [`${report.slug}: skipped, the store is on a legal hold`];
  }
  if (report.products.length === 0 && report.categories.length === 0) {
    return [`${report.slug}: no samples`];
  }
  const verb = report.dryRun ? "would remove" : "removed";
  const lines = [
    `${report.slug}: ${verb} ${report.products.length} sample product(s), ${report.categories.length} sample categor${report.categories.length === 1 ? "y" : "ies"}`,
  ];
  if (report.products.length)
    lines.push(`  products: ${list(report.products)}`);
  if (report.categories.length) {
    lines.push(`  categories: ${list(report.categories)}`);
  }
  const links = [
    report.menus ? "menus" : null,
    report.chromeDraft ? "header and footer (draft)" : null,
    report.chromePublished ? "header and footer (live)" : null,
    ...report.pages.map((slug) => `page ${slug === "" ? "(homepage)" : slug}`),
  ].filter(Boolean);
  if (links.length) {
    lines.push(
      `  links to them ${report.dryRun ? "would be" : "were"} taken out of: ${links.join(", ")}`,
    );
  }
  return lines;
}

export interface RemoveSamplesDeps {
  env: Readonly<Record<string, string | undefined>>;
  readStores: () => Promise<SampleCleanupStore[]>;
  seedsFor: (settings: unknown) => Promise<SampleSeeds>;
  clean: (
    store: SampleCleanupStore,
    seeds: SampleSeeds,
    options: { commit: boolean },
  ) => Promise<SampleCleanupReport>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * The whole run. Exit codes: 0 every store done, 1 a store failed, 2 refused
 * before reading anything (bad arguments or the commit gate).
 */
export async function runRemoveThemeSamples(
  argv: readonly string[],
  deps: RemoveSamplesDeps,
): Promise<number> {
  const args = parseRemoveSamplesArgs(argv);
  if ("error" in args) {
    deps.err(args.error);
    deps.err(USAGE);
    return 2;
  }
  if (args.help) {
    deps.out(USAGE);
    return 0;
  }
  const database = deps.env.DB_NAME?.trim() || "";
  // ★ A write names the database it will change: .env points at staging, and
  // staging and production are two databases in one instance, so the proxy
  // being up says nothing about which one is read (CODEBASE.md §7).
  if (args.commit && (!database || args.confirmDatabase !== database)) {
    deps.err(
      `Refusing to write: --commit needs --confirm-database ${database || "<DB_NAME>"} (the database this run reads is "${database || "unset"}").`,
    );
    return 2;
  }

  deps.out(
    `Database: ${database || "unset"} on ${deps.env.DB_HOST ?? "?"}:${deps.env.DB_PORT ?? "?"}`,
  );
  deps.out(
    args.commit ? "Mode: COMMIT (writes)" : "Mode: dry run (writes nothing)",
  );

  const all = await deps.readStores();
  const chosen = args.store ? all.filter((s) => s.slug === args.store) : all;
  if (args.store && chosen.length === 0) {
    deps.err(`No store with the address "${args.store}".`);
    return 2;
  }

  let removedProducts = 0;
  let removedCategories = 0;
  let storesWithSamples = 0;
  let skipped = 0;
  let failed = 0;
  for (const store of chosen) {
    const reason = skipReason(store);
    if (reason) {
      skipped++;
      continue;
    }
    try {
      const seeds = await deps.seedsFor(store.settings);
      const report = await deps.clean(store, seeds, { commit: args.commit });
      for (const line of reportLines(report)) deps.out(line);
      if (report.products.length || report.categories.length) {
        storesWithSamples++;
        removedProducts += report.products.length;
        removedCategories += report.categories.length;
      }
    } catch (err) {
      failed++;
      deps.err(
        `${store.slug}: failed, nothing of it was changed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  const verb = args.commit ? "Removed" : "Would remove";
  deps.out(
    `${verb} ${removedProducts} sample product(s) and ${removedCategories} sample categor${removedCategories === 1 ? "y" : "ies"} from ${storesWithSamples} store(s). Skipped ${skipped} demo or preview store(s). ${failed} failed.`,
  );
  if (!args.commit && removedProducts + removedCategories > 0) {
    deps.out(
      `Nothing was written. To apply: npm run themes:remove-samples -- --commit --confirm-database ${database || "<DB_NAME>"}`,
    );
  }
  return failed > 0 ? 1 : 0;
}
