// ---------------------------------------------------------------------------
// Copying a Theme Studio theme's releases from one environment to another:
// the decisions, with no database and no network (scripts/theme-release-copy.ts
// does the reading and the writing).
//
// WHY (owner, 22 Nov 2026: "volt and roast themes are on my local. push to
// production through CLI"). A theme built in Theme Studio exists only in the
// database it was built in. `theme-registry:import` copies the BUNDLED themes
// (the ones in source control); for a generated theme there was no tool, so a
// theme built and published on a laptop could reach production only by being
// built again there, paying for every picture a second time.
//
// What a copy is, in the order Publish itself works (lib/theme-studio/
// publication.ts), so that exposure is the last step:
//   1. the release rows, oldest first (immutable; the package is the whole
//      theme, and its pictures are public addresses in a bucket both
//      environments read);
//   2. the demo store, seeded from the release new stores will get;
//   3. the catalogue pointer, last.
//
// What a copy is NOT: the Theme Studio project (its chat, designs, checks and
// private pictures). In the target the theme is a catalogue theme with no
// project, so it cannot be changed from that environment's Theme Studio: a
// change is made where the project lives and copied again as the next
// release.
//
// ★ A RELEASE IS IMMUTABLE. One that already exists with the same content is
//   left alone; one that exists with DIFFERENT content under the same id and
//   version refuses the whole copy.
// ★ THE CATALOGUE NEVER GOES BACKWARDS. If the target already offers a newer
//   version of the theme than the copy carries, the pointer is not moved.
// ★ A DEMO SLUG HELD BY A REAL STORE REFUSES THE COPY, as it does at Publish:
//   seeding resets the store it is given.
// ---------------------------------------------------------------------------

export const COPY_FORMAT = "storemink-theme-release-copy-v1";

export type CatalogVisibility = "public" | "hidden" | "legacy";

export interface ExportedRelease {
  version: string;
  manifestDigest: string;
  /** The package, exactly as the source's registry stores it. */
  package: unknown;
}

export interface ExportedTheme {
  themeId: string;
  /** The version the source's catalogue offers, or null when it offers none. */
  currentVersion: string | null;
  visibility: CatalogVisibility | null;
  releases: ExportedRelease[];
}

export interface ExportFile {
  format: typeof COPY_FORMAT;
  /** The database the releases were read from, for the record. */
  sourceDatabase: string;
  exportedAt: string;
  themes: ExportedTheme[];
}

/** What the target holds for one theme, before the copy. */
export interface TargetTheme {
  /** Releases already there: version to content digest. */
  releases: ReadonlyMap<string, string>;
  catalog: { version: string; visibility: CatalogVisibility } | null;
  /** The store holding the theme's demo slug, if any. */
  demoStore: { isDemo: boolean } | null;
}

export interface ReleaseStep {
  version: string;
  manifestDigest: string;
  action: "insert" | "exists";
}

export interface ThemePlan {
  themeId: string;
  releases: ReleaseStep[];
  /** The release the demo store is seeded from and the catalogue points at. */
  expose: { version: string; visibility: CatalogVisibility } | null;
  demo: "create" | "reset" | "leave";
  catalog: "create" | "move" | "unchanged" | "leave";
  notes: string[];
}

export type CopyPlan =
  | { ok: true; themes: ThemePlan[] }
  | { ok: false; problems: string[] };

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^[a-f0-9]{64}$/;

/** -1, 0 or 1; a version that is not major.minor.patch sorts first. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Read an export file, refusing anything that is not one. */
export function parseExportFile(
  raw: unknown,
): { ok: true; file: ExportFile } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const file = raw as Partial<ExportFile> | null;
  if (!file || typeof file !== "object" || file.format !== COPY_FORMAT) {
    return {
      ok: false,
      problems: [`Not a theme release export (format ${COPY_FORMAT}).`],
    };
  }
  if (!Array.isArray(file.themes) || file.themes.length === 0) {
    return { ok: false, problems: ["The export holds no themes."] };
  }
  const seen = new Set<string>();
  for (const theme of file.themes) {
    const id = theme?.themeId;
    if (typeof id !== "string" || !THEME_ID.test(id)) {
      problems.push(`A theme has no valid id (${JSON.stringify(id)}).`);
      continue;
    }
    if (seen.has(id)) problems.push(`${id} appears twice.`);
    seen.add(id);
    if (!Array.isArray(theme.releases) || theme.releases.length === 0) {
      problems.push(`${id} has no releases.`);
      continue;
    }
    const versions = new Set<string>();
    for (const release of theme.releases) {
      const at = `${id}@${release?.version}`;
      if (typeof release?.version !== "string" || !SEMVER.test(release.version))
        problems.push(`${at} has no valid version.`);
      else if (versions.has(release.version))
        problems.push(`${at} appears twice.`);
      else versions.add(release.version);
      if (
        typeof release?.manifestDigest !== "string" ||
        !DIGEST.test(release.manifestDigest)
      )
        problems.push(`${at} has no content digest.`);
      if (!release?.package || typeof release.package !== "object")
        problems.push(`${at} has no package.`);
    }
    if (theme.currentVersion !== null && !versions.has(theme.currentVersion))
      problems.push(
        `${id} is offered at v${theme.currentVersion}, which the export does not carry.`,
      );
    if (
      theme.visibility !== null &&
      !["public", "hidden", "legacy"].includes(theme.visibility)
    )
      problems.push(`${id} has an unknown visibility.`);
  }
  return problems.length
    ? { ok: false, problems }
    : { ok: true, file: file as ExportFile };
}

