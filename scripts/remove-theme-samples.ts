/**
 * Remove the theme sample products and categories that older installs left in
 * merchant stores, and the menu, header, footer and page links to them.
 *
 *   npm run themes:remove-samples                        # dry run: prints the plan
 *   npm run themes:remove-samples -- --store <slug>      # one store
 *   npm run themes:remove-samples -- --commit --confirm-database <DB_NAME>
 *
 * Since 31 Oct 2026 no merchant store receives a theme's samples (owner: they
 * "should not be visible anywhere in the dashboard at all"); this clears the
 * ones installed before. The rules are in lib/themes/sample-cleanup-rules.ts
 * and the per-store work, one transaction each, in lib/themes/sample-cleanup.ts.
 * Demo and Theme Studio preview stores are skipped, and so is a store on a
 * legal hold. Safe to run again: a second run finds nothing.
 *
 * ★ DRY RUN BY DEFAULT. A write needs --commit AND --confirm-database naming
 * the database it will change. Staging and production are two databases in
 * one Cloud SQL instance, so the proxy being up says nothing about which one
 * is read. A shell variable beats .env and .env.local, so with
 * `npm run db:proxy` running, staging is:
 *
 *   DB_HOST=127.0.0.1 DB_PORT=6543 DB_USER=app \
 *   DB_PASSWORD="$(gcloud secrets versions access latest \
 *     --secret=CLOUDSQL_PROD_APP_PW --project=storemink-prod)" \
 *   DB_NAME=storemink_staging npm run themes:remove-samples
 *
 * and production the same with DB_NAME=storemink.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true, {
  info: () => {},
  error: () => {},
});

/** Every store, as the clean-up needs it. */
async function readStores() {
  const [{ withService }, { stores }, { asc }] = await Promise.all([
    import("@/lib/db/client"),
    import("@/drizzle/schema"),
    import("drizzle-orm"),
  ]);
  return withService((db) =>
    db
      .select({ id: stores.id, slug: stores.slug, settings: stores.settings })
      .from(stores)
      .orderBy(asc(stores.slug)),
  );
}

async function main(): Promise<number> {
  // Imported AFTER the env is loaded: lib/db/client builds its pool from
  // process.env.
  const [{ runRemoveThemeSamples }, cleanup] = await Promise.all([
    import("./remove-theme-samples-core"),
    import("@/lib/themes/sample-cleanup"),
  ]);
  return runRemoveThemeSamples(process.argv.slice(2), {
    env: process.env,
    readStores,
    seedsFor: cleanup.sampleSeedsForStore,
    clean: cleanup.cleanStoreSamples,
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
    await (await import("@/lib/db/client")).closePool().catch(() => {});
  });
