import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Browser code must call randomUuid() (lib/random-uuid.ts), never
 * `crypto.randomUUID()`, which does not exist on a plain-http page. Local
 * development serves stores on http://{slug}.localtest.me, where a direct call
 * throws and takes the page down (the storefront's analytics tracker did,
 * 2026-11-21).
 *
 * A file counts as browser code when it is a "use client" module or touches
 * a browser-only global (window, document, navigator, localStorage). Server
 * code may keep calling crypto.randomUUID: Node always has it.
 */
const ROOT = process.cwd();
const DIRS = ["app", "components", "lib", "hooks"];
const SKIP_DIRS = new Set(["node_modules", ".next", "__fixtures__"]);

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

/** The code with comments removed (a comment may name crypto.randomUUID). */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function isBrowserCode(code: string, path: string): boolean {
  const firstStatement = code.trimStart();
  if (/^["']use client["']/.test(firstStatement)) return true;
  // Server modules: actions, `server-only` imports and route handlers.
  if (/^["']use server["']/.test(firstStatement)) return false;
  if (/import\s+["']server-only["']/.test(code)) return false;
  if (/[\\/]route\.ts$/.test(path)) return false;
  return /\b(window|document|navigator|localStorage|sessionStorage)\./.test(
    code,
  );
}

const files = DIRS.flatMap((d) => sourceFiles(join(ROOT, d)));

describe("browser code uses randomUuid, never crypto.randomUUID", () => {
  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("finds no direct crypto.randomUUID call in browser code", () => {
    const offenders = files
      .filter((path) => !path.endsWith(`lib${sep}random-uuid.ts`))
      .filter((path) => {
        const code = withoutComments(readFileSync(path, "utf8"));
        return (
          isBrowserCode(code, path) && /crypto\.randomUUID\s*\(/.test(code)
        );
      })
      .map((path) => relative(ROOT, path).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });

  it("would catch one (the check is not vacuous)", () => {
    const sample = '"use client";\nconst id = crypto.randomUUID();\n';
    const code = withoutComments(sample);
    expect(
      isBrowserCode(code, "app/x.tsx") && /crypto\.randomUUID\s*\(/.test(code),
    ).toBe(true);
    expect(isBrowserCode('"use server";\nwindow.x;', "app/actions/x.ts")).toBe(
      false,
    );
  });
});
