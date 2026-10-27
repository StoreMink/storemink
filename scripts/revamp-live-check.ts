/**
 * Run a real Mink storefront redesign on this machine, without the chat, for
 * four made-up shops (scripts/revamp-live-fixtures.ts), so every page can be
 * photographed before and after (docs/mink-storefront-revamp.md, section 14).
 *
 *   npm run revamp:live-check -- --setup
 *       Creates each shop in the local database if it is missing: an open
 *       storefront (settings.launched) on the Pro plan, an owner, and its
 *       theme installed and published. Then puts one phone photo per product
 *       in the shop's Media Library: offline, a bundled theme photo copied
 *       into the staging media bucket. Prints each storefront's address.
 *   npm run revamp:live-check -- --run [--store=<slug>]
 *       Starts a full redesign the way the chat's start tool does (a
 *       conversation and a run for the owner, then the job) and drives the
 *       background runner here until the review card is ready or the job
 *       fails, printing every step. Offline the planner and photographer are
 *       the fakes (MINK_REVAMP_PROVIDER=fake), so nothing is paid for.
 *   npm run revamp:live-check -- --apply --publish [--store=<slug>]
 *       Presses "Apply to Website Builder draft", then "Publish to your store".
 *   npm run revamp:live-check -- --undo [--store=<slug>]
 *       Presses "Undo".
 *   npm run revamp:live-check -- --report [--out=<dir>]
 *       Writes <dir>/report.json: every shop's page addresses, the job's
 *       status, the time each step took and the checks.
 *   npm run revamp:live-check -- --reset --setup [--store=<slug>]
 *       Deletes the shop (rows and its objects under stores/<id>/ in the
 *       staging bucket) first, so the next photos start from a fresh theme
 *       install and the store's free redesign is unused again.
 *
 *   --live --yes, with --setup or --run, uses the real models in
 *   storemink-staging: one image call per phone photo at setup, and a whole
 *   paid redesign per shop at run. The two flags are the consent; nothing asks
 *   again. --live without --yes refuses.
 *   --store=<slug> picks one shop (default: all four). --revamp=<id> picks the
 *   redesign --apply, --publish or --undo acts on (default: the newest that
 *   fits). --out=<dir> (default: <os tmpdir>/revamp-live) holds the step
 *   timings --run records and the report. --max-minutes=<n> (default 60)
 *   bounds how long --run waits for one shop.
 *
 * ★★ IT NEVER TOUCHES PRODUCTION. It refuses unless the database is the local
 *    one (DB_NAME storemink_local on a loopback host), every model and the
 *    media bucket are in storemink-staging, and the platform is not the
 *    production domain. Read from .env and .env.local the way every script
 *    reads them, so a shell variable that points elsewhere is refused too.
 * ★★ THE RUNNER IS DRIVEN HERE, NOT KICKED. The production path posts to
 *    /api/internal/mink/revamps/run, which is a server that may not be
 *    running (or is one somewhere else). This calls `runRevampJob` in a loop
 *    as that route does, with the runner's kick switched off so no server is
 *    told to work on the same job, and waits out a parked lease (a step that
 *    failed and must wait before the next claim) instead of hammering it.
 * ★ THE LIBRARY DOES THE WORK. The request goes through `readRevampRequest`,
 *   the job through `createRevampJob`, the actor through `rebuildRevampActor`
 *   and the buttons through the same functions their routes call, so a run
 *   here fails exactly where the product would.
 * ★ A SHOP IS OURS ONLY WITH OUR MARK. Every store this creates carries
 *   `settings.revampLiveCheck`; a store with the same address and no mark is
 *   somebody's real (synced) store, and it is refused rather than changed.
 * ★ Each shop is independent: one that fails is reported and the rest go on.
 *   The exit code is 1 when any shop failed.
 * ⚠ Publish's search-engine hook runs in `after()`, which has no request
 *   scope in a script, so the publish step logs "publish follow-up failed".
 *   The pages are published; only the indexing nudge and the page.published
 *   activity rows are skipped, and a local store is never indexed anyway.
 */
import { ThinkingLevel } from "@google/genai";
import { loadEnvConfig } from "@next/env";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { RevampRunnerJobs } from "../lib/mink/revamp/runner";
import type { RevampJobRow } from "../lib/mink/revamp/jobs";
import type {
  RevampProgressItem,
  RevampRequest,
  RevampStep,
  RevampStoredPlan,
} from "../lib/mink/revamp/contract";
import type { MinkActorContext } from "../lib/mink/types";
import {
  driveRevamp as driveRevampLoop,
  seconds,
} from "./revamp-live-check-core";
import {
  REVAMP_LIVE_FIXTURES,
  type RevampLiveFixture,
  type RevampLiveProduct,
} from "./revamp-live-fixtures";

loadEnvConfig(process.cwd(), true, { info: () => {}, error: () => {} });

const LOCAL_DATABASE = "storemink_local";
const STAGING_PROJECT = "storemink-staging";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MARK = "revampLiveCheck";
const STEPS: readonly RevampStep[] = [
  "snapshot",
  "plan",
  "compile",
  "photos",
  "products",
  "assemble",
  "checks",
  "card",
];

interface Options {
  reset: boolean;
  setup: boolean;
  run: boolean;
  apply: boolean;
  publish: boolean;
  undo: boolean;
  report: boolean;
  live: boolean;
  store: string;
  revampId: string | null;
  out: string;
  maxMinutes: number;
}

const FLAGS = [
  "--reset",
  "--setup",
  "--run",
  "--apply",
  "--publish",
  "--undo",
  "--report",
  "--live",
  "--yes",
] as const;
const VALUES = ["--store=", "--revamp=", "--out=", "--max-minutes="] as const;

