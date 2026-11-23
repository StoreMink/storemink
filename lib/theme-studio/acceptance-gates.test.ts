import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { THEME_DEFINITIONS } from "@/lib/themes";
import { collectThemeImageUrls } from "@/lib/themes/validation";
import type { ThemeDefinition } from "@/lib/themes/types";
import { logWarn } from "@/lib/observability/logger";
import {
  BELOW_TARGET_FRACTION,
  type BrowserStateSample,
  acceptanceAssetsDigest,
  acceptanceEvidenceDigest,
  acceptanceOutcome,
  acceptanceWarnings,
  evaluateBrowserGates,
  evaluatePackageGates,
  gate,
  gateBlocks,
  headerMenuFindings,
  imageRuleCode,
  internalLinks,
  linkFindings,
  pageTimeoutError,
  ACCEPTANCE_BUDGET_EXHAUSTED,
  MAX_GATE_FINDINGS,
  markupFindings,
  parseBrowserEvidence,
  readAcceptanceReport,
  renderedWithTheme,
  routeRenderFindings,
  securityFindings,
  THEME_STUDIO_QA_VIEWPORTS,
  type AcceptanceAssetRow,
  type AcceptanceSurface,
  type BrowserSample,
  type GateFinding,
  type GateResult,
} from "./acceptance-gates";
import { SEVERITY_RULES_VERSION } from "./finding-severity";

vi.mock("@/lib/observability/logger", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));
import { PLACEHOLDER_LICENSE_NOTE } from "./compiler";
import {
  THEME_PACKAGE_SCHEMA_VERSION,
  THEME_STUDIO_VIEWPORTS,
  type ThemePackageV2,
} from "./contracts";

// A Studio-shaped package built from a bundled theme: every image rewritten to
// a theme-asset:// slot backed by a stored row, release left as a hidden draft.
// It passes every package gate, so each test breaks exactly one thing.
function hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function fixture(): { pkg: ThemePackageV2; rows: AcceptanceAssetRow[] } {
  let theme: ThemeDefinition = structuredClone(THEME_DEFINITIONS[0]);
  // The Studio's package gate holds button labels to 4.5:1 on the accent
  // (validateStudioDesign); Basket's white on #ef5a2a is 3.41:1, which a
  // bundled theme may ship and a candidate may not.
  theme.preset.brand.primaryColor = "#c2410c";
  theme.preset.design.palette.accent = "#c2410c";
  const urls = [...collectThemeImageUrls(theme)];
  const slotFor = new Map(urls.map((url, i) => [url, `slot-${i}`]));
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string" && slotFor.has(value)) {
      return `theme-asset://${slotFor.get(value)}`;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, rewrite(v)]),
      );
    }
    return value;
  };
  theme = rewrite(theme) as ThemeDefinition;
  theme.catalog.visibility = "hidden";
  theme.release = { version: "0.0.3", status: "draft", notes: ["Generated."] };
  theme.demo = { slug: theme.demo.slug, status: "unavailable" };
  const assets = urls.map((url, i) => ({
    id: `slot-${i}`,
    path: `theme-asset://slot-${i}`,
    kind: (url === THEME_DEFINITIONS[0].catalog.previewImage
      ? "preview"
      : "content") as "preview" | "content",
    source: "generated" as const,
    sha256: hex(`asset-${i}`),
    width: 1600,
    height: 1200,
    alt: `Generated image ${i}`,
    licenseNote: "Generated for this theme and licensed to StoreMink.",
  }));
  const rows = assets.map((asset, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    purpose: "placeholder",
    mediaType: "image/webp",
    byteSize: 120_000,
    width: 1600,
    height: 1200,
    sha256: asset.sha256,
  }));
  const pkg: ThemePackageV2 = {
    schemaVersion: THEME_PACKAGE_SCHEMA_VERSION,
    definition: theme,
    renderer: {
      minVersion: theme.engine.version,
      viewports: THEME_STUDIO_VIEWPORTS,
    },
    declaredCapabilities: {
      features: [...theme.catalog.features],
      surfaces: ["home", "shop", "product", "cart"],
    },
    assets,
    provenance: {
      origin: "generated",
      modelKey: "gemini-3.8-flash",
      promptVersion: "theme-studio-v2",
      referenceDigests: [],
    },
    capabilityGaps: [],
  };
  return { pkg, rows };
}

function statusOf(gates: GateResult[], id: string) {
  return gates.find((g) => g.id === id)?.status;
}

describe("package gates", () => {
  it("a clean package passes every package gate", () => {
    const { pkg, rows } = fixture();
    const { gates, pkg: parsed } = evaluatePackageGates(pkg, rows);
    expect(parsed).not.toBeNull();
    for (const result of gates) {
      expect(result.findings, result.id).toEqual([]);
      expect(result.status, result.id).toBe("pass");
    }
  });

  it("a contract failure skips everything after it, and skipped fails", () => {
    const { pkg, rows } = fixture();
    const broken = { ...pkg, schemaVersion: 1 };
    const { gates, pkg: parsed } = evaluatePackageGates(broken, rows);
    expect(parsed).toBeNull();
    expect(statusOf(gates, "package.schema")).toBe("fail");
    expect(statusOf(gates, "package.content")).toBe("skipped");
    expect(acceptanceOutcome(gates)).toBe("fail");
  });

  it("placeholder imagery fails provenance", () => {
    const { pkg, rows } = fixture();
    pkg.assets[0].licenseNote = PLACEHOLDER_LICENSE_NOTE;
    const { gates } = evaluatePackageGates(pkg, rows);
    expect(statusOf(gates, "assets.provenance")).toBe("fail");
    expect(acceptanceOutcome(gates)).toBe("fail");
  });

  it("directs catalog placeholders to capture and artwork placeholders to Images", () => {
    const { pkg, rows } = fixture();
    const catalog = pkg.assets.find(
      (a) => a.path === pkg.definition.catalog.previewImage,
    )!;
    const capturePaths = new Set([
      pkg.definition.catalog.previewImage,
      ...pkg.definition.catalog.screenshots.map((s) => s.src),
    ]);
    const artwork = pkg.assets.find((a) => !capturePaths.has(a.path))!;
    catalog.licenseNote = PLACEHOLDER_LICENSE_NOTE;
    artwork.licenseNote = PLACEHOLDER_LICENSE_NOTE;
    const findings = evaluatePackageGates(pkg, rows).gates.find(
      (g) => g.id === "assets.provenance",
    )!.findings;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: catalog.id,
          message: expect.stringContaining("browser capture"),
        }),
        expect.objectContaining({
          where: artwork.id,
          message: expect.stringContaining("artwork slot"),
        }),
      ]),
    );
    expect(acceptanceOutcome(evaluatePackageGates(pkg, rows).gates)).toBe(
      "fail",
    );
  });

  it("an asset with no stored bytes, or a reference image, fails integrity", () => {
    const { pkg, rows } = fixture();
    const missing = rows.slice(1);
    missing[0] = { ...missing[0], purpose: "reference" };
    const findings = evaluatePackageGates(pkg, missing).gates.find(
      (g) => g.id === "assets.integrity",
    )!.findings;
    expect(findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["missing", "purpose"]),
    );
  });

  it("an undersized real image fails integrity; a placeholder is exempt", () => {
    const { pkg, rows } = fixture();
    rows[1] = { ...rows[1], width: 400, height: 300 };
    pkg.assets[1] = { ...pkg.assets[1], width: 400, height: 300 };
    const sized = evaluatePackageGates(pkg, rows).gates.find(
      (g) => g.id === "assets.integrity",
    )!;
    expect(sized.findings).toEqual([
      expect.objectContaining({ code: "too_small", severity: "serious" }),
    ]);
    pkg.assets[1].licenseNote = PLACEHOLDER_LICENSE_NOTE;
    const exempt = evaluatePackageGates(pkg, rows).gates.find(
      (g) => g.id === "assets.integrity",
    )!;
    expect(exempt.findings.map((f) => f.code)).not.toContain("too_small");
  });

  it("thin content fails the content gate without blocking", () => {
    const { pkg, rows } = fixture();
    pkg.definition.preset.sampleData!.products =
      pkg.definition.preset.sampleData!.products.slice(0, 3);
    const { gates } = evaluatePackageGates(pkg, rows);
    expect(statusOf(gates, "package.content")).toBe("fail");
    expect(acceptanceOutcome(gates)).toBe("fail");
  });

  it("a blocking capability gap fails the content gate", () => {
    const { pkg, rows } = fixture();
    pkg.capabilityGaps = [
      {
        code: "unsupported_section",
        requestedCapability: "3D product viewer",
        fallback: "Use a gallery.",
        blocking: true,
      } as never,
    ];
    const content = evaluatePackageGates(pkg, rows).gates.find(
      (g) => g.id === "package.content",
    );
    // The contract may reject the gap shape first; either way it cannot pass.
    expect(content?.status).not.toBe("pass");
  });
});

