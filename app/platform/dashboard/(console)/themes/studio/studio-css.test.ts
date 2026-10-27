import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// GUARD: Theme Studio's own stylesheet and the theme page's files (wave TS-2,
// builder 2B; plan section 4, "Rules for all three").
//
// - studio.css is loaded once, by themes/layout.tsx, and by nothing else.
// - Every class it defines starts with `studio-` (a global stylesheet stays
//   after navigating away, so nothing may reach another console page), apart
//   from the dashboard frame it widens while the theme page is open.
// - Colours are the dashboard's `--dash-*` tokens only: no raw palette
//   colour, no violet.
// - 44 px on phones AND on touch screens of any width (`pointer: coarse`).
// - The status badge's words stay readable on every tone (the dashboard's
//   amber and green fail AA as text, studio-ui.tsx).
// - The theme page's files use no raw Tailwind colour class, no violet, no
//   browser confirm box, no tooltip, and no em dash or en dash.
// ---------------------------------------------------------------------------

const STUDIO = join("app", "platform", "dashboard", "(console)", "themes");
const CSS = readFileSync(join(STUDIO, "studio", "studio.css"), "utf8");
const DASHBOARD_CSS = readFileSync(
  join("app", "dashboard", "dashboard.css"),
  "utf8",
);
const P = join(STUDIO, "studio", "[projectId]");

/** The theme page's files (builder 2B's, wave TS-2). */
const PAGE_FILES = [
  join(STUDIO, "layout.tsx"),
  join(P, "page.tsx"),
  join(P, "workspace.tsx"),
  join(P, "conversation.tsx"),
  join(P, "progress-card.tsx"),
  join(P, "studio-tabs.tsx"),
  join(P, "tab-types.ts"),
  join(P, "checks-tab.tsx"),
  join(P, "pictures-tab.tsx"),
  join(P, "changes-tab.tsx"),
  join(P, "log-tab.tsx"),
  join(P, "release-controls.tsx"),
  join(P, "delete-theme-button.tsx"),
  join(P, "versions", "[versionId]", "page.tsx"),
  join(P, "versions", "[versionId]", "preview-frame.tsx"),
];

const PALETTE =
  /\b(?:text|bg|border|ring|from|to|via|fill|stroke|outline|divide|placeholder|accent|caret|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?(?:\/\d+)?\b/;

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every rule's selector text and declarations, at any nesting level. */
function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of withoutComments(css).matchAll(pattern)) {
    out.push({ selector: match[1].trim(), body: match[2] });
  }
  return out;
}

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(DASHBOARD_CSS);
  if (!match) throw new Error(`dashboard.css has no --${name}`);
  return match[1].trim();
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

function appFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) appFiles(full, out);
    else if (/\.(tsx?|css)$/.test(full) && !full.includes(".test."))
      out.push(full);
  }
  return out;
}

