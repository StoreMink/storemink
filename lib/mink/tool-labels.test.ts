import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MINK_TOOL_LABELS, minkToolLabel, minkToolStatus } from "./tool-labels";

/** Every `name: "..."` a tool module registers, read from source so the
 *  server-only registry never has to be imported here. */
function registeredToolNames(): string[] {
  const dir = join(process.cwd(), "lib/mink/tools");
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const source = readFileSync(join(dir, file), "utf8");
    for (const match of source.matchAll(/name: ["']([a-z_]+)["']/g)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

describe("Mink tool labels", () => {
  it("names every registered tool, so no raw tool name reaches a merchant", () => {
    const missing = registeredToolNames().filter(
      (name) => !(name in MINK_TOOL_LABELS),
    );
    expect(missing).toEqual([]);
  });

  it("reads as one sentence in each state, with the verb matching the tool's shape", () => {
    expect(minkToolStatus("get_sales_summary", "running")).toBe(
      "Reading sales…",
    );
    expect(minkToolStatus("get_sales_summary", "completed")).toBe("Read sales");
    expect(minkToolStatus("get_sales_summary", "failed")).toBe(
      "Couldn't read sales",
    );
    expect(minkToolStatus("propose_coupon_create", "running")).toBe(
      "Preparing a coupon…",
    );
    expect(minkToolStatus("start_weekly_trading_report", "completed")).toBe(
      "Queued a weekly report",
    );
    expect(minkToolStatus("generate_storefront_image", "running")).toBe(
      "Generating an image…",
    );
  });

  it("says what the storefront revamp tools are doing in the merchant's words", () => {
    expect(minkToolStatus("get_storefront_revamp_context", "running")).toBe(
      "Reading your store…",
    );
    expect(minkToolStatus("start_storefront_revamp", "running")).toBe(
      "Starting your store's redesign…",
    );
    expect(minkToolStatus("start_storefront_revamp", "completed")).toBe(
      "Started your store's redesign",
    );
    expect(minkToolStatus("refine_storefront_revamp", "running")).toBe(
      "Starting the changes…",
    );
    expect(minkToolStatus("refine_storefront_revamp", "failed")).toBe(
      "Couldn't start the changes",
    );
  });

  it("falls back to readable words for a tool it does not know", () => {
    expect(minkToolLabel("get_returns_summary")).toBe("returns summary");
    expect(minkToolStatus("list_new_thing", "running")).toBe(
      "Reading new thing…",
    );
  });

  it("never carries an em dash", () => {
    for (const entry of Object.values(MINK_TOOL_LABELS)) {
      expect(entry.label).not.toContain("—");
    }
  });
});