function readOptions(argv: string[]): Options | string {
  for (const arg of argv) {
    const known =
      (FLAGS as readonly string[]).includes(arg) ||
      VALUES.some((prefix) => arg.startsWith(prefix));
    if (!known)
      return `Unknown argument ${arg}. See the comment at the top of scripts/revamp-live-check.ts.`;
  }
  const has = (flag: (typeof FLAGS)[number]) => argv.includes(flag);
  const value = (prefix: (typeof VALUES)[number]) => {
    const found = argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length).trim() : null;
  };
  const options: Options = {
    reset: has("--reset"),
    setup: has("--setup"),
    run: has("--run"),
    apply: has("--apply"),
    publish: has("--publish"),
    undo: has("--undo"),
    report: has("--report"),
    live: has("--live"),
    store: (value("--store=") || "all").toLowerCase(),
    revampId: value("--revamp="),
    out:
      value("--out=") ||
      process.env.REVAMP_LIVE_OUT ||
      join(tmpdir(), "revamp-live"),
    maxMinutes: Number(value("--max-minutes=") ?? 60),
  };
  const acting =
    options.reset ||
    options.setup ||
    options.run ||
    options.apply ||
    options.publish ||
    options.undo ||
    options.report;
  if (!acting) {
    return "Say what to do: --reset, --setup, --run, --apply, --publish, --undo or --report.";
  }
  if (options.live && !has("--yes")) {
    return "A live run calls paid models in storemink-staging (an image per phone photo at --setup, a whole redesign per shop at --run). Re-run with --live --yes.";
  }
  if (has("--yes") && !options.live) {
    return "--yes is the consent for --live; pass both or neither.";
  }
  if (
    options.store !== "all" &&
    !REVAMP_LIVE_FIXTURES.some((fixture) => fixture.slug === options.store)
  ) {
    return `No shop called ${options.store}. Choose one of: ${REVAMP_LIVE_FIXTURES.map((f) => f.slug).join(", ")}.`;
  }
  if (options.revampId !== null) {
    if (options.store === "all") return "--revamp needs --store=<slug>.";
    if (!/^[0-9a-f-]{36}$/i.test(options.revampId)) {
      return "--revamp must be a redesign id.";
    }
  }
  if (!Number.isFinite(options.maxMinutes) || options.maxMinutes <= 0) {
    return "--max-minutes must be a positive number.";
  }
  return options;
}

/**
 * Everything that makes this run somewhere it must not. ★ Checked before any
 * module that reads the database, the bucket or a model is loaded, because
 * those build their clients from the environment as they load.
 */
function environmentProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const shown = (value: string | undefined) =>
    value && value.trim() ? `"${value.trim()}"` : "unset";
  if (env.DB_NAME?.trim() !== LOCAL_DATABASE) {
    problems.push(
      `DB_NAME is ${shown(env.DB_NAME)}; this tool runs only against ${LOCAL_DATABASE} (see .env.local and scripts/db-local-sync.sh).`,
    );
  }
  if (!LOOPBACK_HOSTS.has(env.DB_HOST?.trim() ?? "")) {
    problems.push(
      `DB_HOST is ${shown(env.DB_HOST)}; the local database listens on 127.0.0.1.`,
    );
  }
  if (env.GCP_PROJECT_ID?.trim() !== STAGING_PROJECT) {
    problems.push(
      `GCP_PROJECT_ID is ${shown(env.GCP_PROJECT_ID)}; models, photos and storage must run in ${STAGING_PROJECT}.`,
    );
  }
  const studio = env.THEME_STUDIO_GCP_PROJECT_ID?.trim();
  if (studio && studio !== STAGING_PROJECT) {
    problems.push(
      `THEME_STUDIO_GCP_PROJECT_ID is "${studio}"; the redesign's planner and photos use it, and it must be ${STAGING_PROJECT}.`,
    );
  }
  const bucket = env.GCS_BUCKET?.trim();
  if (!bucket) {
    problems.push(
      "GCS_BUCKET is unset; the redesign stores its photos in the staging media bucket.",
    );
  } else if (/prod/i.test(bucket)) {
    problems.push(`GCS_BUCKET is "${bucket}", a production bucket.`);
  }
  return problems;
}

