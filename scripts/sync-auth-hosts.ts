/**
 * Add every active store's exact hosts to Identity Platform's
 * authorizedDomains, ahead of the hourly pass in /api/cron/domain-reconcile
 * (which does the same thing, add-only, on its own).
 *
 *   npm run auth:sync-hosts                 # dry run: prints the plan
 *   npm run auth:sync-hosts -- --commit --confirm-project <firebase-project-id>
 *
 * Phone sign-in checks the EXACT hostname (lib/auth/store-auth-hosts.ts), so a
 * store missing from the list cannot send a single code. This never removes an
 * entry.
 *
 * ★ DRY RUN BY DEFAULT. It prints the database, the Firebase project, the root
 * domain, how many entries are listed now and every host it would add. A write
 * needs --commit AND --confirm-project naming the project it will change: a
 * database and a Firebase project from different environments would write one
 * environment's hosts into the other's list (CODEBASE.md §7).
 *
 * ⚠ THREE INPUTS DECIDE THE RESULT; CHECK ALL THREE IN THE HEADER IT PRINTS.
 * `.env` points at STAGING (DB_NAME=storemink_staging), and staging and
 * production are two databases in one Cloud SQL instance, so the proxy being
 * up says nothing about which one is read. A shell variable beats .env, so
 * production is:
 *
 *   DB_NAME=storemink DB_HOST=127.0.0.1 DB_PORT=6543 \
 *   NEXT_PUBLIC_ROOT_DOMAIN=storemink.com FIREBASE_PROJECT_ID=<prod project> \
 *     npm run auth:sync-hosts
 *
 * The project is read the way lib/auth/authorized-domains.ts reads it
 * (FIREBASE_PROJECT_ID, then DOMAIN_GCP_PROJECT_ID, then GCP_PROJECT_ID), with
 * Application Default Credentials (`gcloud auth application-default login`).
 * Reading needs `firebaseauth.configs.get`; writing `firebaseauth.configs.update`.
 *
 * Writes go through ensureAuthorizedHosts, the same single read-modify-write
 * the cron uses; the only Identity Platform call this file makes itself is a
 * GET.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true, {
  info: () => {},
  error: () => {},
});

const IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com/admin/v2";

/** Active stores, as syncStoreAuthHosts reads them (status = 'active'). */
async function readStores() {
  const [{ withService }, { stores }, { eq }] = await Promise.all([
    import("@/lib/db/client"),
    import("@/drizzle/schema"),
    import("drizzle-orm"),
  ]);
  const rows = await withService((db) =>
    db
      .select({
        slug: stores.slug,
        customDomain: stores.customDomain,
        settings: stores.settings,
      })
      .from(stores)
      .where(eq(stores.status, "active")),
  );
  return rows.map((row) => ({
    slug: row.slug,
    custom_domain: row.customDomain,
    settings: row.settings,
  }));
}

/** A read-only GET of the project's auth config. */
async function readAuthorizedDomains(project: string) {
  const [{ GoogleAuth }, { parseAuthorizedDomainsResponse }] =
    await Promise.all([
      import("google-auth-library"),
      import("./sync-auth-hosts-core"),
    ]);
  const client = await new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  }).getClient();
  const token = await client.getAccessToken();
  const res = await fetch(
    `${IDENTITY_TOOLKIT}/projects/${encodeURIComponent(project)}/config`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${token.token ?? ""}`,
        // Billed to the project itself, as in the core; under local ADC the
        // request is otherwise refused with a 403.
        "x-goog-user-project": project,
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  return parseAuthorizedDomainsResponse(res.ok, await res.text());
}

async function main(): Promise<number> {
  // Imported AFTER the env is loaded: lib/store/host reads
  // NEXT_PUBLIC_ROOT_DOMAIN at module scope, and lib/db/client builds its pool
  // from process.env.
  const [{ runSyncAuthHosts }, { ROOT_DOMAIN }] = await Promise.all([
    import("./sync-auth-hosts-core"),
    import("@/lib/store/host"),
  ]);
  return runSyncAuthHosts(process.argv.slice(2), {
    env: process.env,
    rootDomain: ROOT_DOMAIN,
    readStores,
    readAuthorizedDomains,
    ensureAuthorizedHosts: async (hosts) =>
      (await import("@/lib/auth/authorized-domains")).ensureAuthorizedHosts(
        hosts,
      ),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The pool is created lazily, so this is a no-op when nothing was read.
    await (await import("@/lib/db/client")).closePool().catch(() => {});
  });
