import { createHash } from "node:crypto";
import {
  THEME_IMAGE_RULES,
  collectThemeImageUrls,
  validateThemeCatalogMeta,
  validateThemeHomepage,
  validateThemeImage,
  validateThemeLinks,
  validateThemePages,
  validateThemeSampleData,
  type ThemeFinding,
  validateThemeCopy,
  validateStudioDesign,
} from "@/lib/themes/validation";
import type { ThemeDefinition } from "@/lib/themes/types";
import { logWarn } from "@/lib/observability/logger";
import { PLACEHOLDER_LICENSE_NOTE, THEME_ASSET_PREFIX } from "./compiler";
import {
  canonicalJson,
  validateThemePackageV2,
  type ThemePackageV2,
} from "./contracts";
import {
  CHROME_STATES,
  CHROME_STATE_LABELS,
  CHROME_STATE_SKIPS,
  type ChromeState,
  type ChromeStateSkip,
} from "./chrome-states";
import {
  SEVERITY_RULES_VERSION,
  findingSeverity,
  isPlatformFinding,
  isSeriousFinding,
  stricterSeverity,
  type FindingSeverity,
} from "./finding-severity";
import { slotTargetSize } from "./slot-images-core";

// ---------------------------------------------------------------------------
// Theme Studio automated acceptance: the gates, as pure functions.
//
// A generated version must clear these before it can be published. The
// orchestration (reading rows, building the preview, fetching rendered
// pages, recording evidence) lives in acceptance.ts; everything that DECIDES
// lives here and in finding-severity.ts, so every rule is unit-tested without
// a database or a browser.
//
// ★ A RUN PASSES WHEN NO SERIOUS FINDING IS LEFT; WARNINGS NEVER STOP IT
// ("Fix it, then allow Publish", owner, 24 Oct 2026). Every finding is given
// its severity when it is measured (gate(), finding-severity.ts). Broken
// pages, text below the AA line, broken links, security, and anything that
// could not be checked or that nobody classified are serious and fail the
// run; smaller things are warnings, kept with the run and shown, that the
// operator may publish past. A gate's STATUS still reports every finding
// exactly as measured (a required gate with any finding is "fail"), so the
// exemplar check and the evidence screens keep failing on everything they
// failed on before: the severity rule applies only where the outcome is
// decided, acceptanceOutcome here and automaticQaDecision in
// automatic-qa-policy.ts. Performance is the one advisory gate (its findings
// warnings) until THEME_STUDIO_PERFORMANCE_REQUIRED makes it required, and
// its findings serious, judged from the automatic capture's frozen timings
// at phone390 and desktop1440.
//
// ★ SECURITY FAILURES BLOCK THE PROJECT; QUALITY FAILURES DO NOT. A version
// that carries a script or an off-site asset is not something to iterate on,
// so the project moves to `blocked`. A version with a thin catalogue or a
// contrast problem stays `ready` and is fixed by a revision.
//
// ★ EVIDENCE IS DERIVED FROM RAW MEASUREMENTS HERE, NEVER FROM A CLIENT'S
// VERDICT. The operator's browser reports what it measured (overflow in
// pixels, axe violations with impact, broken images) and the thresholds are
// applied on the server. A client that says "passed" is ignored.
// ---------------------------------------------------------------------------

export const ACCEPTANCE_REPORT_VERSION = 2;

export type GateStatus = "pass" | "fail" | "advisory" | "skipped";

export type GateId =
  | "package.schema"
  | "package.content"
  | "package.design"
  | "package.security"
  | "assets.integrity"
  | "assets.provenance"
  | "demo.materialize"
  | "routes.render"
  | "routes.links"
  | "routes.markup"
  | "browser.coverage"
  | "browser.overflow"
  | "browser.clipped_text"
  | "browser.tap_targets"
  | "browser.image_crops"
  | "browser.accessibility"
  | "browser.media"
  | "browser.performance"
  | "browser.header_menu";

export interface GateFinding {
  code: string;
  message: string;
  where?: string;
  contrast?: { target: string; ratio: number; required: number }[];
  /** browser.accessibility: the axe impact (null when axe gave none this
   * code recognises) and how many elements the rule failed on. */
  impact?: AxeImpact | null;
  nodes?: number;
  /** browser.clipped_text: the pixels of text the box hides. */
  clipped?: { x: number; y: number };
  /** The selectors the browser named (axe examples, the clipped element,
   * the overflow offenders), so a finding is labelled without parsing its
   * message. */
  targets?: string[];
  /** "serious" stops Publish; "minor" is a warning (finding-severity.ts).
   * Set by gate() as the finding is measured. Absent on findings stored
   * before severity-v1, which count as serious (isSeriousFinding). */
  severity?: FindingSeverity;
}

export interface GateResult {
  id: GateId;
  label: string;
  required: boolean;
  status: GateStatus;
  /** The severity rules the findings were measured under
   * (SEVERITY_RULES_VERSION); absent on results from before them. */
  severityRules?: string;
  findings: GateFinding[];
  metrics?: Record<string, number | string | null>;
}

export const GATE_LABELS: Record<GateId, string> = {
  "package.schema": "Package contract",
  "package.content": "Pages, catalogue and links",
  "package.design": "Design system and contrast",
  "package.security": "Security scan",
  "assets.integrity": "Asset integrity",
  "assets.provenance": "Asset provenance",
  "demo.materialize": "Demo materialization",
  "routes.render": "Storefront routes",
  "routes.links": "Navigation links",
  "routes.markup": "Rendered markup",
  "browser.coverage": "Browser coverage",
  "browser.overflow": "Responsive layout",
  "browser.clipped_text": "Clipped text",
  "browser.tap_targets": "Tap targets",
  "browser.image_crops": "Image crops",
  "browser.accessibility": "Accessibility (axe)",
  "browser.media": "Media loading",
  "browser.performance": "Performance",
  "browser.header_menu": "Header menu",
};

/** Findings per gate are capped: a reviewer needs the pattern, not 400 rows.
 * Serious findings are kept first, so the cap can never hide one. */
export const MAX_GATE_FINDINGS = 40;

/**
 * One measured gate. Every finding is given its severity here, as it is
 * measured: by its rule (finding-severity.ts), raised but never lowered by a
 * severity the measuring step set itself; an advisory gate cannot stop a
 * run, so everything it holds is a warning. Serious findings are ordered
 * first, then the list is capped. The STATUS is unchanged by severity: a
 * required gate with any finding fails, as the exemplar check expects.
 */
export function gate(
  id: GateId,
  findings: GateFinding[],
  options: {
    required?: boolean;
    status?: GateStatus;
    metrics?: GateResult["metrics"];
  } = {},
): GateResult {
  const required = options.required ?? true;
  const status =
    options.status ??
    (findings.length === 0 ? "pass" : required ? "fail" : "advisory");
  const measured = findings.map(
    (finding): GateFinding => ({
      ...finding,
      severity: required
        ? stricterSeverity(finding.severity, findingSeverity(id, finding))
        : "minor",
    }),
  );
  const ordered = [
    ...measured.filter((finding) => finding.severity === "serious"),
    ...measured.filter((finding) => finding.severity !== "serious"),
  ];
  logPlatformFindings(id, ordered);
  return {
    id,
    label: GATE_LABELS[id],
    required,
    status,
    severityRules: SEVERITY_RULES_VERSION,
    findings: ordered.slice(0, MAX_GATE_FINDINGS),
    ...(options.metrics ? { metrics: options.metrics } : {}),
  };
}

/**
 * One content-free line per finding code in StoreMink's own storefront code
 * (finding-severity.ts isPlatformFinding), counted before the cap, so an
 * alert can watch for them: the gate, the code, the finding's severity and
 * how many. Never a selector, a path or a message, which can carry a store's
 * content. The field is `findingSeverity`, never `severity`: Cloud Logging
 * reads a top-level `severity` as the log level (observability/logger.ts).
 */
