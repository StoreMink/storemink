// ---------------------------------------------------------------------------
// The testable half of scripts/sync-auth-hosts.ts: argument parsing, the
// safety gates, the host plan and the whole run with its I/O injected, so the
// rule "nothing is written without --commit" is pinned by tests rather than
// trusted. The script file only wires the real database, Identity Toolkit
// read and write into `runSyncAuthHosts`.
//
// ⚠ Import this only AFTER the env is loaded: lib/store/host (reached through
// both lib/auth imports) reads NEXT_PUBLIC_ROOT_DOMAIN at module scope.
// ---------------------------------------------------------------------------

import { planAddHosts } from "@/lib/auth/authorized-domains";
import {
  normalizeAuthHost,
  storeAuthHosts,
  type StoreAuthHostInput,
} from "@/lib/auth/store-auth-hosts";
import { isLocalDevHostname } from "@/lib/store/host";

export const USAGE = [
  "Usage:",
  "  npm run auth:sync-hosts                 dry run: print the plan, write nothing",
  "  npm run auth:sync-hosts -- --commit --confirm-project <firebase-project-id>",
].join("\n");

export interface SyncArgs {
  commit: boolean;
  confirmProject: string | null;
  help: boolean;
}

/**
 * Unknown arguments are refused rather than ignored: a mistyped flag must not
 * quietly turn a run the operator meant as a write into something else.
 */
export function parseSyncArgs(
  argv: readonly string[],
): SyncArgs | { error: string } {
  const args: SyncArgs = { commit: false, confirmProject: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--commit") args.commit = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (
      arg === "--confirm-project" ||
      arg.startsWith("--confirm-project=")
    ) {
      const value = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : argv[++i];
      if (!value || value.startsWith("-")) {
        return { error: "--confirm-project needs the Firebase project id." };
      }
      args.confirmProject = value.trim();
    } else {
      return { error: `Unknown argument: ${arg}` };
    }
  }
  return args;
}

/**
 * The env keys `projectId()` in lib/auth/authorized-domains.ts reads, in its
 * order. ★ A MIRROR: the confirmation vouches for this project, while the
 * write goes wherever that function points, so the two must not drift
 * (pinned by a test that reads that function's source).
 */
export const PROJECT_ENV_KEYS = [
  "FIREBASE_PROJECT_ID",
  "DOMAIN_GCP_PROJECT_ID",
  "GCP_PROJECT_ID",
] as const;

/** The Identity Platform project the core module reads and writes. */
export function authDomainsProject(
  env: Readonly<Record<string, string | undefined>>,
): string {
  // `??`, not `||`, exactly as the core does.
  return (
    env[PROJECT_ENV_KEYS[0]] ??
    env[PROJECT_ENV_KEYS[1]] ??
    env[PROJECT_ENV_KEYS[2]] ??
    ""
  );
}

/** True when the root can never name a host in a real project's list. */
export function isLocalRoot(rootDomain: string): boolean {
  const root = normalizeAuthHost(rootDomain);
  return !root || isLocalDevHostname(root);
}

/**
 * The known pairings of database, Firebase project and root domain. ★ Checked
 * because --confirm-project only proves the operator named the project the run
 * will write to; it says nothing about which database the stores came from, so
 * staging's stores (and staging's custom domains) could be written into
 * production's list. Production owns the `storemink` database and the
 * `storemink.com` root; staging and dev share `storemink_staging`.
 */
const ENVIRONMENTS = [
  { project: "storemink-prod", db: "storemink", root: "storemink.com" },
  { project: "storemink-staging", db: "storemink_staging", root: null },
] as const;

