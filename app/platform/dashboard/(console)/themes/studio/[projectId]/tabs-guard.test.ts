import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// GUARD: the theme page's tabs and release controls (wave TS-2, builder 2C;
// plan section 4, "Rules for all three", and section 8 row 2). Beside the
// Studio stylesheet's own guard (studio-css.test.ts), for the files 2C
// wrote or rebuilt:
//
// - the dashboard's design system only: no raw Tailwind colour, no violet;
// - in-app dialogs, never the browser's confirm or alert; no tooltip;
// - no em dash or en dash, and never a number of Mink credits;
// - no "Capture catalogue pictures" button anywhere (every final check
//   takes them), and no release version picker or Restore on screen;
// - the old sub-pages are redirects and nothing more;
// - "Describe a fix" is built by the one draft builder, never by hand.
// ---------------------------------------------------------------------------

const P = join(
  "app",
  "platform",
  "dashboard",
  "(console)",
  "themes",
  "studio",
  "[projectId]",
);
const V = join(P, "versions", "[versionId]");

const SCREENS = [
  join(P, "checks-tab.tsx"),
  join(P, "pictures-tab.tsx"),
  join(P, "changes-tab.tsx"),
  join(P, "log-tab.tsx"),
  join(P, "release-controls.tsx"),
  join(P, "checks-controls.tsx"),
  join(P, "check-screenshots.tsx"),
  join(P, "checks-model.ts"),
  join(P, "tab-reads.ts"),
  join(P, "tab-rules.ts"),
  join(P, "release", "release-workspace.tsx"),
  join(V, "acceptance", "acceptance-evidence.tsx"),
  join(V, "images", "capture-panel.tsx"),
  join(V, "images", "slot-images-editor.tsx"),
  join(V, "images", "generate-images-button.tsx"),
  join(V, "images", "picture-names.ts"),
];

const REDIRECTS = [
  join(V, "acceptance", "page.tsx"),
  join(V, "images", "page.tsx"),
  join(P, "compare", "page.tsx"),
  join(P, "release", "page.tsx"),
];

const PALETTE =
  /\b(?:text|bg|border|ring|from|to|via|fill|stroke|outline|divide|placeholder|accent|caret|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?(?:\/\d+)?\b/;

function source(file: string): string {
  return readFileSync(file, "utf8");
}

/** A file's code without its comments, so a comment may name what went. */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("★ the tabs and the release controls", () => {
  it("use the design system's classes and tokens, never a raw colour or violet", () => {
    for (const file of [...SCREENS, ...REDIRECTS]) {
      const text = source(file);
      const raw = text.match(PALETTE);
      expect(raw, `${file}: ${raw?.[0]}`).toBeNull();
      expect(text, file).not.toMatch(/violet/i);
    }
  });

  it("ask in an in-app dialog, never the browser's confirm or alert, and use no tooltip", () => {
    for (const file of SCREENS) {
      const text = source(file);
      expect(text, file).not.toMatch(/window\.(?:confirm|alert|prompt)\(/);
      expect(text, file).not.toMatch(/\b(?:confirm|alert)\(/);
      expect(text, file).not.toMatch(/components\/ui\/tooltip/);
      // A title attribute on an element is a tooltip.
      expect(text, file).not.toMatch(/<[a-z][\w-]*\s[^<>]*\btitle=/);
    }
  });

  it("carry no em dash and no en dash, and never a number of Mink credits", () => {
    const EM = String.fromCharCode(0x2014);
    const EN = String.fromCharCode(0x2013);
    for (const file of [...SCREENS, ...REDIRECTS]) {
      const text = source(file);
      expect(text.includes(EM), `${file} has an em dash`).toBe(false);
      expect(text.includes(EN), `${file} has an en dash`).toBe(false);
      expect(text, file).not.toMatch(/\bcredits?\b/i);
    }
  });

  it("offer no Capture catalogue pictures button and no release version picker", () => {
    for (const file of SCREENS) {
      const text = code(file);
      expect(text, file).not.toMatch(/queueThemeStudioCaptureAction/);
      expect(text, file).not.toMatch(/Capture (?:catalog|catalogue) pictures/i);
      expect(text, file).not.toMatch(/Restore this version/);
      expect(text, file).not.toMatch(/Generate images|Confirm redraw/);
    }
  });

  it("never changes the release new stores get from the screen (the Log tab only names that history)", () => {
    for (const file of [
      join(P, "release", "release-workspace.tsx"),
      join(P, "release-controls.tsx"),
    ])
      expect(code(file), file).not.toMatch(/select_release|<select\b/);
  });

  it("put Describe a fix's words through the one draft builder", () => {
    const checks = source(join(P, "checks-tab.tsx"));
    expect(checks).toMatch(/describeFixDraft\(/);
    expect(source(join(P, "checks-controls.tsx"))).toMatch(
      /api\.putInChat\(draft\)/,
    );
    // Never sent from the tab: no revise action is imported by its parts.
    for (const file of SCREENS)
      expect(source(file), file).not.toMatch(
        /reviseThemeStudioVersionAction|submitThemeStudioDetailsAction/,
      );
  });
});

describe("★ the old sub-pages", () => {
  it("are redirects into the theme page's tabs and nothing more", () => {
    const tabs = ["checks", "pictures", "changes", "log"];
    REDIRECTS.forEach((file, index) => {
      const text = source(file);
      const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map(
        (m) => m[1],
      );
      expect(imports, file).toEqual(["next/navigation"]);
      expect(text, file).toContain(`?tab=${tabs[index]}`);
      expect(text, file).toMatch(/redirect\(/);
      expect(text, file).toMatch(/encodeURIComponent\(projectId\)/);
    });
  });
});