function logPlatformFindings(
  gateId: GateId,
  findings: readonly GateFinding[],
): void {
  const counts = new Map<
    string,
    { code: string; findingSeverity: FindingSeverity; count: number }
  >();
  for (const finding of findings) {
    if (!isPlatformFinding(gateId, finding)) continue;
    const findingSeverity = finding.severity ?? "serious";
    const key = `${finding.code}|${findingSeverity}`;
    const entry = counts.get(key) ?? {
      code: finding.code,
      findingSeverity,
      count: 0,
    };
    entry.count += 1;
    counts.set(key, entry);
  }
  for (const entry of counts.values()) {
    logWarn("theme_studio.platform_finding", { gate: gateId, ...entry });
  }
}

/**
 * Whether a gate stops a run. A required gate that was not passed stops it
 * when it holds a serious finding, or nothing that says why it was not
 * passed: a skipped check, a failure with no findings and any status this
 * code does not know are never a pass. A required gate whose findings are
 * all warnings does not stop it; an advisory gate never does. A passed gate
 * is trusted as measured.
 */
export function gateBlocks(
  g: Pick<GateResult, "required" | "status" | "findings">,
): boolean {
  if (!g.required || g.status === "pass") return false;
  if (g.status !== "fail" && g.status !== "advisory") return true;
  return (
    !Array.isArray(g.findings) ||
    g.findings.length === 0 ||
    g.findings.some(isSeriousFinding)
  );
}

/** The warnings a run carries: every finding of each gate that does not
 * stop it, as measured. A run that passes is published with these. */
export function acceptanceWarnings(
  gates: readonly GateResult[],
): { id: GateId; label: string; findings: GateFinding[] }[] {
  return gates
    .filter((g) => !gateBlocks(g) && g.findings.length > 0)
    .map((g) => ({ id: g.id, label: g.label, findings: g.findings }));
}

function skipped(id: GateId, reason: string): GateResult {
  return gate(id, [{ code: "skipped", message: reason }], {
    status: "skipped",
  });
}

function fromThemeFindings(findings: ThemeFinding[]): GateFinding[] {
  return findings.map((f) => ({
    code: `${f.area}.${f.code}`,
    message: f.message,
  }));
}

// ------------------------------------------------------------ digests

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A stored asset row, as much of it as the gates read. */
export interface AcceptanceAssetRow {
  id: string;
  purpose: string;
  mediaType: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
}

/**
 * The content address of every asset a package renders: each declared asset
 * paired with the stored row that backs it. Rows are immutable, so this moves
 * only when the package points at different bytes, which is exactly when
 * earlier evidence stops describing what would be shown.
 */
export function acceptanceAssetsDigest(
  pkg: ThemePackageV2,
  rows: readonly AcceptanceAssetRow[],
): string {
  const bySha = new Map(rows.map((row) => [row.sha256, row]));
  const entries = [...pkg.assets]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((asset) => {
      const row = asset.sha256 ? bySha.get(asset.sha256) : undefined;
      return {
        asset: asset.id,
        sha256: asset.sha256,
        row: row
          ? {
              id: row.id,
              purpose: row.purpose,
              mediaType: row.mediaType,
              bytes: row.byteSize,
              width: row.width,
              height: row.height,
            }
          : null,
      };
    });
  return sha256Hex(canonicalJson(entries));
}

export interface EvidenceBinding {
  runId: string;
  versionId: string;
  packageDigest: string;
  assetsDigest: string;
  buildId: string;
}

/** The digest a finished run is recorded under: its inputs and every gate. */
export function acceptanceEvidenceDigest(
  binding: EvidenceBinding,
  gates: readonly GateResult[],
): string {
  return sha256Hex(
    canonicalJson({ version: ACCEPTANCE_REPORT_VERSION, binding, gates }),
  );
}

// ------------------------------------------------------------ package gates

const SCRIPT_RE =
  /<\s*\/?\s*(script|iframe|object|embed|frame|style|link|meta|base)\b/i;
const HANDLER_RE = /\bon[a-z]{3,}\s*=/i;
const SCRIPT_SCHEME_RE = /\b(?:javascript|vbscript)\s*:/i;
const URL_KEY_RE = /(?:^|_)(?:url|src|image|poster)$/i;