describe("security scan", () => {
  it("is clean for a clean package", () => {
    expect(securityFindings(fixture().pkg)).toEqual([]);
  });

  it("finds script tags, handlers and javascript: links in copy", () => {
    const { pkg } = fixture();
    pkg.definition.description =
      'Lovely <img src=x onerror="alert(1)"> and <script>steal()</script>';
    pkg.definition.preset.menus.header.push({
      label: "Hi",
      href: "javascript:alert(1)",
    } as never);
    const codes = securityFindings(pkg).map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining(["markup", "handler", "scheme", "external_link"]),
    );
  });

  it("finds an off-site image and a CSS escape in a design token", () => {
    const { pkg } = fixture();
    pkg.definition.preset.sampleData!.products[0].image_url =
      "https://evil.example/x.jpg";
    pkg.definition.preset.design.shape.card = "4px; background:url(x)";
    const codes = securityFindings(pkg).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["external_asset", "css"]));
  });

  it("finds an unregistered capability and custom code", () => {
    const { pkg } = fixture();
    pkg.declaredCapabilities.features = [];
    const page = pkg.definition.preset.pages[0];
    page.sections.push({
      ...page.sections[0],
      id: "x",
      type: "custom_code",
    } as never);
    const codes = securityFindings(pkg).map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining(["capability", "custom_code"]),
    );
  });

  it("a security failure BLOCKS rather than fails", () => {
    const gates = [
      gate("package.schema", []),
      gate("package.security", [{ code: "markup", message: "x" }]),
    ];
    expect(acceptanceOutcome(gates)).toBe("blocked");
  });

  it("ordinary copy mentioning words like online is not a handler", () => {
    const { pkg } = fixture();
    pkg.definition.description =
      "Shop online = easy. Order online today and pick up in store, anytime.";
    expect(securityFindings(pkg)).toEqual([]);
  });
});

describe("digests", () => {
  it("the assets digest moves when the backing bytes change", () => {
    const { pkg, rows } = fixture();
    const before = acceptanceAssetsDigest(pkg, rows);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(acceptanceAssetsDigest(pkg, [...rows].reverse())).toBe(before);
    const changed = rows.map((row, i) =>
      i === 0 ? { ...row, byteSize: 1 } : row,
    );
    expect(acceptanceAssetsDigest(pkg, changed)).not.toBe(before);
    const repointed = structuredClone(pkg);
    repointed.assets[0].sha256 = hex("other");
    expect(acceptanceAssetsDigest(repointed, rows)).not.toBe(before);
  });

  it("the evidence digest binds the inputs and every gate", () => {
    const binding = {
      runId: "r",
      versionId: "v",
      packageDigest: hex("p"),
      assetsDigest: hex("a"),
      buildId: "b1",
    };
    const gates = [gate("package.schema", [])];
    const base = acceptanceEvidenceDigest(binding, gates);
    expect(
      acceptanceEvidenceDigest({ ...binding, buildId: "b2" }, gates),
    ).not.toBe(base);
    expect(
      acceptanceEvidenceDigest(binding, [
        gate("package.schema", [{ code: "x", message: "y" }]),
      ]),
    ).not.toBe(base);
  });
});

describe("rendered routes", () => {
  it("recognises the themed root in HTML and in an escaped RSC payload", () => {
    expect(
      renderedWithTheme(
        '<div class="storefront-root sm-header-classic sm-themed-type sm-pdp-classic">',
      ),
    ).toBe(true);
    expect(
      renderedWithTheme(
        '["$","div",null,{\\"className\\":\\"storefront-root sm-header-classic sm-themed-type\\"}]',
      ),
    ).toBe(true);
    expect(
      renderedWithTheme('<div class="storefront-root sm-header-classic">'),
    ).toBe(false);
    // The two tokens in DIFFERENT class lists do not count.
    expect(
      renderedWithTheme(
        '<div class="storefront-root"></div><p class="sm-themed-type">',
      ),
    ).toBe(false);
  });

  it("does not hold Next's minimal error document to the lang rule", () => {
    expect(
      markupFindings(
        [
          {
            path: "/missing",
            html: '<!DOCTYPE html><html id="__next_error__"><body></body></html>',
          },
        ],
        "https://x.example",
      ),
    ).toEqual([]);
  });

  it("expects 200 for surfaces, 404 for the missing page, themed and noindex", () => {
    const ok = (surface: AcceptanceSurface, status: number) => ({
      surface,
      path: `/${surface}`,
      status,
      themed: true,
      noindex: true,
      error: null,
    });
    expect(
      routeRenderFindings([ok("home", 200), ok("not_found", 404)]),
    ).toEqual([]);
    const findings = routeRenderFindings([
      ok("home", 500),
      ok("not_found", 200),
      { ...ok("shop", 200), themed: false },
      { ...ok("cart", 200), noindex: false },
      { ...ok("content", 200), status: null, error: "timeout" },
    ]);
    expect(findings.map((f) => f.code)).toEqual([
      "status",
      "status",
      "unthemed",
      "indexable",
      "fetch",
    ]);
  });

  it("tells a slow page and a spent budget apart from a dropped connection", () => {
    const failing = (error: string) => ({
      surface: "home" as AcceptanceSurface,
      path: "/",
      status: null,
      themed: false,
      noindex: false,
      error,
    });
    expect(
      routeRenderFindings([
        failing(pageTimeoutError(45_000)),
        failing(ACCEPTANCE_BUDGET_EXHAUSTED),
        failing("socket hang up"),
      ]).map((f) => f.code),
    ).toEqual(["timeout", "budget", "fetch"]);
    expect(
      linkFindings([
        { path: "/a", status: null, error: pageTimeoutError(45_000) },
        { path: "/b", status: null, error: "read ECONNRESET" },
      ]).map((f) => f.code),
    ).toEqual(["timeout", "fetch"]);
  });

  it("broken links are 4xx/5xx, redirects are fine", () => {
    expect(
      linkFindings([
        { path: "/a", status: 200, error: null },
        { path: "/b", status: 307, error: null },
        { path: "/c", status: 404, error: null },
        { path: "/d", status: null, error: "timeout" },
      ]).map((f) => f.where),
    ).toEqual(["/c", "/d"]);
  });

  it("extracts only same-origin page links", () => {
    const html =
      '<a href="/shop">x</a><a href="/shop#top">y</a><a href="https://x.com">z</a>' +
      '<a href="//evil.example">e</a><a href="/api/x">a</a><a href="/_next/y">n</a>' +
      "<a href='/our-story'>s</a>";
    expect(internalLinks(html).sort()).toEqual(["/our-story", "/shop"]);
  });

  it("markup: foreign resources, missing alt and missing lang", () => {
    const origin = "https://studio-preview-abc.storemink.com";
    const clean =
      '<html lang="en"><img src="/_next/image?url=%2Fa" alt="">' +
      `<script src="/_next/static/x.js"></script><img src="${origin}/x.webp" alt="x">` +
      '<img src="data:image/gif;base64,AA" alt=""></html>';
    expect(markupFindings([{ path: "/", html: clean }], origin)).toEqual([]);
    const bad =
      '<html><img src="https://cdn.evil.example/p.jpg"><script src="https://t.example/a.js"></script></html>';
    expect(
      markupFindings([{ path: "/", html: bad }], origin).map((f) => f.code),
    ).toEqual(["external_resource", "external_resource", "img_alt", "lang"]);
  });
});

