// ---------------------------------------------------------------------------
// Mink AI Theme Studio publication rules, with no I/O.
//
// Everything that decides whether a theme may be published, what goes live
// with it, and what the published package looks like, lives here so it can be
// tested without a database, and so the release screen and the server agree
// on the rules.
//
// Publication is ONE superadmin step with no second person (2026-10-03, and
// the owner again on 23 Oct 2026). "Fix it, then allow Publish": a theme's
// checks and its design review fix what they can by themselves; serious
// problems stop it before it is Ready to publish, and smaller ones are
// WARNINGS that go live with it (`publicationWarnings`), recorded on the
// publish events with the severity rule version. What still refuses Publish
// here is the package itself (`publicationBlockers`); whether the evidence is
// today's is acceptance.ts `currentPublishEvidence`. The database repeats the
// load-bearing half (migration 0151): a project cannot enter `approved`
// without passing acceptance evidence, nor `published` without a publication.
// ---------------------------------------------------------------------------

import {
  validateThemePackageV2,
  publishedAssetObjectPath,
  type ThemePackageV2,
} from "./contracts";
import { THEME_ASSET_PREFIX } from "./compiler";
import {
  acceptanceWarnings,
  isPlaceholderAsset,
  type GateId,
  type GateResult,
} from "./acceptance-gates";
import { isPlatformFinding } from "./finding-severity";
import { validateThemeDefinition } from "@/lib/themes/validation";
import type { ThemeDefinition } from "@/lib/themes/types";
import type { Parsed, ReviewFinding, ReviewSeverity } from "./scorecard";

// ------------------------------------------------------------------ release

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** 1.0.0 for a theme's first release; otherwise the next minor above the
 * highest version already stored. Never reuses or overwrites a version. */
export function nextReleaseVersion(existing: readonly string[]): string {
  const parsed = existing
    .map((v) => SEMVER.exec(v))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
  if (parsed.length === 0) return "1.0.0";
  parsed.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const [major, minor] = parsed[parsed.length - 1];
  // Nothing at 1.0.0 or above exists when the highest is a 0.x draft.
  return major === 0 ? "1.0.0" : `${major}.${minor + 1}.0`;
}

/**
 * One kind of WARNING a theme goes live with: findings that do not stop
 * Publish ("Fix it, then allow Publish"), grouped by where they came from and
 * their code. The words for each code are the screens' (TS-2); this carries
 * the measured facts.
 */
export interface PublicationWarning {
  source: "checks" | "review";
  /** The check that measured it; null for the design review. */
  gate: GateId | null;
  code: string;
  /** How many findings of this kind. */
  count: number;
  /** The first finding's own words, as measured; null for the design
   * review, whose findings are codes. */
  message: string | null;
  /** Where, at most PUBLICATION_WARNING_PLACES: the page and width, the
   * review's row and score, or the picture's slot. */
  where: string[];
  /** StoreMink's shared storefront code rather than the theme
   * (finding-severity.ts isPlatformFinding). Words only, never severity. */
  platform: boolean;
}

export const PUBLICATION_WARNING_PLACES = 5;

/** A stored finding's words without a long dash: evidence measured before
 * severity-v1 joined its examples with one ("... \u2014 examples: ..."), and
 * no screen shows one (the product's dash rule). */
function plainWords(message: string): string {
  return message
    .replace(/\s*\u2014\s*/g, "; ")
    .replace(/\s*\u2013\s*/g, " to ");
}

function reviewWhere(finding: ReviewFinding): string | null {
  if (finding.slotId) return finding.slotId;
  if (finding.row && typeof finding.score === "number") {
    return `${finding.row} ${finding.score} of 5`;
  }
  if (finding.row) return finding.row;
  if (typeof finding.score === "number") return `${finding.score} of 40`;
  return null;
}

/**
 * The warnings a theme goes live with: every finding of the check run's
 * gates that do not stop it (acceptance-gates.ts acceptanceWarnings, as
 * measured, never judged again), then the design review's own warnings
 * (`reviewSeverity.warnings`, visual-qa.ts). Grouped by source, check and
 * code, in the order found.
 */