/** Why this database / project / root combination crosses environments, or null. */
export function environmentMismatch(input: {
  project: string;
  dbName?: string | null;
  rootDomain?: string | null;
}): string | null {
  const db = input.dbName?.trim() || null;
  const root = input.rootDomain ? normalizeAuthHost(input.rootDomain) : null;
  for (const env of ENVIRONMENTS) {
    const ownsDb = db !== null && db === env.db;
    const ownsRoot = root !== null && env.root !== null && root === env.root;
    if ((ownsDb || ownsRoot) && input.project !== env.project) {
      return (
        `The ${ownsDb ? `database "${db}"` : `root domain "${root}"`} belongs ` +
        `to Firebase project "${env.project}", but this run would write to ` +
        `"${input.project}". Point both at the same environment.`
      );
    }
    if (input.project === env.project) {
      if (db !== null && db !== env.db) {
        return (
          `Firebase project "${env.project}" pairs with database "${env.db}", ` +
          `not "${db}". Point both at the same environment.`
        );
      }
      if (env.root !== null && root !== null && root !== env.root) {
        return (
          `Firebase project "${env.project}" serves "${env.root}", not ` +
          `"${root}". Point both at the same environment.`
        );
      }
    }
  }
  return null;
}

/**
 * Why a --commit must not proceed, or null. Checked BEFORE any read: a write
 * names the project it will change, because a database and a Firebase project
 * from different environments is the crossing CODEBASE.md §7 warns about, and
 * this run would otherwise write one environment's hosts into the other's list.
 */
export function commitRefusal(input: {
  commit: boolean;
  confirmProject: string | null;
  project: string;
  dbName?: string | null;
  rootDomain?: string | null;
}): string | null {
  if (!input.commit) return null;
  if (!input.project) {
    return "No Firebase project is configured, so there is nothing to write to.";
  }
  const crossed = environmentMismatch(input);
  if (crossed) return crossed;
  if (!input.confirmProject) {
    return (
      `--commit writes to "${input.project}". Check the database and root ` +
      `domain above, then re-run with --confirm-project ${input.project}.`
    );
  }
  if (input.confirmProject !== input.project) {
    return (
      `--confirm-project "${input.confirmProject}" does not match the ` +
      `configured project "${input.project}".`
    );
  }
  return null;
}

/**
 * Every host the stores need, deduplicated in first-seen order: the same fold
 * syncStoreAuthHosts makes, through the same storeAuthHosts.
 */
export function expectedAuthHosts(
  stores: readonly StoreAuthHostInput[],
  rootDomain: string,
): { hosts: string[]; storesWithoutHosts: number } {
  const seen = new Set<string>();
  let storesWithoutHosts = 0;
  for (const store of stores) {
    const hosts = storeAuthHosts(store, rootDomain);
    if (hosts.length === 0) storesWithoutHosts++;
    for (const host of hosts) seen.add(host);
  }
  return { hosts: [...seen], storesWithoutHosts };
}

export type AuthorizedDomainsRead =
  | { ok: true; domains: string[] }
  | { ok: false; error: string };

/** Parse an Identity Toolkit `GET …/config` response body. */
export function parseAuthorizedDomainsResponse(
  ok: boolean,
  text: string,
): AuthorizedDomainsRead {
  let json: Record<string, unknown>;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { ok: false, error: `unreadable response: ${text.slice(0, 200)}` };
  }
  if (!ok) {
    const err = json.error as { message?: string } | undefined;
    return { ok: false, error: err?.message ?? (text || "request failed") };
  }
  const list = json.authorizedDomains ?? [];
  if (!Array.isArray(list) || list.some((d) => typeof d !== "string")) {
    return { ok: false, error: "authorizedDomains is not a list of strings" };
  }
  return { ok: true, domains: list as string[] };
}