/** Keys whose string values are rendered as a media source. */
function isAssetKey(key: string): boolean {
  return URL_KEY_RE.test(key) || key === "images" || key === "previewImage";
}
const HREF_KEY_RE = /(?:^|_)href$/i;
const CSS_ESCAPE_RE = /(?:expression\s*\(|url\s*\(|@import|behavior\s*:)/i;

/** Walk every string in a JSON value with the key path that holds it. */
function walkStrings(
  value: unknown,
  visit: (text: string, key: string, path: string) => void,
  key = "",
  path = "",
): void {
  if (typeof value === "string") {
    visit(value, key, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkStrings(item, visit, key, `${path}[${index}]`),
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, nested] of Object.entries(value)) {
      walkStrings(nested, visit, k, path ? `${path}.${k}` : k);
    }
  }
}

/** A link a generated theme may carry: same-site paths and in-page anchors. */
function isSafeHref(href: string): boolean {
  if (href === "") return true;
  if (href.startsWith("#")) return true;
  return /^\/(?![/\\])[^\s\\]*$/.test(href);
}

/**
 * Plan §7.2 item 9: no scripts, event handlers, external asset URLs, unknown
 * CSS values or unregistered capabilities reached the package. Deliberately
 * independent of the compiler that should already have refused all of this:
 * a gate that trusts the thing it checks is not a gate.
 */
export function securityFindings(pkg: ThemePackageV2): GateFinding[] {
  const findings: GateFinding[] = [];
  const add = (code: string, message: string, where: string) =>
    findings.push({ code, message, where });

  walkStrings(pkg.definition, (text, key, path) => {
    const htmlish = text.includes("<");
    if (SCRIPT_RE.test(text)) {
      add("markup", "Contains an executable or document-level HTML tag.", path);
    }
    if (htmlish && HANDLER_RE.test(text)) {
      add("handler", "Contains an inline event handler.", path);
    }
    const linkish = isAssetKey(key) || HREF_KEY_RE.test(key);
    if (
      (SCRIPT_SCHEME_RE.test(text) &&
        (linkish || htmlish || text.includes("="))) ||
      (linkish && /^\s*data\s*:/i.test(text))
    ) {
      add("scheme", "Contains a javascript:, vbscript: or data: URL.", path);
    }
    if (isAssetKey(key) && text && !text.startsWith(THEME_ASSET_PREFIX)) {
      add(
        "external_asset",
        "An image or media field points outside the package's own assets.",
        path,
      );
    }
    if (HREF_KEY_RE.test(key) && !isSafeHref(text)) {
      add("external_link", "A link leaves the storefront.", path);
    }
  });

  // Design tokens reach an inline style attribute, so anything beyond a plain
  // colour, length or font variable is refused here as well as upstream.
  walkStrings(pkg.definition.preset.design, (text, _key, path) => {
    if (CSS_ESCAPE_RE.test(text) || /[;{}<>]/.test(text)) {
      add(
        "css",
        "A design token is not a plain CSS value.",
        `preset.design.${path}`,
      );
    }
  });

  for (const page of pkg.definition.preset.pages) {
    for (const section of page.sections) {
      if (section.type === "custom_code") {
        add(
          "custom_code",
          "Generated themes may not contain custom code.",
          `${page.slug || "(home)"}/${section.id}`,
        );
      }
    }
  }

  const declared = new Set(pkg.declaredCapabilities.features);
  for (const feature of pkg.definition.catalog.features) {
    if (!declared.has(feature)) {
      add(
        "capability",
        `The catalog claims "${feature}" but the package never declared it.`,
        "definition.catalog.features",
      );
    }
  }
  return findings;
}

/** Media types a storefront asset may be stored as. */
const STOREFRONT_MEDIA_TYPES = new Set(["image/webp", "image/avif"]);

/**
 * validateThemeImage's messages (lib/themes/validation.ts), split by what
 * they mean, since one shared `size` code made a byte budget block like a
 * broken picture: a wrong format, a picture below the storefront minimum
 * and a preview that is too short or not 4:3 are serious; a picture over its
 * byte budget is a warning (finding-severity.ts). A message none of these
 * recognises keeps the old `size` code, which is serious.
 */
const IMAGE_RULE_CODES: readonly (readonly [RegExp, string])[] = [
  [/must be WebP or AVIF/, "wrong_format"],
  [/the preview must be at least \d+px tall/, "preview_too_small"],
  [/the preview must be at most \d+ KiB/, "preview_over_budget"],
  [/the preview must be 4:3/, "preview_shape"],
  [/must be at least \d+px wide/, "too_small"],
  [/must be at most \d+ KiB/, "over_budget"],
];

/** The code for one validateThemeImage message, read after its label. */
export function imageRuleCode(message: string): string {
  return IMAGE_RULE_CODES.find(([rule]) => rule.test(message))?.[1] ?? "size";
}

/** Asset purposes whose bytes may render on a storefront. Reference images are
 * the operator's inspiration and are never licensed for publication. */
const RENDERABLE_PURPOSES = new Set(["placeholder", "image"]);

export function isPlaceholderAsset(
  asset: ThemePackageV2["assets"][number],
): boolean {
  return asset.licenseNote === PLACEHOLDER_LICENSE_NOTE;
}

/** A stored picture this fraction of its slot's width or wider is not
 * reported as soft (`below_target`). */
export const BELOW_TARGET_FRACTION = 0.85;

/** Every declared asset resolves to a stored row with the same bytes. */
export function assetIntegrityFindings(
  pkg: ThemePackageV2,
  rows: readonly AcceptanceAssetRow[],
): GateFinding[] {
  const findings: GateFinding[] = [];
  const bySha = new Map(rows.map((row) => [row.sha256, row]));
  const referenced = collectThemeImageUrls(pkg.definition);
  for (const asset of pkg.assets) {
    const where = asset.id;
    if (!asset.sha256) {
      findings.push({
        code: "digest",
        message: "The asset has no content digest.",
        where,
      });
      continue;
    }
    const row = bySha.get(asset.sha256);
    if (!row) {
      findings.push({
        code: "missing",
        message: "No stored image matches the asset's digest.",
        where,
      });
      continue;
    }
    if (!RENDERABLE_PURPOSES.has(row.purpose)) {
      findings.push({
        code: "purpose",
        message: `A ${row.purpose} image cannot be rendered on a storefront.`,
        where,
      });
    }
    if (!STOREFRONT_MEDIA_TYPES.has(row.mediaType)) {
      findings.push({
        code: "format",
        message: `Stored as ${row.mediaType}.`,
        where,
      });
    }
    if (
      (asset.width !== null && asset.width !== row.width) ||
      (asset.height !== null && asset.height !== row.height)
    ) {
      findings.push({
        code: "dimensions",
        message: "The declared dimensions do not match the stored image.",
        where,
      });
    }
    // Placeholders are tiny solid images by design and are refused by
    // provenance; production sizing applies to real imagery only.
    if (!isPlaceholderAsset(asset)) {
      for (const message of validateThemeImage(
        asset.id,
        {
          format: row.mediaType.replace("image/", ""),
          width: row.width,
          height: row.height,
          bytes: row.byteSize,
        },
        { preview: asset.path === pkg.definition.catalog.previewImage },
      )) {
        findings.push({
          code: imageRuleCode(
            message.startsWith(asset.id)
              ? message.slice(asset.id.length)
              : message,
          ),
          message,
          where,
        });
      }
      // A picture smaller than its slot is made for (a draw that came back
      // at a smaller size, or one shrunk to fit its byte budget) can look
      // soft on a large screen: a warning. Below the storefront minimum it
      // is `too_small` above, which is serious. image-vertex.ts only logs
      // the small draw; this reads the stored width.
      // ★ Only when it is more than 15% narrower. A wide picture at "2K"
      //   comes back 2,239px (21:9) or 2,048px (16:9) for a 2,400px slot
      //   from every provider setting there is, so the warning fired on
      //   every wide picture of every theme and told nobody anything they
      //   could act on; the design review listed it as a finding each time.
      const target = slotTargetSize(asset);
      if (
        target &&
        row.width >= THEME_IMAGE_RULES.minWidth &&
        row.width < target.width * BELOW_TARGET_FRACTION
      ) {
        findings.push({
          code: "below_target",
          message: `The stored picture is ${row.width}px wide, narrower than the ${target.width}px its slot is made for, so it can look soft on large screens.`,
          where,
        });
      }
    }
    if (!referenced.has(asset.path) && asset.kind !== "reference") {
      findings.push({
        code: "unused",
        message: "The asset is declared but nothing renders it.",
        where,
      });
    }
  }
  return findings;
}

/** Every rendered asset must be publishable: no placeholders, alt text, and
 * a source this platform can stand behind. */
export function assetProvenanceFindings(pkg: ThemePackageV2): GateFinding[] {
  const findings: GateFinding[] = [];
  const placeholders = pkg.assets.filter(isPlaceholderAsset);
  const capturePaths = new Set([
    pkg.definition.catalog.previewImage,
    ...pkg.definition.catalog.screenshots.map((image) => image.src),
  ]);
  for (const catalog of [true, false]) {
    const missing = placeholders.filter(
      (asset) => capturePaths.has(asset.path) === catalog,
    );
    if (!missing.length) continue;
    findings.push({
      code: "placeholder",
      message: catalog
        ? `${missing.length} catalog image slot(s) await browser capture. Open Images and capture the preview, desktop and mobile screenshots before running acceptance again. These are pictures of the finished storefront, not AI artwork.`
        : `${missing.length} artwork slot(s) are still StoreMink placeholders. Open Images to generate or replace them with operator-owned or licensed imagery before this version can be published.`,
      where: missing
        .map((a) => a.id)
        .slice(0, 12)
        .join(", "),
    });
  }
  for (const asset of pkg.assets) {
    if (asset.alt.trim().length < 3) {
      findings.push({
        code: "alt",
        message: "The asset has no alt text.",
        where: asset.id,
      });
    }
    if (asset.source === "legacy-bundled") {
      findings.push({
        code: "source",
        message: "A generated theme cannot ship bundled legacy imagery.",
        where: asset.id,
      });
    }
    if (
      (asset.source === "licensed" || asset.source === "operator-owned") &&
      !asset.licenseNote?.trim()
    ) {
      findings.push({
        code: "license",
        message: "Licensed or operator-owned imagery needs a licence note.",
        where: asset.id,
      });
    }
  }
  return findings;
}

/**
 * The package-level gates (plan §7.2 items 1, 2 and 9). The schema gate runs
 * the full ThemePackageV2 contract again: a stored version was valid when it
 * was written, and this proves it is still valid under today's rules.
 */
export function evaluatePackageGates(
  packageJson: unknown,
  rows: readonly AcceptanceAssetRow[],
): { gates: GateResult[]; pkg: ThemePackageV2 | null } {
  const parsed = validateThemePackageV2(packageJson);
  if (!parsed.ok) {
    const reason =
      "The package contract failed, so nothing else can be checked.";
    return {
      pkg: null,
      gates: [
        gate(
          "package.schema",
          parsed.issues.map((message) => ({ code: "contract", message })),
        ),
        skipped("package.content", reason),
        skipped("package.design", reason),
        skipped("package.security", reason),
        skipped("assets.integrity", reason),
        skipped("assets.provenance", reason),
      ],
    };
  }
  const pkg = parsed.value;
  const theme: ThemeDefinition = pkg.definition;
  const integrity = assetIntegrityFindings(pkg, rows);
  return {
    pkg,
    gates: [
      gate("package.schema", []),
      gate(
        "package.content",
        fromThemeFindings([
          ...validateThemeCatalogMeta(theme, { bundledAssets: false }),
          ...validateThemePages(theme),
          ...validateThemeHomepage(theme),
          ...validateThemeSampleData(theme),
          ...validateThemeLinks(theme),
          ...validateThemeCopy(theme),
        ]).concat(
          pkg.capabilityGaps
            .filter((gap) => gap.blocking)
            .map((gap) => ({
              code: "capability_gap",
              message: `A blocking capability gap remains: ${gap.requestedCapability}.`,
            })),
        ),
      ),
      gate("package.design", fromThemeFindings(validateStudioDesign(theme))),
      gate("package.security", securityFindings(pkg)),
      gate("assets.integrity", integrity, {
        // A picture narrower than its slot (new in severity-v1) is listed as
        // a warning without failing the gate, as a lower-impact axe rule is,
        // so the gate fails on exactly what it failed on before: the bundled
        // exemplar pictures are 800 to 1000px wide and the exemplar check
        // passes them.
        status: integrity.some((f) => f.code !== "below_target")
          ? "fail"
          : "pass",
      }),
      gate("assets.provenance", assetProvenanceFindings(pkg)),
    ],
  };
}

// ------------------------------------------------------------ rendered routes

export type AcceptanceSurface =
  | "home"
  | "shop"
  | "product"
  | "cart"
  | "content"
  | "not_found";

export interface RouteFetchResult {
  surface: AcceptanceSurface;
  path: string;
  status: number | null;
  /** Whether the page rendered with the theme's design applied. */
  themed: boolean;
  noindex: boolean;
  error: string | null;
}

/** The error a page carries when automatic acceptance ran out of its time
 * budget before reading it. Not a transient fetch failure: the same slow
 * preview exhausts the same budget on every attempt, so it is reported as
 * `budget` and never retried by a recapture. */
export const ACCEPTANCE_BUDGET_EXHAUSTED =
  "Acceptance time budget exhausted before this page was read.";

/** The error a page carries when it did not answer within its timeout
 * (acceptance-http.ts). Like an exhausted budget, a page that slow is slow on
 * every attempt, so it is `timeout`, not a `fetch` blip worth a recapture. A
 * reset or dropped connection keeps `fetch`: that one does clear on retry. */
export function pageTimeoutError(timeoutMs: number): string {
  return `${PAGE_TIMEOUT_PREFIX} ${Math.round(timeoutMs / 1000)}s.`;
}
const PAGE_TIMEOUT_PREFIX = "No response within";

/** Finding codes for a page that could not be read; only `fetch` is worth
 * retrying by recapture. */
function fetchCode(error: string): "budget" | "timeout" | "fetch" {
  if (error === ACCEPTANCE_BUDGET_EXHAUSTED) return "budget";
  if (error.startsWith(PAGE_TIMEOUT_PREFIX)) return "timeout";
  return "fetch";
}

/** Plan §7.2 item 4: the five surfaces render themed, the missing route is a
 * real (themed) 404, and every one of them tells crawlers to stay away. */
export function routeRenderFindings(
  routes: readonly RouteFetchResult[],
): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const route of routes) {
    const expected = route.surface === "not_found" ? 404 : 200;
    if (route.error) {
      findings.push({
        code: fetchCode(route.error),
        message: route.error,
        where: route.path,
      });
      continue;
    }
    if (route.status !== expected) {
      findings.push({
        code: "status",
        message: `Returned ${route.status ?? "no response"}, expected ${expected}.`,
        where: route.path,
      });
      continue;
    }
    if (!route.themed) {
      findings.push({
        code: "unthemed",
        message: "Rendered without the theme's design.",
        where: route.path,
      });
    }
    if (!route.noindex) {
      findings.push({
        code: "indexable",
        message: "A preview page did not carry noindex.",
        where: route.path,
      });
    }
  }
  return findings;
}

