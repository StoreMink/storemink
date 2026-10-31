import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// COVERAGE GUARD: every public write for a store goes through
// `writeStoreObject` (lib/storage/store-objects.ts; takedown design 5.7, plan
// A4 and A8).
//
// `writeStoreObject` hashes the bytes and asks the re-upload guard before it
// writes, so bytes StoreMink has blocked cannot be put back by any StoreMink
// tool. That promise holds only while nothing else calls `gcsUploadObject`,
// the raw public write in lib/storage/gcs.ts: a store writer that calls it
// directly writes blocked bytes back with no refusal and no record. This test
// fails on any such call ("mutation check 20", CODEBASE.md).
//
// The only callers allowed are named below, each with its reason and, where
// it applies, the one function the call must sit in. Nothing else is allowed:
// to add a caller, name it here with a reason a reviewer can check.
//
// Scope:
// - `app/`, `lib/`, `components/` and `hooks/`, what the deployed service
//   runs, and `scripts/`. Plan A8 left scripts out; they are scanned here
//   anyway, because a script can run against a real bucket (the WhatsApp
//   media move does, with --commit), so a new script that writes store
//   objects should have to say why. The one script that does is named below.
// - Test files are not scanned: they mock the storage calls.
// - Private-bucket writers (`gcsPrivateUploadObject`: Mink chat attachments,
//   Refine's unpaid stages, WhatsApp chat media, the takedown archive) are
//   outside this rule and not matched: a private object is never served by a
//   public address or to a shopper, so writing blocked bytes there puts
//   nothing back in public. Two other public paths are not matched either:
//   `gcsCopyObject` into the public bucket (only the takedown's restore
//   adapter, lib/moderation/storage.ts) and `gcsSignUploadUrl` (videos go
//   from the browser to a signed URL, no server sees the bytes: plan A8's
//   known gap for videos).
// - The second test holds the storage SDK to lib/storage/gcs.ts, so the rule
//   cannot be stepped around by writing through the SDK directly.
//
// The scan reads identifiers through the TypeScript parser, so a mention in a
// comment or a string is not a call; an aliased or namespaced use still
// carries the identifier and is found.
// ---------------------------------------------------------------------------

const WRITER = "gcsUploadObject";
const SDK = "@google-cloud/storage";

type Allowed = {
  /** The file, from the repository root, with forward slashes. */
  file: string;
  /** The one function every use must sit in; null for the definition. */
  within: string | null;
  why: string;
};

const ALLOWED: Allowed[] = [
  {
    file: "lib/storage/gcs.ts",
    within: null,
    why: "where the raw public write is defined",
  },
  {
    file: "lib/storage/store-objects.ts",
    within: "writeStoreObject",
    why: "the one writer: the path check, the re-upload guard, then the upload",
  },
  {
    file: "app/api/upload/route.ts",
    within: "writePlatformUpload",
    why: "an operator's upload on the platform host, fenced to platform/uploads/ (checked below): not a store object, and no store shows anything under it",
  },
  {
    file: "lib/moderation/storage.ts",
    within: "uploadPublic",
    why: "the takedown's own writes: the placeholder over a blocked object and the restore of a lifted one, each pinned to a generation (preconditions writeStoreObject does not take); the restore must not be refused by the block it undoes",
  },
  {
    file: "scripts/revamp-live-check.ts",
    within: "storePhonePhoto",
    why: "a local-only check: it refuses any database but storemink_local, writes made-up shops' photos and never runs in the deployed service",
  },
];

const ROOT = join(__dirname, "..", "..");
const SCANNED_DIRS = ["app", "lib", "components", "hooks", "scripts"];
const SDK_DIRS = ["app", "lib", "components", "hooks"];
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry === "__fixtures__"
    ) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (
      SOURCE.test(full) &&
      !/\.(test|spec)\./.test(full) &&
      !full.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function repoPath(full: string): string {
  return relative(ROOT, full).split(sep).join("/");
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** The names of the functions (and object members) enclosing a node. */
function enclosingNames(node: ts.Node): string[] {
  const names: string[] = [];
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) ||
        ts.isMethodDeclaration(at) ||
        ts.isPropertyAssignment(at) ||
        ts.isVariableDeclaration(at)) &&
      at.name &&
      ts.isIdentifier(at.name)
    ) {
      names.push(at.name.text);
    }
  }
  return names;
}

function insideImport(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isImportDeclaration(at)) return true;
  }
  return false;
}

export interface WriterUse {
  line: number;
  /** Enclosing function and member names, innermost first. */
  within: string[];
}

