import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PROJECT_ENV_KEYS,
  authDomainsProject,
  commitRefusal,
  environmentMismatch,
  expectedAuthHosts,
  isLocalRoot,
  parseAuthorizedDomainsResponse,
  parseSyncArgs,
  runSyncAuthHosts,
  type SyncAuthHostsDeps,
} from "./sync-auth-hosts-core";

const ROOT = "storemink.com";
// One consistent environment: the new pairing check refuses a crossed one.
const PROJECT = "storemink-prod";

const STORES = [
  { slug: "echoss", custom_domain: null, settings: {} },
  {
    slug: "wholesip",
    custom_domain: "wholesip.com",
    settings: { custom_domain_verified: true },
  },
  {
    slug: "pending",
    custom_domain: "pending.com",
    settings: { custom_domain_verified: false },
  },
  { slug: "demo-vitrine", custom_domain: null, settings: { demo: true } },
];

const EXPECTED = [
  "echoss.storemink.com",
  "wholesip.storemink.com",
  "wholesip.com",
  "www.wholesip.com",
  "pending.storemink.com",
];

// Already listed: the root, one store host (in another case) and Firebase's own.
const LISTED = ["localhost", "storemink.com", "ECHOSS.storemink.com"];

function harness(overrides: Partial<SyncAuthHostsDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: SyncAuthHostsDeps = {
    env: { FIREBASE_PROJECT_ID: PROJECT, DB_NAME: "storemink" },
    rootDomain: ROOT,
    readStores: vi.fn(async () => STORES),
    readAuthorizedDomains: vi.fn(async () => ({
      ok: true as const,
      domains: LISTED,
    })),
    ensureAuthorizedHosts: vi.fn(async (hosts: string[]) => ({
      added: hosts.filter((h) => h !== "echoss.storemink.com"),
    })),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...overrides,
  };
  return {
    deps,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

describe("parseSyncArgs", () => {
  it("defaults to a dry run", () => {
    expect(parseSyncArgs([])).toEqual({
      commit: false,
      confirmProject: null,
      help: false,
    });
  });

  it("reads --commit and the project in both spellings", () => {
    expect(
      parseSyncArgs(["--commit", "--confirm-project", "storemink-prod"]),
    ).toEqual({ commit: true, confirmProject: "storemink-prod", help: false });
    expect(parseSyncArgs(["--confirm-project=storemink-prod"])).toMatchObject({
      confirmProject: "storemink-prod",
    });
    expect(parseSyncArgs(["-h"])).toMatchObject({ help: true });
  });

  it("★ refuses an unknown or mistyped flag rather than ignoring it", () => {
    expect(parseSyncArgs(["--comit"])).toEqual({
      error: "Unknown argument: --comit",
    });
    expect(parseSyncArgs(["storemink-prod"])).toHaveProperty("error");
  });

  it("refuses --confirm-project with no value", () => {
    expect(parseSyncArgs(["--confirm-project"])).toHaveProperty("error");
    expect(parseSyncArgs(["--confirm-project", "--commit"])).toHaveProperty(
      "error",
    );
    expect(parseSyncArgs(["--confirm-project="])).toHaveProperty("error");
  });
});

describe("authDomainsProject", () => {
  it("takes the first set key, in the core's order", () => {
    expect(
      authDomainsProject({
        FIREBASE_PROJECT_ID: "a",
        DOMAIN_GCP_PROJECT_ID: "b",
        GCP_PROJECT_ID: "c",
      }),
    ).toBe("a");
    expect(
      authDomainsProject({ DOMAIN_GCP_PROJECT_ID: "b", GCP_PROJECT_ID: "c" }),
    ).toBe("b");
    expect(authDomainsProject({ GCP_PROJECT_ID: "c" })).toBe("c");
    expect(authDomainsProject({})).toBe("");
  });

  it("★ mirrors projectId() in lib/auth/authorized-domains.ts exactly", () => {
    // The confirmation vouches for THIS project while the write goes wherever
    // that function points; if they drift, --confirm-project checks the wrong one.
    const source = readFileSync(
      path.join(process.cwd(), "lib/auth/authorized-domains.ts"),
      "utf8",
    );
    const body = /function projectId\(\): string \{([\s\S]*?)\n\}/.exec(
      source,
    )?.[1];
    expect(body, "projectId() not found").toBeTruthy();
    const keys = [...body!.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]);
    expect(keys).toEqual([...PROJECT_ENV_KEYS]);
    expect(body).not.toContain("||");
  });
});

describe("isLocalRoot", () => {
  it("is true for any root that can never be a real project's host", () => {
    for (const root of [
      "localhost",
      "localhost:3000",
      "shop.localhost",
      "localtest.me",
      "",
    ]) {
      expect(isLocalRoot(root), root).toBe(true);
    }
  });

  it("is false for a real root", () => {
    expect(isLocalRoot("storemink.com")).toBe(false);
    expect(isLocalRoot("staging.storemink.com")).toBe(false);
  });
});

describe("commitRefusal", () => {
  const base = { commit: true, confirmProject: PROJECT, project: PROJECT };

  it("has nothing to say about a dry run", () => {
    expect(
      commitRefusal({ commit: false, confirmProject: null, project: "" }),
    ).toBeNull();
  });

  it("allows a commit only when the named project is the configured one", () => {
    expect(commitRefusal(base)).toBeNull();
    expect(commitRefusal({ ...base, confirmProject: null })).toContain(
      `--confirm-project ${PROJECT}`,
    );
    expect(
      commitRefusal({ ...base, confirmProject: "storemink-staging" }),
    ).toContain("does not match");
    expect(commitRefusal({ ...base, project: "" })).toContain(
      "No Firebase project",
    );
  });
});

describe("environmentMismatch", () => {
  it("accepts each environment's own database, project and root", () => {
    expect(
      environmentMismatch({
        project: "storemink-prod",
        dbName: "storemink",
        rootDomain: "storemink.com",
      }),
    ).toBeNull();
    expect(
      environmentMismatch({
        project: "storemink-staging",
        dbName: "storemink_staging",
        rootDomain: "staging.storemink.com",
      }),
    ).toBeNull();
  });

  // ★ --confirm-project alone would have let this through: staging's stores
  // written into production's list.
  it("refuses staging's database against production's project", () => {
    expect(
      environmentMismatch({
        project: "storemink-prod",
        dbName: "storemink_staging",
        rootDomain: "staging.storemink.com",
      }),
    ).toMatch(/Point both at the same environment/);
  });

  it("refuses production's database or root against staging's project", () => {
    expect(
      environmentMismatch({
        project: "storemink-staging",
        dbName: "storemink",
      }),
    ).toMatch(/belongs to Firebase project "storemink-prod"/);
    expect(
      environmentMismatch({
        project: "storemink-staging",
        rootDomain: "storemink.com",
      }),
    ).toMatch(/belongs to Firebase project "storemink-prod"/);
  });

  it("is enforced on --commit", () => {
    expect(
      commitRefusal({
        commit: true,
        confirmProject: "storemink-prod",
        project: "storemink-prod",
        dbName: "storemink_staging",
      }),
    ).toMatch(/same environment/);
  });
});

describe("expectedAuthHosts", () => {
  it("folds stores the way the cron's sync does", () => {
    expect(expectedAuthHosts(STORES, ROOT)).toEqual({
      hosts: EXPECTED,
      storesWithoutHosts: 1,
    });
  });

  it("dedupes hosts shared across rows, first seen first", () => {
    expect(expectedAuthHosts([STORES[0], STORES[0]], ROOT).hosts).toEqual([
      "echoss.storemink.com",
    ]);
  });

  it("counts a Theme Studio preview store as needing no host", () => {
    const preview = {
      slug: "studio-preview-ab12",
      settings: {
        demo: true,
        studioPreview: {
          projectId: "6f1c2a8e-1d4b-4c1a-9a5e-2b7f0c3d4e51",
          versionId: "0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b",
        },
      },
    };
    expect(expectedAuthHosts([preview], ROOT)).toEqual({
      hosts: [],
      storesWithoutHosts: 1,
    });
  });
});

describe("parseAuthorizedDomainsResponse", () => {
  it("reads the list", () => {
    expect(
      parseAuthorizedDomainsResponse(
        true,
        JSON.stringify({ authorizedDomains: ["a.com", "b.com"] }),
      ),
    ).toEqual({ ok: true, domains: ["a.com", "b.com"] });
  });

  it("treats a config with no list as an empty one", () => {
    expect(parseAuthorizedDomainsResponse(true, "{}")).toEqual({
      ok: true,
      domains: [],
    });
    expect(parseAuthorizedDomainsResponse(true, "")).toEqual({
      ok: true,
      domains: [],
    });
  });

  it("surfaces the API's own error message", () => {
    expect(
      parseAuthorizedDomainsResponse(
        false,
        JSON.stringify({ error: { message: "PERMISSION_DENIED" } }),
      ),
    ).toEqual({ ok: false, error: "PERMISSION_DENIED" });
  });

  it("refuses a body it cannot trust", () => {
    expect(parseAuthorizedDomainsResponse(true, "<html>")).toMatchObject({
      ok: false,
    });
    expect(parseAuthorizedDomainsResponse(false, "<html>")).toMatchObject({
      ok: false,
    });
    expect(
      parseAuthorizedDomainsResponse(
        true,
        JSON.stringify({ authorizedDomains: ["a.com", 7] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseAuthorizedDomainsResponse(
        true,
        JSON.stringify({ authorizedDomains: "a.com" }),
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("runSyncAuthHosts", () => {
  function untouched(deps: SyncAuthHostsDeps) {
    expect(deps.readStores).not.toHaveBeenCalled();
    expect(deps.readAuthorizedDomains).not.toHaveBeenCalled();
    expect(deps.ensureAuthorizedHosts).not.toHaveBeenCalled();
  }

  it("★ a dry run prints the project, the count and every host, and writes nothing", async () => {
    const h = harness();

    expect(await runSyncAuthHosts([], h.deps)).toBe(0);

    expect(h.deps.ensureAuthorizedHosts).not.toHaveBeenCalled();
    expect(h.deps.readAuthorizedDomains).toHaveBeenCalledWith(PROJECT);
    const out = h.stdout();
    expect(out).toContain(`Firebase     ${PROJECT}`);
    expect(out).toContain("Root domain  storemink.com");
    expect(out).toContain("dry run");
    expect(out).toContain("Listed now             3 entries");
    expect(out).toContain("To add                 4");
    // echoss is listed already (case-insensitively), so it is not proposed.
    for (const host of EXPECTED.slice(1)) expect(out).toContain(`  + ${host}`);
    expect(out).not.toContain("+ echoss.storemink.com");
    expect(out).toContain("List after the write   7 entries");
    expect(out).toContain(
      `npm run auth:sync-hosts -- --commit --confirm-project ${PROJECT}`,
    );
  });

  it("flags a production database in the header", async () => {
    const h = harness({
      env: { FIREBASE_PROJECT_ID: PROJECT, DB_NAME: "storemink" },
    });
    await runSyncAuthHosts([], h.deps);
    expect(h.stdout()).toContain("← PRODUCTION");
  });

  it("says so when every host is already listed", async () => {
    const h = harness({
      readAuthorizedDomains: vi.fn(async () => ({
        ok: true as const,
        domains: EXPECTED,
      })),
    });

    expect(
      await runSyncAuthHosts(
        ["--commit", "--confirm-project", PROJECT],
        h.deps,
      ),
    ).toBe(0);

    expect(h.stdout()).toContain("Nothing to add");
    expect(h.deps.ensureAuthorizedHosts).not.toHaveBeenCalled();
  });

  it("★ --commit without --confirm-project reads and writes nothing", async () => {
    const h = harness();

    expect(await runSyncAuthHosts(["--commit"], h.deps)).toBe(1);

    untouched(h.deps);
    expect(h.stderr()).toContain(`--confirm-project ${PROJECT}`);
    expect(h.stderr()).toContain("Nothing was read or written.");
  });

  it("★ --commit naming another project reads and writes nothing", async () => {
    const h = harness();

    expect(
      await runSyncAuthHosts(
        ["--commit", "--confirm-project", "storemink-staging"],
        h.deps,
      ),
    ).toBe(1);

    untouched(h.deps);
    expect(h.stderr()).toContain("does not match");
  });

  it("refuses a local development root before any read", async () => {
    const h = harness({ rootDomain: "localhost:3000" });

    expect(await runSyncAuthHosts([], h.deps)).toBe(1);

    untouched(h.deps);
    expect(h.stderr()).toContain("local development root");
  });

  it("refuses to run with no Firebase project before any read", async () => {
    const h = harness({ env: { DB_NAME: "storemink_staging" } });

    expect(await runSyncAuthHosts([], h.deps)).toBe(1);

    untouched(h.deps);
    expect(h.stderr()).toContain("No Firebase project");
  });

  it("prints usage for --help and bad arguments without touching anything", async () => {
    const help = harness();
    expect(await runSyncAuthHosts(["--help"], help.deps)).toBe(0);
    expect(help.stdout()).toContain("Usage:");
    untouched(help.deps);

    const bad = harness();
    expect(await runSyncAuthHosts(["--force"], bad.deps)).toBe(1);
    expect(bad.stderr()).toContain("Unknown argument: --force");
    untouched(bad.deps);
  });

  it("stops before Identity Platform when the stores cannot be read", async () => {
    const h = harness({
      readStores: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });

    expect(
      await runSyncAuthHosts(
        ["--commit", "--confirm-project", PROJECT],
        h.deps,
      ),
    ).toBe(1);

    expect(h.deps.readAuthorizedDomains).not.toHaveBeenCalled();
    expect(h.deps.ensureAuthorizedHosts).not.toHaveBeenCalled();
    expect(h.stderr()).toContain("Could not read stores: ECONNREFUSED");
  });

  it("★ never writes what it could not preview", async () => {
    const refused = harness({
      readAuthorizedDomains: vi.fn(async () => ({
        ok: false as const,
        error: "PERMISSION_DENIED",
      })),
    });
    expect(
      await runSyncAuthHosts(
        ["--commit", "--confirm-project", PROJECT],
        refused.deps,
      ),
    ).toBe(1);
    expect(refused.deps.ensureAuthorizedHosts).not.toHaveBeenCalled();
    expect(refused.stderr()).toContain("PERMISSION_DENIED");

    const thrown = harness({
      readAuthorizedDomains: vi.fn(async () => {
        throw new Error("Could not load the default credentials");
      }),
    });
    expect(
      await runSyncAuthHosts(
        ["--commit", "--confirm-project", PROJECT],
        thrown.deps,
      ),
    ).toBe(1);
    expect(thrown.deps.ensureAuthorizedHosts).not.toHaveBeenCalled();
  });

  it("★ a confirmed commit sends the full expected set in one write", async () => {
    const h = harness();

    expect(
      await runSyncAuthHosts(
        ["--commit", "--confirm-project", PROJECT],
        h.deps,
      ),
    ).toBe(0);

    expect(h.deps.ensureAuthorizedHosts).toHaveBeenCalledTimes(1);
    expect(h.deps.ensureAuthorizedHosts).toHaveBeenCalledWith(EXPECTED);
    expect(h.stdout()).toContain(`Added 4 host(s) to ${PROJECT}.`);
    expect(h.stdout()).not.toContain("The list changed");
  });

  it("says when the list moved between the preview and the write", async () => {
    const h = harness({
      ensureAuthorizedHosts: vi.fn(async () => ({ added: ["wholesip.com"] })),
    });

    expect(
      await runSyncAuthHosts(
        ["--commit", "--confirm-project", PROJECT],
        h.deps,
      ),
    ).toBe(0);

    expect(h.stdout()).toContain("Added 1 host(s)");
    expect(h.stdout()).toContain("The list changed");
  });

  it("exits non-zero when the write fails or throws", async () => {
    const failed = harness({
      ensureAuthorizedHosts: vi.fn(async () => ({
        added: [],
        error: "HTTP 403",
      })),
    });
    expect(
      await runSyncAuthHosts(
        ["--commit", "--confirm-project", PROJECT],
        failed.deps,
      ),
    ).toBe(1);
    expect(failed.stderr()).toContain("Write failed: HTTP 403");

    const thrown = harness({
      ensureAuthorizedHosts: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    });
    expect(
      await runSyncAuthHosts(
        ["--commit", "--confirm-project", PROJECT],
        thrown.deps,
      ),
    ).toBe(1);
    expect(thrown.stderr()).toContain("socket hang up");
  });
});