/**
 * Whether a rendered page carries the theme's root classes. The class list is
 * matched as ONE contiguous string, either in the HTML attribute or inside the
 * streamed RSC payload: a not-found page can arrive as Next's minimal error
 * document with the real tree in the payload, and it is still the themed
 * storefront 404 once rendered.
 */
export function renderedWithTheme(html: string): boolean {
  return /storefront-root\b[^"\\<>]*\bsm-themed-type\b/.test(html);
}

export interface LinkCheckResult {
  path: string;
  status: number | null;
  error: string | null;
}

export function linkFindings(links: readonly LinkCheckResult[]): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const link of links) {
    if (link.error) {
      findings.push({
        code: fetchCode(link.error),
        message: link.error,
        where: link.path,
      });
    } else if (link.status === null || link.status >= 400) {
      findings.push({
        code: "broken",
        message: `Returned ${link.status ?? "no response"}.`,
        where: link.path,
      });
    }
  }
  return findings;
}

/** Attribute values of every occurrence of `attr` on `tag` elements. */
function attributeValues(html: string, tag: string, attr: string): string[] {
  const out: string[] = [];
  const tagRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const attrRe = new RegExp(
    `\\s${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  for (const match of html.matchAll(tagRe)) {
    const found = match[0].match(attrRe);
    if (found) out.push(found[2] ?? found[3] ?? found[4] ?? "");
  }
  return out;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&quot;/g, '"');
}

/** A resource URL counts as first-party when it is relative, or absolute on
 * the page's own origin. */
function isFirstParty(url: string, origin: string): boolean {
  const value = decodeEntities(url.trim());
  if (value === "" || value.startsWith("#")) return true;
  // An inline image costs no request and reveals nothing to anyone.
  if (/^data:image\//i.test(value)) return true;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

/** Same-origin page links worth crawling, from one rendered page. */
export function internalLinks(html: string): string[] {
  const links = new Set<string>();
  for (const raw of attributeValues(html, "a", "href")) {
    const href = decodeEntities(raw.trim());
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    if (href.startsWith("/api/") || href.startsWith("/_next/")) continue;
    const path = href.split("#")[0];
    if (path) links.add(path);
  }
  return [...links];
}

/**
 * Static checks on rendered HTML: nothing loads from another origin, and every
 * image says what it is (an empty alt is a deliberate "decorative", a missing
 * one is a defect). The browser stage runs axe over the live page; this is the
 * part that needs no browser.
 */
export function markupFindings(
  pages: readonly { path: string; html: string }[],
  origin: string,
): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const { path, html } of pages) {
    const resources = [
      ...attributeValues(html, "img", "src"),
      ...attributeValues(html, "script", "src"),
      ...attributeValues(html, "iframe", "src"),
      ...attributeValues(html, "source", "src"),
      ...attributeValues(html, "video", "src"),
      ...attributeValues(html, "video", "poster"),
    ];
    const foreign = resources.filter(
      (url) => url && !isFirstParty(url, origin),
    );
    for (const url of [...new Set(foreign)].slice(0, 5)) {
      findings.push({
        code: "external_resource",
        message: `Loads ${url.slice(0, 120)} from another origin.`,
        where: path,
      });
    }
    for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
      if (!/\salt\s*=/i.test(tag)) {
        findings.push({
          code: "img_alt",
          message: "An image has no alt attribute.",
          where: path,
        });
        break;
      }
    }
    // Next's minimal error document (a not-found page's first paint) has no
    // lang until the payload renders; the browser stage's axe run checks the
    // rendered page, so only a full document is held to it here.
    const errorShell = /<html\b[^>]*\bid="__next_error__"/.test(html);
    if (!errorShell && !/<html\b[^>]*\slang\s*=\s*["']?[a-z]/i.test(html)) {
      findings.push({
        code: "lang",
        message: "The page has no language.",
        where: path,
      });
    }
  }
  return findings;
}

// ------------------------------------------------------------ browser stage

/** Track 5's five browser widths. The package renderer contract deliberately
 * remains the original desktop/tablet/mobile trio; these are QA samples, not
 * theme-authored breakpoints. */
export const THEME_STUDIO_QA_VIEWPORTS = {
  phone360: { width: 360, height: 800 },
  phone390: { width: 390, height: 844 },
  tablet768: { width: 768, height: 1024 },
  laptop1024: { width: 1024, height: 768 },
  desktop1440: { width: 1440, height: 900 },
} as const;

export type AcceptanceViewport = keyof typeof THEME_STUDIO_QA_VIEWPORTS;
export const ACCEPTANCE_VIEWPORTS = Object.keys(
  THEME_STUDIO_QA_VIEWPORTS,
) as AcceptanceViewport[];

export const AXE_IMPACTS = [
  "minor",
  "moderate",
  "serious",
  "critical",
] as const;
export type AxeImpact = (typeof AXE_IMPACTS)[number];

export interface BrowserSample {
  viewport: AcceptanceViewport;
  surface: AcceptanceSurface;
  path: string;
  width: number;
  height: number;
  overflowPx: number;
  overflowOffenders: string[];
  clippedText: { target: string; clippedX: number; clippedY: number }[];
  /** How many clipped elements the probe found before it cut its list to
   * the largest (studio-acceptance-probe.tsx clippedText). Absent on
   * evidence from a probe that listed them in page order and stopped at its
   * limit, whose full list may leave a larger clip out. */
  clippedTextFound?: number;
  smallTapTargets: { target: string; width: number; height: number }[];
  imageCropIssues: { target: string; retainedFraction: number }[];
  brokenImages: number;
  violations: {
    id: string;
    impact: AxeImpact | null;
    nodes: number;
    help: string;
    /** The first offending element's selector, when the browser gave one. */
    target?: string;
    /** Bounded representative selectors and axe's measured failure details. */
    examples?: { target: string; summary: string }[];
    contrast?: { target: string; ratio: number; required: number }[];
  }[];
  lcpMs: number | null;
  cls: number | null;
  /** axe's `incomplete` colour-contrast nodes: text it could not judge
   * (over a photograph, gradient or overlapping layer). Evidence for the
   * vision reviewer, never a gate. Absent on evidence older than the probe
   * that reports it. */
  contrastUnresolved?: { target: string; reason: string }[];
  /** The chrome states opened and audited on this page. The probe opens
   * them on the home page only, and the coverage gate requires them there;
   * absent on every other surface and on older evidence. */
  states?: BrowserStateSample[];
  /** The header's menu as this screen showed it (home page only; absent on
   * older evidence): the header layout, its top-level items, whether they
   * were on screen or behind the menu button, and whether they had to move
   * to a row of their own under a centred logo (absent on older evidence). */
  headerMenu?: {
    layout: string;
    links: number;
    shown: boolean;
    stacked?: boolean;
  };
}

/** The widths a shopper reads as a computer, where a hidden menu is a
 *  finding. Phones and the portrait tablet always use the menu button. */
const HEADER_MENU_VIEWPORTS: readonly AcceptanceViewport[] = [
  "laptop1024",
  "desktop1440",
];

/**
 * A menu a shopper on a computer cannot see (owner, 23 Nov 2026: Muse's
 * menu sat behind the menu button on a 1440px screen through two designs,
 * and no check said so). The hamburger header hides it on purpose, so it is
 * never a finding there. Advisory: a theme may still choose a menu button;
 * the operator is told, and a change to design.layout.header clears it.
 * ★ The same day: a centred header's menu that had to move to a row of its
 *   own under the logo (`menu_wraps`). Theme Studio plans a new theme's menu
 *   to fit beside the logo (menu-fit.ts), so this says the plan's measure
 *   missed or a change made the menu longer. Advisory too.
 */
export function headerMenuFindings(
  samples: readonly BrowserSample[],
): GateFinding[] {
  return samples.flatMap((sample) => {
    const menu = sample.headerMenu;
    if (
      sample.surface !== "home" ||
      !HEADER_MENU_VIEWPORTS.includes(sample.viewport) ||
      !menu ||
      menu.links === 0 ||
      menu.layout === "hamburger"
    )
      return [];
    if (menu.shown)
      return menu.stacked
        ? [
            {
              code: "menu_wraps",
              message: `The header's menu does not fit beside the centred logo on this screen, so it sits on a row of its own under it (${menu.links} ${menu.links === 1 ? "link" : "links"}).`,
              where: `${sample.viewport} · ${sample.surface}`,
            },
          ]
        : [];
    return [
      {
        code: "menu_hidden",
        message:
          menu.links === 1
            ? `The header's menu link is hidden behind the menu button on this screen: it does not fit beside the logo (${menu.layout} header).`
            : `The header's ${menu.links} menu links are hidden behind the menu button on this screen: they do not fit beside the logo (${menu.layout} header).`,
        where: `${sample.viewport} · ${sample.surface}`,
      },
    ];
  });
}