function sample(overrides: Partial<BrowserSample> = {}): BrowserSample {
  return {
    viewport: "desktop1440",
    surface: "home",
    path: "/",
    width: 1440,
    height: 900,
    overflowPx: 0,
    overflowOffenders: [],
    clippedText: [],
    smallTapTargets: [],
    imageCropIssues: [],
    brokenImages: 0,
    violations: [],
    states: measuredStates(),
    lcpMs: 900,
    cls: 0.01,
    ...overrides,
  };
}

function fullCoverage(surfaces: AcceptanceSurface[]): BrowserSample[] {
  return (
    ["phone360", "phone390", "tablet768", "laptop1024", "desktop1440"] as const
  ).flatMap((viewport) =>
    surfaces.map((surface) =>
      sample({
        viewport,
        surface,
        width: THEME_STUDIO_QA_VIEWPORTS[viewport].width,
      }),
    ),
  );
}

describe("★ the header menu on a computer (owner, 23 Nov 2026)", () => {
  // Muse's menu sat behind the menu button on a 1440px screen through two
  // designs, and no check said so.
  const hidden = { layout: "classic", links: 7, shown: false };

  it("warns when a computer screen shows the menu button instead of the menu", () => {
    const findings = headerMenuFindings([
      sample({ headerMenu: hidden }),
      sample({
        viewport: "laptop1024",
        width: 1024,
        headerMenu: { ...hidden, links: 1 },
      }),
    ]);
    expect(findings).toEqual([
      {
        code: "menu_hidden",
        message:
          "The header's 7 menu links are hidden behind the menu button on this screen: they do not fit beside the logo (classic header).",
        where: "desktop1440 · home",
      },
      {
        code: "menu_hidden",
        message:
          "The header's menu link is hidden behind the menu button on this screen: it does not fit beside the logo (classic header).",
        where: "laptop1024 · home",
      },
    ]);
  });

  it("says nothing for a shown menu, a hamburger header, phones and tablets, an empty menu or older evidence", () => {
    expect(
      headerMenuFindings([
        sample({ headerMenu: { ...hidden, shown: true } }),
        sample({ headerMenu: { ...hidden, layout: "hamburger" } }),
        sample({ headerMenu: { ...hidden, links: 0 } }),
        sample({ viewport: "tablet768", width: 768, headerMenu: hidden }),
        sample({ viewport: "phone390", width: 390, headerMenu: hidden }),
        sample({ surface: "shop", path: "/shop", headerMenu: hidden }),
        sample(),
      ]),
    ).toEqual([]);
  });

  it("★ warns when a centred menu had to move to a row of its own under the logo", () => {
    // Theme Studio plans a centred theme's menu to fit beside the logo
    // (menu-fit.ts); a second row says the plan missed or a change grew it.
    const wraps = { layout: "centered", links: 6, shown: true, stacked: true };
    expect(headerMenuFindings([sample({ headerMenu: wraps })])).toEqual([
      {
        code: "menu_wraps",
        message:
          "The header's menu does not fit beside the centred logo on this screen, so it sits on a row of its own under it (6 links).",
        where: "desktop1440 · home",
      },
    ]);
    // One row, or evidence from before the probe reported it: nothing.
    expect(
      headerMenuFindings([
        sample({ headerMenu: { ...wraps, stacked: false } }),
        sample({ headerMenu: { layout: "centered", links: 6, shown: true } }),
      ]),
    ).toEqual([]);
    const parsed = parseBrowserEvidence({
      userAgent: "test",
      samples: [sample({ headerMenu: wraps })],
    });
    expect(parsed.ok && parsed.value.samples[0].headerMenu).toEqual(wraps);
    const gates = evaluateBrowserGates(
      {
        userAgent: "test",
        samples: fullCoverage(["home"]).map((s) =>
          s.viewport === "desktop1440" ? { ...s, headerMenu: wraps } : s,
        ),
      },
      ["home"],
    );
    const menu = gates.find((g) => g.id === "browser.header_menu")!;
    expect(menu.findings.map((f) => [f.code, f.severity])).toEqual([
      ["menu_wraps", "minor"],
    ]);
    expect(gateBlocks(menu)).toBe(false);
  });

  it("is a warning that never stops a run, and the probe's value survives parsing", () => {
    const samples = fullCoverage(["home"]).map((s) =>
      s.viewport === "desktop1440" ? { ...s, headerMenu: hidden } : s,
    );
    const parsed = parseBrowserEvidence({ userAgent: "test", samples });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      parsed.value.samples.find((s) => s.viewport === "desktop1440")
        ?.headerMenu,
    ).toEqual(hidden);
    const gates = evaluateBrowserGates(parsed.value, ["home"]);
    const menu = gates.find((g) => g.id === "browser.header_menu")!;
    expect(menu).toMatchObject({ required: false, status: "advisory" });
    expect(menu.findings.map((f) => f.severity)).toEqual(["minor"]);
    expect(gateBlocks(menu)).toBe(false);
    // A malformed value is "not measured", never a parse failure.
    const odd = parseBrowserEvidence({
      userAgent: "test",
      samples: [sample({ headerMenu: { layout: 3 } as never })],
    });
    expect(odd.ok && odd.value.samples[0].headerMenu).toBeUndefined();
  });
});

describe("browser evidence", () => {
  it("bounds diagnostic examples and preserves contrast details in repair findings", () => {
    const parsed = parseBrowserEvidence({
      samples: [
        sample({
          violations: [
            {
              id: "color-contrast",
              impact: "serious",
              nodes: 27,
              help: "Low contrast",
              examples: [
                {
                  target: ".shop-card-base",
                  summary: "Foreground #aaa on #fff: 2.1:1; expected 4.5:1.",
                },
                { target: ".columnTitle", summary: "Footer heading: 2.3:1." },
                { target: "x".repeat(500), summary: "y".repeat(1000) },
                { target: ".ignored", summary: "Fourth example" },
              ],
            },
          ],
        }),
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const examples = parsed.value.samples[0].violations[0].examples!;
    expect(examples).toHaveLength(3);
    expect(examples[2].target).toHaveLength(180);
    expect(examples[2].summary).toHaveLength(300);
    const gate = evaluateBrowserGates(parsed.value, ["home"]).find(
      (g) => g.id === "browser.accessibility",
    )!;
    expect(gate.status).toBe("fail");
    expect(gate.findings[0].message).toContain(".columnTitle");
    expect(gate.findings[0].message).toContain(
      "Foreground #aaa on #fff: 2.1:1",
    );
    expect(gate.findings[0].message).not.toContain(".ignored");
  });
  it("parses a well-formed report and refuses malformed ones", () => {
    const good = parseBrowserEvidence({
      userAgent: "Chrome",
      samples: [sample()],
    });
    expect(good.ok).toBe(true);
    for (const bad of [
      null,
      { samples: [] },
      { samples: [{ ...sample(), viewport: "watch" }] },
      { samples: [{ ...sample(), overflowPx: "0" }] },
      { samples: [{ ...sample(), violations: undefined }] },
      { samples: [{ ...sample(), violations: [{ id: "", nodes: 1 }] }] },
      { samples: Array.from({ length: 31 }, () => sample()) },
    ]) {
      expect(parseBrowserEvidence(bad).ok).toBe(false);
    }
  });

  it("drops a client verdict and unknown impacts rather than trusting them", () => {
    const parsed = parseBrowserEvidence({
      samples: [
        {
          ...sample(),
          passed: true,
          violations: [{ id: "x", nodes: 1, impact: "catastrophic" }],
        },
      ],
    });
    expect(
      parsed.ok && parsed.value.samples[0].violations[0].impact,
    ).toBeNull();
    expect(parsed.ok && "passed" in parsed.value.samples[0]).toBe(false);
  });

  it("full clean coverage passes", () => {
    const surfaces: AcceptanceSurface[] = ["home", "shop", "not_found"];
    const gates = evaluateBrowserGates(
      { userAgent: "x", samples: fullCoverage(surfaces) },
      surfaces,
    );
    expect(acceptanceOutcome(gates)).toBe("pass");
  });

  it("a missing surface or a wrong viewport width fails coverage", () => {
    const surfaces: AcceptanceSurface[] = ["home", "shop"];
    const samples = fullCoverage(surfaces).slice(1);
    samples[0] = { ...samples[0], width: 1000 };
    const coverage = evaluateBrowserGates(
      { userAgent: "", samples },
      surfaces,
    )[0];
    expect(coverage.status).toBe("fail");
    expect(coverage.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["missing", "viewport"]),
    );
  });

  it("overflow, serious axe violations and broken images fail; minor ones and slow LCP do not", () => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const samples = fullCoverage(surfaces);
    samples[2] = {
      ...samples[2],
      overflowPx: 24,
      overflowOffenders: ["div.hero"],
      brokenImages: 1,
      violations: [
        { id: "color-contrast", impact: "serious", nodes: 3, help: "Contrast" },
      ],
    };
    const gates = evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    expect(statusOf(gates, "browser.overflow")).toBe("fail");
    expect(statusOf(gates, "browser.accessibility")).toBe("fail");
    expect(statusOf(gates, "browser.media")).toBe("fail");

    const soft = fullCoverage(surfaces);
    // phone390 is a judged width, so the slow paint IS a finding: advisory.
    soft[1] = {
      ...soft[1],
      lcpMs: 9000,
      cls: 0.5,
      violations: [
        { id: "region", impact: "moderate", nodes: 1, help: "Region" },
      ],
    };
    const softGates = evaluateBrowserGates(
      { userAgent: "", samples: soft },
      surfaces,
    );
    expect(statusOf(softGates, "browser.accessibility")).toBe("pass");
    expect(
      softGates.find((g) => g.id === "browser.accessibility")!.findings,
    ).toHaveLength(1);
    expect(statusOf(softGates, "browser.performance")).toBe("advisory");
    expect(acceptanceOutcome(softGates)).toBe("pass");
  });

  it("clipped text, undersized touch targets and extreme crops fail", () => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const samples = fullCoverage(surfaces);
    samples[0] = {
      ...samples[0],
      clippedText: [{ target: "h1.hero", clippedX: 12, clippedY: 0 }],
      smallTapTargets: [{ target: "button.buy", width: 18, height: 20 }],
      imageCropIssues: [{ target: "img.hero", retainedFraction: 0.2 }],
    };
    const gates = evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    expect(statusOf(gates, "browser.clipped_text")).toBe("fail");
    expect(statusOf(gates, "browser.tap_targets")).toBe("fail");
    expect(statusOf(gates, "browser.image_crops")).toBe("fail");
  });
});

