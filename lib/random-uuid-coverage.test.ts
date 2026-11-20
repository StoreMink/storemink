import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Browser code must call randomUuid() (lib/random-uuid.ts), never
 * `crypto.randomUUID`, which does not exist on a plain-http page. Local
 * development serves stores on http://{slug}.localtest.me, where a direct call
 * throws and takes the page down (the storefront's analytics tracker did,
 * 2026-11-21).
 *
 * ★ EVERY FILE IS BROWSER CODE UNLESS IT PROVES OTHERWISE. A module is often
 * client-only because client components import it, with no directive of its
 * own (lib/mink/voice-turn.ts was one), so the guard cannot wait for a
 * "use client" line. A file counts as server code only when it starts with
 * "use server", imports `server-only`, imports a `node:*` module (a value
 * import: `import type` is erased at build time and proves nothing), or is a
 * route handler under `app/` (`route.ts` or `route.tsx`).
 *
 * ★ A BARE `crypto` IMPORT IS NOT SERVER CODE. Next bundles it for the
 * browser as `crypto-browserify`, which has no `randomUUID`, so such a call
 * builds and then throws on every page, https included. Server files import
 * `node:crypto`.
 *
 * ★ IT MATCHES THE NAME, NOT THE CALL. `const { randomUUID } = crypto`,
 * `window.crypto.randomUUID()` and `crypto.randomUUID?.()` all throw the same
 * way, so any `randomUUID` identifier in browser code fails. The file is
 * parsed with TypeScript itself, so a comment or a string that names it does
 * not count, and a string such as `accept="image/*"` or a template literal
 * cannot hide code from the parse.
 *
 * ⚠ What it cannot see: script built as a string and injected into a page or
 * frame (custom-code-frame.tsx does this), and third-party code in
 * node_modules. It covers our own .ts and .tsx files only.
 */
const ROOT = process.cwd();
const DIRS = ["app", "components", "lib", "hooks"];
const SKIP_DIRS = new Set(["node_modules", ".next", "__fixtures__"]);
const HELPER = "lib/random-uuid.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** The file parsed as TypeScript (as TSX for a .tsx file). */
function parse(source: string, path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const NODE_MODULE = /^node:.+$/;
const ROUTE_HANDLER = /^app\/.*\/route\.tsx?$/;

/** `path` is relative to the repository root, with forward slashes. */
function isServerCode(file: ts.SourceFile, path: string): boolean {
  if (ROUTE_HANDLER.test(path)) return true;
  const first = file.statements[0];
  if (
    first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use server"
  ) {
    return true;
  }
  return file.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) return false;
    // Erased at build time, so the file can still reach the browser.
    if (statement.importClause?.isTypeOnly) return false;
    const from = statement.moduleSpecifier;
    if (!ts.isStringLiteral(from)) return false;
    return from.text === "server-only" || NODE_MODULE.test(from.text);
  });
}

/** Whether any identifier in the code (never a comment or a string) is randomUUID. */
function namesRandomUuid(file: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === "randomUUID") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether the guard would refuse this source at this path. */
function offends(source: string, path: string): boolean {
  // Most files never mention it: skip the parse for them (the parse still
  // decides for the rest, so a comment or a string never counts).
  if (!source.includes("randomUUID")) return false;
  const file = parse(source, path);
  return !isServerCode(file, path) && namesRandomUuid(file);
}

const files = DIRS.flatMap((d) => sourceFiles(join(ROOT, d))).map((path) =>
  relative(ROOT, path).split(sep).join("/"),
);

describe("browser code uses randomUuid, never crypto.randomUUID", () => {
  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("finds no randomUUID in browser code", { timeout: 30_000 }, () => {
    const offenders = files
      .filter((path) => path !== HELPER)
      .filter((path) => offends(readFileSync(join(ROOT, path), "utf8"), path));
    expect(offenders).toEqual([]);
  });

  it("catches a file with no directive of its own", () => {
    expect(
      offends("export const id = () => crypto.randomUUID();", "lib/x.ts"),
    ).toBe(true);
  });

  it("catches the aliased and optional forms", () => {
    for (const code of [
      "const { randomUUID } = crypto; randomUUID();",
      "const c = window.crypto; c.randomUUID();",
      "crypto.randomUUID?.();",
    ]) {
      expect(offends(code, "lib/x.ts")).toBe(true);
    }
  });

  it("is not fooled by a string that looks like a comment", () => {
    const code = [
      '"use client";',
      'const el = <input accept="image/*" />;',
      "const id = crypto.randomUUID();",
      "const note = <p>{/* a comment */}</p>;",
    ].join("\n");
    expect(offends(code, "app/x.tsx")).toBe(true);
  });

  it("is not fooled by a template literal before the code", () => {
    const code = [
      "const a = `${1}`; // crypto.randomUUID is not here",
      "/** `crypto.randomUUID()` by default. */",
      "const b = `x${a}y`;",
    ].join("\n");
    expect(offends(code, "lib/x.ts")).toBe(false);
    expect(offends(code + "\ncrypto.randomUUID();", "lib/x.ts")).toBe(true);
  });

  it("ignores comments and server code", () => {
    expect(offends("// crypto.randomUUID() is not here", "lib/x.ts")).toBe(
      false,
    );
    expect(
      offends('"use server";\nconst id = crypto.randomUUID();', "app/a.ts"),
    ).toBe(false);
    expect(
      offends(
        'import "server-only";\nconst id = crypto.randomUUID();',
        "lib/a.ts",
      ),
    ).toBe(false);
    expect(
      offends(
        'import { randomUUID } from "node:crypto";\nrandomUUID();',
        "lib/a.ts",
      ),
    ).toBe(false);
    expect(
      offends("const id = crypto.randomUUID();", "app/api/x/route.ts"),
    ).toBe(false);
    expect(
      offends("const id = crypto.randomUUID();", "app/api/og/route.tsx"),
    ).toBe(false);
  });

  it("does not take a bare crypto import as server code (Next bundles it for the browser)", () => {
    expect(
      offends(
        'import { randomUUID } from "crypto";\nrandomUUID();',
        "lib/a.ts",
      ),
    ).toBe(true);
  });

  it("does not take a type-only Node import as server code", () => {
    expect(
      offends(
        'import type { Readable } from "node:stream";\ncrypto.randomUUID();',
        "lib/a.ts",
      ),
    ).toBe(true);
  });

  it("exempts only route handlers under app/", () => {
    expect(offends("const id = crypto.randomUUID();", "lib/x/route.ts")).toBe(
      true,
    );
    expect(
      offends("const id = crypto.randomUUID();", "components/x/route.tsx"),
    ).toBe(true);
  });
});