/** One chrome state (menu drawer, search sheet, cart drawer, account menu,
 * sign-in dialog) as the probe opened it. `measured` false carries why;
 * `stuck` may accompany a measured state that then would not close. */
export interface BrowserStateSample {
  state: ChromeState;
  measured: boolean;
  reason?: ChromeStateSkip;
  violations: BrowserSample["violations"];
  clippedText: BrowserSample["clippedText"];
  clippedTextFound?: number;
  smallTapTargets: BrowserSample["smallTapTargets"];
  contrastUnresolved: { target: string; reason: string }[];
}

export interface BrowserEvidence {
  userAgent: string;
  samples: BrowserSample[];
}

const SURFACES: readonly AcceptanceSurface[] = [
  "home",
  "shop",
  "product",
  "cart",
  "content",
  "not_found",
];

function str(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

/**
 * Strictly parse what the operator's browser sent. Anything malformed is
 * refused outright rather than repaired: a missing measurement must never be
 * read as a clean one.
 */
export function parseBrowserEvidence(
  raw: unknown,
): { ok: true; value: BrowserEvidence } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "The browser report is not an object." };
  }
  const input = raw as Record<string, unknown>;
  const userAgent = str(input.userAgent, 300) ?? "";
  if (!Array.isArray(input.samples) || input.samples.length === 0) {
    return { ok: false, error: "The browser report has no samples." };
  }
  if (input.samples.length > ACCEPTANCE_VIEWPORTS.length * SURFACES.length) {
    return { ok: false, error: "The browser report has too many samples." };
  }
  const samples: BrowserSample[] = [];
  for (const [index, item] of input.samples.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `Sample ${index} is not an object.` };
    }
    const s = item as Record<string, unknown>;
    const viewport = s.viewport as AcceptanceViewport;
    const surface = s.surface as AcceptanceSurface;
    if (
      !ACCEPTANCE_VIEWPORTS.includes(viewport) ||
      !SURFACES.includes(surface)
    ) {
      return {
        ok: false,
        error: `Sample ${index} names an unknown viewport or surface.`,
      };
    }
    const width = finiteNumber(s.width, 1, 10_000);
    const height = finiteNumber(s.height, 1, 10_000);
    const overflowPx = finiteNumber(s.overflowPx, -100_000, 100_000);
    const brokenImages = finiteNumber(s.brokenImages, 0, 10_000);
    if (
      width === null ||
      height === null ||
      overflowPx === null ||
      brokenImages === null
    ) {
      return { ok: false, error: `Sample ${index} is missing a measurement.` };
    }
    if (!Array.isArray(s.violations) || s.violations.length > 100) {
      return {
        ok: false,
        error: `Sample ${index} has no accessibility result.`,
      };
    }
    if (
      !Array.isArray(s.clippedText) ||
      !Array.isArray(s.smallTapTargets) ||
      !Array.isArray(s.imageCropIssues)
    ) {
      return {
        ok: false,
        error: `Sample ${index} is missing a layout-quality measurement.`,
      };
    }
    const violations = parseViolations(s.violations, index);
    if (!violations.ok) return violations;
    const offenders = Array.isArray(s.overflowOffenders)
      ? s.overflowOffenders
          .slice(0, 5)
          .map((o) => str(o, 120))
          .filter((o): o is string => o !== null)
      : [];
    const clippedText = parseClippedText(s.clippedText);
    const clippedTextFound = finiteNumber(s.clippedTextFound, 0, 100_000);
    const smallTapTargets = parseSmallTapTargets(s.smallTapTargets);
    // Both are absent on evidence from a probe older than the one that
    // reports them; a present value must parse, and the gates decide what an
    // absent one means (coverage requires states on the home page).
    const contrastUnresolved =
      s.contrastUnresolved === undefined
        ? undefined
        : parseUnresolved(s.contrastUnresolved);
    const states =
      s.states === undefined ? undefined : parseStates(s.states, index);
    if (states && !states.ok) return states;
    const headerMenu = parseHeaderMenu(s.headerMenu);
    const imageCropIssues = Array.isArray(s.imageCropIssues)
      ? s.imageCropIssues.slice(0, 40).flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const value = item as Record<string, unknown>;
          const target = str(value.target, 120);
          const retainedFraction = finiteNumber(value.retainedFraction, 0, 1);
          return target && retainedFraction !== null
            ? [{ target, retainedFraction }]
            : [];
        })
      : [];
    samples.push({
      viewport,
      surface,
      path: str(s.path, 512) ?? "",
      width,
      height,
      overflowPx,
      overflowOffenders: offenders,
      clippedText,
      ...(clippedTextFound !== null ? { clippedTextFound } : {}),
      smallTapTargets,
      imageCropIssues,
      brokenImages,
      violations: violations.value,
      lcpMs: finiteNumber(s.lcpMs, 0, 600_000),
      cls: finiteNumber(s.cls, 0, 1_000),
      ...(contrastUnresolved ? { contrastUnresolved } : {}),
      ...(states ? { states: states.value } : {}),
      ...(headerMenu ? { headerMenu } : {}),
    });
  }
  return { ok: true, value: { userAgent, samples } };
}

