// cloudbuild.yaml's Theme Studio rules (Theme Studio plan P3 and P4, and the
// owner's spend cap of 24 Oct 2026), checked by running the steps' own bash
// after Cloud Build's substitution. Nothing here can reach Google: every
// `gcloud` in a step becomes a shell function that only records its
// arguments, and the steps run with PATH limited to /usr/bin and /bin.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

import { getMinkConfig } from "@/lib/mink/config";
import { currentAcceptanceBuildId } from "@/lib/theme-studio/acceptance";
import { getThemeStudioConfig } from "@/lib/theme-studio/config";
import { getThemeStudioImageConfig } from "@/lib/theme-studio/image-models";

const ROOT = path.resolve(__dirname, "..");
const LINES = readFileSync(path.join(ROOT, "cloudbuild.yaml"), "utf8").split(
  "\n",
);

// Cloud Build's own substitutions. Any other `$NAME` in a step fails the
// whole build before it starts, which is why bash variables are `$$NAME`.
const BUILT_INS = [
  "PROJECT_ID",
  "PROJECT_NUMBER",
  "LOCATION",
  "BUILD_ID",
  "TRIGGER_NAME",
  "TRIGGER_BUILD_CONFIG_PATH",
  "COMMIT_SHA",
  "SHORT_SHA",
  "REVISION_ID",
  "REPO_NAME",
  "REPO_FULL_NAME",
  "BRANCH_NAME",
  "TAG_NAME",
  "REF_NAME",
  "SERVICE_ACCOUNT_EMAIL",
  "SERVICE_ACCOUNT",
];
const SHA = "4f2c9e1d0b7a6c5e8f9d0a1b2c3d4e5f6a7b8c9d";
const DIGEST = `asia-south1-docker.pkg.dev/storemink-prod/storemink/theme-studio-capture@sha256:${"a".repeat(64)}`;

/** The `substitutions:` defaults, quotes removed. */
function substitutionDefaults(): Map<string, string> {
  const defaults = new Map<string, string>();
  for (const line of LINES.slice(LINES.indexOf("substitutions:") + 1)) {
    if (/^[^\s#]/.test(line)) break;
    const match = /^ {2}(_[A-Z0-9_]+): ?(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2].trim();
    defaults.set(
      match[1],
      raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw,
    );
  }
  return defaults;
}

/** Step ids, in the order Cloud Build runs them. */
function stepIds(): string[] {
  return LINES.flatMap((line) => {
    const match = /^ {2}- id: ([a-z-]+)$/.exec(line);
    return match ? [match[1]] : [];
  });
}

/** One step's lines, up to the next step or top-level key. */
function stepLines(id: string): string[] {
  const start = LINES.indexOf(`  - id: ${id}`);
  expect(start, `step ${id}`).toBeGreaterThan(-1);
  const lines: string[] = [];
  for (const line of LINES.slice(start + 1)) {
    if (/^ {2}- id: /.test(line) || /^[^\s#]/.test(line)) break;
    lines.push(line);
  }
  return lines;
}

/** One step's bash: its `- |` block, dedented. */
function stepScript(id: string): string {
  const lines = stepLines(id);
  const start = lines.indexOf("      - |");
  expect(start, `script of ${id}`).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") body.push("");
    else if (line.startsWith("        ")) body.push(line.slice(8));
    else break;
  }
  return body.join("\n");
}

/** What Cloud Build does before bash runs: `$$` becomes `$`, and every
 *  `$NAME` or `${NAME}` becomes its value. An unknown name throws, as Cloud
 *  Build refuses the build. */
function substitute(text: string, values: Record<string, string>): string {
  return text.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced?: string, bare?: string) => {
      if (match === "$$") return "$";
      const name = (braced ?? bare) as string;
      if (!(name in values)) {
        throw new Error(`Cloud Build would refuse the substitution ${name}`);
      }
      return values[name];
    },
  );
}

/** Built-ins empty (a manual build), the file's defaults, then overrides. */
function values(overrides: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(BUILT_INS.map((name) => [name, ""])),
    ...Object.fromEntries(substitutionDefaults()),
    ...overrides,
  };
}

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