async function main(): Promise<number> {
  const options = readOptions(process.argv.slice(2));
  if (typeof options === "string") {
    console.error(options);
    return 2;
  }
  const problems = environmentProblems(process.env);
  if (problems.length) {
    console.error(
      [
        "Refused: this tool never touches production.",
        ...problems.map((p) => `  - ${p}`),
      ].join("\n"),
    );
    return 2;
  }
  // ★ One read decides every step (lib/mink/revamp/provider.ts), so it is set
  //   before anything runs: offline unless --live --yes.
  process.env.MINK_REVAMP_PROVIDER = options.live ? "vertex" : "fake";

  const host = await import("../lib/store/host");
  if (host.IS_PRODUCTION_PLATFORM) {
    console.error(
      `Refused: NEXT_PUBLIC_ROOT_DOMAIN is ${host.ROOT_DOMAIN}, the production platform.`,
    );
    return 2;
  }

  const lib = await loadLib();
  loaded = lib;
  if (!lib.config.getMinkConfig().enabled) {
    // The runner route's own stop: nothing would be claimed.
    console.error("Refused: Mink AI is switched off (MINK_AI_ENABLED).");
    return 2;
  }
  const port = /:(\d+)$/.exec(host.ROOT_DOMAIN)?.[1] ?? "3000";
  const context: Context = {
    lib,
    options,
    origin: (slug) => `http://${slug}.localtest.me:${port}`,
  };
  const fixtures =
    options.store === "all"
      ? [...REVAMP_LIVE_FIXTURES]
      : REVAMP_LIVE_FIXTURES.filter((f) => f.slug === options.store);

  const mode =
    options.setup || options.run
      ? options.live
        ? "LIVE (paid models in storemink-staging)"
        : "offline (fake planner and photos, no paid call)"
      : "no model calls";
  console.log(
    `Revamp live check: ${mode}, database ${process.env.DB_NAME}, bucket ${process.env.GCS_BUCKET}, ${fixtures.length} shop${fixtures.length === 1 ? "" : "s"}.`,
  );

  let failed = 0;
  for (const fixture of fixtures) {
    const log = logger(fixture.slug);
    try {
      if (options.reset) await resetShop(context, fixture, log);
      if (options.setup) await setupShop(context, fixture, log);
      if (options.run) {
        const ok = await runShop(context, fixture, log);
        if (!ok) failed += 1;
      }
      let revampId = options.revampId;
      if (options.apply)
        revampId = await applyShop(context, fixture, revampId, log);
      if (options.publish) await publishShop(context, fixture, revampId, log);
      if (options.undo) await undoShop(context, fixture, revampId, log);
    } catch (error) {
      failed += 1;
      log(`FAILED: ${describe(error)}`);
    }
  }
  if (options.report) {
    try {
      await writeReport(context, fixtures);
    } catch (error) {
      failed += 1;
      console.error(`Report failed: ${describe(error)}`);
    }
  }
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The library, loaded after the environment has been checked.
// ---------------------------------------------------------------------------

async function loadLib() {
  const [
    db,
    schema,
    jobs,
    runner,
    deps,
    actor,
    request,
    images,
    record,
    publish,
    actions,
    contract,
    credits,
    config,
    apply,
    registry,
    gcs,
    processImage,
    generation,
    generationContract,
    assemble,
    metering,
  ] = await Promise.all([
    import("../lib/db/client"),
    import("../drizzle/schema"),
    import("../lib/mink/revamp/jobs"),
    import("../lib/mink/revamp/runner"),
    import("../lib/mink/revamp/deps"),
    import("../lib/mink/revamp/actor"),
    import("../lib/mink/revamp/request"),
    import("../lib/mink/revamp/image-store"),
    import("../lib/notifications/record"),
    import("../lib/mink/revamp/publish"),
    import("../lib/mink/storefront-personalization-actions"),
    import("../lib/mink/revamp/contract"),
    import("../lib/mink/image-credits"),
    import("../lib/mink/config"),
    import("../lib/themes/apply"),
    import("../lib/themes/runtime-registry"),
    import("../lib/storage/gcs"),
    import("../lib/storage/process-image"),
    import("../lib/mink/media-generation"),
    import("../lib/mink/media-generation-contract"),
    import("../lib/mink/revamp/assemble"),
    import("../lib/mink/metering"),
  ]);
  return {
    db,
    schema,
    jobs,
    runner,
    deps,
    actor,
    request,
    images,
    record,
    publish,
    actions,
    contract,
    credits,
    config,
    apply,
    registry,
    gcs,
    processImage,
    generation,
    generationContract,
    assemble,
    metering,
  };
}

type Lib = Awaited<ReturnType<typeof loadLib>>;

/** The library once loaded, so the exit can close its pool. */
let loaded: Lib | null = null;

interface Context {
  lib: Lib;
  options: Options;
  /** The shop's storefront address on this machine. */
  origin: (slug: string) => string;
}

type Log = (line: string) => void;

function logger(slug: string): Log {
  return (line) => console.log(`[${slug}] ${clock()} ${line}`);
}

/** Local wall-clock time, so a line can be matched against the reader's own clock. */
function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

// ---------------------------------------------------------------------------
// The shops.
// ---------------------------------------------------------------------------

interface Shop {
  id: string;
  slug: string;
  name: string;
  settings: Record<string, unknown>;
  ownerId: string;
  ownerEmail: string;
}

function ownerIdFor(fixture: RevampLiveFixture): string {
  // A made-up uid: nobody signs in as this owner; the storefront is open.
  return `revamp-live-owner-${fixture.slug}`;
}

function ownerEmailFor(fixture: RevampLiveFixture): string {
  // RFC 2606: example.com has no inbox, so nothing can reach a real person.
  return `${fixture.slug}.owner@example.com`;
}

async function readShop(
  lib: Lib,
  fixture: RevampLiveFixture,
): Promise<Shop | null> {
  const { stores, admins } = lib.schema;
  return lib.db.withService(async (db) => {
    const [store] = await db
      .select({
        id: stores.id,
        slug: stores.slug,
        name: stores.name,
        settings: stores.settings,
      })
      .from(stores)
      .where(eq(stores.slug, fixture.slug))
      .limit(1);
    if (!store) return null;
    const settings = record(store.settings);
    if (settings[MARK] !== true) {
      throw new Error(
        `A store called ${fixture.slug} exists and was not made by this tool, so it is left alone.`,
      );
    }
    const [owner] = await db
      .select({ id: admins.id, email: admins.email })
      .from(admins)
      .where(and(eq(admins.storeId, store.id), eq(admins.role, "superadmin")))
      .orderBy(admins.createdAt)
      .limit(1);
    if (!owner) throw new Error("The shop has no owner. Run --setup again.");
    return {
      id: store.id,
      slug: store.slug,
      name: store.name,
      settings,
      ownerId: owner.id,
      ownerEmail: owner.email,
    };
  });
}

async function requireShop(
  lib: Lib,
  fixture: RevampLiveFixture,
): Promise<Shop> {
  const shop = await readShop(lib, fixture);
  if (!shop) throw new Error("The shop does not exist yet. Run --setup first.");
  return shop;
}

// ---------------------------------------------------------------------------
// --reset
// ---------------------------------------------------------------------------

/**
 * Delete a shop this tool made, so --setup builds it again from nothing.
 * ★ The mark is checked twice: `readShop` refuses an unmarked store, and the
 *   delete itself carries the mark in its WHERE, so no other store can match.
 * ★ The store purge's transaction rule (app/actions/platform.ts deleteStore):
 *   constraints deferred, so the cascade can remove rows that point at each
 *   other.
 */
async function resetShop(
  context: Context,
  fixture: RevampLiveFixture,
  log: Log,
) {
  const { lib } = context;
  const { stores } = lib.schema;
  const shop = await readShop(lib, fixture);
  if (!shop) {
    log("nothing to reset: the shop does not exist");
    return;
  }
  await lib.db.withService(async (db) => {
    await db.execute(sql`set constraints all deferred`);
    await db
      .delete(stores)
      .where(
        and(
          eq(stores.id, shop.id),
          sql`(${stores.settings} ->> ${MARK}::text) = 'true'`,
        ),
      );
  });
  const removed = await lib.gcs.gcsDeletePrefix(`stores/${shop.id}/`);
  log(
    `shop deleted; ${removed.deleted} stored file${removed.deleted === 1 ? "" : "s"} removed from the bucket${removed.error ? ` (${removed.error})` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// --setup
// ---------------------------------------------------------------------------

async function setupShop(
  context: Context,
  fixture: RevampLiveFixture,
  log: Log,
) {
  const { lib } = context;
  const { stores, admins, storeBillingSettings } = lib.schema;
  const created = await lib.db.withService(async (db) => {
    const [existing] = await db
      .select({ id: stores.id, settings: stores.settings })
      .from(stores)
      .where(eq(stores.slug, fixture.slug))
      .limit(1);
    if (existing) {
      const settings = record(existing.settings);
      if (settings[MARK] !== true) {
        throw new Error(
          `A store called ${fixture.slug} exists and was not made by this tool, so it is left alone.`,
        );
      }
      // ★ Open, whatever happened since: a closed store's pages redirect to
      //   its password page and cannot be photographed.
      if (settings.launched !== true) {
        await db
          .update(stores)
          .set({ settings: { ...settings, launched: true } })
          .where(eq(stores.id, existing.id));
      }
      return false;
    }
    const [store] = await db
      .insert(stores)
      .values({
        slug: fixture.slug,
        name: fixture.storeName,
        status: "active",
        // ★ Pro: on Free the theme's draft samples already fill the product
        //   cap, and Apply would refuse to create the merchant's products.
        plan: "pro",
        settings: {
          [MARK]: true,
          // Open, so the storefront is public and has no password page.
          launched: true,
          brand: { name: fixture.storeName },
          business: {
            country: "IN",
            city: fixture.place.city,
            state: fixture.place.state,
            timeZone: "Asia/Kolkata",
          },
        },
      })
      .returning({ id: stores.id });
    await db.insert(admins).values({
      id: ownerIdFor(fixture),
      email: ownerEmailFor(fixture),
      role: "superadmin",
      storeId: store.id,
      firstName: "Owner",
      lastName: fixture.storeName,
      forcePasswordReset: false,
    });
    await db
      .insert(storeBillingSettings)
      .values({
        storeId: store.id,
        businessName: fixture.storeName,
        contactEmail: ownerEmailFor(fixture),
        updatedBy: ownerIdFor(fixture),
      })
      .onConflictDoNothing();
    return true;
  });
  log(created ? "store created" : "store found");

  const shop = await requireShop(lib, fixture);
  const installed = record(shop.settings.theme).presetId;
  if (created || installed !== fixture.themeId) {
    const theme = await lib.registry.resolveThemeDefinition(fixture.themeId);
    if (theme.id !== fixture.themeId) {
      throw new Error(`The ${fixture.themeId} theme is not registered.`);
    }
    const result = await lib.apply.applyTheme(shop.id, fixture.themeId, {
      publish: true,
      actorUserId: shop.ownerId,
    });
    if (!result.success) {
      throw new Error(
        `Installing ${fixture.themeId} failed: ${result.errors.join("; ")}`,
      );
    }
    log(`theme ${theme.id} ${theme.release.version} installed and published`);
  } else {
    log(`theme ${fixture.themeId} already installed`);
  }

  const photos = await ensurePhonePhotos(context, shop, fixture, log);
  for (const photo of photos) {
    log(
      `phone photo ${photo.key} (${photo.kind}, ${photo.made ? "new" : "kept"}): ${photo.url}`,
    );
  }
  log(`storefront: ${context.origin(fixture.slug)}/`);
}

interface PhonePhoto {
  key: string;
  url: string;
  kind: "phone" | "theme";
  made: boolean;
}

/** Product keys are given by position, as `readRevampRequest` gives them. */
function productKey(index: number): string {
  return `p${index + 1}`;
}

function photoFilename(key: string, kind: PhonePhoto["kind"]): string {
  return `revamp-live-${key}-${kind}.webp`;
}

/**
 * The phone photo each product's request points at. ★ A real phone photo
 * (from --live) wins over a bundled one, and an existing photo is kept, so a
 * second --setup never pays for a photo again.
 */
async function phonePhotos(
  lib: Lib,
  shop: Shop,
  fixture: RevampLiveFixture,
): Promise<Map<string, PhonePhoto>> {
  const { mediaAssets } = lib.schema;
  const names = fixture.request.products.flatMap((_, index) => [
    photoFilename(productKey(index), "phone"),
    photoFilename(productKey(index), "theme"),
  ]);
  const rows = await lib.db.withService((db) =>
    db
      .select({ url: mediaAssets.url, filename: mediaAssets.filename })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.storeId, shop.id),
          inArray(mediaAssets.filename, names),
        ),
      )
      .orderBy(desc(mediaAssets.createdAt)),
  );
  const found = new Map<string, PhonePhoto>();
  fixture.request.products.forEach((_, index) => {
    const key = productKey(index);
    for (const kind of ["phone", "theme"] as const) {
      const row = rows.find((r) => r.filename === photoFilename(key, kind));
      if (row && !found.has(key))
        found.set(key, { key, url: row.url, kind, made: false });
    }
  });
  return found;
}

async function ensurePhonePhotos(
  context: Context,
  shop: Shop,
  fixture: RevampLiveFixture,
  log: Log,
): Promise<PhonePhoto[]> {
  const { lib, options } = context;
  const existing = await phonePhotos(lib, shop, fixture);
  const out: PhonePhoto[] = [];
  for (const [index, product] of fixture.request.products.entries()) {
    const key = productKey(index);
    const have = existing.get(key);
    // Offline any photo will do; live wants a real phone photo.
    if (have && (!options.live || have.kind === "phone")) {
      out.push(have);
      continue;
    }
    const kind: PhonePhoto["kind"] = options.live ? "phone" : "theme";
    const source = options.live
      ? await drawPhonePhoto(lib, product, log, key)
      : readBundledPhoto(product.photo.bundled);
    out.push({
      key,
      kind,
      made: true,
      url: await storePhonePhoto(lib, shop, key, kind, source),
    });
  }
  return out;
}

interface PhotoBytes {
  bytes: Uint8Array;
  type: string;
}

function readBundledPhoto(path: string): PhotoBytes {
  const types: Record<string, string> = {
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
  };
  const type = types[extname(path).toLowerCase()];
  const publicDir = join(process.cwd(), "public");
  const file = normalize(join(publicDir, path));
  // A fixture names a file under public/themes and nothing else.
  if (
    !type ||
    !path.startsWith("/themes/") ||
    !file.startsWith(publicDir + sep)
  ) {
    throw new Error(`${path} is not a bundled theme photo.`);
  }
  return { bytes: readFileSync(file), type };
}

/**
 * One amateur phone photo of a product, from Mink's own image client (the one
 * the redesign's product photos use). ★ Purpose `gallery`, never `product`:
 * a gallery picture is drawn with people refused outright, and there is no
 * real item to reference, because the shop is made up.
 */
async function drawPhonePhoto(
  lib: Lib,
  product: RevampLiveProduct,
  log: Log,
  key: string,
): Promise<PhotoBytes> {
  const prompt = `An everyday smartphone photo, taken by the shop owner for a quick online listing, of ${product.photo.scene}. Uneven window light, a little phone-camera grain, framed slightly off-centre, nothing styled like a studio or a campaign. No people, hands or faces anywhere, and no text, labels, logos or watermarks.`;
  const validation = lib.generationContract.validateMinkMediaGenerationRequest({
    purpose: "gallery",
    prompt,
    referenceImageUrls: [],
    alt: `Phone photo of ${product.name}`,
  });
  if (!validation.ok) {
    throw new Error(
      `The phone photo request for ${product.name} is invalid: ${validation.issues.join(" ")}`,
    );
  }
  log(`drawing a phone photo for ${key} (${product.name})`);
  const started = Date.now();
  // ★ This tool can wait, so every attempt gets its own clock (the revamp's
  //   product photos, L2-E): under the chat's one 45 s deadline for the whole
  //   call, waits included, a busy provider failed most setups (2026-10-23).
  const image = await lib.generation.generateMinkMediaImage(
    lib.config.getMinkConfig(),
    validation.value,
    [],
    {
      rateLimitRetries: 3,
      attemptTimeoutMs: 90_000,
      // ★ As a Mink chat image asks (owner, 25 Oct 2026): "2K", MINIMAL.
      imageSize: "2K",
      thinkingLevel: ThinkingLevel.MINIMAL,
    },
  );
  log(`phone photo for ${key} drawn in ${seconds(Date.now() - started)}`);
  return { bytes: image.bytes, type: image.mimeType || "image/jpeg" };
}

/**
 * Store a phone photo the way the Media Library stores an upload: the same
 * validation and WebP re-encode, the same folder, a `media_assets` row of
 * source `upload`, which is what makes it the store's own photo to the
 * redesign's ownership checks.
 */
async function storePhonePhoto(
  lib: Lib,
  shop: Shop,
  key: string,
  kind: PhonePhoto["kind"],
  source: PhotoBytes,
): Promise<string> {
  const filename = photoFilename(key, kind);
  const processed = await lib.processImage.processImageUpload(
    new File([new Uint8Array(source.bytes)], filename, { type: source.type }),
  );
  if (!processed.ok) throw new Error(`${filename}: ${processed.error}`);
  const { bytes, contentType, ext } = processed.data;
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const path = `stores/${shop.id}/media/revamp-live-${key}-${kind}-${digest}.${ext}`;
  const url = await lib.gcs.gcsUploadObject(path, bytes, contentType);
  await lib.db.withService((db) =>
    db.insert(lib.schema.mediaAssets).values({
      storeId: shop.id,
      url,
      path,
      filename,
      contentType,
      sizeBytes: bytes.length,
      createdBy: shop.ownerId,
      source: "upload",
    }),
  );
  return url;
}

// ---------------------------------------------------------------------------
// --run
// ---------------------------------------------------------------------------

async function runShop(
  context: Context,
  fixture: RevampLiveFixture,
  log: Log,
): Promise<boolean> {
  const { lib, options } = context;
  const shop = await requireShop(lib, fixture);
  const photos = await phonePhotos(lib, shop, fixture);
  const read = lib.request.readRevampRequest(
    {
      brief: fixture.request.brief,
      products: fixture.request.products.map((product, index) => {
        const photo = photos.get(productKey(index));
        if (!photo)
          throw new Error(
            `No phone photo for ${product.name}. Run --setup first.`,
          );
        return {
          name: product.name,
          description: product.description,
          sizes: product.sizes.map((size) => ({
            label: size.label,
            price: size.price,
            mrp: size.mrp ?? null,
          })),
          photo_url: photo.url,
          category_slug: product.categorySlug,
        };
      }),
      categories: fixture.request.categories,
      pages: null,
    },
    "full",
  );
  if (!read.ok)
    throw new Error(`The request does not read: ${read.issues.join(" ")}`);

  const started = Date.now();
  let revampId: string;
  let actor: MinkActorContext;
  const active = await activeRevampId(lib, shop.id);
  if (active) {
    // ★ One redesign builds at a time per store: an earlier run that was
    //   stopped half way is carried on rather than refused.
    const job = await lib.jobs.readRevampJob(active);
    if (!job) throw new Error("The redesign being built could not be read.");
    revampId = job.id;
    actor = await actorFor(lib, job);
    log(`carrying on the redesign already being built: ${revampId}`);
  } else {
    const { conversationId, runId } = await startChat(lib, shop);
    const rebuilt = await lib.actor.rebuildRevampActor(
      {
        storeId: shop.id,
        adminId: shop.ownerId,
        requesterEmail: shop.ownerEmail,
        originRunId: runId,
      },
      randomUUID(),
    );
    if (!rebuilt) throw new Error("The owner has no dashboard access.");
    actor = rebuilt;
    const budget = await budgetFor(lib, actor, read.value);
    if (budget === "refused") {
      throw new Error(
        "The store has too few credits left for a paid redesign (its free one is used).",
      );
    }
    const created = await lib.jobs.createRevampJob({
      actor,
      conversationId,
      kind: "full",
      request: read.value,
      parentId: null,
      budgetCredits: budget,
    });
    await finishChat(lib, runId);
    if (!created.ok) {
      revampId = created.activeId;
      log(`another redesign started first; carrying on with it: ${revampId}`);
    } else {
      revampId = created.job.id;
      log(
        `redesign queued: ${revampId} (${created.job.free ? "the store's free redesign" : `paid, budget ${created.job.budgetCredits ?? "unmetered"}`})`,
      );
    }
  }

  const watch = new ProgressWatch(log);
  const deadline = started + options.maxMinutes * 60_000;
  const { outcome, invocations } = await driveRevamp(
    lib,
    revampId,
    actor,
    watch,
    deadline,
    log,
  );
  const job = await lib.jobs.readRevampJob(revampId);
  const status = job?.status ?? "missing";
  log(
    `runner finished after ${invocations} invocation${invocations === 1 ? "" : "s"}: ${outcome}, status ${status}, ${seconds(Date.now() - started)}`,
  );
  await printOutcome(lib, actor, revampId, log);
  saveRunRecord(options.out, {
    slug: fixture.slug,
    revampId,
    storeId: shop.id,
    provider: options.live ? "vertex" : "fake",
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    totalMs: Date.now() - started,
    invocations,
    outcome,
    status,
    timings: watch.timings(),
  });
  return status === "ready";
}

async function activeRevampId(
  lib: Lib,
  storeId: string,
): Promise<string | null> {
  const { minkRevamps } = lib.schema;
  const [row] = await lib.db.withService((db) =>
    db
      .select({ id: minkRevamps.id })
      .from(minkRevamps)
      .where(
        and(
          eq(minkRevamps.storeId, storeId),
          inArray(minkRevamps.status, ["queued", "running"]),
        ),
      )
      .limit(1),
  );
  return row?.id ?? null;
}

/**
 * The rows the chat writes before its start tool runs: a conversation and a
 * run for the owner. ★ The job's `origin_run_id` is that run, and the review
 * card's draft belongs to it, so a job with no run could never finish.
 */
async function startChat(
  lib: Lib,
  shop: Shop,
): Promise<{ conversationId: string; runId: string }> {
  const { minkConversations, minkRuns } = lib.schema;
  const conversationId = randomUUID();
  const runId = randomUUID();
  await lib.db.withService(async (db) => {
    await db.insert(minkConversations).values({
      id: conversationId,
      storeId: shop.id,
      adminId: shop.ownerId,
      title: "Customise my store for my business",
    });
    await db.insert(minkRuns).values({
      id: runId,
      storeId: shop.id,
      conversationId,
      requestedBy: shop.ownerId,
      requestId: randomUUID(),
      status: "running",
      model: lib.config.getMinkConfig().model,
      currentPath: "/dashboard",
    });
  });
  return { conversationId, runId };
}

/** The chat's run ends once the start tool has answered, as it does in chat. */
async function finishChat(lib: Lib, runId: string): Promise<void> {
  const { minkRuns } = lib.schema;
  await lib.db.withService((db) =>
    db
      .update(minkRuns)
      .set({ status: "succeeded", completedAt: new Date().toISOString() })
      .where(eq(minkRuns.id, runId)),
  );
}

/**
 * The budget the start tool gives a job: its `budgetFor`
 * (lib/mink/tools/storefront-revamp-tools.ts), which is not exported, so this
 * mirrors it line for line. ★ The store's remaining credits LESS what the
 * starting chat run may still cost (MINK_MAX_RUN_CREDITS), or null when the
 * plan is unmetered; a paid start whose budget cannot cover the redesign's
 * fixed part (assemble.ts revampFixedCreditCeiling, the rule the budget fit
 * follows) is refused. A redesign that turns out free drops the budget under
 * the store's lock (jobs.ts). Keep it in step with the tool.
 */
async function budgetFor(
  lib: Lib,
  actor: MinkActorContext,
  request: RevampRequest,
): Promise<number | null | "refused"> {
  const { minkRevamps } = lib.schema;
  const [taken] = await lib.db.withService((db) =>
    db
      .select({ id: minkRevamps.id })
      .from(minkRevamps)
      .where(
        and(
          eq(minkRevamps.storeId, actor.storeId),
          eq(minkRevamps.kind, "full"),
          eq(minkRevamps.free, true),
          inArray(minkRevamps.status, lib.jobs.FREE_HOLDING_STATUSES),
        ),
      )
      .limit(1),
  );
  const headroom = await lib.credits.imageCreditHeadroom(
    actor,
    lib.config.getMinkConfig().chargeCredits,
  );
  if (headroom.remaining === null) return null;
  const budget = Math.max(
    0,
    headroom.remaining - lib.metering.MINK_MAX_RUN_CREDITS,
  );
  const fixed = lib.assemble.revampFixedCreditCeiling(request, null);
  if (taken && budget < fixed) return "refused";
  return budget;
}

/** The requester as they are now, as the runner rebuilds them at each claim. */
async function actorFor(
  lib: Lib,
  job: RevampJobRow,
): Promise<MinkActorContext> {
  const actor = await lib.actor.rebuildRevampActor(
    {
      storeId: job.storeId,
      adminId: job.adminId,
      requesterEmail: job.requesterEmail,
      originRunId: job.originRunId,
    },
    randomUUID(),
  );
  if (!actor)
    throw new Error("The redesign's owner no longer has dashboard access.");
  return actor;
}

/**
 * Claim and run until the job settles, as the run route does, one invocation
 * after another: the loop in revamp-live-check-core.ts (tested there), over
 * this machine's runner, the runner's read and the card's status read. ★ A
 * parked lease is waited out, never polled; a job past its ceiling (B8) is
 * settled by the status read, as the card would; the whole thing stops at the
 * deadline rather than waiting on a job forever.
 */
function driveRevamp(
  lib: Lib,
  revampId: string,
  actor: MinkActorContext,
  watch: ProgressWatch,
  deadline: number,
  log: Log,
): Promise<{ outcome: string; invocations: number }> {
  const jobs = instrumentedJobs(lib, watch);
  return driveRevampLoop(
    {
      run: () =>
        lib.runner.runRevampJob({
          revampId,
          deps: lib.deps.defaultRevampDeps(),
          requestId: randomUUID(),
          jobs,
        }),
      read: () => lib.jobs.readRevampJob(revampId),
      readStatus: () => lib.jobs.readRevampStatus(actor, revampId),
      sleep,
      now: Date.now,
      log,
      ceilingMs: lib.jobs.REVAMP_RUN_CEILING_MS,
    },
    deadline,
  );
}

/**
 * The runner's real side effects with two changes: no kick, of this job or of
 * a waiting one (this loop is the runner, and a kick would wake a server to
 * work on the same jobs), and every progress write watched, for the lines and
 * the step timings. The photo hold is the real write: it is part of the job.
 */
function instrumentedJobs(lib: Lib, watch: ProgressWatch): RevampRunnerJobs {
  const { jobs, actor, images, record: events } = lib;
  return {
    claim: async (revampId) => {
      const claimed = await jobs.claimRevampJob(revampId);
      if (claimed) watch.claimed(claimed.job);
      return claimed;
    },
    renew: jobs.renewRevampLease,
    release: jobs.releaseRevampLease,
    save: async (input) => {
      const saved = await jobs.saveRevampStep(input);
      if (saved) watch.observe(input.progress);
      return saved;
    },
    report: async (revampId, leaseToken, progress) => {
      await jobs.reportRevampProgress(revampId, leaseToken, progress);
      watch.observe(progress);
    },
    finish: async (input) => {
      const finished = await jobs.finishRevampReady(input);
      if (finished) watch.finished();
      return finished;
    },
    fail: async (input) => {
      watch.failed(input.code, input.detail);
      return jobs.failRevampJob(input);
    },
    cancel: jobs.markRevampCancelled,
    read: jobs.readRevampJob,
    rebuildActor: actor.rebuildRevampActor,
    listImages: images.listRevampImages,
    kick: async () => {},
    kickWaiting: async () => 0,
    hold: jobs.holdRevampPhotos,
    reviews: jobs.recordRevampPhotoReviews,
    notify: (event) => events.recordEvent(event),
  };
}

interface StepTiming {
  startedAt: string | null;
  finishedAt: string | null;
  ms: number | null;
  state: string;
}

/** Prints each step as the runner moves, and remembers when it did. */
class ProgressWatch {
  private seen = new Map<RevampStep, string>();
  private started = new Map<RevampStep, number>();
  private ended = new Map<RevampStep, number>();
  private states = new Map<RevampStep, string>();

  constructor(private readonly log: Log) {}

  claimed(job: RevampJobRow) {
    // ★ The runner says nothing until the first step's output is saved, so
    //   the claim is when the job's current step started.
    for (const item of job.progress) {
      if (!this.seen.has(item.step)) this.seen.set(item.step, signature(item));
      this.states.set(item.step, item.state);
    }
    this.begin(job.step, null);
  }

  observe(progress: RevampProgressItem[]) {
    for (const item of progress) {
      const key = signature(item);
      if (this.seen.get(item.step) === key) continue;
      this.seen.set(item.step, key);
      this.states.set(item.step, item.state);
      if (item.state === "running") this.begin(item.step, item.detail);
      else if (item.state === "done" || item.state === "skipped")
        this.end(item.step, item.state);
    }
  }

  finished() {
    this.end("card", "done");
  }

  failed(code: string, detail: string) {
    this.log(`failed: ${code} (${detail})`);
  }

  timings(): Record<string, StepTiming> {
    const out: Record<string, StepTiming> = {};
    for (const step of STEPS) {
      const started = this.started.get(step) ?? null;
      const ended = this.ended.get(step) ?? null;
      out[step] = {
        startedAt: started === null ? null : new Date(started).toISOString(),
        finishedAt: ended === null ? null : new Date(ended).toISOString(),
        ms: started !== null && ended !== null ? ended - started : null,
        state: this.states.get(step) ?? "waiting",
      };
    }
    return out;
  }

  private begin(step: RevampStep, detail: string | null) {
    const first = !this.started.has(step);
    if (first) this.started.set(step, Date.now());
    this.states.set(step, "running");
    if (first || detail)
      this.log(`${step}: running${detail ? ` (${detail})` : ""}`);
  }

  private end(step: RevampStep, state: string) {
    if (this.ended.has(step)) return;
    const now = Date.now();
    this.ended.set(step, now);
    this.states.set(step, state);
    const started = this.started.get(step);
    this.log(
      `${step}: ${state}${started === undefined ? "" : ` in ${seconds(now - started)}`}`,
    );
  }
}

function signature(item: RevampProgressItem): string {
  return `${item.state}|${item.detail ?? ""}`;
}

/** What the card would show, and what the run cost. */
async function printOutcome(
  lib: Lib,
  actor: MinkActorContext,
  revampId: string,
  log: Log,
) {
  const view = await lib.jobs.readRevampStatus(actor, revampId);
  const job = await lib.jobs.readRevampJob(revampId);
  if (!view || !job) {
    log("the redesign could not be read back");
    return;
  }
  if (view.status === "failed") {
    log(
      `error: ${view.error ?? "(none)"} [${job.errorCode ?? "?"}: ${job.errorDetail ?? ""}]`,
    );
  }
  const review = view.review;
  if (review) {
    log(`summary: ${review.summary}`);
    for (const page of review.pages) {
      log(
        `  page /${page.slug} "${page.title}"${page.create ? " (new)" : ""}: ${page.changes.added} added, ${page.changes.removed} removed, ${page.changes.kept} kept, ${page.changes.photos} photos`,
      );
    }
    for (const product of review.products) {
      log(
        `  product ${product.name} (${product.sizes.join(", ") || "one size"}) at ${rupees(product.price)}${product.mrp ? `, MRP ${rupees(product.mrp)}` : ""}${product.imageUrl ? "" : ", no studio photo"}`,
      );
    }
    if (review.hiddenSampleProducts)
      log(
        `  sample products taken off the shop: ${review.hiddenSampleProducts}`,
      );
    for (const change of review.liveChanges) log(`  live at Apply: ${change}`);
    log(
      `checks (${review.checks.filter((c) => c.passed).length} of ${review.checks.length} passed):`,
    );
    for (const check of review.checks) {
      log(
        `  [${check.passed ? "ok" : "!!"}] ${check.label}${check.note ? `: ${check.note}` : ""}`,
      );
    }
    if (review.skipped.length) {
      log("not done this time:");
      for (const item of review.skipped) log(`  ${item.label}: ${item.reason}`);
    } else {
      log("not done this time: nothing");
    }
    for (const note of review.notes) log(`  note: ${note}`);
  }
  const outcomes = job.result?.photos?.outcomes ?? [];
  if (outcomes.length) {
    const count = (status: string) =>
      outcomes.filter((o) => o.status === status).length;
    log(
      `photos: ${count("generated")} drawn, ${count("failed")} failed, ${count("skipped")} skipped`,
    );
    for (const outcome of outcomes.filter((o) => o.status === "failed")) {
      log(`  ${outcome.shotId}: ${outcome.reason ?? "failed"}`);
    }
  }
  for (const failure of job.result?.products?.failed ?? []) {
    log(`  product photo ${failure.key}: ${failure.reason}`);
  }
  // ★ Why each photograph was drawn again, and how its check went (P0), so a
  //   live run can explain its redraws and its waits.
  for (const outcome of outcomes) {
    for (const redraw of outcome.redraws ?? []) {
      log(
        `  redraw ${outcome.shotId} after attempt ${redraw.attempt}: ${redraw.problems.join(", ") || "no detail"}`,
      );
    }
  }
  for (const [key, redraws] of Object.entries(
    job.result?.products?.redraws ?? {},
  )) {
    for (const redraw of redraws) {
      log(
        `  redraw product ${key} after attempt ${redraw.attempt}: ${redraw.problems.join(", ") || "no detail"}`,
      );
    }
  }
  for (const [shotId, check] of Object.entries(
    job.result?.photoReviews?.shots ?? {},
  )) {
    if (!check.firstAskedAt) continue;
    const verdict =
      check.verdict === "expired"
        ? "no answer in time"
        : check.verdict
          ? check.verdict.problems.join(", ") || "passed"
          : "still waiting";
    log(`  check ${shotId}: ${check.tries} tries, ${verdict}`);
  }
  const usage = job.usage;
  log(
    `model usage: ${usage.inputTokens} input, ${usage.outputTokens} output, ${usage.thinkingTokens} thinking tokens; ${usage.images} images, ${usage.reviews} reviews; about $${(usage.estimatedCostMicroUsd / 1e6).toFixed(3)}`,
  );
  for (const [model, counts] of Object.entries(usage.calls ?? {})) {
    log(
      `  ${model}: ${counts.rateLimited} refused with 429, ${counts.timeouts} timed out`,
    );
  }
  log(
    `credits charged: ${job.credits}${job.free ? " (the store's free redesign)" : ""}`,
  );
}

// ---------------------------------------------------------------------------
// The card's three buttons.
// ---------------------------------------------------------------------------

/** The newest redesign of the shop that `pick` accepts, or the one named. */
async function pickRevamp(
  lib: Lib,
  shop: Shop,
  named: string | null,
  pick: (job: RevampJobRow) => boolean,
  what: string,
): Promise<RevampJobRow> {
  const { minkRevamps } = lib.schema;
  if (named) {
    const job = await lib.jobs.readRevampJob(named);
    if (!job || job.storeId !== shop.id)
      throw new Error(`Redesign ${named} is not this shop's.`);
    return job;
  }
  const rows = await lib.db.withService((db) =>
    db
      .select({ id: minkRevamps.id })
      .from(minkRevamps)
      .where(eq(minkRevamps.storeId, shop.id))
      .orderBy(desc(minkRevamps.createdAt))
      .limit(20),
  );
  for (const row of rows) {
    const job = await lib.jobs.readRevampJob(row.id);
    if (job && pick(job)) return job;
  }
  throw new Error(`The shop has no redesign ${what}.`);
}

async function applyShop(
  context: Context,
  fixture: RevampLiveFixture,
  named: string | null,
  log: Log,
): Promise<string> {
  const { lib } = context;
  const shop = await requireShop(lib, fixture);
  const job = await pickRevamp(
    lib,
    shop,
    named,
    (row) => row.status === "ready" && row.draftId !== null && !row.appliedAt,
    "ready to apply (run --run first)",
  );
  if (!job.draftId) throw new Error("The redesign has no review card yet.");
  const actor = await actorFor(lib, job);
  log(`Apply to Website Builder draft: ${job.id}`);
  // The card's own sequence: the preview makes the exact approval, the
  // execute consumes it.
  const approval = await lib.actions.previewMinkStorefrontPersonalizationAction(
    {
      actor,
      draftId: job.draftId,
      expectedDraftVersion: 0,
      idempotencyKey: randomUUID(),
    },
  );
  log(
    `  approval ${approval.id} (${approval.status}), ${approval.pages.length} pages${approval.chromeChanged ? ", header and footer" : ""}`,
  );
  const result = await lib.actions.executeMinkStorefrontPersonalizationAction({
    actor,
    draftId: job.draftId,
    approvalId: approval.id,
  });
  log(
    `  applied${result.repeated ? " (already applied)" : ""}: audit ${result.auditId}`,
  );
  const stored = job.result?.stored;
  if (stored) {
    for (const change of lib.contract.revampLiveChanges(stored))
      log(`  live now: ${change}`);
  }
  return job.id;
}

async function publishShop(
  context: Context,
  fixture: RevampLiveFixture,
  named: string | null,
  log: Log,
) {
  const { lib } = context;
  const shop = await requireShop(lib, fixture);
  const job = await pickRevamp(
    lib,
    shop,
    named,
    (row) => Boolean(row.appliedAt) && !row.undoneAt,
    "applied and not undone (run --apply first)",
  );
  const actor = await actorFor(lib, job);
  log(`Publish to your store: ${job.id}`);
  const result = await lib.publish.publishRevamp(actor, job.id);
  log(`  published: ${result.published.join(", ") || "nothing"}`);
  for (const item of result.skipped)
    log(`  skipped ${item.label}: ${item.reason}`);
  log(`  storefront: ${context.origin(fixture.slug)}/`);
}

async function undoShop(
  context: Context,
  fixture: RevampLiveFixture,
  named: string | null,
  log: Log,
) {
  const { lib } = context;
  const shop = await requireShop(lib, fixture);
  const job = await pickRevamp(
    lib,
    shop,
    named,
    (row) => Boolean(row.appliedAt),
    "that was applied (run --apply first)",
  );
  const actor = await actorFor(lib, job);
  log(`Undo: ${job.id}`);
  const result = await lib.publish.undoRevamp(actor, job.id);
  log(`  restored: ${result.restored.join(", ") || "nothing"}`);
  for (const item of result.kept) log(`  kept ${item.label}: ${item.reason}`);
}

// ---------------------------------------------------------------------------
// --report
// ---------------------------------------------------------------------------

interface RunRecord {
  slug: string;
  revampId: string;
  storeId: string;
  provider: "vertex" | "fake";
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  invocations: number;
  outcome: string;
  status: string;
  timings: Record<string, StepTiming>;
}

function runRecordPath(out: string, slug: string): string {
  return join(out, "runs", `${slug}.json`);
}

function saveRunRecord(out: string, run: RunRecord) {
  mkdirSync(join(out, "runs"), { recursive: true });
  writeFileSync(runRecordPath(out, run.slug), JSON.stringify(run, null, 2));
}

function readRunRecord(out: string, slug: string): RunRecord | null {
  const path = runRecordPath(out, slug);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

async function writeReport(context: Context, fixtures: RevampLiveFixture[]) {
  const { lib, options } = context;
  const { minkRevamps } = lib.schema;
  const shops: Record<string, unknown>[] = [];
  for (const fixture of fixtures) {
    const base = context.origin(fixture.slug);
    const shop = await readShop(lib, fixture);
    if (!shop) {
      shops.push({
        slug: fixture.slug,
        storeName: fixture.storeName,
        exists: false,
      });
      continue;
    }
    const [latest] = await lib.db.withService((db) =>
      db
        .select({ id: minkRevamps.id })
        .from(minkRevamps)
        .where(eq(minkRevamps.storeId, shop.id))
        .orderBy(desc(minkRevamps.createdAt))
        .limit(1),
    );
    const job = latest ? await lib.jobs.readRevampJob(latest.id) : null;
    const stored: RevampStoredPlan | null = job?.result?.stored ?? null;
    const run = readRunRecord(options.out, fixture.slug);
    const pageUrl = (slug: string) => (slug ? `${base}/${slug}` : `${base}/`);
    shops.push({
      slug: fixture.slug,
      storeName: fixture.storeName,
      themeId: fixture.themeId,
      storeId: shop.id,
      storefront: `${base}/`,
      revamp: job
        ? {
            id: job.id,
            kind: job.kind,
            status: job.status,
            step: job.step,
            free: job.free,
            credits: job.credits,
            usage: job.usage,
            errorCode: job.errorCode,
            errorDetail: job.errorDetail,
            createdAt: job.createdAt,
            finishedAt: job.finishedAt,
            appliedAt: job.appliedAt,
            publishedAt: job.publishedAt,
            undoneAt: job.undoneAt,
          }
        : null,
      // Every page the redesign wrote, the homepage first, then the shop.
      pages: stored
        ? [
            ...stored.pages.map((page) => ({
              slug: page.slug,
              title: page.title,
              created: page.create,
              url: pageUrl(page.slug),
            })),
            {
              slug: "shop",
              title: "Shop",
              created: false,
              url: `${base}/shop`,
            },
          ]
        : [],
      products: stored
        ? stored.products.create.map((product) => ({
            name: product.name,
            url: `${base}/shop/${product.slug}`,
          }))
        : [],
      collections: stored
        ? stored.categories
            .filter(
              (category) =>
                category.action !== "hide" && Boolean(category.slug),
            )
            .map((category) => ({
              name: category.name,
              url: `${base}/collections/${category.slug}`,
            }))
        : [],
      run:
        run && job && run.revampId === job.id
          ? {
              provider: run.provider,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              totalMs: run.totalMs,
              invocations: run.invocations,
              outcome: run.outcome,
              timings: run.timings,
            }
          : null,
      checks: stored?.checks ?? [],
      skipped: stored?.skipped ?? [],
    });
  }
  mkdirSync(options.out, { recursive: true });
  const path = join(options.out, "report.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        database: process.env.DB_NAME,
        shops,
      },
      null,
      2,
    ),
  );
  console.log(`Report written: ${path}`);
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Rupees with Indian digit grouping, as the card shows them. */
function rupees(amount: number): string {
  return `₹${amount.toLocaleString("en-IN")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string"
      ? `${error.message} [${code}]`
      : error.message;
  }
  return String(error);
}

main()
  .then(async (code) => {
    // The pool keeps the process alive; close it so the exit code is ours.
    // A refusal never loaded the client, so there is nothing to close.
    if (loaded) await loaded.db.closePool().catch(() => undefined);
    process.exit(code);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