/** The probe's header menu; anything malformed is treated as not measured. */
function parseHeaderMenu(raw: unknown): BrowserSample["headerMenu"] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const layout = str(value.layout, 20);
  const links = finiteNumber(value.links, 0, 200);
  if (!layout || links === null || typeof value.shown !== "boolean")
    return null;
  return {
    layout,
    links,
    shown: value.shown,
    ...(typeof value.stacked === "boolean" ? { stacked: value.stacked } : {}),
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseViolations(
  raw: unknown[],
  index: number,
): Parsed<BrowserSample["violations"]> {
  const malformed = {
    ok: false as const,
    error: `Sample ${index} has a malformed violation.`,
  };
  const violations: BrowserSample["violations"] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") return malformed;
    const record = v as Record<string, unknown>;
    const id = str(record.id, 80);
    const nodes = finiteNumber(record.nodes, 0, 100_000);
    if (!id || nodes === null) return malformed;
    const impact = AXE_IMPACTS.includes(record.impact as AxeImpact)
      ? (record.impact as AxeImpact)
      : null;
    const target = str(record.target, 120);
    const examples = Array.isArray(record.examples)
      ? record.examples.slice(0, 3).flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const example = item as Record<string, unknown>;
          const target = str(example.target, 180);
          return target
            ? [{ target, summary: str(example.summary, 300) ?? "" }]
            : [];
        })
      : [];
    violations.push({
      id,
      impact,
      nodes,
      help: str(record.help, 200) ?? "",
      ...(target ? { target } : {}),
      ...(examples.length ? { examples } : {}),
      ...(id === "color-contrast" && Array.isArray(record.contrast)
        ? {
            contrast: record.contrast.slice(0, 40).flatMap((item) => {
              if (!item || typeof item !== "object") return [];
              const value = item as Record<string, unknown>;
              const target = str(value.target, 180);
              const ratio = finiteNumber(value.ratio, 1, 21);
              const required = finiteNumber(value.required, 1, 21);
              return target && ratio !== null && required !== null
                ? [{ target, ratio, required }]
                : [];
            }),
          }
        : {}),
    });
  }
  return { ok: true, value: violations };
}

/** How many clipped elements the probe lists on a page and in one opened
 * chrome state (studio-acceptance-probe.tsx). The server keeps at most the
 * page's number, the largest clips first. */
export const PROBE_CLIPPED_TEXT_LIMITS = { page: 40, state: 20 } as const;

function clipSize(item: { clippedX: number; clippedY: number }): number {
  return Math.max(item.clippedX, item.clippedY);
}

/** The clipped elements a sample or a state reports, the largest clip first
 * before the list is cut, so the cut can never drop a serious clip behind
 * smaller ones (a stable sort: equal clips keep their page order). */
function parseClippedText(raw: unknown): BrowserSample["clippedText"] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      const target = str(value.target, 120);
      const clippedX = finiteNumber(value.clippedX, 0, 100_000);
      const clippedY = finiteNumber(value.clippedY, 0, 100_000);
      return target && clippedX !== null && clippedY !== null
        ? [{ target, clippedX, clippedY }]
        : [];
    })
    .sort((a, b) => clipSize(b) - clipSize(a))
    .slice(0, PROBE_CLIPPED_TEXT_LIMITS.page);
}

function parseSmallTapTargets(raw: unknown): BrowserSample["smallTapTargets"] {
  return Array.isArray(raw)
    ? raw.slice(0, 60).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const value = item as Record<string, unknown>;
        const target = str(value.target, 120);
        const width = finiteNumber(value.width, 0, 10_000);
        const height = finiteNumber(value.height, 0, 10_000);
        return target && width !== null && height !== null
          ? [{ target, width, height }]
          : [];
      })
    : [];
}

function parseUnresolved(raw: unknown): { target: string; reason: string }[] {
  return Array.isArray(raw)
    ? raw.slice(0, 40).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const value = item as Record<string, unknown>;
        const target = str(value.target, 180);
        const reason = str(value.reason, 40);
        return target && reason ? [{ target, reason }] : [];
      })
    : [];
}

/** The chrome states a sample carries. Strict like the sample itself: a
 * state with an unknown name, no `measured`, an unknown skip reason or no
 * violations list is refused, because a missing measurement must never be
 * read as a clean one. */
