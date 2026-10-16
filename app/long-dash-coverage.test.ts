import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// COVERAGE GUARD: no em dash (U+2014) in text the product shows.
//
// The owner's rule, already enforced for every email (lib/email/no-long-dash
// .test.ts) and the marketing site, now holds for the whole app: dashboard,
// storefront, POS, operator console. Sentences use " - ", a comma or a colon;
// an empty table cell is "-"; page titles use " · ".
//
// Only string literals, template text and JSX text are checked. Comments are
// not product text, and regex literals that MATCH a dash on purpose (the
// migration and help lints, withoutLongDashes) are a different thing entirely.
//
// The exemptions are files whose text is frozen elsewhere, where editing the
// source would change nothing a visitor sees, or would break a checksum:
// ---------------------------------------------------------------------------

const EXEMPT: { prefix: string; why: string }[] = [
  {
    prefix: "lib/themes/definitions/",
    why: "bundled theme releases are digest-checked; changed content without a version bump fails the registry import",
  },
  {
    prefix: "lib/themes/meta.ts",
    why: "feeds the bundled theme releases above",
  },
  {
    prefix: "lib/theme-studio/",
    why: "model-facing prompts, and qa-diagnosis parses the acceptance messages on their dash",
  },
  {
    prefix: "lib/help/embedding-worker.ts",
    why: "embedding input for the help index, never rendered",
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(full) && !full.includes(".test."))
      out.push(full);
  }
  return out;
}

const EM_DASH = "—";

/** Every em dash inside a literal the product could render, as "file:line". */
function literalDashes(file: string, text: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)) &&
      node.text.includes(EM_DASH)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      hits.push(`${file}:${line + 1}: ${node.text.trim().slice(0, 80)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("★★ no em dash in product text", () => {
  const files = ["app", "components", "lib", "hooks"]
    .flatMap((dir) => sourceFiles(dir))
    .filter((file) => !EXEMPT.some((e) => file.startsWith(e.prefix)));

  it("finds real files to scan, so a broken scan cannot pass silently", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("every exemption still names a real path", () => {
    const all = ["app", "components", "lib", "hooks"].flatMap((dir) =>
      sourceFiles(dir),
    );
    for (const { prefix } of EXEMPT) {
      expect(
        all.some((file) => file.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
  });

  // Parses every file that holds a dash, comments included, so it grows with
  // the codebase: ~4.7s under CI coverage on main, past vitest's 5s default
  // once the whatsapp merge added its files.
  it(
    "uses a hyphen, comma or colon instead of an em dash",
    {
      timeout: 30_000,
    },
    () => {
      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        // Cheap filter first: most files carry dashes only in comments, and a
        // file with none at all needs no parse. "—" is the escaped form.
        if (!text.includes(EM_DASH) && !text.includes("\\u2014")) continue;
        offenders.push(...literalDashes(file, text));
      }
      expect(
        offenders,
        'StoreMink copy never uses an em dash. Write " - ", a comma or a colon in ' +
          'a sentence, "-" for an empty cell, and " · " in a page title.',
      ).toEqual([]);
    },
  );
});