describe("stored reports", () => {
  it("reads back only recognised gates", () => {
    const report = readAcceptanceReport({
      gates: [gate("package.schema", []), { id: "nope", findings: [] }, "x"],
      surfaces: ["home", "attic"],
    });
    expect(report.gates.map((g) => g.id)).toEqual(["package.schema"]);
    expect(report.surfaces).toEqual(["home"]);
    expect(readAcceptanceReport(null).gates).toEqual([]);
  });
});

/** Every chrome state opened and found clean: what a sound home page reports. */
function measuredStates(): BrowserStateSample[] {
  return (["menu", "search", "cart", "account", "sign_in"] as const).map(
    (state) => chromeState(state),
  );
}

function chromeState(
  state: BrowserStateSample["state"],
  over: Partial<BrowserStateSample> = {},
): BrowserStateSample {
  return {
    state,
    measured: true,
    violations: [],
    clippedText: [],
    smallTapTargets: [],
    contrastUnresolved: [],
    ...over,
  };
}

describe("chrome states", () => {
  it("a home page without states fails coverage; absent and hidden states do not", () => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const samples = fullCoverage(surfaces);
    samples[0] = { ...samples[0], states: undefined };
    samples[1] = {
      ...samples[1],
      states: [
        chromeState("menu", { measured: false, reason: "hidden" }),
        chromeState("search", { measured: false, reason: "hidden" }),
        chromeState("cart", { measured: false, reason: "absent" }),
        chromeState("account"),
        chromeState("sign_in"),
      ],
    };
    const gates = evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    const coverage = gates[0];
    expect(coverage.status).toBe("fail");
    expect(coverage.findings).toEqual([
      expect.objectContaining({
        code: "states_missing",
        where: "phone360 · home",
      }),
    ]);
    // Three full viewports (5 each) plus the two measured on the second.
    expect(coverage.metrics?.states).toBe(17);
  });

  it("a state that did not open, or would not close, fails coverage and names itself", () => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const samples = fullCoverage(surfaces);
    samples[0] = {
      ...samples[0],
      states: [
        chromeState("menu", { measured: false, reason: "unopened" }),
        chromeState("search"),
        chromeState("cart", { reason: "stuck" }),
        chromeState("account"),
        chromeState("sign_in"),
      ],
    };
    const gates = evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    expect(gates[0].findings).toEqual([
      expect.objectContaining({
        code: "state_unopened",
        where: "phone360 · home · menu drawer",
      }),
      expect.objectContaining({
        code: "state_stuck",
        where: "phone360 · home · cart drawer",
      }),
    ]);
    expect(acceptanceOutcome(gates)).toBe("fail");
  });

  it("what a state contained reaches the same gates as the page, with the state named", () => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const samples = fullCoverage(surfaces);
    samples[0] = {
      ...samples[0],
      states: [
        chromeState("menu", {
          violations: [
            {
              id: "color-contrast",
              impact: "serious",
              nodes: 1,
              help: "Contrast",
              contrast: [{ target: "small", ratio: 1.37, required: 4.5 }],
            },
          ],
          clippedText: [{ target: "a.nav", clippedX: 9, clippedY: 0 }],
        }),
        chromeState("search"),
        chromeState("cart"),
        chromeState("account"),
        chromeState("sign_in"),
      ],
    };
    const gates = evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    expect(statusOf(gates, "browser.coverage")).toBe("pass");
    const a11y = gates.find((g) => g.id === "browser.accessibility")!;
    expect(a11y.status).toBe("fail");
    expect(a11y.findings[0]).toMatchObject({
      code: "color-contrast",
      where: "phone360 · home · menu drawer",
      contrast: [{ target: "small", ratio: 1.37, required: 4.5 }],
    });
    expect(a11y.metrics?.blockingViolations).toBe(1);
    const clipped = gates.find((g) => g.id === "browser.clipped_text")!;
    expect(clipped.findings[0]?.where).toBe("phone360 · home · menu drawer");
  });

  it("a surface other than home needs no states", () => {
    const surfaces: AcceptanceSurface[] = ["shop"];
    const samples = fullCoverage(surfaces).map((s) => ({
      ...s,
      states: undefined,
    }));
    const gates = evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    expect(statusOf(gates, "browser.coverage")).toBe("pass");
  });

  it("parsing keeps unresolved contrast and states, and refuses a malformed state", () => {
    const base = {
      ...sample({ viewport: "phone390", surface: "home" }),
      contrastUnresolved: [
        { target: ".home-hero-heading", reason: "bgImage" },
        { target: 7, reason: "bgImage" },
      ],
      states: [
        {
          ...chromeState("cart", { measured: false, reason: "unopened" }),
          violations: [],
        },
        chromeState("menu", {
          contrastUnresolved: [{ target: ".drawer a", reason: "bgOverlap" }],
        }),
      ],
    };
    const parsed = parseBrowserEvidence({
      userAgent: "ua",
      samples: [base],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.samples[0].contrastUnresolved).toEqual([
      { target: ".home-hero-heading", reason: "bgImage" },
    ]);
    expect(parsed.value.samples[0].states).toEqual([
      chromeState("cart", { measured: false, reason: "unopened" }),
      chromeState("menu", {
        contrastUnresolved: [{ target: ".drawer a", reason: "bgOverlap" }],
      }),
    ]);

    const bad = parseBrowserEvidence({
      userAgent: "ua",
      samples: [{ ...base, states: [{ state: "attic", measured: true }] }],
    });
    expect(bad).toEqual({
      ok: false,
      error: "Sample 0 has a malformed chrome state.",
    });

    const legacy = parseBrowserEvidence({
      userAgent: "ua",
      samples: [{ ...base, states: undefined, contrastUnresolved: undefined }],
    });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      expect(legacy.value.samples[0].states).toBeUndefined();
      expect(legacy.value.samples[0].contrastUnresolved).toBeUndefined();
    }
  });
});