export interface SyncAuthHostsDeps {
  env: Readonly<Record<string, string | undefined>>;
  rootDomain: string;
  readStores: () => Promise<StoreAuthHostInput[]>;
  /** A GET only. The script never writes except through ensureAuthorizedHosts. */
  readAuthorizedDomains: (project: string) => Promise<AuthorizedDomainsRead>;
  ensureAuthorizedHosts: (
    hosts: string[],
  ) => Promise<{ added: string[]; error?: string }>;
  out: (line: string) => void;
  err: (line: string) => void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The whole run. Resolves to the process exit code; never throws. */
export async function runSyncAuthHosts(
  argv: readonly string[],
  deps: SyncAuthHostsDeps,
): Promise<number> {
  const { env, rootDomain, out, err } = deps;
  const args = parseSyncArgs(argv);
  if ("error" in args) {
    err(`${args.error}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    out(USAGE);
    return 0;
  }

  const project = authDomainsProject(env);
  const dbName = env.DB_NAME ?? "(unset)";
  out("");
  out(
    `Database     ${dbName} @ ${env.DB_HOST ?? "(unset)"}:${env.DB_PORT ?? "5432"}` +
      (dbName === "storemink" ? "  ← PRODUCTION" : ""),
  );
  out(`Firebase     ${project || "(none configured)"}`);
  out(`Root domain  ${rootDomain}`);
  out(
    `Mode         ${args.commit ? "COMMIT" : "dry run (nothing is written)"}`,
  );
  out("");

  // ★ Every refusal comes before the first read, so a misconfigured run
  // touches neither the database nor Identity Platform.
  if (isLocalRoot(rootDomain)) {
    err(
      `${rootDomain} is a local development root, so no store host belongs ` +
        "in a real project. Set NEXT_PUBLIC_ROOT_DOMAIN to the environment's " +
        "root domain (for example storemink.com).",
    );
    return 1;
  }
  if (!project) {
    err(`No Firebase project is configured (${PROJECT_ENV_KEYS.join(" / ")}).`);
    return 1;
  }
  const refusal = commitRefusal({
    ...args,
    project,
    dbName: env.DB_NAME ?? null,
    rootDomain,
  });
  if (!args.commit) {
    const crossed = environmentMismatch({
      project,
      dbName: env.DB_NAME ?? null,
      rootDomain,
    });
    if (crossed) out(`⚠ ${crossed} A --commit would be refused.\n`);
  }
  if (refusal) {
    err(`${refusal}\nNothing was read or written.`);
    return 1;
  }

  let stores: StoreAuthHostInput[];
  try {
    stores = await deps.readStores();
  } catch (e) {
    err(`Could not read stores: ${message(e)}`);
    return 1;
  }
  const expected = expectedAuthHosts(stores, rootDomain);
  out(
    `Active stores          ${stores.length}` +
      (expected.storesWithoutHosts
        ? ` (${expected.storesWithoutHosts} need none, e.g. demo or preview stores)`
        : ""),
  );
  out(`Hosts they need        ${expected.hosts.length}`);

  let current: AuthorizedDomainsRead;
  try {
    current = await deps.readAuthorizedDomains(project);
  } catch (e) {
    current = { ok: false, error: message(e) };
  }
  if (!current.ok) {
    // ★ Never write what could not be previewed.
    err(`Could not read authorizedDomains: ${current.error}`);
    err("Nothing was written.");
    return 1;
  }

  const plan = planAddHosts(current.domains, expected.hosts);
  out(`Listed now             ${current.domains.length} entries`);
  out(`To add                 ${plan.added.length}`);
  for (const host of plan.added) out(`  + ${host}`);

  if (plan.added.length === 0) {
    out("\nNothing to add: every active store's hosts are already listed.");
    return 0;
  }
  out(`List after the write   ${plan.next.length} entries`);

  if (!args.commit) {
    out(
      `\nDry run: nothing was written. To add these ${plan.added.length} ` +
        `host(s):\n  npm run auth:sync-hosts -- --commit --confirm-project ${project}`,
    );
    return 0;
  }

  // The core re-reads the list and writes once, so the full expected set goes
  // in: anything another writer added since the read above is skipped there.
  let result: { added: string[]; error?: string };
  try {
    result = await deps.ensureAuthorizedHosts(expected.hosts);
  } catch (e) {
    result = { added: [], error: message(e) };
  }
  if (result.error) {
    err(`\nWrite failed: ${result.error}\nNothing was added.`);
    return 1;
  }
  out(`\nAdded ${result.added.length} host(s) to ${project}.`);
  if (result.added.length !== plan.added.length) {
    out(
      "The list changed between the preview and the write, so the count " +
        "differs from the plan above.",
    );
  }
  return 0;
}
