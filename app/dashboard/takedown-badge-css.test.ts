import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// GUARD: StoreMink's takedown marks ("Blocked by StoreMink", "Removed by
// StoreMink", the notices list's "Blocked") wear their own scoped class,
// `.dash-badge-storemink`, whose words read at 4.5:1 or more on the red tint.
//
// The shared `dash-badge-red` pair (--dash-red on --dash-red-soft) measures
// about 4:1 for its 11.5px text, under the 4.5:1 small text needs (takedown
// fix pass, must-do 25). It is left exactly as it is for every other badge;
// only the takedown marks move to the new class.
//
// The ratio is measured from the tokens in dashboard.css, the way the Theme
// Studio stylesheet guard measures its badges (studio-css.test.ts).
// ---------------------------------------------------------------------------

const DASHBOARD_CSS = readFileSync(
  join("app", "dashboard", "dashboard.css"),
  "utf8",
);

const AA_SMALL_TEXT = 4.5;

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The declarations of the rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of withoutComments(DASHBOARD_CSS).matchAll(pattern)) {
    if (match[1].trim() === selector) return match[2];
  }
  throw new Error(`dashboard.css has no rule ${selector}`);
}

function declaration(body: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`).exec(body);
  if (!match) throw new Error(`no ${property} in ${body}`);
  return match[1].trim();
}

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(DASHBOARD_CSS);
  if (!match) throw new Error(`dashboard.css has no --${name}`);
  return match[1].trim();
}

/** A colour value: a hex, an rgba(), or var(--dash-…) read from the tokens. */
function resolve(value: string): string {
  const variable = /^var\(--([\w-]+)\)$/.exec(value);
  return variable ? token(variable[1]) : value;
}

type RGB = [number, number, number];

function parse(colour: string): { rgb: RGB; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(colour);
  if (!rgba) throw new Error(`cannot read colour ${colour}`);
  const [r, g, b, a = "1"] = rgba[1].split(",").map((part) => part.trim());
  return { rgb: [Number(r), Number(g), Number(b)], alpha: Number(a) };
}

function over(top: string, under: RGB): RGB {
  const { rgb, alpha } = parse(top);
  return rgb.map((c, i) => c * alpha + under[i] * (1 - alpha)) as RGB;
}

function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every surface a takedown mark is drawn on: the dashboard's three surfaces
 * and its page background (cards, table rows and their hover, the builder's
 * white top bar), plus the red-tinted rows some marks sit inside (the media
 * view's blocked status row, the product and blog banners).
 */
function backgroundsUnderTheMark(): { name: string; rgb: RGB }[] {
  const tint = token("dash-red-soft");
  const plain = [
    "dash-surface",
    "dash-surface-2",
    "dash-surface-3",
    "dash-bg",
  ].map((name) => ({ name, rgb: parse(token(name)).rgb }));
  const tintedRow = {
    name: "red-tinted row over dash-surface",
    rgb: over(tint, parse(token("dash-surface")).rgb),
  };
  return [...plain, tintedRow];
}

function ratiosFor(selector: string): { surface: string; ratio: number }[] {
  const body = ruleBody(selector);
  const text = parse(resolve(declaration(body, "color"))).rgb;
  const fill = resolve(declaration(body, "background"));
  return backgroundsUnderTheMark().map(({ name, rgb }) => ({
    surface: name,
    ratio: contrast(text, over(fill, rgb)),
  }));
}

describe("★ the takedown badge's colours", () => {
  it("keeps the red tint and reads at 4.5:1 or more on every dashboard surface", () => {
    const body = ruleBody(".dashboard-shell .dash-badge-storemink");
    expect(declaration(body, "background")).toBe("var(--dash-red-soft)");
    // A literal colour: no token both reads well here and leaves every other
    // red badge as it is.
    expect(declaration(body, "color")).toMatch(/^#[0-9a-f]{6}$/i);

    const ratios = ratiosFor(".dashboard-shell .dash-badge-storemink");
    for (const { surface, ratio } of ratios) {
      expect(
        ratio,
        `${surface}: ${ratio.toFixed(2)} to 1`,
      ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
  });

  it("leaves the shared dash-badge-red pair exactly as it was", () => {
    const body = ruleBody(".dashboard-shell .dash-badge-red");
    expect(declaration(body, "background")).toBe("var(--dash-red-soft)");
    expect(declaration(body, "color")).toBe("var(--dash-red)");
    expect(token("dash-red")).toBe("#dc2626");
    expect(token("dash-red-soft")).toBe("rgba(220, 38, 38, 0.12)");
  });

  it("reads better than the shared pair it replaces, on every surface", () => {
    const shared = ratiosFor(".dashboard-shell .dash-badge-red");
    const storemink = ratiosFor(".dashboard-shell .dash-badge-storemink");
    // The reason for the class: the shared pair is under the line.
    expect(Math.min(...shared.map((r) => r.ratio))).toBeLessThan(AA_SMALL_TEXT);
    storemink.forEach(({ ratio }, i) =>
      expect(ratio).toBeGreaterThan(shared[i].ratio),
    );
  });
});

// ── Which marks wear it ─────────────────────────────────────────────────────

function dashboardSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) dashboardSources(full, out);
    else if (full.endsWith(".tsx") && !full.includes(".test.")) out.push(full);
  }
  return out;
}

/** A span that holds nothing but one of the takedown marks' words. */
const MARK =
  /<span\b([^>]*)>\s*\{(ITEM\.(?:blocked|removed)|NOTICES\.states\.blocked)\}\s*<\/span>/g;

type Mark = { file: string; attrs: string; words: string };

function takedownBadges(): Mark[] {
  const found: Mark[] = [];
  for (const file of dashboardSources(join("app", "dashboard"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(MARK)) {
      const attrs = match[1];
      // Drawn as a badge or the builder's status pill; plain text (the bulk
      // bar's second line, the pages rail's grey line) is not a badge.
      if (/dash-badge|sm-builder-status/.test(attrs)) {
        found.push({ file, attrs, words: match[2] });
      }
    }
  }
  return found;
}

/** The takedown marks from T18a, T18b, T19a and T19b, by file. */
const EXPECTED_MARKS: Record<string, number> = {
  [join("app", "dashboard", "settings", "notices", "page.tsx")]: 1,
  [join("app", "dashboard", "blogs", "blogs-management-view.tsx")]: 1,
  [join("app", "dashboard", "blogs", "blog-editor-dialog.tsx")]: 1,
  [join("app", "dashboard", "products", "products-management-view.tsx")]: 1,
  [join("app", "dashboard", "products", "product-edit-panel.tsx")]: 1,
  [join("app", "dashboard", "users", "customer-detail.tsx")]: 1,
  [join("app", "dashboard", "categories", "categories-management-view.tsx")]: 1,
  [join("app", "dashboard", "media", "media-library-view.tsx")]: 2,
  [join("app", "dashboard", "builder", "builder-client.tsx")]: 1,
};

describe("★ every takedown mark uses dash-badge-storemink", () => {
  it("finds every mark it expects (so the scan cannot pass by matching nothing)", () => {
    const counts: Record<string, number> = {};
    for (const mark of takedownBadges()) {
      counts[mark.file] = (counts[mark.file] ?? 0) + 1;
    }
    for (const [file, count] of Object.entries(EXPECTED_MARKS)) {
      expect(counts[file] ?? 0, file).toBeGreaterThanOrEqual(count);
    }
  });

  it("draws each one with the new class, never dash-badge-red", () => {
    for (const mark of takedownBadges()) {
      expect(mark.attrs, `${mark.file} (${mark.words})`).toContain(
        "dash-badge-storemink",
      );
      expect(mark.attrs, `${mark.file} (${mark.words})`).not.toContain(
        "dash-badge-red",
      );
    }
  });

  it("is used by the takedown marks and nothing else", () => {
    // Class attributes only: a comment naming the class is not a use.
    const USE = /className="[^"]*\bdash-badge-storemink\b[^"]*"/g;
    let uses = 0;
    for (const file of dashboardSources(join("app", "dashboard"))) {
      uses += [...readFileSync(file, "utf8").matchAll(USE)].length;
    }
    expect(uses).toBe(takedownBadges().length);
    // In the operator console only the block marks below may wear it.
    const platformUses = platformSources().reduce(
      (n, file) => n + quotedClassUses(file),
      0,
    );
    expect(platformUses).toBe(
      consoleMarks().filter((mark) => mark.tone === STOREMINK_CLASS).length,
    );
  });
});

// ── The operator console's block marks (FX-C) ──────────────────────────────
//
// The console's takedown screens (the complaints list and the complaint page,
// which share BlocksTable, the block page and the block form) mark a live
// StoreMink block with the same scoped class. The store page's "Complaints and
// holds" card draws no badge (its lines are links), so it has none to check.

const STOREMINK_CLASS = "dash-badge-storemink";
const CONSOLE = join("app", "platform", "dashboard", "(console)");

/** Every non-test .ts/.tsx source under app/platform. */
function platformSources(dir = join("app", "platform"), out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) platformSources(full, out);
    else if (/\.tsx?$/.test(full) && !full.includes(".test.")) out.push(full);
  }
  return out;
}

/** The source without its block comments and whole-line comments. */
function withoutCodeComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** How often a quoted string in the file names the class (comments aside). */
function quotedClassUses(file: string): number {
  const QUOTED = /"[^"\n]*\bdash-badge-storemink\b[^"\n]*"/g;
  return [...withoutCodeComments(readFileSync(file, "utf8")).matchAll(QUOTED)]
    .length;
}

type ConsoleMark = { file: string; where: string; tone: string };

/**
 * The console's block marks, in the three shapes the console draws them: the
 * block-state tone map behind BlocksTable, the block page's heading chip
 * ({ text, tone }), and a span whose only words are "Blocked" or "Suspended".
 */
function consoleMarks(): ConsoleMark[] {
  const found: ConsoleMark[] = [];
  for (const file of platformSources(CONSOLE)) {
    const source = withoutCodeComments(readFileSync(file, "utf8"));
    const map = /const BLOCK_STATE_TONE[^=]*=\s*\{([^}]*)\}/.exec(source);
    if (map) {
      for (const entry of map[1].matchAll(/(\w+):\s*"([^"]+)"/g)) {
        found.push({ file, where: `state ${entry[1]}`, tone: entry[2] });
      }
    }
    const CHIP =
      /\{\s*text:\s*"(Blocked|Suspended)",\s*tone:\s*"(dash-badge-[\w-]+)"\s*\}/g;
    for (const chip of source.matchAll(CHIP)) {
      found.push({ file, where: `chip ${chip[1]}`, tone: chip[2] });
    }
    const SPAN = /<span\b([^>]*)>\s*(Blocked|Suspended)\s*<\/span>/g;
    for (const span of source.matchAll(SPAN)) {
      const classes = /className="([^"]*)"/.exec(span[1])?.[1].split(/\s+/);
      if (!classes?.includes("dash-badge")) continue;
      const tone = classes.find((name) => name.startsWith("dash-badge-"));
      found.push({ file, where: `span ${span[2]}`, tone: tone ?? "" });
    }
  }
  return found;
}

/** The console's block marks, by file and shape. */
const EXPECTED_CONSOLE_MARKS: Record<string, string[]> = {
  [join(CONSOLE, "complaints", "complaints-console.tsx")]: [
    "state blocked",
    "state blocked_untold",
    "state store_suspended",
  ],
  [join(CONSOLE, "complaints", "blocks", "[blockId]", "page.tsx")]: [
    "chip Suspended",
    "chip Blocked",
  ],
  [join(CONSOLE, "complaints", "block", "block-form.tsx")]: [
    "span Blocked",
    "span Blocked",
    "span Blocked",
  ],
};

describe("★ the operator console's block marks use dash-badge-storemink", () => {
  it("puts every console page inside .dashboard-shell, where the class applies", () => {
    const layout = readFileSync(join(CONSOLE, "layout.tsx"), "utf8");
    // dashboard.css is loaded for the console, and its pages render in the
    // scope its rule `.dashboard-shell .dash-badge-storemink` needs.
    expect(layout).toContain('import "@/app/dashboard/dashboard.css";');
    expect(layout).toMatch(/className=\{`dashboard-shell\b/);
    expect(layout).toContain("{children}");
    expect(ruleBody(".dashboard-shell .dash-badge-storemink")).toBeTruthy();
  });

  it("finds every console mark it expects (so the scan cannot pass by matching nothing)", () => {
    const live = consoleMarks().filter((mark) => mark.where !== "state lifted");
    for (const [file, wheres] of Object.entries(EXPECTED_CONSOLE_MARKS)) {
      expect(
        live
          .filter((mark) => mark.file === file)
          .map((mark) => mark.where)
          .sort(),
        file,
      ).toEqual([...wheres].sort());
    }
    expect(live).toHaveLength(
      Object.values(EXPECTED_CONSOLE_MARKS).flat().length,
    );
  });

  it("draws each live block mark with the new class, never dash-badge-red", () => {
    for (const mark of consoleMarks()) {
      if (mark.where === "state lifted") continue;
      expect(mark.tone, `${mark.file} (${mark.where})`).toBe(STOREMINK_CLASS);
    }
  });

  it("keeps a lifted block grey: only a live block is a StoreMink mark", () => {
    const lifted = consoleMarks().find((mark) => mark.where === "state lifted");
    expect(lifted?.tone).toBe("dash-badge-grey");
  });

  it("draws the tone it chose: BlocksTable and the block page read their tone", () => {
    // A mark drawn from a hard-coded class beside the map would escape the
    // scan, so pin that each badge takes its class from the tone it was given.
    const table = readFileSync(
      join(CONSOLE, "complaints", "complaints-console.tsx"),
      "utf8",
    );
    expect(table).toMatch(
      /<span className=\{`dash-badge \$\{BLOCK_STATE_TONE\[row\.status\]\}`\}>\s*\{BLOCK_STATE_LABEL\[row\.status\]\}/,
    );
    const page = readFileSync(
      join(CONSOLE, "complaints", "blocks", "[blockId]", "page.tsx"),
      "utf8",
    );
    expect(page).toMatch(
      /<span className=\{`dash-badge \$\{tone\.tone\}`\}>\{tone\.text\}<\/span>/,
    );
  });
});
