// The Theme Studio model probe builds its Vertex host from the kind of
// location (the rule of vertexHost in lib/ai/gemini.ts, written out in the
// .mjs script). Its dry run prints the host and makes no request, so the rule
// is checked by running the script itself.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "theme-studio-model-check.mjs");

function dryRunHosts(location: string): string[] {
  const out = execFileSync(process.execPath, [SCRIPT, "--dry-run", "--json"], {
    cwd: path.resolve(__dirname, ".."),
    // Only what the script reads (and the NODE_ENV Node's types require; the
    // script never reads it): no model overrides, no credentials.
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "",
      THEME_STUDIO_VERTEX_LOCATION: location,
    },
    encoding: "utf8",
  });
  const rows = JSON.parse(out) as Array<{ location: string; host: string }>;
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.location === location)).toBe(true);
  return [...new Set(rows.map((row) => row.host))];
}

describe("theme-studio-model-check.mjs", () => {
  it("★ keeps global on aiplatform.googleapis.com and prefixes a region", () => {
    expect(dryRunHosts("global")).toEqual(["aiplatform.googleapis.com"]);
    expect(dryRunHosts("asia-south1")).toEqual([
      "asia-south1-aiplatform.googleapis.com",
    ]);
  });

  it("★ sends a multi-region to its regional-endpoint host, never `us-aiplatform`", () => {
    expect(dryRunHosts("us")).toEqual(["aiplatform.us.rep.googleapis.com"]);
    expect(dryRunHosts("eu")).toEqual(["aiplatform.eu.rep.googleapis.com"]);
  });
});