describe("performance gate", () => {
  const surfaces: AcceptanceSurface[] = ["home"];
  const slow = (viewport: BrowserSample["viewport"], lcpMs: number) =>
    fullCoverage(surfaces).map((s) =>
      s.viewport === viewport ? { ...s, lcpMs } : s,
    );

  it("is advisory by default and required when the option says so", () => {
    const samples = slow("phone390", 3500);
    const advisory = evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    expect(statusOf(advisory, "browser.performance")).toBe("advisory");
    expect(acceptanceOutcome(advisory)).toBe("pass");
    const required = evaluateBrowserGates(
      { userAgent: "", samples },
      surfaces,
      { performanceRequired: true },
    );
    expect(statusOf(required, "browser.performance")).toBe("fail");
    expect(acceptanceOutcome(required)).toBe("fail");
    expect(required.find((g) => g.id === "browser.performance")).toMatchObject({
      label: "Performance",
      required: true,
      findings: [
        {
          code: "lcp",
          message: "LCP 3500ms; the limit is 3000ms.",
          where: "phone390 · home",
        },
      ],
      metrics: { worstLcpMs: 3500, judgedAt: "phone390, desktop1440" },
    });
  });

  it("judges phone390 and desktop1440 only; the other widths are reported, never failed", () => {
    const samples = slow("phone360", 9000).map((s) =>
      s.viewport === "tablet768" ? { ...s, cls: 0.4 } : s,
    );
    const gates = evaluateBrowserGates({ userAgent: "", samples }, surfaces, {
      performanceRequired: true,
    });
    const performance = gates.find((g) => g.id === "browser.performance")!;
    expect(performance.status).toBe("pass");
    expect(performance.metrics).toMatchObject({
      worstLcpMs: 9000,
      worstCls: 0.4,
    });
  });

  it("allows 3.0 s and refuses a CLS of 0.1", () => {
    const fine = evaluateBrowserGates(
      { userAgent: "", samples: slow("desktop1440", 3000) },
      surfaces,
      { performanceRequired: true },
    );
    expect(statusOf(fine, "browser.performance")).toBe("pass");
    const shifted = fullCoverage(surfaces).map((s) =>
      s.viewport === "desktop1440" ? { ...s, cls: 0.1 } : s,
    );
    const gates = evaluateBrowserGates(
      { userAgent: "", samples: shifted },
      surfaces,
      { performanceRequired: true },
    );
    expect(gates.find((g) => g.id === "browser.performance")!.findings).toEqual(
      [
        {
          code: "cls",
          message: "CLS 0.100; the limit is under 0.1.",
          where: "desktop1440 · home",
          // A deployment that requires the gate makes slowness serious.
          severity: "serious",
        },
      ],
    );
  });

  it("an unreported LCP is a finding only once the gate is required", () => {
    const framed = fullCoverage(surfaces).map((s) => ({ ...s, lcpMs: null }));
    const advisory = evaluateBrowserGates(
      { userAgent: "", samples: framed },
      surfaces,
    );
    expect(statusOf(advisory, "browser.performance")).toBe("pass");
    const required = evaluateBrowserGates(
      { userAgent: "", samples: framed },
      surfaces,
      { performanceRequired: true },
    );
    expect(
      required
        .find((g) => g.id === "browser.performance")!
        .findings.map((f) => [f.code, f.where]),
    ).toEqual([
      ["unmeasured", "phone390 · home"],
      ["unmeasured", "desktop1440 · home"],
    ]);
  });
});