function parseStates(
  raw: unknown,
  index: number,
): Parsed<BrowserStateSample[]> {
  const malformed = {
    ok: false as const,
    error: `Sample ${index} has a malformed chrome state.`,
  };
  if (!Array.isArray(raw) || raw.length > CHROME_STATES.length * 2) {
    return malformed;
  }
  const states: BrowserStateSample[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return malformed;
    const value = item as Record<string, unknown>;
    const state = value.state as ChromeState;
    if (!CHROME_STATES.includes(state) || typeof value.measured !== "boolean") {
      return malformed;
    }
    const reason = value.reason as ChromeStateSkip | undefined;
    if (reason !== undefined && !CHROME_STATE_SKIPS.includes(reason)) {
      return malformed;
    }
    if (!Array.isArray(value.violations) || value.violations.length > 100) {
      return malformed;
    }
    const violations = parseViolations(value.violations, index);
    if (!violations.ok) return violations;
    const clippedTextFound = finiteNumber(value.clippedTextFound, 0, 100_000);
    states.push({
      state,
      measured: value.measured,
      ...(reason ? { reason } : {}),
      violations: violations.value,
      clippedText: parseClippedText(value.clippedText),
      ...(clippedTextFound !== null ? { clippedTextFound } : {}),
      smallTapTargets: parseSmallTapTargets(value.smallTapTargets),
      contrastUnresolved: parseUnresolved(value.contrastUnresolved),
    });
  }
  return { ok: true, value: states };
}

/**
 * Plan thresholds (docs/theme-studio-shopify-grade-plan.md, Phase 1 item 4):
 * LCP ≤ 3.0 s (relaxed from the 2.5 s "good" line because the preview is
 * not CDN-fronted) and CLS under 0.1, judged at the two widths below. The
 * other three widths are measured and reported in the metrics, never failed.
 */
export const PERFORMANCE_THRESHOLDS = { lcpMs: 3000, cls: 0.1 } as const;
export const PERFORMANCE_VIEWPORTS: readonly AcceptanceViewport[] = [
  "phone390",
  "desktop1440",
];

interface AuditSinks {
  clippedText: GateFinding[];
  tapTargets: GateFinding[];
  accessibility: GateFinding[];
}

/** The findings a page and an opened chrome state share (clipped text,
 * small targets and axe violations), pushed to their gates under `where`.
 * `clipLimit` is how many clipped elements the probe lists there
 * (PROBE_CLIPPED_TEXT_LIMITS). Returns how many violations were serious
 * (finding-severity.ts): colour contrast below the AA line whatever its
 * impact, and every other rule at a serious, critical or unknown impact. */
function pushAuditFindings(
  audit: Pick<
    BrowserStateSample,
    "violations" | "clippedText" | "clippedTextFound" | "smallTapTargets"
  >,
  where: string,
  sinks: AuditSinks,
  clipLimit: number,
): number {
  const clipped: GateFinding[] = audit.clippedText.map((item) => {
    const x = Math.round(item.clippedX);
    const y = Math.round(item.clippedY);
    return {
      code: "clipped_text",
      message: `Text is clipped by ${x}px horizontally and ${y}px vertically (${item.target}).`,
      where,
      clipped: { x, y },
      targets: [item.target],
    };
  });
  sinks.clippedText.push(...clipped);
  // A clip of a pixel or two is a warning, so a list cut at its limit must
  // hold the largest clips, or a heading cut in half could hide behind a
  // grid of slightly clipped titles. A probe that says how many it found
  // lists the largest first; an older one listed them in page order and
  // stopped at its limit. Its full list with no serious clip in it is a clip
  // nobody measured: "we could not check it", never a pass, and a check on
  // today's probe measures them all.
  if (
    (audit.clippedTextFound === undefined ||
      audit.clippedTextFound < audit.clippedText.length) &&
    audit.clippedText.length >= clipLimit &&
    !clipped.some(
      (finding) =>
        findingSeverity("browser.clipped_text", finding) === "serious",
    )
  ) {
    sinks.clippedText.push({
      code: "unmeasured",
      message: `Text is clipped in at least ${audit.clippedText.length} places, and the list stopped there, so a larger clip may not have been measured.`,
      where,
    });
  }
  for (const item of audit.smallTapTargets) {
    sinks.tapTargets.push({
      code: "small_target",
      message: `${Math.round(item.width)}×${Math.round(item.height)}px interactive target (${item.target}); minimum is 24×24px.`,
      where,
    });
  }
  let serious = 0;
  for (const violation of audit.violations) {
    const targets = violation.examples?.length
      ? violation.examples.map((example) => example.target)
      : violation.target
        ? [violation.target]
        : [];
    const entry: GateFinding = {
      code: violation.id,
      message: `${violation.help || violation.id} (${violation.nodes} element${violation.nodes === 1 ? "" : "s"}, ${violation.impact ?? "unrated"})${
        violation.examples?.length
          ? `; examples: ${violation.examples.map((example) => `${example.target}${example.summary ? `: ${example.summary}` : ""}`).join(" | ")}`
          : violation.target
            ? `; first: ${violation.target}`
            : ""
      }`,
      where,
      impact: violation.impact,
      nodes: violation.nodes,
      ...(targets.length ? { targets } : {}),
      ...(violation.contrast?.length ? { contrast: violation.contrast } : {}),
    };
    sinks.accessibility.push(entry);
    if (findingSeverity("browser.accessibility", entry) === "serious") {
      serious += 1;
    }
  }
  return serious;
}

/**
 * The chrome states the probe opened on the home page. They are hidden on
 * load, so the page audit never sees them: the roastery's 1.37:1 delivery
 * trigger (benchmark 2026-10-04) lived in the open phone menu. A state the
 * probe could not open or close is a COVERAGE failure, like a page it could
 * not measure; what it found inside goes to the same gates as the page, with
 * the state named in `where`. `absent` and `hidden` are ordinary (no cart on
 * a catalogue store, no hamburger on desktop) and only count in the metric.
 */
function stateFindings(
  sample: BrowserSample,
  where: string,
  coverage: GateFinding[],
  sinks: AuditSinks,
): { measured: number; blocking: number } {
  if (!sample.states) {
    coverage.push({
      code: "states_missing",
      message:
        "The menu, search, cart, account and sign-in states were not measured.",
      where,
    });
    return { measured: 0, blocking: 0 };
  }
  const seen = new Set(sample.states.map((s) => s.state));
  for (const state of CHROME_STATES) {
    if (!seen.has(state)) {
      coverage.push({
        code: "state_missing",
        message: `The ${CHROME_STATE_LABELS[state]} was not measured.`,
        where,
      });
    }
  }
  let measured = 0;
  let blocking = 0;
  for (const state of sample.states) {
    const label = CHROME_STATE_LABELS[state.state];
    const stateWhere = `${where} · ${label}`;
    if (state.reason === "unopened") {
      coverage.push({
        code: "state_unopened",
        message: `The ${label} did not open when its control was pressed.`,
        where: stateWhere,
      });
    } else if (state.reason === "stuck") {
      coverage.push({
        code: "state_stuck",
        message: `The ${label} did not close after it was measured.`,
        where: stateWhere,
      });
    }
    if (!state.measured) continue;
    measured += 1;
    blocking += pushAuditFindings(
      state,
      stateWhere,
      sinks,
      PROBE_CLIPPED_TEXT_LIMITS.state,
    );
  }
  return { measured, blocking };
}

/**
 * Plan §7.2 items 5 to 7 as far as a browser can measure them: every surface
 * at every viewport, no horizontal overflow, no serious axe violation, no
 * broken image. The expected surfaces come from the SERVER's record of the
 * run, so a report that silently skips a page fails coverage.
 */