/** Runs one step with a recording stand-in for gcloud. `files` are written
 *  to the step's /workspace first. */
function runStep(
  id: string,
  substitutions: Record<string, string>,
  files: Record<string, string> = {},
): { stdout: string; calls: string[] } {
  const workspace = mkdtempSync(path.join(tmpdir(), "cloudbuild-step-"));
  workspaces.push(workspace);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(workspace, name), content);
  }
  const record = path.join(workspace, "gcloud-calls");
  writeFileSync(record, "");
  const script = substitute(stepScript(id), substitutions)
    .replaceAll("/workspace", workspace)
    .replace(/\bgcloud\b/g, "recorded_gcloud");
  const stdout = execFileSync(
    "/bin/bash",
    [
      "-c",
      `recorded_gcloud() { printf '%s\\n' "$*" >> '${record}'; }\n${script}`,
    ],
    {
      cwd: ROOT,
      // Only PATH, limited to where gcloud is not installed (and the NODE_ENV
      // Node's types require; no step reads it).
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    },
  );
  return {
    stdout,
    calls: readFileSync(record, "utf8").split("\n").filter(Boolean),
  };
}

/** The runtime environment a recorded `gcloud run deploy` sets. */
function deployedEnv(calls: string[]): Map<string, string> {
  const deploy = calls.filter((call) => call.startsWith("run deploy "));
  expect(deploy).toHaveLength(1);
  const list = /--set-env-vars=(\S+)/.exec(deploy[0])?.[1] ?? "";
  return new Map(
    list.split(",").map((entry) => {
      const at = entry.indexOf("=");
      return [entry.slice(0, at), entry.slice(at + 1)] as [string, string];
    }),
  );
}

