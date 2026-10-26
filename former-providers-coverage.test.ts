import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, relative, sep } from "path";
import { gunzipSync, gzipSync } from "zlib";

// ---------------------------------------------------------------------------
// COVERAGE GUARD: the repository names neither former provider.
//
// The owner's rule (2026-10-26): StoreMink runs entirely on Google Cloud, and
// the codebase carries no trace of the database host or the web host it moved
// off: not in code, comments, tests, docs, config or file names (CODEBASE.md
// §5, convention 42). The names are assembled from fragments so this file
// never matches itself.
//
// Allowed, each for a reason this repository cannot change, and pinned to the
// exact lines so a new mention in the same file still fails:
//   - FROZEN: two APPLIED migrations name the removed pre-ledger SQL folder in
//     a comment. The runner checksums every byte of an applied migration, so
//     editing either one stops every later deploy (docs/migrations.md §4).
//   - package-lock.json: drizzle-orm lists one provider's Postgres driver among
//     its optional peer dependencies, which npm copies into the lockfile (two
//     lines). Nothing installs it; package.json is scanned like any other file.
// ---------------------------------------------------------------------------

const NAMES = [
  ["supa", "base"],
  ["ver", "cel"],
].map((parts) => parts.join(""));
const PATTERN = new RegExp(NAMES.join("|"), "i");

/** The only matching lines allowed in frozen migrations: file -> line numbers. */
const FROZEN: Record<string, number[]> = {
  "drizzle/migrations/sql/20261014_0206_stock_rpc_store_ownership.sql": [12],
  "drizzle/migrations/sql/20261014_0207_fixed_staff_roles.sql": [27],
};

/** The only matching lines allowed in package-lock.json, trimmed. */
const DRIVER = `@${NAMES[1]}/postgres`;
const LOCKFILE_LINES = [`"${DRIVER}": ">=0.8.0",`, `"${DRIVER}": {`];

const ROOT = process.cwd();
const SKIP_ANYWHERE = new Set(["node_modules", ".next", ".git", "__pycache__"]);
const SKIP_AT_ROOT = new Set(["coverage", "out", "build"]);
/** Root dot-directories that are part of the codebase. Every other root one
 *  (gitignored caches and references) is local tooling. Below the root every
 *  dot-directory is scanned (public/.well-known, say). */
const ROOT_DOT_DIRS = new Set([".github", ".vscode", ".claude"]);
/** Claude Code's local state, which git never sees (the user's global ignore
 *  and .git/info/exclude). The rest of .claude, launch.json among it, is
 *  committed and scanned. */
const CLAUDE_LOCAL = new Set(
  [
    "worktrees",
    "settings.local.json",
    "scheduled_tasks.lock",
    "scheduled_tasks.json",
    "routines/.state",
    "checkpoints",
    "mailbox",
    "agent-registry.json",
    "agent-memory-local",
    "first-run",
    "assistant-daemon-state.json",
  ].map((path) => `.claude/${path}`),
);
/** Env templates are committed, so they are scanned, but a hit names only the
 *  file and line, in case a real value was pasted into one. */
const ENV_TEMPLATES = new Set([".env.example", ".env.sample"]);

/** Never walked: dependencies, build output, git's own data, root
 *  dot-directories that are local tooling, Claude Code's local state. */
function skipDir(name: string, rel: string, atRoot: boolean): boolean {
  return (
    SKIP_ANYWHERE.has(name) ||
    (atRoot && SKIP_AT_ROOT.has(name)) ||
    (atRoot && name.startsWith(".") && !ROOT_DOT_DIRS.has(name)) ||
    CLAUDE_LOCAL.has(rel)
  );
}

/** Never read: env files (templates aside), local MCP config, compiler
 *  caches, OS litter, the gitignored data dump, Claude Code's local state.
 *  package-lock.json is checked by its own test below. */
function skipFile(name: string, rel: string): boolean {
  return (
    (name.startsWith(".env") && !ENV_TEMPLATES.has(name)) ||
    name.startsWith(".mcp") ||
    name === ".DS_Store" ||
    name.endsWith(".tsbuildinfo") ||
    rel === "db-data.sql" ||
    rel === "package-lock.json" ||
    CLAUDE_LOCAL.has(rel)
  );
}

type Found = { files: string[]; badNames: string[]; dumps: string[] };