/**
 * What a copy would do to the target. `visibility` overrides the source's own
 * for every theme (a copy made to look at before it is offered: "hidden").
 */
export function planCopy(
  file: ExportFile,
  target: ReadonlyMap<string, TargetTheme>,
  options: { visibility?: CatalogVisibility | null } = {},
): CopyPlan {
  const problems: string[] = [];
  const themes: ThemePlan[] = [];
  for (const theme of file.themes) {
    const at = target.get(theme.themeId) ?? {
      releases: new Map<string, string>(),
      catalog: null,
      demoStore: null,
    };
    const notes: string[] = [];
    const releases: ReleaseStep[] = [...theme.releases]
      .sort((a, b) => compareVersions(a.version, b.version))
      .map((release) => {
        const existing = at.releases.get(release.version);
        if (existing && existing !== release.manifestDigest) {
          problems.push(
            `${theme.themeId}@${release.version} already exists in the target with different content. A release is never rewritten: publish the change as a new version and copy that.`,
          );
        }
        return {
          version: release.version,
          manifestDigest: release.manifestDigest,
          action: existing ? ("exists" as const) : ("insert" as const),
        };
      });

    if (!theme.currentVersion) {
      notes.push(
        "The source's catalogue offers no version of this theme, so only its releases are copied.",
      );
      themes.push({
        themeId: theme.themeId,
        releases,
        expose: null,
        demo: "leave",
        catalog: "leave",
        notes,
      });
      continue;
    }

    const visibility =
      options.visibility ?? theme.visibility ?? ("hidden" as const);
    // ★ Never backwards: the target may already offer a newer version.
    if (
      at.catalog &&
      compareVersions(at.catalog.version, theme.currentVersion) > 0
    ) {
      notes.push(
        `The target already offers v${at.catalog.version}, newer than v${theme.currentVersion}: its catalogue and demo store are left as they are.`,
      );
      themes.push({
        themeId: theme.themeId,
        releases,
        expose: null,
        demo: "leave",
        catalog: "leave",
        notes,
      });
      continue;
    }
    if (at.demoStore && !at.demoStore.isDemo) {
      problems.push(
        `The store demo-${theme.themeId} exists in the target and is not a demo store. Seeding would reset it, so nothing is copied.`,
      );
    }
    const unchanged =
      at.catalog?.version === theme.currentVersion &&
      at.catalog.visibility === visibility;
    themes.push({
      themeId: theme.themeId,
      releases,
      expose: { version: theme.currentVersion, visibility },
      demo: at.demoStore ? "reset" : "create",
      catalog: !at.catalog ? "create" : unchanged ? "unchanged" : "move",
      notes,
    });
  }
  return problems.length ? { ok: false, problems } : { ok: true, themes };
}

/** Every address in a package that a storefront would fetch a picture from. */
export function pictureUrls(pkg: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 40) return;
    if (typeof value === "string") {
      if (/^https?:\/\/\S+$/.test(value)) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(pkg, 0);
  return [...found].sort();
}

/** The plan in words, for the terminal. */
export function describePlan(plan: ThemePlan[]): string[] {
  const lines: string[] = [];
  for (const theme of plan) {
    lines.push(`${theme.themeId}:`);
    for (const release of theme.releases) {
      lines.push(
        `  release v${release.version} (${release.manifestDigest.slice(0, 12)}): ${release.action === "insert" ? "will be stored" : "already there, same content"}`,
      );
    }
    if (theme.expose) {
      lines.push(
        `  demo store demo-${theme.themeId}: ${theme.demo === "create" ? "will be created and seeded" : "will be reset and seeded again"} from v${theme.expose.version}`,
      );
      lines.push(
        `  catalogue: ${
          theme.catalog === "create"
            ? `will offer v${theme.expose.version} as ${theme.expose.visibility}`
            : theme.catalog === "move"
              ? `will move to v${theme.expose.version} as ${theme.expose.visibility}`
              : `already offers v${theme.expose.version} as ${theme.expose.visibility}`
        }`,
      );
    }
    for (const note of theme.notes) lines.push(`  note: ${note}`);
  }
  return lines;
}
