import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MINK_ACTION_TOOLS } from "./product-action-types";

/** Keep the application vocabulary, DB allowlist and automatic provisioning
 * aligned: a missing provisioned tool silently refuses proposals in new stores. */
const SQL_DIR = join(process.cwd(), "drizzle", "migrations", "sql");
const CONSTRAINT = "mink_action_tool_access_name_check";

function latestAllowlist(): string[] {
  const files = readdirSync(SQL_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  let latest: string[] | null = null;
  for (const name of files) {
    const sql = readFileSync(join(SQL_DIR, name), "utf8");
    const at = sql.lastIndexOf(`ADD CONSTRAINT ${CONSTRAINT}`);
    if (at === -1) continue;
    const open = sql.indexOf("ARRAY[", at);
    const close = sql.indexOf("]", open);
    if (open === -1 || close === -1) continue;
    latest = [...sql.slice(open, close).matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1],
    );
  }
  if (!latest) throw new Error(`No migration defines ${CONSTRAINT}`);
  return latest;
}

describe("Mink action-tool registry", () => {
  it("matches the database's own tool allowlist exactly", () => {
    // Unknown names fail at approval time; missing names deny store access.
    expect([...MINK_ACTION_TOOLS].sort()).toEqual(latestAllowlist().sort());
  });
  it("provisions every registered tool for existing and new stores", () => {
    const files = readdirSync(SQL_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const sql = files
      .map((name) => readFileSync(join(SQL_DIR, name), "utf8"))
      .filter((text) =>
        /CREATE (?:OR REPLACE )?FUNCTION public.enable_store_mink_access/.test(
          text,
        ),
      )
      .at(-1);
    expect(sql).toBeDefined();
    const array = sql!.match(
      /FROM unnest\(ARRAY\[([\s\S]*?)\]::text\[\]\)/,
    )![1];
    const tools = [...array.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect(tools.sort()).toEqual([...MINK_ACTION_TOOLS].sort());
  });
});