function walk(root: string, dir: string, found: Found): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join("/");
    const isDir = entry.isDirectory();
    // Every NAME is checked before any skip: a skipped folder can still be
    // committed (the link folder a hosting CLI writes at the root is one).
    if (PATTERN.test(entry.name)) found.badNames.push(isDir ? `${rel}/` : rel);
    if (isDir) {
      if (!skipDir(entry.name, rel, dir === root)) walk(root, full, found);
      continue;
    }
    // A database dump never belongs in the tree, wherever it sits: a
    // custom-format pg_dump compresses its data, so no scan can read it.
    if (/\.dump$/i.test(entry.name)) found.dumps.push(rel);
    // A symbolic link is never followed (it could leave the repository), but
    // its own name is checked above.
    if (entry.isFile() && !skipFile(entry.name, rel)) found.files.push(rel);
  }
}

/** The text a file is searched as: a .gz file gunzipped first, a file that
 *  starts with a UTF-16 byte-order mark decoded. Other content with a NUL byte
 *  is binary (images, fonts) and is searched as raw bytes, and again with the
 *  NULs dropped, which is how UTF-16 text without a mark reads. */
function contentOf(
  root: string,
  rel: string,
): { text: string; binary: boolean } {
  let bytes = readFileSync(join(root, rel));
  if (/\.t?gz$/i.test(rel)) {
    try {
      bytes = gunzipSync(bytes);
    } catch {
      // Not gzip after all: searched as it is.
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: bytes.subarray(2).toString("utf16le"), binary: false };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const units = Buffer.from(bytes.subarray(2, bytes.length & ~1));
    return { text: units.swap16().toString("utf16le"), binary: false };
  }
  if (bytes.subarray(0, 8000).includes(0)) {
    const raw = bytes.toString("latin1");
    return { text: `${raw}\n${raw.replace(/\0/g, "")}`, binary: true };
  }
  return { text: bytes.toString("utf8"), binary: false };
}

/** Each mention in a file as [line, excerpt]; binary content has no lines and
 *  reports line 0. */
function mentionsIn(root: string, rel: string): Array<[number, string]> {
  const { text, binary } = contentOf(root, rel);
  if (binary) return PATTERN.test(text) ? [[0, ""]] : [];
  const hits: Array<[number, string]> = [];
  text.split("\n").forEach((line, index) => {
    if (PATTERN.test(line)) hits.push([index + 1, line.trim().slice(0, 100)]);
  });
  return hits;
}

/** How a mention is reported: never with an env template's content. */
function describeMention(rel: string, line: number, excerpt: string): string {
  if (line === 0) return `${rel}: binary content`;
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return ENV_TEMPLATES.has(name)
    ? `${rel}:${line}`
    : `${rel}:${line}: ${excerpt}`;
}

const found: Found = { files: [], badNames: [], dumps: [] };
walk(ROOT, ROOT, found);
const { files, badNames } = found;

