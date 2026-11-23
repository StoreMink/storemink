#!/usr/bin/env node
/**
 * Theme Studio's schedulers, for localhost.
 *
 *   npm run theme-studio:local
 *
 * WHY. With a real model provider (`THEME_STUDIO_PROVIDER=vertex-gemini`) a
 * theme is not built inside the click that asked for it. In production three
 * things outside the web app move it along: a Cloud Scheduler job calls the
 * worker route every minute (the build and the photographs), another calls
 * the design-review route, and a Cloud Run job opens the theme in a browser
 * for its checks. None of them exists on a laptop, so a real theme started on
 * localhost just waits at "queued".
 *
 * This is all three, in one terminal, against the dev server you already
 * have running. Leave it open while a theme is being built and stop it with
 * Ctrl+C. Stopping it does not cancel a theme: the work waits, and continues
 * when this is started again.
 *
 *   --origin=http://localhost:3000   the dev server (the default)
 *   --no-checks                      do not open themes in a browser
 *   --skip-auth-check                do not test the Google sign-in first
 *
 * ★ IT SPENDS REAL MONEY ONLY WHEN A THEME IS WAITING. It starts nothing by
 *   itself: a theme is started from the Studio page. Idle, it makes three
 *   local requests every half minute and no call to any provider.
 * ★ The secret it sends (CRON_SECRET, read from .env) goes only to the
 *   origin given, which must be this machine.
 * Docs: docs/theme-studio-local.md.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name) => process.argv.includes(`--${name}`);

const origin = new URL(arg("origin") ?? "http://localhost:3000");
const secret = process.env.CRON_SECRET?.trim();
const IDLE_MS = 30_000;
const BUSY_MS = 5_000;

const stamp = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
const say = (text) => console.log(`${stamp()}  ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  say(
    "Stopping. A step already running finishes inside the dev server; nothing is cancelled. Press Ctrl+C again to leave now.",
  );
});

/**
 * One request to the dev server. node:http, not fetch: a build step answers
 * only when it has finished, which can be nineteen minutes, and fetch gives
 * up waiting for headers after five.
 */