export function evaluateBrowserGates(
  evidence: BrowserEvidence,
  expectedSurfaces: readonly AcceptanceSurface[],
  options: {
    /**
     * Whether `browser.performance` FAILS a run (`THEME_STUDIO_PERFORMANCE_REQUIRED`).
     * Advisory by default: the 2026-10-04 benchmark measured LCP up to 25 s
     * and CLS up to 1.4 because the probe read both AFTER its scroll-through
     * (fixed in the same change); until a live batch shows the frozen
     * numbers, requiring the gate would fail every candidate for a
     * measurement fault. The flip is one environment variable.
     */
    performanceRequired?: boolean;
  } = {},
): GateResult[] {
  const coverage: GateFinding[] = [];
  const bySample = new Map<string, BrowserSample>();
  for (const sample of evidence.samples) {
    bySample.set(`${sample.viewport}:${sample.surface}`, sample);
  }
  for (const viewport of ACCEPTANCE_VIEWPORTS) {
    const expectedWidth = THEME_STUDIO_QA_VIEWPORTS[viewport].width;
    for (const surface of expectedSurfaces) {
      const sample = bySample.get(`${viewport}:${surface}`);
      if (!sample) {
        coverage.push({
          code: "missing",
          message: "Not measured.",
          where: `${viewport} · ${surface}`,
        });
      } else if (Math.abs(sample.width - expectedWidth) > 1) {
        coverage.push({
          code: "viewport",
          message: `Measured at ${sample.width}px, expected ${expectedWidth}px.`,
          where: `${viewport} · ${surface}`,
        });
      }
    }
  }
  const measured = [...bySample.values()].filter((s) =>
    expectedSurfaces.includes(s.surface),
  );

  const overflow: GateFinding[] = [];
  const clippedText: GateFinding[] = [];
  const tapTargets: GateFinding[] = [];
  const imageCrops: GateFinding[] = [];
  const accessibility: GateFinding[] = [];
  const media: GateFinding[] = [];
  const performance: GateFinding[] = [];
  let worstLcp: number | null = null;
  let worstCls: number | null = null;
  let blockingViolations = 0;
  let statesMeasured = 0;
  const sinks: AuditSinks = {
    clippedText,
    tapTargets,
    accessibility,
  };

  for (const sample of measured) {
    const where = `${sample.viewport} · ${sample.surface}`;
    if (sample.overflowPx > 1) {
      overflow.push({
        code: "horizontal_overflow",
        message: `The page is ${Math.round(sample.overflowPx)}px wider than the viewport${sample.overflowOffenders.length ? ` (${sample.overflowOffenders.join(", ")})` : ""}.`,
        where,
        ...(sample.overflowOffenders.length
          ? { targets: [...sample.overflowOffenders] }
          : {}),
      });
    }
    blockingViolations += pushAuditFindings(
      sample,
      where,
      sinks,
      PROBE_CLIPPED_TEXT_LIMITS.page,
    );
    for (const item of sample.imageCropIssues) {
      imageCrops.push({
        code: "extreme_crop",
        message: `Only ${Math.round(item.retainedFraction * 100)}% of the source frame remains visible (${item.target}).`,
        where,
      });
    }
    if (sample.surface === "home") {
      const states = stateFindings(sample, where, coverage, sinks);
      statesMeasured += states.measured;
      blockingViolations += states.blocking;
    }
    if (sample.brokenImages > 0) {
      media.push({
        code: "broken_image",
        message: `${sample.brokenImages} image${sample.brokenImages === 1 ? "" : "s"} failed to load.`,
        where,
      });
    }
    if (sample.lcpMs !== null) worstLcp = Math.max(worstLcp ?? 0, sample.lcpMs);
    if (sample.cls !== null) worstCls = Math.max(worstCls ?? 0, sample.cls);
    if (!PERFORMANCE_VIEWPORTS.includes(sample.viewport)) continue;
    if (sample.lcpMs === null) {
      // Not reported inside a frame (the operator's browser run). Once the
      // gate is required, "we could not measure" is not a pass; while it is
      // advisory the absence is simply not a finding.
      if (options.performanceRequired) {
        performance.push({
          code: "unmeasured",
          message:
            "LCP was not reported; performance passes only from the automatic capture.",
          where,
        });
      }
    } else if (sample.lcpMs > PERFORMANCE_THRESHOLDS.lcpMs) {
      performance.push({
        code: "lcp",
        message: `LCP ${Math.round(sample.lcpMs)}ms; the limit is ${PERFORMANCE_THRESHOLDS.lcpMs}ms.`,
        where,
      });
    }
    if (sample.cls !== null && sample.cls >= PERFORMANCE_THRESHOLDS.cls) {
      performance.push({
        code: "cls",
        message: `CLS ${sample.cls.toFixed(3)}; the limit is under ${PERFORMANCE_THRESHOLDS.cls}.`,
        where,
      });
    }
  }

  // Lower-impact violations are listed, as warnings, without failing the
  // gate; a serious one fails it. gate() puts the serious ones first.
  const accessibilityGate = gate("browser.accessibility", accessibility, {
    status: blockingViolations > 0 ? "fail" : "pass",
    metrics: {
      blockingViolations,
      otherViolations: accessibility.length - blockingViolations,
    },
  });
  const performanceRequired = options.performanceRequired ?? false;

  return [
    gate("browser.coverage", coverage, {
      metrics: {
        samples: measured.length,
        expected: ACCEPTANCE_VIEWPORTS.length * expectedSurfaces.length,
        states: statesMeasured,
      },
    }),
    gate("browser.overflow", overflow),
    gate("browser.clipped_text", clippedText),
    gate("browser.tap_targets", tapTargets),
    gate("browser.image_crops", imageCrops),
    accessibilityGate,
    gate("browser.media", media),
    // Speed is a warning while the gate is advisory. A deployment that makes
    // it required wants slowness to stop a run, so its findings are measured
    // as serious; "unmeasured" is serious either way.
    gate("browser.header_menu", headerMenuFindings(measured), {
      required: false,
    }),
    gate(
      "browser.performance",
      performanceRequired
        ? performance.map((finding) => ({
            ...finding,
            severity: "serious" as const,
          }))
        : performance,
      {
        required: performanceRequired,
        metrics: {
          worstLcpMs: worstLcp,
          worstCls,
          judgedAt: PERFORMANCE_VIEWPORTS.join(", "),
        },
      },
    ),
  ];
}

// ------------------------------------------------------------ verdict

export type AcceptanceOutcome = "pass" | "fail" | "blocked";

/** A failed security gate blocks the project. Otherwise a run passes when no
 * gate stops it (gateBlocks): no serious finding is left, and every required
 * check ran, since a skipped one is never a pass. Warnings ride along. */
export function acceptanceOutcome(
  gates: readonly GateResult[],
): AcceptanceOutcome {
  if (gates.some((g) => g.id === "package.security" && g.status === "fail")) {
    return "blocked";
  }
  return gates.some(gateBlocks) ? "fail" : "pass";
}

export interface AcceptanceReport {
  version: typeof ACCEPTANCE_REPORT_VERSION;
  gates: GateResult[];
  /** The surfaces the browser stage must measure, fixed by the server. */
  surfaces?: AcceptanceSurface[];
  userAgent?: string;
  /** The severity rules the report was judged under, when the writer
   * recorded them (SEVERITY_RULES_VERSION); each gate also carries its own. */
  severityRules?: string;
}

/** Read a stored report back leniently for display: anything unexpected is
 * dropped rather than trusted. */
export function readAcceptanceReport(value: unknown): AcceptanceReport {
  const input =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const gates = Array.isArray(input.gates)
    ? input.gates.filter(
        (g): g is GateResult =>
          !!g &&
          typeof g === "object" &&
          typeof (g as GateResult).id === "string" &&
          (g as GateResult).id in GATE_LABELS &&
          Array.isArray((g as GateResult).findings),
      )
    : [];
  const surfaces = Array.isArray(input.surfaces)
    ? input.surfaces.filter((s): s is AcceptanceSurface =>
        SURFACES.includes(s as AcceptanceSurface),
      )
    : undefined;
  return {
    version: ACCEPTANCE_REPORT_VERSION,
    gates,
    ...(surfaces ? { surfaces } : {}),
    ...(typeof input.userAgent === "string"
      ? { userAgent: input.userAgent }
      : {}),
    ...(typeof input.severityRules === "string"
      ? { severityRules: input.severityRules }
      : {}),
  };
}