describe("severity (severity-v1)", () => {
  beforeEach(() => vi.mocked(logWarn).mockClear());

  const integrity = (pkg: ThemePackageV2, rows: AcceptanceAssetRow[]) =>
    evaluatePackageGates(pkg, rows).gates.find(
      (g) => g.id === "assets.integrity",
    )!;
  const previewIndex = (pkg: ThemePackageV2) =>
    pkg.assets.findIndex((a) => a.path === pkg.definition.catalog.previewImage);
  const contentIndex = (pkg: ThemePackageV2) =>
    pkg.assets.findIndex(
      (a, i) =>
        i !== previewIndex(pkg) &&
        !pkg.definition.catalog.screenshots.some((s) => s.src === a.path),
    );
  const resize = (
    pkg: ThemePackageV2,
    rows: AcceptanceAssetRow[],
    index: number,
    width: number,
    height: number,
    over: Partial<AcceptanceAssetRow> = {},
  ) => {
    pkg.assets[index] = { ...pkg.assets[index], width, height };
    rows[index] = { ...rows[index], width, height, ...over };
  };

  it("stamps every finding and every gate as it is measured", () => {
    const g = gate("routes.markup", [
      { code: "lang", message: "The page has no language.", where: "/" },
      {
        code: "external_resource",
        message: "Loads https://t.example/a.js from another origin.",
        where: "/",
      },
    ]);
    expect(SEVERITY_RULES_VERSION).toBe("severity-v1");
    expect(g.severityRules).toBe(SEVERITY_RULES_VERSION);
    expect(g.findings.map((f) => [f.code, f.severity])).toEqual([
      ["external_resource", "serious"],
      ["lang", "minor"],
    ]);
    expect(gate("package.schema", []).severityRules).toBe("severity-v1");
    const { pkg, rows } = fixture();
    for (const result of evaluatePackageGates(pkg, rows).gates) {
      expect(result.severityRules, result.id).toBe("severity-v1");
    }
  });

  it("keeps serious findings first, so the 40-finding cap can never hide one", () => {
    const warnings = Array.from({ length: 45 }, (_, i) => ({
      code: "lang",
      message: "The page has no language.",
      where: `/page-${i}`,
    }));
    const g = gate("routes.markup", [
      ...warnings,
      { code: "external_resource", message: "Loads x.", where: "/last" },
    ]);
    expect(MAX_GATE_FINDINGS).toBe(40);
    expect(g.findings).toHaveLength(40);
    expect(g.findings[0]).toMatchObject({
      code: "external_resource",
      severity: "serious",
    });
    // Within one severity the measured order is kept.
    expect(g.findings[1].where).toBe("/page-0");
    expect(acceptanceOutcome([g])).toBe("fail");
  });

  it("never lowers the severity a rule sets, and makes all an advisory gate holds a warning", () => {
    const raised = gate("routes.render", [
      { code: "indexable", message: "x", severity: "serious" },
    ]);
    expect(raised.findings[0].severity).toBe("serious");
    const lowered = gate("package.security", [
      { code: "markup", message: "x", severity: "minor" },
    ]);
    expect(lowered.findings[0].severity).toBe("serious");
    expect(acceptanceOutcome([lowered])).toBe("blocked");
    const advisory = gate(
      "browser.performance",
      [{ code: "unmeasured", message: "x" }],
      { required: false },
    );
    expect(advisory.findings[0].severity).toBe("minor");
    expect(acceptanceOutcome([advisory])).toBe("pass");
  });

  it("passes a run whose findings are all warnings, while each gate still reports them as measured", () => {
    const gates = [
      gate("package.schema", []),
      gate("routes.render", [
        {
          code: "indexable",
          message: "A preview page did not carry noindex.",
          where: "/",
        },
      ]),
      gate("browser.tap_targets", [
        { code: "small_target", message: "9×9px", where: "phone390 · home" },
      ]),
    ];
    // What the exemplar check fails on is unchanged: a required gate that
    // reports anything is "fail".
    expect(
      gates.filter((g) => g.status === "fail" && g.required).map((g) => g.id),
    ).toEqual(["routes.render", "browser.tap_targets"]);
    expect(acceptanceOutcome(gates)).toBe("pass");
    expect(acceptanceWarnings(gates).map((w) => w.id)).toEqual([
      "routes.render",
      "browser.tap_targets",
    ]);
  });

  it("never passes a check that did not run, a failure that says nothing, or a status it does not know", () => {
    expect(gateBlocks(gate("routes.links", [], { status: "skipped" }))).toBe(
      true,
    );
    expect(
      gateBlocks(
        gate("routes.render", [{ code: "indexable", message: "x" }], {
          status: "skipped",
        }),
      ),
    ).toBe(true);
    expect(gateBlocks(gate("routes.links", [], { status: "fail" }))).toBe(true);
    expect(
      gateBlocks({
        required: true,
        status: "unknown" as GateResult["status"],
        findings: [{ code: "lang", message: "x", severity: "minor" }],
      }),
    ).toBe(true);
    expect(
      gateBlocks(
        gate("routes.render", [], { status: "skipped", required: false }),
      ),
    ).toBe(false);
    expect(
      acceptanceOutcome([gate("routes.links", [], { status: "skipped" })]),
    ).toBe("fail");
  });

  it("counts a finding stored before severity-v1 as serious, and trusts a passed gate as measured", () => {
    const legacy: GateResult = {
      id: "routes.render",
      label: "Storefront routes",
      required: true,
      status: "fail",
      findings: [
        { code: "indexable", message: "A preview page did not carry noindex." },
      ],
    };
    expect(acceptanceOutcome([legacy])).toBe("fail");
    const listedNotFailed: GateResult = {
      id: "browser.accessibility",
      label: "Accessibility (axe)",
      required: true,
      status: "pass",
      findings: [{ code: "region", message: "Region (1 element, moderate)" }],
    };
    expect(acceptanceOutcome([listedNotFailed])).toBe("pass");
  });

  it("splits the shared size code: a broken or too small picture blocks, a byte budget warns", () => {
    let { pkg, rows } = fixture();
    const c = contentIndex(pkg);
    rows[c] = { ...rows[c], byteSize: 600 * 1024 };
    expect(integrity(pkg, rows).findings).toEqual([
      expect.objectContaining({ code: "over_budget", severity: "minor" }),
    ]);
    expect(acceptanceOutcome(evaluatePackageGates(pkg, rows).gates)).toBe(
      "pass",
    );

    ({ pkg, rows } = fixture());
    rows[c] = { ...rows[c], mediaType: "image/png" };
    expect(
      integrity(pkg, rows).findings.map((f) => [f.code, f.severity]),
    ).toEqual([
      ["format", "serious"],
      ["wrong_format", "serious"],
    ]);

    ({ pkg, rows } = fixture());
    const p = previewIndex(pkg);
    rows[p] = { ...rows[p], byteSize: 300 * 1024 };
    expect(integrity(pkg, rows).findings).toEqual([
      expect.objectContaining({
        code: "preview_over_budget",
        severity: "minor",
      }),
    ]);

    ({ pkg, rows } = fixture());
    resize(pkg, rows, p, 1600, 1000);
    expect(integrity(pkg, rows).findings).toEqual([
      expect.objectContaining({ code: "preview_shape", severity: "serious" }),
    ]);

    ({ pkg, rows } = fixture());
    resize(pkg, rows, p, 780, 585);
    expect(
      integrity(pkg, rows).findings.map((f) => [f.code, f.severity]),
    ).toEqual([
      ["too_small", "serious"],
      ["preview_too_small", "serious"],
    ]);
    expect(imageRuleCode(": a rule nobody wrote down")).toBe("size");
  });

  it("warns when a stored picture is narrower than its slot, above the storefront minimum", () => {
    let { pkg, rows } = fixture();
    const c = contentIndex(pkg);
    resize(pkg, rows, c, 1024, 768);
    expect(integrity(pkg, rows).findings).toEqual([
      expect.objectContaining({
        code: "below_target",
        severity: "minor",
        where: pkg.assets[c].id,
        message:
          "The stored picture is 1024px wide, narrower than the 1600px its slot is made for, so it can look soft on large screens.",
      }),
    ]);
    expect(acceptanceOutcome(evaluatePackageGates(pkg, rows).gates)).toBe(
      "pass",
    );
    // Listed without failing the gate, so the exemplar check, whose bundled
    // pictures are 800 to 1000px wide, passes what it passed before.
    expect(integrity(pkg, rows).status).toBe("pass");
    expect(
      acceptanceWarnings(evaluatePackageGates(pkg, rows).gates).map(
        (w) => w.id,
      ),
    ).toEqual(["assets.integrity"]);
    // Beside anything else the gate reports, the gate fails as before.
    rows[c] = { ...rows[c], byteSize: 600 * 1024 };
    expect(integrity(pkg, rows).status).toBe("fail");
    expect(
      integrity(pkg, rows).findings.map((f) => [f.code, f.severity]),
    ).toEqual([
      ["over_budget", "minor"],
      ["below_target", "minor"],
    ]);
    // A wide slot is made for 2400px.
    ({ pkg, rows } = fixture());
    resize(pkg, rows, c, 1600, 900);
    expect(integrity(pkg, rows).findings.map((f) => f.code)).toEqual([
      "below_target",
    ]);
    // A pixel of rounding is not a smaller picture.
    ({ pkg, rows } = fixture());
    resize(pkg, rows, c, 1599, 1199);
    expect(integrity(pkg, rows).findings).toEqual([]);
    // ★ Nor is a picture within 15% of its slot (22 Nov 2026): every wide
    //   picture drawn at "2K" is 2,239px (21:9) or 2,048px (16:9) for a
    //   2,400px slot, so the warning fired on every theme and the design
    //   review listed it as a finding each time.
    expect(BELOW_TARGET_FRACTION).toBe(0.85);
    for (const [width, height] of [
      [2239, 960],
      [2048, 1152],
    ]) {
      ({ pkg, rows } = fixture());
      resize(pkg, rows, c, width, height);
      expect(
        integrity(pkg, rows).findings.map((f) => f.code),
        `${width}x${height}`,
      ).not.toContain("below_target");
    }
    ({ pkg, rows } = fixture());
    resize(pkg, rows, c, 2000, 1125);
    expect(integrity(pkg, rows).findings.map((f) => f.code)).toContain(
      "below_target",
    );
    // Below the minimum it is too small, which is serious, and only that.
    ({ pkg, rows } = fixture());
    resize(pkg, rows, c, 760, 570);
    expect(integrity(pkg, rows).findings.map((f) => f.code)).toEqual([
      "too_small",
    ]);
    // A placeholder is never held to its slot.
    ({ pkg, rows } = fixture());
    resize(pkg, rows, c, 1024, 768);
    pkg.assets[c].licenseNote = PLACEHOLDER_LICENSE_NOTE;
    expect(integrity(pkg, rows).findings.map((f) => f.code)).not.toContain(
      "below_target",
    );
  });

  it('★ a slide\'s phone photograph is a picture the theme renders, never "unused" (22 Nov 2026)', () => {
    // The check followed only the key `image_url`, so every opening slide's
    // `mobile_image_url` was reported "declared but nothing renders it"; the
    // design review read that as a platform fault and failed finished
    // designs. Move one section picture to each picture field in turn.
    for (const key of ["mobile_image_url", "poster_url", "logo_url"]) {
      const { pkg, rows } = fixture();
      const text = JSON.stringify(pkg.definition);
      // A picture one section names, once, and nothing else does.
      const once = new Set(
        pkg.assets
          .map((asset) => asset.path)
          .filter((path) => text.split(JSON.stringify(path)).length === 2),
      );
      let moved: string | null = null;
      const visit = (value: unknown): void => {
        if (moved || !value || typeof value !== "object") return;
        if (Array.isArray(value)) return value.forEach(visit);
        const record = value as Record<string, unknown>;
        const url = record.image_url;
        if (typeof url === "string" && once.has(url)) {
          moved = url;
          delete record.image_url;
          record[key] = url;
          return;
        }
        Object.values(record).forEach(visit);
      };
      for (const page of pkg.definition.preset.pages)
        for (const section of page.sections) visit(section.config);
      expect(moved, "the fixture has such a section picture").not.toBeNull();
      const id = pkg.assets.find((asset) => asset.path === moved)!.id;
      expect(
        integrity(pkg, rows)
          .findings.filter((f) => f.code === "unused")
          .map((f) => f.where),
        key,
      ).not.toContain(id);
    }
    // A picture nothing names at all is still reported.
    const { pkg, rows } = fixture();
    const text = JSON.stringify(pkg.definition);
    const orphan = pkg.assets.find(
      (asset) => asset.kind !== "reference" && !text.includes(asset.path),
    );
    if (orphan)
      expect(
        integrity(pkg, rows).findings.some(
          (f) => f.code === "unused" && f.where === orphan.id,
        ),
      ).toBe(true);
  });

  it("keeps every package-level problem serious", () => {
    const { pkg, rows } = fixture();
    pkg.definition.preset.sampleData!.products =
      pkg.definition.preset.sampleData!.products.slice(0, 3);
    pkg.definition.description = "Lovely <script>steal()</script>";
    pkg.assets[0].alt = "";
    const gates = evaluatePackageGates(pkg, rows).gates;
    for (const id of [
      "package.content",
      "package.security",
      "assets.provenance",
    ]) {
      const g = gates.find((x) => x.id === id)!;
      expect(g.findings.length, id).toBeGreaterThan(0);
      expect(
        g.findings.every((f) => f.severity === "serious"),
        id,
      ).toBe(true);
    }
  });

  it("warns on a clip of a pixel or two and blocks a clip that hides part of a word", () => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const clipped = (px: number) => {
      const samples = fullCoverage(surfaces);
      samples[0] = {
        ...samples[0],
        clippedText: [{ target: "h2.home-title", clippedX: 0, clippedY: px }],
      };
      return evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    };
    const small = clipped(2);
    expect(
      small.find((g) => g.id === "browser.clipped_text")!.findings[0],
    ).toMatchObject({
      severity: "minor",
      clipped: { x: 0, y: 2 },
      targets: ["h2.home-title"],
    });
    expect(statusOf(small, "browser.clipped_text")).toBe("fail");
    expect(acceptanceOutcome(small)).toBe("pass");
    const large = clipped(12);
    expect(
      large.find((g) => g.id === "browser.clipped_text")!.findings[0].severity,
    ).toBe("serious");
    expect(acceptanceOutcome(large)).toBe("fail");
  });

  // A list cut at its limit must not hide a serious clip behind forty that
  // are a pixel or two (review of TS-1, 25 Oct 2026).
  const twoPixelClips = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({
      target: `${prefix}:nth-child(${i + 1}) .shop-card-name`,
      clippedX: 2,
      clippedY: 0,
    }));
  const headingClip = { target: "h2.home-title", clippedX: 0, clippedY: 14 };
  const clippedGate = (gates: GateResult[]) =>
    gates.find((g) => g.id === "browser.clipped_text")!;
  /** Full coverage of one surface, the first sample replaced by `over`
   * after it went through the parser, as the capture job sends it. */
  const parsedRun = (over: Record<string, unknown>) => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const samples = fullCoverage(surfaces);
    const parsed = parseBrowserEvidence({
      samples: [{ ...samples[0], ...over }, ...samples.slice(1)],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return evaluateBrowserGates(parsed.value, surfaces);
  };

  it("keeps the largest clips when a page's list is cut, so forty small ones cannot hide a large one", () => {
    const gates = parsedRun({
      clippedText: [...twoPixelClips(40, "li"), headingClip],
      clippedTextFound: 41,
    });
    const gateResult = clippedGate(gates);
    expect(gateResult.findings).toHaveLength(MAX_GATE_FINDINGS);
    expect(gateResult.findings[0]).toMatchObject({
      severity: "serious",
      clipped: { x: 0, y: 14 },
      targets: ["h2.home-title"],
    });
    expect(gateBlocks(gateResult)).toBe(true);
    expect(acceptanceOutcome(gates)).toBe("fail");
  });

  it("treats a page list an older probe cut at forty, every clip in it small, as not measured", () => {
    // The probe that listed clips in page order stopped at 40 and never said
    // how many it found: the heading clipped by 14px was never sent.
    const old = parsedRun({ clippedText: twoPixelClips(40, "li") });
    const gateResult = clippedGate(old);
    expect(gateResult.findings[0]).toMatchObject({
      code: "unmeasured",
      severity: "serious",
      where: "phone360 · home",
    });
    expect(gateBlocks(gateResult)).toBe(true);
    expect(acceptanceOutcome(old)).toBe("fail");
    // Today's probe lists the largest first and says how many it found:
    // forty small clips listed of forty-one found means every clip is small.
    const today = parsedRun({
      clippedText: twoPixelClips(40, "li"),
      clippedTextFound: 41,
    });
    expect(
      clippedGate(today).findings.every((f) => f.code === "clipped_text"),
    ).toBe(true);
    expect(acceptanceOutcome(today)).toBe("pass");
    // An older probe whose list never reached its limit listed every clip.
    expect(
      acceptanceOutcome(parsedRun({ clippedText: twoPixelClips(39, "li") })),
    ).toBe("pass");
  });

  it("holds an opened chrome state to the same rule at its own limit of twenty", () => {
    const withMenu = (menu: Record<string, unknown>) =>
      parsedRun({
        states: measuredStates().map((state) =>
          state.state === "menu" ? { ...state, ...menu } : state,
        ),
      });
    const cut = withMenu({
      clippedText: [...twoPixelClips(20, "a"), headingClip],
      clippedTextFound: 21,
    });
    expect(clippedGate(cut).findings[0]).toMatchObject({
      severity: "serious",
      clipped: { x: 0, y: 14 },
      where: "phone360 · home · menu drawer",
    });
    expect(acceptanceOutcome(cut)).toBe("fail");
    const old = withMenu({ clippedText: twoPixelClips(20, "a") });
    expect(clippedGate(old).findings[0]).toMatchObject({
      code: "unmeasured",
      severity: "serious",
      where: "phone360 · home · menu drawer",
    });
    expect(acceptanceOutcome(old)).toBe("fail");
    expect(
      acceptanceOutcome(
        withMenu({ clippedText: twoPixelClips(20, "a"), clippedTextFound: 26 }),
      ),
    ).toBe("pass");
  });

  it("makes small tap targets and tight crops warnings, and overflow and broken images serious", () => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const samples = fullCoverage(surfaces);
    samples[0] = {
      ...samples[0],
      smallTapTargets: [{ target: "button.buy", width: 18, height: 20 }],
      imageCropIssues: [{ target: "img.hero", retainedFraction: 0.2 }],
    };
    const soft = evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    for (const id of ["browser.tap_targets", "browser.image_crops"]) {
      expect(statusOf(soft, id), id).toBe("fail");
      expect(soft.find((g) => g.id === id)!.findings[0].severity, id).toBe(
        "minor",
      );
    }
    expect(acceptanceOutcome(soft)).toBe("pass");
    samples[1] = {
      ...samples[1],
      overflowPx: 24,
      overflowOffenders: ["div.hero"],
    };
    samples[2] = { ...samples[2], brokenImages: 1 };
    const hard = evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    expect(
      hard.find((g) => g.id === "browser.overflow")!.findings[0],
    ).toMatchObject({ severity: "serious", targets: ["div.hero"] });
    expect(
      hard.find((g) => g.id === "browser.media")!.findings[0].severity,
    ).toBe("serious");
    expect(acceptanceOutcome(hard)).toBe("fail");
  });

  it("fails the accessibility gate on contrast whatever its impact, on serious rules and on an impact axe did not give", () => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const withViolations = (violations: BrowserSample["violations"]) => {
      const samples = fullCoverage(surfaces);
      samples[0] = { ...samples[0], violations };
      return evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    };
    const a11y = (gates: GateResult[]) =>
      gates.find((g) => g.id === "browser.accessibility")!;

    const moderate = withViolations([
      { id: "region", impact: "moderate", nodes: 1, help: "Region" },
    ]);
    expect(a11y(moderate).status).toBe("pass");
    expect(a11y(moderate).findings[0]).toMatchObject({
      severity: "minor",
      impact: "moderate",
    });
    expect(acceptanceOutcome(moderate)).toBe("pass");

    const unrated = withViolations([
      { id: "region", impact: null, nodes: 1, help: "Region" },
    ]);
    expect(a11y(unrated).status).toBe("fail");
    expect(a11y(unrated).findings[0].severity).toBe("serious");

    const contrast = withViolations([
      {
        id: "color-contrast",
        impact: "moderate",
        nodes: 1,
        help: "Contrast",
        contrast: [{ target: ".shop-card-off", ratio: 4.39, required: 4.5 }],
      },
    ]);
    expect(a11y(contrast).status).toBe("fail");
    expect(a11y(contrast).findings[0]).toMatchObject({
      severity: "serious",
      nodes: 1,
    });
    expect(a11y(contrast).metrics).toMatchObject({
      blockingViolations: 1,
      otherViolations: 0,
    });
    expect(acceptanceOutcome(contrast)).toBe("fail");
  });

  it("puts the serious accessibility findings first, ahead of forty warnings", () => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const samples: BrowserSample[] = fullCoverage(surfaces).map((s) => ({
      ...s,
      violations: Array.from({ length: 9 }, (_, i) => ({
        id: `rule-${i}`,
        impact: "minor" as const,
        nodes: 1,
        help: "Minor",
      })),
    }));
    samples[4] = {
      ...samples[4],
      violations: [
        ...samples[4].violations,
        {
          id: "color-contrast",
          impact: "serious",
          nodes: 1,
          help: "Contrast",
          contrast: [{ target: "h1", ratio: 2.1, required: 4.5 }],
        },
      ],
    };
    const g = evaluateBrowserGates({ userAgent: "", samples }, surfaces).find(
      (x) => x.id === "browser.accessibility",
    )!;
    expect(g.findings).toHaveLength(40);
    expect(g.findings[0]).toMatchObject({
      code: "color-contrast",
      severity: "serious",
    });
    expect(g.status).toBe("fail");
    expect(g.metrics).toMatchObject({
      blockingViolations: 1,
      otherViolations: 45,
    });
  });

  it("writes axe findings without a dash a person would read", () => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const samples = fullCoverage(surfaces);
    samples[0] = {
      ...samples[0],
      violations: [
        {
          id: "color-contrast",
          impact: "serious",
          nodes: 2,
          help: "Contrast",
          examples: [{ target: ".a", summary: "2.1:1" }],
        },
        {
          id: "button-name",
          impact: "critical",
          nodes: 1,
          help: "Buttons need names",
          target: "button.x",
        },
      ],
    };
    const findings = evaluateBrowserGates(
      { userAgent: "", samples },
      surfaces,
    ).find((g) => g.id === "browser.accessibility")!.findings;
    expect(findings.map((f) => f.message)).toEqual([
      "Contrast (2 elements, serious); examples: .a: 2.1:1",
      "Buttons need names (1 element, critical); first: button.x",
    ]);
    expect(findings.map((f) => f.targets)).toEqual([[".a"], ["button.x"]]);
    for (const f of findings) {
      expect(f.message).not.toContain(String.fromCharCode(0x2014));
      expect(f.message).not.toContain(String.fromCharCode(0x2013));
    }
  });

  it("keeps speed a warning while the gate is advisory and makes it serious once required", () => {
    const surfaces: AcceptanceSurface[] = ["home"];
    const samples = fullCoverage(surfaces).map((s) =>
      s.viewport === "phone390" ? { ...s, lcpMs: 9000 } : s,
    );
    const advisory = evaluateBrowserGates({ userAgent: "", samples }, surfaces);
    expect(
      advisory.find((g) => g.id === "browser.performance")!.findings[0]
        .severity,
    ).toBe("minor");
    expect(acceptanceOutcome(advisory)).toBe("pass");
    const required = evaluateBrowserGates(
      { userAgent: "", samples },
      surfaces,
      { performanceRequired: true },
    );
    expect(
      required.find((g) => g.id === "browser.performance")!.findings[0]
        .severity,
    ).toBe("serious");
    expect(acceptanceOutcome(required)).toBe("fail");
  });

  it("makes a missing noindex, language or image alt a warning, and an off-site resource serious", () => {
    const render = gate(
      "routes.render",
      routeRenderFindings([
        {
          surface: "cart",
          path: "/cart",
          status: 200,
          themed: true,
          noindex: false,
          error: null,
        },
      ]),
    );
    expect(render.findings[0]).toMatchObject({
      code: "indexable",
      severity: "minor",
    });
    const markup = gate(
      "routes.markup",
      markupFindings(
        [
          {
            path: "/",
            html: '<html><img src="https://cdn.evil.example/p.jpg"></html>',
          },
        ],
        "https://studio-preview-abc.storemink.com",
      ),
    );
    expect(markup.findings.map((f) => [f.code, f.severity])).toEqual([
      ["external_resource", "serious"],
      ["img_alt", "minor"],
      ["lang", "minor"],
    ]);
    expect(acceptanceOutcome([render])).toBe("pass");
    expect(acceptanceOutcome([markup])).toBe("fail");
  });

  it("logs each StoreMink platform finding without content, and nothing for the theme's", () => {
    gate("routes.render", [
      { code: "indexable", message: "secret store words", where: "/a" },
      { code: "indexable", message: "secret store words", where: "/b" },
      { code: "status", message: "Returned 500.", where: "/c" },
    ]);
    expect(vi.mocked(logWarn).mock.calls).toEqual([
      [
        "theme_studio.platform_finding",
        {
          gate: "routes.render",
          code: "indexable",
          findingSeverity: "minor",
          count: 2,
        },
      ],
    ]);
    vi.mocked(logWarn).mockClear();
    gate("browser.accessibility", [
      {
        code: "color-contrast",
        message: "Contrast",
        where: "phone390 · home · menu drawer",
        contrast: [{ target: "a.my-product", ratio: 1.37, required: 4.5 }],
      },
      {
        code: "color-contrast",
        message: "Contrast",
        where: "phone390 · home",
        contrast: [{ target: "h1", ratio: 2, required: 4.5 }],
      },
    ]);
    expect(vi.mocked(logWarn).mock.calls).toEqual([
      [
        "theme_studio.platform_finding",
        {
          gate: "browser.accessibility",
          code: "color-contrast",
          findingSeverity: "serious",
          count: 1,
        },
      ],
    ]);
    vi.mocked(logWarn).mockClear();
    gate("browser.overflow", [
      { code: "horizontal_overflow", message: "x", targets: ["div.hero"] },
    ]);
    expect(logWarn).not.toHaveBeenCalled();
    // Never a top-level `severity`: Cloud Logging reads it as the log level.
    gate("routes.markup", [{ code: "lang", message: "x" }]);
    expect(vi.mocked(logWarn).mock.calls[0][1]).not.toHaveProperty("severity");
  });

  it("reads back the rules version and each finding's severity", () => {
    const stored = JSON.parse(
      JSON.stringify({
        version: 2,
        severityRules: SEVERITY_RULES_VERSION,
        gates: [gate("routes.render", [{ code: "indexable", message: "x" }])],
      }),
    );
    const report = readAcceptanceReport(stored);
    expect(report.severityRules).toBe("severity-v1");
    expect(report.gates[0].severityRules).toBe("severity-v1");
    expect(report.gates[0].findings[0].severity).toBe("minor");
    expect(
      readAcceptanceReport({ ...stored, severityRules: 3 }).severityRules,
    ).toBeUndefined();
  });

  it("lists as warnings only what does not stop the run", () => {
    const gates = [
      gate("routes.markup", [
        { code: "external_resource", message: "Loads x." },
        { code: "lang", message: "No language." },
      ]),
      gate("browser.performance", [{ code: "lcp", message: "Slow" }], {
        required: false,
      }),
      gate(
        "browser.accessibility",
        [{ code: "region", message: "Region", impact: "moderate" }],
        { status: "pass" },
      ),
      gate("package.schema", []),
    ];
    expect(
      acceptanceWarnings(gates).map((w) => [
        w.id,
        w.findings.map((f: GateFinding) => f.code),
      ]),
    ).toEqual([
      ["browser.performance", ["lcp"]],
      ["browser.accessibility", ["region"]],
    ]);
  });
});