/** Every use of the raw writer in one source text, imports excepted. */
export function writerUses(file: string, text: string): WriterUse[] {
  if (!text.includes(WRITER)) return [];
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const uses: WriterUse[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === WRITER && !insideImport(node)) {
      uses.push({
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        within: enclosingNames(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

/** The problems with one file's uses: an unknown file, or a use outside its function. */
export function writerProblems(file: string, uses: WriterUse[]): string[] {
  if (uses.length === 0) return [];
  const allowed = ALLOWED.find((entry) => entry.file === file);
  if (!allowed) {
    return uses.map(
      (use) =>
        `${file}:${use.line} calls ${WRITER} directly; write through writeStoreObject`,
    );
  }
  if (allowed.within === null) return [];
  return uses
    .filter((use) => !use.within.includes(allowed.within as string))
    .map(
      (use) => `${file}:${use.line} uses ${WRITER} outside ${allowed.within}`,
    );
}

/** Whether a source text loads the storage SDK (import, import() or require). */
export function loadsSdk(file: string, text: string): boolean {
  if (!text.includes(SDK)) return false;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === SDK
    ) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === SDK
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("the raw public write: only writeStoreObject and the named exceptions call it", () => {
  const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)));
  const usesByFile = new Map<string, WriterUse[]>();
  for (const full of files) {
    const file = repoPath(full);
    const uses = writerUses(file, readFileSync(full, "utf8"));
    if (uses.length > 0) usesByFile.set(file, uses);
  }

  it("scans the source tree", () => {
    // A scan that found nothing to read would pass for ever.
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((file) => repoPath(file) === "lib/storage/gcs.ts")).toBe(
      true,
    );
  });

  it("★★ no store writer calls gcsUploadObject directly (mutation check 20)", () => {
    const problems = [...usesByFile].flatMap(([file, uses]) =>
      writerProblems(file, uses),
    );
    expect(problems).toEqual([]);
  });

  it("every exception is still used, in its own function (a stale entry is removed, not kept)", () => {
    for (const entry of ALLOWED) {
      const uses = usesByFile.get(entry.file) ?? [];
      expect(uses.length, `${entry.file}: ${entry.why}`).toBeGreaterThan(0);
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  it("the upload route's platform write stays fenced to platform/uploads/", () => {
    const text = readFileSync(join(ROOT, "app/api/upload/route.ts"), "utf8");
    expect(text).toContain('const PLATFORM_UPLOAD_ROOT = "platform/uploads/";');
    const source = ts.createSourceFile(
      "route.ts",
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    let body = "";
    source.forEachChild((node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "writePlatformUpload"
      ) {
        body = node.getText(source);
      }
    });
    expect(body).toContain("if (!path.startsWith(PLATFORM_UPLOAD_ROOT))");
    expect(body.indexOf("startsWith(PLATFORM_UPLOAD_ROOT)")).toBeLessThan(
      body.indexOf(WRITER),
    );
  });

  it("the scan itself: a call, an alias, a namespace use and a member use are found; a comment, a string and an import are not", () => {
    const text = [
      `import { ${WRITER} } from "@/lib/storage/gcs";`,
      `import { ${WRITER} as up } from "@/lib/storage/gcs";`,
      `import * as gcs from "@/lib/storage/gcs";`,
      `// ${WRITER}(path, bytes, type) is not a call`,
      `const note = "${WRITER}";`,
      `export async function save(path: string, bytes: Uint8Array) {`,
      `  await ${WRITER}(path, bytes, "image/webp");`,
      `  await gcs.${WRITER}(path, bytes, "image/webp");`,
      `}`,
      `export const adapter = { put: (p: string) => ${WRITER}(p, new Uint8Array(), "a") };`,
    ].join("\n");
    const uses = writerUses("lib/mink/example.ts", text);
    expect(uses.map((use) => use.line)).toEqual([7, 8, 10]);
    expect(uses[0].within).toContain("save");
    expect(uses[2].within).toEqual(expect.arrayContaining(["put", "adapter"]));
    expect(writerProblems("lib/mink/example.ts", uses)).toHaveLength(3);
    // An allowed file is held to its one function.
    expect(
      writerProblems("app/api/upload/route.ts", [
        { line: 3, within: ["writePlatformUpload"] },
        { line: 9, within: ["POST"] },
      ]),
    ).toEqual([
      `app/api/upload/route.ts:9 uses ${WRITER} outside writePlatformUpload`,
    ]);
    expect(
      writerProblems("lib/storage/gcs.ts", [{ line: 1, within: [] }]),
    ).toEqual([]);
  });
});

describe("the storage SDK", () => {
  it("only lib/storage/gcs.ts loads @google-cloud/storage, so no writer can go round the rule", () => {
    const loaders = SDK_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)))
      .filter((full) => loadsSdk(full, readFileSync(full, "utf8")))
      .map(repoPath);
    expect(loaders).toEqual(["lib/storage/gcs.ts"]);
    // The check itself sees a static, a dynamic and a required load.
    expect(loadsSdk("a.ts", `import { Storage } from "${SDK}";`)).toBe(true);
    expect(loadsSdk("a.ts", `const m = await import("${SDK}");`)).toBe(true);
    expect(loadsSdk("a.cjs", `const m = require("${SDK}");`)).toBe(true);
    expect(loadsSdk("a.ts", `// "${SDK}" is mentioned only`)).toBe(false);
  });
});