export function publicationWarnings(
  gates: readonly GateResult[],
  review: ReviewSeverity | null,
): PublicationWarning[] {
  const out: PublicationWarning[] = [];
  const byKey = new Map<string, PublicationWarning>();
  const add = (
    key: string,
    fresh: () => PublicationWarning,
    where: string | null | undefined,
    platform: boolean,
  ) => {
    let entry = byKey.get(key);
    if (!entry) {
      entry = fresh();
      byKey.set(key, entry);
      out.push(entry);
    }
    entry.count += 1;
    entry.platform = entry.platform && platform;
    if (
      where &&
      entry.where.length < PUBLICATION_WARNING_PLACES &&
      !entry.where.includes(where)
    ) {
      entry.where.push(where);
    }
  };
  for (const g of acceptanceWarnings(gates)) {
    for (const finding of g.findings) {
      add(
        `checks|${g.id}|${finding.code}`,
        () => ({
          source: "checks",
          gate: g.id,
          code: finding.code,
          count: 0,
          message: plainWords(finding.message),
          where: [],
          platform: true,
        }),
        finding.where,
        isPlatformFinding(g.id, finding),
      );
    }
  }
  for (const finding of review?.warnings ?? []) {
    add(
      `review|${finding.code}`,
      () => ({
        source: "review",
        gate: null,
        code: finding.code,
        count: 0,
        message: null,
        where: [],
        platform: false,
      }),
      reviewWhere(finding),
      false,
    );
  }
  return out;
}

/**
 * Why a version cannot be published as it stands, in the operator's words
 * (`blocking`), and the warnings it would go live with (`warnings`), given
 * the check run and design review it would publish on. Only the package can
 * refuse here: whether that evidence is today's, and passed, is
 * acceptance.ts `currentPublishEvidence`, and a check run's verdict is never
 * worked out again from its stored findings.
 */
export function publicationBlockers(
  pkg: ThemePackageV2,
  evidence: {
    gates?: readonly GateResult[];
    review?: ReviewSeverity | null;
  } = {},
): { blocking: string[]; warnings: PublicationWarning[] } {
  const blocking: string[] = [];
  const placeholders = pkg.assets.filter(isPlaceholderAsset);
  if (placeholders.length > 0) {
    blocking.push(
      `${placeholders.length} image slot${placeholders.length === 1 ? " still has a" : "s still have a"} placeholder. Replace ${placeholders.length === 1 ? "it" : "them"} under Images.`,
    );
  }
  if (pkg.provenance.origin !== "generated") {
    blocking.push("Only a Theme Studio package can be published from here.");
  }
  for (const asset of pkg.assets) {
    if (!asset.path.startsWith(THEME_ASSET_PREFIX)) {
      blocking.push(`Image ${asset.id} is not a Studio slot.`);
    } else if (!asset.sha256) {
      blocking.push(`Image ${asset.id} has no stored bytes.`);
    }
  }
  // The same production validator every bundled theme passes (TA-2.1 to
  // 2.5). Checked before Publish writes anything, so a theme that could
  // never be published is refused at the first step, not the last.
  for (const finding of validateThemeDefinition(pkg.definition, {
    bundledAssets: false,
  })) {
    blocking.push(finding.message);
  }
  return {
    blocking,
    warnings: publicationWarnings(
      evidence.gates ?? [],
      evidence.review ?? null,
    ),
  };
}

/** Kinds of warning recorded on one publish event, at most: its detail is
 * capped at 4 KiB (theme_studio_events_detail_check). */
export const PUBLICATION_WARNING_LOG_KINDS = 16;

/**
 * The warnings a publish accepted, as its events record them: how many, and
 * each kind's source, check, code and count. Never a message, a place or a
 * selector, so the event stays small and content-free.
 */
export function publicationWarningLog(
  warnings: readonly PublicationWarning[],
): {
  count: number;
  kinds: {
    source: PublicationWarning["source"];
    gate: GateId | null;
    code: string;
    count: number;
  }[];
  omitted: number;
} {
  return {
    count: warnings.reduce((total, w) => total + w.count, 0),
    kinds: warnings.slice(0, PUBLICATION_WARNING_LOG_KINDS).map((w) => ({
      source: w.source,
      gate: w.gate,
      code: w.code.slice(0, 64),
      count: w.count,
    })),
    omitted: Math.max(0, warnings.length - PUBLICATION_WARNING_LOG_KINDS),
  };
}

/** The public URL of each promoted slot image, by asset id. */
export type PublishedUrlFor = (objectPath: string) => string;

export interface BuildPublishedInput {
  version: string;
  /** YYYY-MM-DD */
  releasedAt: string;
  sourceVersionNumber: number;
  publicUrl: PublishedUrlFor;
}

