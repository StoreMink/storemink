import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// COVERAGE GUARD: no database scope is opened inside another one.
//
// Every scope (`withService`, `withUser`, `withAnon` and the Theme Studio
// `withServiceAndNotices` wrapper) checks out its OWN pooled connection and
// holds it until its callback returns. So a scope opened inside another
// scope's callback holds two connections for one request, and the pool is
// small (5 per process in production, with a 5 s wait for a free one). A few
// such requests at once take every connection and then wait on each other
// until the pool's wait runs out and every one of them fails with
// DatabaseBusyError. `getMyOrder` did exactly this until 2026-10-25: the
// shopper's order page read its shipments through `withService` from inside
// its `withUser` callback.
//
// The fix is always the same: let the first scope return what the second
// needs, close it, then open the second (or pass the open `db` down to the
// helper instead of letting it open its own).
//
// This catches the DIRECT shape only: a scope call written inside another
// scope's callback. A helper that opens its own scope and is CALLED from
// inside one is the indirect shape, which a lexical scan cannot see; pass
// such a helper the `db` you already hold.
//
// A callback handed to `after()` runs once the response is finished, long
// after the enclosing transaction has closed, so a scope inside one is not
// nested and is not reported.
// ---------------------------------------------------------------------------

const SCOPES = new Set([
  "withService",
  "withUser",
  "withAnon",
  "withServiceAndNotices",
]);

/** Deliberate exceptions, as "file:outerLine->innerLine" with the reason. */
const ALLOWED: { site: string; why: string }[] = [];

const ROOT = join(__dirname, "..", "..");
const SCANNED_DIRS = ["app", "lib", "components", "hooks"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (
      /\.(ts|tsx)$/.test(full) &&
      !full.includes(".test.") &&
      !full.endsWith(".d.ts")
    )
      out.push(full);
  }
  return out;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function isFunctionLiteral(
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

interface ScanResult {
  /** Every scope call found, nested or not. */
  scopeCalls: number;
  /** "file:outerLine->innerLine outerName->innerName" for each nested one. */
  nested: string[];
}

/** Scope calls written inside another scope call's callback, in one file. */
function nestedScopeCalls(file: string, text: string): ScanResult {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const result: ScanResult = { scopeCalls: 0, nested: [] };

  function visit(node: ts.Node, open: ts.CallExpression[]): void {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && SCOPES.has(name)) {
        result.scopeCalls++;
        const outer = open[open.length - 1];
        if (outer) {
          result.nested.push(
            `${file}:${lineOf(outer)}->${lineOf(node)} ${calleeName(outer)}->${name}`,
          );
        }
        visit(node.expression, open);
        for (const arg of node.arguments) {
          // Only the callback runs while this scope's connection is held.
          if (isFunctionLiteral(arg)) visit(arg.body, [...open, node]);
          else visit(arg, open);
        }
        return;
      }
      if (name === "after") {
        visit(node.expression, open);
        for (const arg of node.arguments) {
          // Deferred until the response is done: no scope is open then.
          visit(arg, isFunctionLiteral(arg) ? [] : open);
        }
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, open));
  }

  visit(source, []);
  return result;
}

describe("database scopes are never nested", () => {
  it("finds a nested scope in a sample, and skips one deferred by after()", () => {
    const sample = `
      async function nested() {
        return withUser(id, async (db) => {
          const a = await db.select();
          const b = await withService((service) => service.select());
          return [a, b];
        });
      }
      async function sequential() {
        const a = await withUser(id, async (db) => db.select());
        return withService(async (service) => service.select());
      }
      async function deferred() {
        return withService(async (db) => {
          after(() => withService((service) => service.select()));
          return db.select();
        });
      }
    `;
    const { scopeCalls, nested } = nestedScopeCalls("sample.ts", sample);
    expect(scopeCalls).toBe(6);
    expect(nested).toEqual(["sample.ts:3->5 withUser->withService"]);
  });

  it("no source file opens a scope inside another scope's callback", () => {
    let scopeCalls = 0;
    const nested: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const text = readFileSync(file, "utf8");
        if (!/with(Service|User|Anon)/.test(text)) continue;
        const found = nestedScopeCalls(relative(ROOT, file), text);
        scopeCalls += found.scopeCalls;
        nested.push(...found.nested);
      }
    }

    // A scan that silently stopped matching would pass for ever. Hundreds of
    // scope calls exist; finding almost none means the scan is broken.
    expect(scopeCalls).toBeGreaterThan(200);

    const allowed = new Set(ALLOWED.map((entry) => entry.site));
    const unexpected = nested.filter(
      (site) => !allowed.has(site.split(" ")[0]),
    );
    expect(unexpected).toEqual([]);
  });
});
