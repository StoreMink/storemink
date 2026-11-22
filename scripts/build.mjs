// `npm run build`: `next build`, run again when (and only when) it failed
// because of a Google font, with the build cache cleared first so Google is
// really asked again. The rule and the reason are in
// scripts/build-font-retry.mjs.
//
// ★ THE HEAP LIMIT TRAVELS IN `NODE_OPTIONS`, as it did when this was a
//   one-line script: Next type-checks by spawning `tsc` as a separate process
//   that inherits the ENVIRONMENT, never this process's command-line flags,
//   and the full project needs 4 GiB (CODEBASE.md, Deploy). Whatever
//   `NODE_OPTIONS` the caller set is kept and appended.
// ★ Extra arguments go to `next build` unchanged (`npm run build -- --debug`).
// ★ The build's output is passed through as it arrives, and its exit code is
//   this script's exit code.

import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_ATTEMPTS,
  isFontFetchFailure,
  waitBeforeAttempt,
} from "./build-font-retry.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const nextBin = path.join(
  projectRoot,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);

/** The most output kept for reading afterwards; a font failure prints near
 *  the end, and a build can print a great deal before it. */
const KEPT_OUTPUT_CHARS = 400_000;

function runBuild() {
  return new Promise((resolve) => {
    let kept = "";
    const keep = (chunk) => {
      kept = (kept + chunk).slice(-KEPT_OUTPUT_CHARS);
    };
    const child = spawn(
      process.execPath,
      [nextBin, "build", ...process.argv.slice(2)],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          NODE_OPTIONS:
            `--max-old-space-size=4096 ${process.env.NODE_OPTIONS ?? ""}`.trim(),
        },
        stdio: ["inherit", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      keep(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      keep(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      console.error(`Could not start the build: ${error.message}`);
      resolve({ code: 1, output: kept });
    });
    child.on("close", (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), output: kept });
    });
  });
}

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Remove what the failed build left in `.next`, so the next attempt asks
 * Google for every stylesheet again instead of reading the same answer back
 * from the bundler's cache (which is what made an unchanged retry fail in
 * two seconds). `.next/dev` is the dev server's own and is left alone.
 */
async function clearBuildCache() {
  const dir = path.join(projectRoot, ".next");
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry !== "dev")
      .map((entry) =>
        rm(path.join(dir, entry), { recursive: true, force: true }),
      ),
  );
}

for (let attempt = 1; ; attempt += 1) {
  const result = await runBuild();
  if (result.code === 0) process.exit(0);
  const wait = waitBeforeAttempt(attempt + 1);
  if (wait === null || !isFontFetchFailure(result.output)) {
    process.exit(result.code);
  }
  console.error(
    `\nGoogle Fonts answered with font addresses this build cannot read (attempt ${attempt} of ${BUILD_ATTEMPTS}). ` +
      `It does so about once in a hundred requests; it is not a fault in the code. ` +
      `Clearing the build cache and building again in ${wait} seconds.\n`,
  );
  await clearBuildCache();
  await sleep(wait);
}