export interface BuiltRelease {
  pkg: ThemePackageV2;
  /** asset id -> in-bucket object path the bytes must be copied to. */
  objects: { assetId: string; sha256: string; objectPath: string }[];
}

/**
 * The draft being published, as the release a merchant installs: every slot pointed
 * at its immutable public object, the release numbered and published, the
 * catalog entry public and the demo declared healthy.
 *
 * ★ `visibility: public` and `demo: healthy` are written into the immutable
 * package BEFORE the demo is seeded. That is safe because exposure is decided
 * by the catalog POINTER, which publication writes only after the demo
 * renders; a release nobody points at is installable only by an exact pin.
 */
export function buildPublishedPackage(
  draft: ThemePackageV2,
  input: BuildPublishedInput,
): Parsed<BuiltRelease> {
  const { blocking } = publicationBlockers(draft);
  if (blocking.length > 0) return { ok: false, error: blocking[0] };
  if (!SEMVER.test(input.version)) {
    return { ok: false, error: "The release version must be semver." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.releasedAt)) {
    return { ok: false, error: "The release date must be YYYY-MM-DD." };
  }
  const themeId = draft.definition.id;
  const objects = draft.assets.map((asset) => ({
    assetId: asset.id,
    sha256: asset.sha256 as string,
    objectPath: publishedAssetObjectPath({
      themeId,
      version: input.version,
      assetId: asset.id,
      sha256: asset.sha256 as string,
    }),
  }));
  const urlForSlot = new Map(
    objects.map((o) => [o.assetId, input.publicUrl(o.objectPath)]),
  );
  const pathForDraft = new Map(
    draft.assets.map((asset) => [asset.path, urlForSlot.get(asset.id)!]),
  );
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return pathForDraft.get(value) ?? value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, walk(inner)]),
      );
    }
    return value;
  };
  const definition = walk(structuredClone(draft.definition)) as ThemeDefinition;
  definition.release = {
    version: input.version,
    status: "published",
    releasedAt: input.releasedAt,
    notes: [
      `Published from Theme Studio version ${input.sourceVersionNumber}.`,
    ],
  };
  definition.catalog = { ...definition.catalog, visibility: "public" };
  definition.demo = { slug: `demo-${themeId}`, status: "healthy" };
  const candidate: ThemePackageV2 = {
    ...draft,
    definition,
    assets: draft.assets.map((asset) => ({
      ...asset,
      path: urlForSlot.get(asset.id)!,
    })),
  };
  const parsed = validateThemePackageV2(candidate);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `The published package failed its contract: ${parsed.issues[0]}`,
    };
  }
  const findings = validateThemeDefinition(parsed.value.definition, {
    bundledAssets: false,
  });
  if (findings.length > 0) {
    return {
      ok: false,
      error: `The published theme failed validation: ${findings[0].message}`,
    };
  }
  return { ok: true, value: { pkg: parsed.value, objects } };
}

/** The date a release is dated with. India first, like the rest of the
 * operator console: a release published at 01:00 IST is dated that day. */
export function releaseDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// ------------------------------------------------------------------ catalog

export const CATALOG_REASON_MAX = 500;

export type CatalogChange =
  | { action: "hide"; reason: string }
  | { action: "show"; reason: string }
  | { action: "select_release"; version: string; reason: string };

export function validateCatalogChange(input: unknown): Parsed<CatalogChange> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  // Optional: the audit always records who and what; a blank reason gets a
  // plain sentence so one click is enough to hide or restore a theme.
  const typed = typeof raw.reason === "string" ? raw.reason.trim() : "";
  const reason =
    typed ||
    (raw.action === "hide"
      ? "Hidden from new stores."
      : raw.action === "show"
        ? "Shown in the catalog again."
        : "Restored an earlier release.");
  if (reason.length > CATALOG_REASON_MAX) {
    return {
      ok: false,
      error: `Keep the reason under ${CATALOG_REASON_MAX} characters.`,
    };
  }
  if (raw.action === "hide" || raw.action === "show") {
    return { ok: true, value: { action: raw.action, reason } };
  }
  if (raw.action === "select_release") {
    if (typeof raw.version !== "string" || !SEMVER.test(raw.version)) {
      return { ok: false, error: "Choose a release." };
    }
    return {
      ok: true,
      value: { action: "select_release", version: raw.version, reason },
    };
  }
  return { ok: false, error: "Unknown catalog change." };
}
