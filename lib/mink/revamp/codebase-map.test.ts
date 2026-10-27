import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MINK_TOOL_GROUPS } from "@/lib/mink/tool-routing";

// ★ CODEBASE.md IS THE MAP EVERY ENGINEER AND AGENT READS FIRST (AGENTS.md),
//   and a module, table, route or variable it does not name is one nobody
//   finds. The storefront revamp shipped with no word in it, while the map
//   still described the personalisation routing it replaced as current, so
//   these checks keep the two in step from now on: a new revamp module, or a
//   routing group the map names that the router no longer has, fails here.

const ROOT = process.cwd();
const MAP = readFileSync(path.join(ROOT, "CODEBASE.md"), "utf8");
const REVAMP_DIR = path.join(ROOT, "lib/mink/revamp");

/** The text from a heading to the next heading of the same or higher level. */
function sectionFrom(heading: string): string {
  const start = MAP.indexOf(heading);
  if (start < 0) return "";
  const level = heading.match(/^#+/)?.[0] ?? "###";
  const rest = MAP.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{2,${level.length}} `));
  return MAP.slice(start, next < 0 ? undefined : start + heading.length + next);
}

const revamp = () => sectionFrom("### Mink storefront revamp");
const environments = () => sectionFrom("## 7. Environments");

/** The revamp's own modules, tests left out. */
function revampModules(): string[] {
  return readdirSync(REVAMP_DIR)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .sort();
}

/** A file name standing on its own: `card.ts`, never `mink-revamp-card.tsx`. */
function names(text: string, file: string): boolean {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`).test(text);
}

describe("CODEBASE.md describes the storefront revamp", () => {
  it("has a section of its own", () => {
    expect(revamp()).not.toBe("");
  });

  it("names every module under lib/mink/revamp", () => {
    const section = revamp();
    const missing = revampModules().filter((file) => !names(section, file));
    expect(missing).toEqual([]);
  });

  it("names its tables, routes, migrations, tools, card and event", () => {
    const section = revamp();
    const required = [
      "mink_revamps",
      "mink_revamp_images",
      "mink_revamps_ready_check",
      "mink_revamps_one_active_idx",
      "/api/mink/revamps/[revampId]",
      "/api/internal/mink/revamps/run",
      "/api/cron/mink-workflows",
      "/api/mink/drafts/[draftId]/personalization-action",
      "20261021_0234_mink_storefront_revamp",
      "20261021_0235_mink_storefront_revamp_help",
      "lib/mink/tools/storefront-revamp-tools.ts",
      "app/dashboard/mink-revamp-card.tsx",
      "app/dashboard/mink-revamp-preview.tsx",
      "docs/mink-storefront-revamp.md",
      "mink.revamp_ready",
      "MINK_REVAMP_LOCAL_TEST",
    ];
    expect(required.filter((text) => !section.includes(text))).toEqual([]);
  });

  it("lists every MINK_REVAMP_ variable the revamp code reads in section 7", () => {
    const read = new Set<string>();
    for (const file of revampModules()) {
      const source = readFileSync(path.join(REVAMP_DIR, file), "utf8");
      for (const match of source.matchAll(/\bMINK_REVAMP_[A-Z_]+\b/g)) {
        read.add(match[0]);
      }
    }
    expect([...read].length).toBeGreaterThan(0);
    const section = environments();
    expect([...read].filter((name) => !section.includes(name))).toEqual([]);
  });

  // ★ The map said routing used the `personalize` group long after the router
  //   replaced it with `revamp`, so a reader looked for a group that is gone.
  it("names only routing groups the router still has", () => {
    const named = [
      ...MAP.matchAll(/`([a-z_]+)` group \(`lib\/mink\/tool-routing\.ts`/g),
    ].map((match) => match[1]);
    const groups: readonly string[] = MINK_TOOL_GROUPS;
    expect(named.filter((group) => !groups.includes(group))).toEqual([]);
  });
});