function call(path, { method = "POST", auth = true } = {}) {
  return new Promise((resolve) => {
    const request = (origin.protocol === "https:" ? https : http).request(
      new URL(path, origin),
      {
        method,
        headers: {
          ...(auth ? { authorization: `Bearer ${secret}` } : {}),
          "content-type": "application/json",
          "content-length": 0,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // Not JSON: the status is the answer.
          }
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.on("error", (error) =>
      resolve({ status: 0, body: null, error: error.code ?? error.message }),
    );
    request.end();
  });
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

async function preflight() {
  const problems = [];
  if (
    !LOCAL_HOSTS.has(origin.hostname) &&
    !origin.hostname.endsWith(".localhost")
  )
    problems.push(
      `--origin must be this machine (localhost), not ${origin.hostname}: this sends the job secret to it.`,
    );
  if (!secret) problems.push("CRON_SECRET is not set in .env or .env.local.");
  const provider = (process.env.THEME_STUDIO_PROVIDER ?? "fake").trim();
  if (provider !== "vertex-gemini")
    problems.push(
      `THEME_STUDIO_PROVIDER is "${provider}", the offline practice mode, which needs no runner. Set THEME_STUDIO_PROVIDER=vertex-gemini in .env.local and restart the dev server to build real themes.`,
    );
  if (!(process.env.THEME_STUDIO_GCP_PROJECT_ID ?? process.env.GCP_PROJECT_ID))
    problems.push("GCP_PROJECT_ID is not set: the model has no project.");
  if (problems.length) return problems;

  // The worker route answers 401 to a request without the secret: that is
  // the dev server saying it is there.
  const probe = await call("/api/internal/theme-studio/runs", {
    method: "GET",
    auth: false,
  });
  if (probe.status !== 401)
    problems.push(
      probe.status === 0
        ? `Nothing is answering at ${origin.origin} (${probe.error}). Start the app first: npm run build && npm run start`
        : `${origin.origin} answered ${probe.status} where a StoreMink dev server answers 401. Is another app on that port?`,
    );

  if (!flag("skip-auth-check")) {
    try {
      const { GoogleAuth } = await import("google-auth-library");
      const token = await Promise.race([
        new GoogleAuth({
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        }).getAccessToken(),
        sleep(20_000).then(() => {
          throw new Error("timed out");
        }),
      ]);
      if (!token) throw new Error("no token");
    } catch {
      problems.push(
        "Google sign-in on this machine has expired or is missing, so the model and the image storage would refuse every call. Run this once, then start again:\n      gcloud auth application-default login",
      );
    }
  }
  return problems;
}

/** The build and photograph steps: one long request after another. */
async function builds() {
  let idle = false;
  while (!stopping) {
    const { status, body, error } = await call(
      "/api/internal/theme-studio/runs",
    );
    if (status === 200 && body?.ok) {
      const worked = body.claimed > 0 || body.reaped > 0;
      if (worked) {
        idle = false;
        say(
          `build: ${body.claimed} step(s) worked on. Finished ${body.succeeded}, failed ${body.failed}, waiting to continue ${body.requeued}, stopped ${body.cancelled}.`,
        );
      } else if (!idle) {
        idle = true;
        say("build: nothing waiting. Start or change a theme in the Studio.");
      }
      await sleep(worked ? BUSY_MS : IDLE_MS);
    } else {
      idle = false;
      say(
        status === 0
          ? `build: the dev server did not answer (${error}). If it restarted, the step continues on the next try.`
          : `build: the worker route answered ${status}. See the dev server's own log.`,
      );
      await sleep(IDLE_MS);
    }
  }
}

/** The design review, on its own clock so a long build never holds it. */
async function reviews() {
  while (!stopping) {
    const { status, body } = await call("/api/internal/theme-studio/qa");
    const worked =
      status === 200 &&
      Array.isArray(body?.lanes) &&
      body.lanes.some((lane) => lane && lane.claimed > 0);
    if (worked) say("review: a design review ran.");
    await sleep(worked ? BUSY_MS : IDLE_MS);
  }
}

/** The browser checks: the capture job, run whenever one may be waiting. */
function captureOnce() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["jobs/theme-studio-capture/capture-job.mjs"],
      {
        env: {
          ...process.env,
          APP_ORIGIN: origin.origin,
          CRON_SECRET: secret,
          // The machine's own Chrome: no browser download.
          CAPTURE_CHROME_CHANNEL:
            process.env.CAPTURE_CHROME_CHANNEL ?? "chrome",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => resolve({ count: 0, error: error.message }));
    child.on("close", (code) => {
      const last = out.trim().split("\n").pop() ?? "";
      let count = 0;
      try {
        count = JSON.parse(last).captures?.length ?? 0;
      } catch {
        // No result line: the exit code says the rest.
      }
      resolve({
        count,
        error: code ? err.trim().split("\n").slice(-2).join(" ") : null,
      });
    });
  });
}

async function checks() {
  while (!stopping) {
    const { count, error } = await captureOnce();
    if (error) say(`checks: the browser run failed: ${error.slice(0, 300)}`);
    else if (count) say(`checks: ${count} design(s) opened and measured.`);
    await sleep(count ? BUSY_MS : IDLE_MS);
  }
}

const problems = await preflight();
if (problems.length) {
  console.error("Theme Studio's local runner cannot start:\n");
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

say(`Theme Studio local runner, driving ${origin.origin}.`);
say(
  "A theme you start in the Studio now uses the real models and is charged for. Leave this open until it is ready; Ctrl+C to stop.",
);
// ★ First, alone: the review route fails any check left waiting from an
//   earlier session (queued over 15 minutes; capture.ts
//   sweepStaleThemeStudioCaptures). Without this the browser loop below
//   could claim such a leftover first, and its design review would then be
//   a paid model call for a theme nobody asked to check today.
await call("/api/internal/theme-studio/qa");
await Promise.all([
  builds(),
  reviews(),
  ...(flag("no-checks") ? [] : [checks()]),
]);