describe("★★ no former provider names in the codebase", () => {
  it("finds real files to scan, so a broken walk cannot pass silently", () => {
    expect(files.length).toBeGreaterThan(2500);
    expect(files).toContain("CODEBASE.md");
    expect(files).toContain("drizzle/schema.ts");
    for (const rel of Object.keys(FROZEN)) expect(files).toContain(rel);
  });

  it("names no file or folder after either provider", () => {
    expect(badNames).toEqual([]);
  });

  it("keeps every database dump out of the tree, wherever it sits", () => {
    // A custom-format pg_dump compresses its data blocks, so the content scan
    // below cannot see the old media host inside one.
    expect(found.dumps).toEqual([]);
  });

  it(
    "mentions neither name in any file except the frozen migration lines",
    { timeout: 30_000 },
    () => {
      const offenders: string[] = [];
      const frozenSeen: Record<string, number[]> = {};
      for (const rel of files) {
        for (const [line, excerpt] of mentionsIn(ROOT, rel)) {
          if (FROZEN[rel]?.includes(line)) {
            (frozenSeen[rel] ??= []).push(line);
          } else {
            offenders.push(describeMention(rel, line, excerpt));
          }
        }
      }
      expect(
        offenders,
        "Name the Google Cloud service or the database object instead (CODEBASE.md §5, convention 42).",
      ).toEqual([]);
      expect(frozenSeen).toEqual(FROZEN);
    },
  );

  it("lets package-lock.json name a provider only in drizzle-orm's optional peer entries", () => {
    const text = readFileSync(join(ROOT, "package-lock.json"), "utf8");
    // Exactly the two lines npm writes for that optional peer, nothing else.
    expect(
      text
        .split("\n")
        .filter((line) => PATTERN.test(line))
        .map((line) => line.trim()),
    ).toEqual(LOCKFILE_LINES);
    // And both of them sit where they are allowed: drizzle-orm's
    // peerDependencies / peerDependenciesMeta. A dependency bump that adds
    // another such peer fails here on purpose, so a human looks.
    const lock = JSON.parse(text) as {
      packages?: Record<string, Record<string, unknown>>;
    };
    const offenders: string[] = [];
    for (const [key, pkg] of Object.entries(lock.packages ?? {})) {
      for (const [field, value] of Object.entries(pkg)) {
        const optionalPeer =
          key === "node_modules/drizzle-orm" &&
          (field === "peerDependencies" || field === "peerDependenciesMeta");
        if (!optionalPeer && PATTERN.test(`${key} ${JSON.stringify(value)}`)) {
          offenders.push(`${key || "(root)"} ${field}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("★ the walk reaches everything the repository could commit", () => {
  it("finds a name or a mention wherever it hides, and never reads a secret", () => {
    const root = mkdtempSync(join(tmpdir(), "former-providers-"));
    try {
      const [oldDb, oldWeb] = NAMES;
      const url = `https://x.${oldDb}.example/storage/photo.png`;
      const put = (rel: string, body: string | Buffer) => {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
      };
      const utf16 = (text: string) => Buffer.from(text, "utf16le");

      // By NAME, even where nothing is read: the link folder a hosting CLI
      // writes at the root, and a compiler cache.
      put(`.${oldWeb}/project.json`, "{}");
      put(`lib/${oldWeb}.tsbuildinfo`, "{}");
      // By CONTENT: committed Claude config, a nested dot-folder, an env
      // template (file and line only), a gzip fixture, UTF-16 text with and
      // without a byte-order mark, and a PNG text chunk.
      put(".claude/launch.json", url);
      put("public/.well-known/notes.txt", url);
      put(".env.example", `MEDIA=${url}`);
      put("lib/__fixtures__/rows.json.gz", gzipSync(`[\n"${url}"\n]`));
      put(
        "docs/notes-utf16.txt",
        Buffer.concat([Buffer.from([0xff, 0xfe]), utf16(url)]),
      );
      put("docs/notes-utf16-unmarked.txt", utf16(url));
      put(
        "public/photo.png",
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
          Buffer.from(`tEXtComment\0${url}`, "latin1"),
        ]),
      );
      // A database dump below the root.
      put("scripts/copy.dump", "PGDMP\0");
      // Never read: env files, Claude Code's local state, root tooling
      // folders and dependencies.
      put(".env", url);
      put(".env.local", url);
      put(".claude/settings.local.json", url);
      put(".claude/worktrees/copy/notes.md", url);
      put(".marketing-raw/notes.md", url);
      put("node_modules/pkg/index.js", url);
      put("lib/clean.ts", "export {};\n");

      const seen: Found = { files: [], badNames: [], dumps: [] };
      walk(root, root, seen);
      const mentions = seen.files.flatMap((rel) =>
        mentionsIn(root, rel).map(([line, excerpt]) =>
          describeMention(rel, line, excerpt),
        ),
      );

      expect(seen.badNames.sort()).toEqual([
        `.${oldWeb}/`,
        `lib/${oldWeb}.tsbuildinfo`,
      ]);
      expect(seen.dumps).toEqual(["scripts/copy.dump"]);
      expect(mentions.sort()).toEqual(
        [
          `.claude/launch.json:1: ${url}`,
          ".env.example:1",
          `docs/notes-utf16.txt:1: ${url}`,
          "docs/notes-utf16-unmarked.txt: binary content",
          `lib/__fixtures__/rows.json.gz:2: "${url}"`,
          "public/photo.png: binary content",
          `public/.well-known/notes.txt:1: ${url}`,
        ].sort(),
      );
      for (const secret of [".env", ".env.local"]) {
        expect(seen.files).not.toContain(secret);
      }
      expect(seen.files).toContain("lib/clean.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