describe("cloudbuild.yaml, Theme Studio", () => {
  it("★ updates the capture job after the web deploy and before the private workers (P4)", () => {
    const ids = stepIds();
    const web = ids.indexOf("deploy");
    const capture = ids.indexOf("capture-deploy");
    const workers = ids.indexOf("theme-workers-deploy");
    expect(web).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(web);
    expect(workers).toBeGreaterThan(capture);
    // No waitFor, so each waits for every step before it.
    for (const id of ["deploy", "capture-deploy", "theme-workers-deploy"]) {
      expect(stepLines(id).some((line) => /^\s+waitFor:/.test(line))).toBe(
        false,
      );
    }
  });

  // The production build of 23 Nov 2026 failed at this step with "python3:
  // command not found", after the web deploy: the Cloud SDK image's tag
  // floats, and it no longer had a python3 on PATH.
  describe("★★ the worker deploy finds a Python whatever the Cloud SDK image has on PATH", () => {
    /** Run the real step with only its own bin folder on PATH and a gcloud
     *  that names `sdk-python` as the Python it runs on. Returns what ran. */
    function deployWorkers(withPython3OnPath: boolean): string {
      const workspace = mkdtempSync(path.join(tmpdir(), "cloudbuild-step-"));
      workspaces.push(workspace);
      const binDir = path.join(workspace, "bin");
      mkdirSync(binDir);
      const record = path.join(workspace, "ran");
      const fake = (name: string) => {
        const file = path.join(workspace, name);
        writeFileSync(
          file,
          ["#!/bin/sh", `echo "${name} $*" >> "${record}"`, ""].join("\n"),
        );
        chmodSync(file, 0o755);
        return file;
      };
      const sdkPython = fake("sdk-python");
      if (withPython3OnPath) {
        symlinkSync(fake("path-python"), path.join(binDir, "python3"));
      }
      const script = substitute(
        stepScript("theme-workers-deploy"),
        values({ _SERVICE: "storemink-web-prod" }),
      )
        .replaceAll("/workspace", workspace)
        .replace(/\bgcloud\b/g, "fake_gcloud");
      const gcloud = `fake_gcloud() { if [ "$1" = info ]; then echo "${sdkPython}"; fi; }`;
      execFileSync("/bin/bash", ["-c", `${gcloud}\n${script}`], {
        cwd: ROOT,
        env: { NODE_ENV: "test", PATH: binDir },
        encoding: "utf8",
      });
      return readFileSync(record, "utf8").trim();
    }

    it("no python3 on PATH: it uses the Python gcloud itself runs on", () => {
      expect(deployWorkers(false)).toMatch(
        /^sdk-python scripts\/theme-studio-workers\.py --deploy --web=storemink-web-prod --project=\S+ --region=\S+$/,
      );
    });

    it("a python3 on PATH is still the one used", () => {
      expect(deployWorkers(true)).toMatch(
        /^path-python scripts\/theme-studio-workers\.py --deploy /,
      );
    });

    it("the step never calls a bare python3 again", () => {
      const script = stepScript("theme-workers-deploy");
      expect(script).not.toMatch(/^\s*python3 /m);
      expect(script).toContain("basic.python_location");
    });
  });

  it("★ updates no capture job outside production (P4: nothing Theme Studio runs on dev)", () => {
    for (const service of ["storemink-web-dev", "storemink-web"]) {
      const run = runStep("capture-deploy", values({ _SERVICE: service }), {
        "capture-image": DIGEST,
      });
      expect(run.calls).toEqual([]);
      expect(run.stdout).toContain(
        `No Theme Studio capture job for ${service}`,
      );
    }
    const prod = runStep(
      "capture-deploy",
      values({ _SERVICE: "storemink-web-prod" }),
      { "capture-image": DIGEST },
    );
    expect(prod.calls).toEqual([
      `run jobs update storemink-theme-studio-capture --image=${DIGEST} --region=asia-south1`,
    ]);
    // A superseded build changes nothing.
    const superseded = runStep(
      "capture-deploy",
      values({ _SERVICE: "storemink-web-prod" }),
      { "capture-image": DIGEST, superseded: "" },
    );
    expect(superseded.calls).toEqual([]);
  });

  it("★ binds Theme Studio's build to the commit, and to the revision on a manual build (P3)", () => {
    const triggered = runStep(
      "deploy",
      values({ _SERVICE: "storemink-web-prod", COMMIT_SHA: SHA }),
    );
    expect(deployedEnv(triggered.calls).get("THEME_STUDIO_BUILD_ID")).toBe(SHA);
    expect(triggered.stdout).toContain(
      `Theme Studio checks are bound to commit ${SHA}.`,
    );

    // A manual `gcloud builds submit` has no commit, so the value is empty...
    const manual = runStep(
      "deploy",
      values({ _SERVICE: "storemink-web-prod", COMMIT_SHA: "" }),
    );
    const empty = deployedEnv(manual.calls).get("THEME_STUDIO_BUILD_ID");
    expect(empty).toBe("");
    expect(manual.stdout).toContain("No commit (a manual build)");

    // ...which the app reads as "use the Cloud Run revision".
    vi.stubEnv("K_REVISION", "storemink-web-prod-00160-abc");
    vi.stubEnv("THEME_STUDIO_BUILD_ID", empty);
    expect(currentAcceptanceBuildId()).toBe("storemink-web-prod-00160-abc");
    vi.stubEnv("THEME_STUDIO_BUILD_ID", SHA);
    expect(currentAcceptanceBuildId()).toBe(SHA);
  });

  it("★ caps estimated Theme Studio spend at 50 dollars per operator a day (owner, 24 Oct 2026)", () => {
    expect(substitutionDefaults().get("_THEME_STUDIO_DAILY_SPEND_USD")).toBe(
      "50",
    );
    const run = runStep(
      "deploy",
      values({ _SERVICE: "storemink-web-prod", COMMIT_SHA: SHA }),
    );
    const cap = deployedEnv(run.calls).get("THEME_STUDIO_DAILY_SPEND_USD");
    expect(cap).toBe("50");
    expect(
      getThemeStudioConfig({ THEME_STUDIO_DAILY_SPEND_USD: cap })
        .dailySpendMicroUsd,
    ).toBe(50_000_000);
  });

  // 22 Nov 2026: ElevenLabs draws Theme Studio and redesign photos only when
  // an operator chooses it AND its key is here, so a deploy with no key
  // changes nothing.
  it("★ passes ElevenLabs' image key as a plain substitution that is empty by default", () => {
    expect(substitutionDefaults().get("_ELEVENLABS_API_KEY")).toBe("");
    const run = runStep(
      "deploy",
      values({
        _SERVICE: "storemink-web-prod",
        COMMIT_SHA: SHA,
        _ELEVENLABS_API_KEY: "sk_test_value",
      }),
    );
    expect(deployedEnv(run.calls).get("ELEVENLABS_API_KEY")).toBe(
      "sk_test_value",
    );
  });

  // PR #303 re-review, 22 Nov 2026: looking for a lost job in the provider's
  // list is safe only where no other environment uses the key, so it is off
  // unless a trigger says so.
  it("★★ the ElevenLabs key is taken as SHARED unless a trigger declares it exclusive", () => {
    expect(substitutionDefaults().get("_ELEVENLABS_KEY_EXCLUSIVE")).toBe("");
    const base = { _SERVICE: "storemink-web-prod", COMMIT_SHA: SHA };
    expect(
      deployedEnv(runStep("deploy", values(base)).calls).get(
        "ELEVENLABS_KEY_EXCLUSIVE",
      ),
    ).toBe("");
    expect(
      deployedEnv(
        runStep(
          "deploy",
          values({ ...base, _ELEVENLABS_KEY_EXCLUSIVE: "true" }),
        ).calls,
      ).get("ELEVENLABS_KEY_EXCLUSIVE"),
    ).toBe("true");
  });

  it("★★ draws every picture with Nano Banana 2.1, and switching back is a trigger substitution and a deploy (owner, 25 Oct 2026)", () => {
    const defaults = substitutionDefaults();
    expect(defaults.get("_THEME_STUDIO_IMAGE_MODEL")).toBe(
      "gemini-nano-banana-2.1",
    );
    expect(defaults.get("_MINK_IMAGE_MODEL")).toBe("gemini-nano-banana-2.1");
    const run = runStep(
      "deploy",
      values({ _SERVICE: "storemink-web-prod", COMMIT_SHA: SHA }),
    );
    const env = deployedEnv(run.calls);
    expect(env.get("THEME_STUDIO_IMAGE_MODEL")).toBe("gemini-nano-banana-2.1");
    expect(env.get("MINK_IMAGE_MODEL")).toBe("gemini-nano-banana-2.1");
    // The app reads the deployed values as the one model.
    expect(
      getThemeStudioImageConfig({
        GCP_PROJECT_ID: "storemink-prod",
        THEME_STUDIO_IMAGE_MODEL: env.get("THEME_STUDIO_IMAGE_MODEL"),
      }),
    ).toMatchObject({
      modelKey: "gemini-nano-banana-2.1",
      providerModel: "gemini-nano-banana-2.1",
      location: "global",
    });
    vi.stubEnv("MINK_IMAGE_MODEL", env.get("MINK_IMAGE_MODEL") ?? "");
    expect(getMinkConfig().imageModel).toBe("gemini-nano-banana-2.1");

    // ★ The owner's rollback: the trigger's substitutions, then a deploy.
    const rollback = deployedEnv(
      runStep(
        "deploy",
        values({
          _SERVICE: "storemink-web-prod",
          COMMIT_SHA: SHA,
          _THEME_STUDIO_IMAGE_MODEL: "gemini-3-pro-image",
          _MINK_IMAGE_MODEL: "gemini-3.1-flash-image",
        }),
      ).calls,
    );
    expect(
      getThemeStudioImageConfig({
        GCP_PROJECT_ID: "storemink-prod",
        THEME_STUDIO_IMAGE_MODEL: rollback.get("THEME_STUDIO_IMAGE_MODEL"),
      })?.modelKey,
    ).toBe("gemini-3-pro-image");
    vi.stubEnv("MINK_IMAGE_MODEL", rollback.get("MINK_IMAGE_MODEL") ?? "");
    expect(getMinkConfig().imageModel).toBe("gemini-3.1-flash-image");
  });

  it("names no substitution Cloud Build does not know, in any step", () => {
    const known = new Set([...BUILT_INS, ...substitutionDefaults().keys()]);
    const unknown = new Set<string>();
    for (const id of stepIds()) {
      const text = stepLines(id).join("\n").replaceAll("$$", "");
      for (const match of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (!known.has(match[1])) unknown.add(match[1]);
      }
    }
    expect([...unknown]).toEqual([]);
  });
});
