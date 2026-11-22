// When a failed build is run again (22 Nov 2026). About one Google Fonts
// stylesheet in a hundred lists its files in a form of address Turbopack
// cannot read, the build asks for about 35 stylesheets, and that failed CI's
// Build job twice in a day with nothing wrong in the code. Only that failure
// is run again, with the build cache cleared so Google is asked afresh.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BUILD_ATTEMPTS,
  BUILD_RETRY_WAIT_SECONDS,
  isFontFetchFailure,
  waitBeforeAttempt,
} from "./build-font-retry.mjs";

// The Build job's own words on commit fde729a7 (run 45046270876), colour
// codes removed and the bundler's package name written as <bundler>.
const CI_FONT_FAILURE = `
> Build error occurred
Error: Turbopack build failed with 28 errors:
[next]/internal/font/google/inter_72a71224.module.css:7:8
Error: Module not found: Can't resolve '<bundler>/internal/font/google/font'
   5 |   font-weight: 400;
   6 |   font-display: swap;
>  7 |   src: url(<bundler>/internal/font/google/font?{%22url%22:%22https://fonts.gs...
     |        ^
next/font/google queries have exactly one entry

Import trace:
  Server Component:
    [next]/internal/font/google/inter_72a71224.module.css
    [next]/internal/font/google/inter_72a71224.js
    ./app/help/layout.tsx
`;

describe("isFontFetchFailure", () => {
  it("★★ recognises the failure CI really printed", () => {
    expect(isFontFetchFailure(CI_FONT_FAILURE)).toBe(true);
    // Either line alone is enough: the refusal itself, or what it is shown as.
    expect(
      isFontFetchFailure("next/font/google queries have exactly one entry"),
    ).toBe(true);
    expect(
      isFontFetchFailure(
        "Module not found: Can't resolve '<bundler>/internal/font/google/font'",
      ),
    ).toBe(true);
  });

  it("recognises a stylesheet that could not be fetched, and a named network error", () => {
    expect(
      isFontFetchFailure(
        "next/font: error:\nFailed to fetch `Inter` from Google Fonts.",
      ),
    ).toBe(true);
    expect(
      isFontFetchFailure(
        "request to https://fonts.gstatic.com/s/inter/v20/x.woff2 failed, reason: ETIMEDOUT",
      ),
    ).toBe(true);
  });

  it("★★ a real build break is NOT run again: it fails at once, as before", () => {
    for (const output of [
      "Failed to type check.\n./lib/billing/collect.ts:12:3\nType error: Property 'x' does not exist",
      "Module not found: Can't resolve '@/lib/does-not-exist'",
      "Error: Turbopack build failed with 1 errors:\n./app/page.tsx:3:1\nExport foo doesn't exist in target module",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      "",
    ]) {
      expect(isFontFetchFailure(output)).toBe(false);
    }
    expect(isFontFetchFailure(undefined as unknown as string)).toBe(false);
  });
});

describe("waitBeforeAttempt", () => {
  it("four attempts in all, a few seconds apart: a fresh answer is the cure, not time", () => {
    expect(BUILD_ATTEMPTS).toBe(4);
    expect(waitBeforeAttempt(2)).toBe(BUILD_RETRY_WAIT_SECONDS[0]);
    expect(waitBeforeAttempt(4)).toBe(BUILD_RETRY_WAIT_SECONDS[2]);
    expect(waitBeforeAttempt(5)).toBeNull();
    expect(waitBeforeAttempt(1)).toBeNull();
  });
});

describe("how the build is run", () => {
  const root = path.resolve(__dirname, "..");
  it("★ `npm run build` goes through the script that runs it again", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    expect(pkg.scripts.build).toBe("node scripts/build.mjs");
  });

  it("★★ the 4 GiB heap still travels in NODE_OPTIONS, appended to the caller's own", () => {
    // Next type-checks in a separate `tsc` process that inherits the
    // environment, not this process's flags; without it the build runs out
    // of memory (CODEBASE.md, Deploy).
    const script = readFileSync(path.join(root, "scripts/build.mjs"), "utf8");
    expect(script).toContain(
      '`--max-old-space-size=4096 ${process.env.NODE_OPTIONS ?? ""}`',
    );
    expect(script).toContain("NODE_OPTIONS:");
  });

  it("★★ the build cache is cleared BEFORE a further attempt, and the dev server's is kept", () => {
    // Run again as it was, the build read Google's same answer back from the
    // bundler's cache and failed in two seconds (CI, commit 7aeb56cd).
    const script = readFileSync(path.join(root, "scripts/build.mjs"), "utf8");
    const cleared = script.indexOf("await clearBuildCache();");
    expect(cleared).toBeGreaterThan(-1);
    expect(cleared).toBeLessThan(script.indexOf("await sleep(wait);"));
    expect(script).toContain('entry !== "dev"');
  });
});
