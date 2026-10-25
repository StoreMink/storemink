import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// FROZEN RELEASES. A store renders its theme from a STORED package, and the
// renderer re-checks that package every time a store loads it: a release that
// no longer passes the package contract, or whose digest no longer matches,
// is dropped, and a Studio theme has no bundled fallback, so the store would
// render un-themed (lib/themes/runtime-registry.ts parseRelease).
//
// So the package contract is frozen for what is already stored: changing
// THEME_STUDIO_VIEWPORTS, THEME_PACKAGE_SCHEMA_VERSION, the model keys
// (THEME_STUDIO_MODEL_KEYS) or any validateThemePackageV2 rule must keep every
// stored package valid (plan section 9, "Never change a package-contract
// constant without a compatibility path"). These are copies of every release
// stored in the local database on 24 Oct 2026 (the exemplars, basket, ritual,
// studio and vitrine), plus two generated Studio packages copied from local
// theme_studio_versions rows, because no stored release carries a model key.
// If this test fails, fix the change, never the copies.
// ---------------------------------------------------------------------------

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

import type { Db } from "@/lib/db/client";
import { loadExactReleaseWithDb } from "@/lib/themes/runtime-registry";
import {
  canonicalJson,
  THEME_PACKAGE_SCHEMA_VERSION,
  THEME_STUDIO_VIEWPORTS,
  validateThemePackageV2,
} from "./contracts";
import { THEME_STUDIO_MODEL_KEYS } from "./models";

interface FrozenRelease {
  themeId: string;
  version: string;
  releaseStatus: string;
  source: string;
  manifestDigest: string;
  packageJson: unknown;
}

interface FrozenVersion {
  id: string;
  packageDigest: string;
  packageJson: unknown;
}

const frozen = JSON.parse(
  gunzipSync(
    readFileSync(join(__dirname, "__fixtures__", "frozen-releases.json.gz")),
  ).toString("utf8"),
) as { releases: FrozenRelease[]; versions: FrozenVersion[] };

const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

/** One stored row, served the way the theme_releases table serves it. */
function storedRow(release: FrozenRelease): Db {
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    themeId: release.themeId,
    version: release.version,
    releaseStatus: release.releaseStatus,
    // A fresh copy each read: nothing here may lean on object identity.
    packageJson: structuredClone(release.packageJson),
    manifestDigest: release.manifestDigest,
  };
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [row],
  };
  return { select: () => chain } as unknown as Db;
}

describe("frozen stored theme packages", () => {
  it("holds every local stored release and generated packages with a model key", () => {
    expect(frozen.releases).toHaveLength(14);
    expect(new Set(frozen.releases.map((r) => r.themeId))).toEqual(
      new Set([
        "basket",
        "exemplar-bold-and-loud",
        "exemplar-classic-and-trusted",
        "exemplar-dense-catalogue",
        "exemplar-luxury-minimal",
        "exemplar-magazine-editorial",
        "exemplar-playful-and-colourful",
        "exemplar-soft-and-natural",
        "ritual",
        "studio",
        "vitrine",
      ]),
    );
    expect(frozen.versions.length).toBeGreaterThanOrEqual(1);
    for (const version of frozen.versions) {
      const pkg = version.packageJson as {
        provenance: { origin: string; modelKey: string | null };
      };
      expect(pkg.provenance.origin).toBe("generated");
      expect(THEME_STUDIO_MODEL_KEYS).toContain(pkg.provenance.modelKey);
    }
  });

  it.each(frozen.releases.map((r) => [`${r.themeId}@${r.version}`, r]))(
    "%s still loads exactly as the renderer loads a stored release",
    async (_label, release) => {
      // The digest of the bytes as stored, before anything parses them.
      expect(digest(release.packageJson)).toBe(release.manifestDigest);
      const parsed = validateThemePackageV2(release.packageJson);
      expect(parsed.ok ? [] : parsed.issues).toEqual([]);
      // The renderer's own path: contract, identity, digest of the parsed
      // value and the engine version this build renders.
      const loaded = await loadExactReleaseWithDb(
        storedRow(release),
        release.themeId,
        release.version,
      );
      expect(loaded, "the renderer would drop this release").not.toBeNull();
      expect(loaded!.manifestDigest).toBe(release.manifestDigest);
      expect(loaded!.definition.id).toBe(release.themeId);
      expect(loaded!.package.schemaVersion).toBe(THEME_PACKAGE_SCHEMA_VERSION);
      expect(loaded!.package.renderer.viewports).toEqual(
        THEME_STUDIO_VIEWPORTS,
      );
    },
  );

  it.each(frozen.versions.map((v) => [v.id, v]))(
    "generated package %s keeps its digest and still passes the contract",
    (_label, version) => {
      expect(digest(version.packageJson)).toBe(version.packageDigest);
      const parsed = validateThemePackageV2(version.packageJson);
      expect(parsed.ok ? [] : parsed.issues).toEqual([]);
      if (!parsed.ok) return;
      // Validation normalises nothing a digest covers.
      expect(digest(parsed.value)).toBe(version.packageDigest);
      expect(parsed.value.renderer.viewports).toEqual(THEME_STUDIO_VIEWPORTS);
    },
  );

  it("would catch a changed contract constant: a copy with another model key or viewport is refused", () => {
    const [version] = frozen.versions;
    const renamed = structuredClone(version.packageJson) as {
      provenance: { modelKey: string };
    };
    renamed.provenance.modelKey = "gemini-9-flash";
    expect(validateThemePackageV2(renamed).ok).toBe(false);
    const resized = structuredClone(version.packageJson) as {
      renderer: { viewports: { mobile: { width: number } } };
    };
    resized.renderer.viewports.mobile.width = 375;
    expect(validateThemePackageV2(resized).ok).toBe(false);
  });
});