describe("★ Theme Studio's stylesheet", () => {
  it("is loaded once, by the Themes layout, and by nothing else", () => {
    const layout = readFileSync(join(STUDIO, "layout.tsx"), "utf8");
    expect(layout).toContain('import "./studio/studio.css";');
    const importers = [...appFiles("app"), ...appFiles("components")].filter(
      (file) =>
        /(?:import|require)\s*\(?\s*["'][^"']*studio\.css["']/.test(
          readFileSync(file, "utf8"),
        ),
    );
    expect(importers).toEqual([join(STUDIO, "layout.tsx")]);
  });

  it("defines only studio- classes, apart from the frame it widens", () => {
    const frame = new Set([
      "dashboard-frame",
      "dash-sidebar",
      "dash-main",
      "dash-content",
      "dash-btn",
    ]);
    const found = rules(CSS)
      .filter(({ selector }) => !selector.startsWith("@"))
      .flatMap(({ selector }) =>
        [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]),
      );
    expect(found.length).toBeGreaterThan(40);
    const strangers = found.filter(
      (name) => !name.startsWith("studio-") && !frame.has(name),
    );
    expect(strangers).toEqual([]);
    // The frame classes appear only in the full-width rules and the touch
    // rule's button links, never as a restyle of their own.
    const frameRules = rules(CSS).filter(({ selector }) =>
      /\.dash-(?:sidebar|main|content)\b/.test(selector),
    );
    for (const { selector } of frameRules)
      expect(selector).toMatch(
        /\.dashboard-frame(?:\.studio-fullwidth|:has\(\.studio-page\))/,
      );
  });

  it("uses the dashboard's tokens only: no raw colour and no violet", () => {
    const declarations = rules(CSS)
      .map(({ body }) => body)
      .join("\n");
    expect(declarations).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(declarations).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
    expect(withoutComments(CSS)).not.toMatch(/violet/i);
    for (const used of declarations.matchAll(/var\((--[\w-]+)/g))
      expect(used[1]).toMatch(/^--(?:dash-|studio-|font-dash)/);
    expect(withoutComments(CSS)).not.toMatch(/\.dashboard-shell\b/);
  });

  it("makes every Studio control at least 44 px on phones and touch screens of any width", () => {
    const touch =
      /@media\s*\(max-width:\s*767px\),\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/g;
    const blocks = [...CSS.matchAll(touch)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(0);
    const main = blocks.find((block) => block.includes("min-height: 44px"));
    expect(main).toBeTruthy();
    for (const control of [
      "button",
      "a.dash-btn",
      '[role="tab"]',
      "summary",
      "select",
      "input:not",
    ])
      expect(main).toContain(control);
  });

  it("covers the back link and links drawn as buttons with the touch rule", () => {
    const touch = [
      ...CSS.matchAll(
        /@media\s*\(max-width:\s*767px\),\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/g,
      ),
    ].map((m) => m[1]);
    const main = touch.find((block) => block.includes("min-height: 44px"));
    expect(main).toContain("a.studio-crumb");
    // An attachment's 44 px remove button hangs over its corner unclipped.
    expect(touch.join("\n")).toMatch(
      /li\.studio-thumb\s*\{\s*overflow:\s*visible;/,
    );
  });

  it("rings a label drawn as a button when the keyboard reaches its hidden file field", () => {
    const ring = rules(CSS).find(({ selector }) =>
      selector.includes("label.dash-btn:has(input:focus-visible)"),
    );
    expect(ring?.body).toMatch(/outline:\s*2px solid var\(--dash-accent\)/);
  });

  it("wraps a group of segmented buttons inside its box", () => {
    const group = rules(CSS).find(
      ({ selector }) => selector === ".studio-segmented",
    );
    expect(group?.body).toMatch(/flex-wrap:\s*wrap;/);
    expect(group?.body).toMatch(/max-width:\s*100%;/);
  });

  it("fades the side of a tab strip that has more tabs", () => {
    for (const side of ["data-more-start", "data-more-end"]) {
      const rule = rules(CSS).find(
        ({ selector }) => selector === `.studio-tabs[${side}]`,
      );
      expect(rule?.body, side).toMatch(/(?:^|\s)mask-image:\s*linear-gradient/);
      expect(rule?.body, side).toMatch(/-webkit-mask-image:/);
    }
  });

  it("scrolls the theme page as one column on a phone, the chat keeping the screen's height", () => {
    const phone = [
      ...CSS.matchAll(/@media\s*\(max-width:\s*767px\)\s*\{([\s\S]*?)\n\}/g),
    ].map((m) => m[1]);
    const column = phone.find((block) => block.includes("--studio-pane-h"));
    expect(column).toBeTruthy();
    const inside = rules(column!);
    // The first rule whose selector starts with `part` (exactly that
    // element, not one that only mentions it inside `:has()`).
    const find = (part: string) =>
      inside.find(({ selector }) => selector.startsWith(part))?.body ?? "";
    // The content column scrolls; the header and notices go with it.
    expect(find(".dashboard-frame.studio-fullwidth .dash-content")).toMatch(
      /overflow-y:\s*auto;/,
    );
    expect(
      inside.find(({ selector }) => selector === ".studio-page")?.body,
    ).toMatch(/height:\s*auto;/);
    // The tab bar and the phone bar stay put while it scrolls.
    expect(find(".studio-tabbar")).toMatch(/position:\s*sticky;/);
    expect(find(".studio-phonebar")).toMatch(/position:\s*sticky;/);
    // The chat and a tab's panel take the screen left between them.
    expect(find(".studio-chat,")).toMatch(/height:\s*var\(--studio-pane-h\);/);
    // A locked composer folds to its one-line reason.
    expect(
      find('.studio-composer[data-locked="true"] > :not(.studio-reason)'),
    ).toMatch(/display:\s*none;/);
  });

  it("keeps a bottom sheet under 85% of the screen's height, scrolling", () => {
    const phone = CSS.slice(CSS.indexOf(".studio-sheet,\n  .studio-popover {"));
    expect(phone).toMatch(/max-height:\s*85dvh/);
    expect(phone).toMatch(/overflow-y:\s*auto/);
  });

  it("keeps the status badge's words readable on every tone", () => {
    const badge = rules(CSS).find(
      ({ selector }) => selector === ".studio-badge",
    );
    expect(badge?.body).toMatch(/color:\s*var\(--dash-text\);/);
    const ink = parse(token("dash-text")).rgb;
    const white: RGB = [255, 255, 255];
    const page = parse(token("dash-bg")).rgb;
    const tints: Record<string, string> = {
      neutral: "dash-surface-2",
      info: "dash-accent-soft",
      success: "dash-green-soft",
      warning: "dash-amber-soft",
      danger: "dash-red-soft",
    };
    for (const [tone, name] of Object.entries(tints)) {
      if (tone !== "neutral") {
        const rule = rules(CSS).find(
          ({ selector }) => selector === `.studio-badge[data-tone="${tone}"]`,
        );
        expect(rule?.body).toContain(`background: var(--${name});`);
      }
      for (const backdrop of [white, page]) {
        const ratio = contrast(ink, over(token(name), backdrop));
        expect(ratio, `${tone} on its tint`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the second ink readable where the Studio uses it for words", () => {
    const muted = parse(token("dash-text-2")).rgb;
    const white: RGB = [255, 255, 255];
    for (const name of ["dash-surface-2", "dash-accent-soft"]) {
      expect(
        contrast(muted, over(token(name), white)),
        name,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("★ every Studio dialog", () => {
  it("carries the Studio's root class, since a dialog renders outside the page", () => {
    // Base UI renders a dialog in a portal, outside `.studio-root`, and the
    // dashboard's own 44 px rule stops at 767 px: without the class a touch
    // tablet's dialog buttons fall back to 32 px.
    const files = [
      ...appFiles(STUDIO),
      join("app", "platform", "dashboard", "(console)", "themes-panel.tsx"),
      join(
        "app",
        "platform",
        "dashboard",
        "(console)",
        "theme-studio-tile.tsx",
      ),
    ].filter((file) => file.endsWith(".tsx"));
    let dialogs = 0;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<DialogContent\b/g)) {
        dialogs += 1;
        const tag = source.slice(match.index, match.index + 400);
        expect(tag, file).toMatch(
          /^<DialogContent\s+className="[^"]*\bstudio-root\b/,
        );
      }
    }
    expect(dialogs).toBeGreaterThanOrEqual(9);
  });
});

describe("★ the theme page's files", () => {
  it("use the design system's classes, never a raw colour or violet", () => {
    for (const file of PAGE_FILES) {
      const source = readFileSync(file, "utf8");
      const raw = source.match(PALETTE);
      expect(raw, `${file}: ${raw?.[0]}`).toBeNull();
      expect(source, file).not.toMatch(/violet/i);
    }
  });

  it("ask in an in-app dialog, never the browser's confirm or alert, and use no tooltip", () => {
    for (const file of PAGE_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/window\.(?:confirm|alert|prompt)\(/);
      expect(source, file).not.toMatch(/\b(?:confirm|alert)\(/);
      expect(source, file).not.toMatch(/components\/ui\/tooltip/);
    }
  });

  it("carry no em dash and no en dash, and never a number of Mink credits", () => {
    const EM = String.fromCharCode(0x2014);
    const EN = String.fromCharCode(0x2013);
    for (const file of [...PAGE_FILES, join(STUDIO, "studio", "studio.css")]) {
      const source = readFileSync(file, "utf8");
      expect(source.includes(EM), `${file} has an em dash`).toBe(false);
      expect(source.includes(EN), `${file} has an en dash`).toBe(false);
      expect(source, file).not.toMatch(/\bcredits?\b/i);
    }
  });
});
