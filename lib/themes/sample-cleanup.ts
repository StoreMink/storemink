import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { readThemeSelection } from "./meta";
import { THEME_DEFINITIONS } from "./index";
import { resolveInstalledThemeDefinition } from "./runtime-registry";
import {
  chromeWithoutRemovedSamples,
  menusWithoutRemovedSamples,
  removedSampleAddresses,
  sampleSeedsFor,
  sectionsWithoutRemovedSamples,
  type SampleSeeds,
} from "./sample-cleanup-rules";
import { homepageEditedSinceSeed, SEED_WINDOW_MS } from "./switch-rules";
import type { ThemeDefinition } from "./types";

// ---------------------------------------------------------------------------
// Remove the theme sample products and categories an older install left in a
// merchant's store, and the links to them. One store, one transaction.
//
// The rules are in sample-cleanup-rules.ts; scripts/remove-theme-samples.ts
// runs this for every store, as a dry run unless told to commit.
//
// ★ NEVER TOUCHED: a product anyone ordered, one in an offer, one with a
// review, one a return swaps to, one a page section or the POS layout picks by
// id, one StoreMink blocked; a category with any product left in it, one in an
// offer, one a page section picks by id, one StoreMink blocked. Demo and
// Theme Studio preview stores keep their samples (the script never passes
// them), and a store on a legal hold is left alone.
//
// ★ LINKS GO WITH THE SAMPLES. A header, footer or page button that pointed at
// a removed sample would 404, so each is taken out (a menu link) or sent to
// the shop (a page button), in store_menus, both halves of store_chrome and
// both halves of every page. Nothing else in those values changes. A homepage
// still in the theme's words records the rewrite as the theme's own
// (settings.theme.homepageSeededAt), so the go-live checklist does not read
// the clean-up as the merchant personalising it.
//
// ⚠ It runs outside Next, so it busts no cache. Storefront reads are memoized
// for one request only (CODEBASE.md §5 item 5), so the next request sees the
// change.
// ---------------------------------------------------------------------------

const SEED_WINDOW_SECONDS = SEED_WINDOW_MS / 1000;

export interface SampleCleanupStore {
  id: string;
  slug: string;
  settings: unknown;
}

export interface RemovedSample {
  id: string;
  slug: string;
  name: string;
}

export interface SampleCleanupReport {
  storeId: string;
  slug: string;
  /** False when the store was skipped; `skipped` says why. */
  cleaned: boolean;
  skipped: "legal_hold" | null;
  products: RemovedSample[];
  categories: RemovedSample[];
  /** store_menus changed. */
  menus: boolean;
  chromeDraft: boolean;
  chromePublished: boolean;
  /** Slugs of the pages whose links changed ("" is the homepage). */
  pages: string[];
  /** Nothing was written: a dry run, or nothing to remove. */
  dryRun: boolean;
}

type Row = Record<string, unknown>;

function rowsOf(res: unknown): Row[] {
  return ((res as { rows?: unknown[] } | null)?.rows ?? []) as Row[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The seeds a store's samples may come from: every bundled theme release and
 * the theme the store has installed (a Theme Studio release included). A
 * theme that no longer resolves only means its own seeds are not checked.
 */
export async function sampleSeedsForStore(
  settings: unknown,
): Promise<SampleSeeds> {
  const themes: Pick<ThemeDefinition, "preset">[] = [...THEME_DEFINITIONS];
  const installed = await resolveInstalledThemeDefinition(
    readThemeSelection(record(settings)),
  ).catch(() => null);
  if (installed) themes.push(installed);
  return sampleSeedsFor(themes);
}

function productSeedValues(seeds: SampleSeeds): SQL {
  return sql.join(
    seeds.products.map(
      (s) =>
        sql`(${s.slug}::text, ${s.name}::text, ${s.description}::text, ${s.imageUrl}::text, ${s.basePrice}::numeric, ${s.sellingPrice}::numeric)`,
    ),
    sql`, `,
  );
}

function categorySeedValues(seeds: SampleSeeds): SQL {
  return sql.join(
    seeds.categories.map(
      (s) =>
        sql`(${s.slug}::text, ${s.name}::text, ${s.description}::text, ${s.imageUrl}::text)`,
    ),
    sql`, `,
  );
}

/** "" and null are one value for a stored description or photo. */
function sameText(column: SQL, seed: SQL): SQL {
  return sql`coalesce(${column}, '') = coalesce(${seed}, '')`;
}

/**
 * Find (and, with `commit`, remove) one store's samples and the links to
 * them, in one transaction. Throws on a database error, so the caller reports
 * the store as failed and nothing of it is half written.
 */
export async function cleanStoreSamples(
  store: SampleCleanupStore,
  seeds: SampleSeeds,
  options: { commit: boolean },
): Promise<SampleCleanupReport> {
  const report: SampleCleanupReport = {
    storeId: store.id,
    slug: store.slug,
    cleaned: false,
    skipped: null,
    products: [],
    categories: [],
    menus: false,
    chromeDraft: false,
    chromePublished: false,
    pages: [],
    dryRun: !options.commit,
  };

  return withService(async (db) => {
    const held = rowsOf(
      await db.execute(sql`
        select 1 from store_legal_holds
        where store_id = ${store.id} and released_at is null
        limit 1
      `),
    );
    if (held.length > 0) {
      report.skipped = "legal_hold";
      return report;
    }

    // --- The samples, locked so nothing assigns or orders them meanwhile ---
    const products =
      seeds.products.length === 0
        ? []
        : rowsOf(
            await db.execute(sql`
              select p.id, p.slug, p.name
              from products p
              join (values ${productSeedValues(seeds)})
                as seed(slug, name, description, image_url, base_price, selling_price)
                on seed.slug = p.slug and seed.name = p.name
              where p.store_id = ${store.id}
                and p.status = 'draft'
                and p.moderation_blocked_at is null
                and (
                  abs(extract(epoch from (p.content_updated_at - p.created_at))) <= ${SEED_WINDOW_SECONDS}
                  or (
                    ${sameText(sql`p.description`, sql`seed.description`)}
                    and ${sameText(sql`p.image_url`, sql`seed.image_url`)}
                    and p.selling_price = seed.selling_price
                    and p.base_price is not distinct from seed.base_price
                  )
                )
                and not exists (select 1 from order_items oi where oi.product_id = p.id)
                and not exists (
                  select 1 from offer_products op
                  left join product_variants v on v.id = op.variant_id
                  where op.product_id = p.id or v.product_id = p.id
                )
                and not exists (select 1 from product_reviews r where r.product_id = p.id)
                and not exists (
                  select 1 from order_return_items ri where ri.exchange_product_id = p.id
                )
                and not exists (
                  select 1 from store_pages sp
                  where sp.store_id = p.store_id
                    and (strpos(sp.sections::text, p.id::text) > 0
                      or strpos(sp.published_sections::text, p.id::text) > 0)
                )
                and not exists (
                  select 1 from pos_layouts pl
                  where pl.store_id = p.store_id
                    and strpos(pl.items::text, p.id::text) > 0
                )
              order by p.slug
              for update of p
            `),
          );
    const productIds = products.map((row) => String(row.id));

    const categories =
      seeds.categories.length === 0
        ? []
        : rowsOf(
            await db.execute(sql`
              select c.id, c.slug, c.name
              from categories c
              join (values ${categorySeedValues(seeds)})
                as seed(slug, name, description, image_url)
                on seed.slug = c.slug and seed.name = c.name
              where c.store_id = ${store.id}
                and c.moderation_blocked_at is null
                and (
                  abs(extract(epoch from (c.updated_at - c.created_at))) <= ${SEED_WINDOW_SECONDS}
                  or (
                    ${sameText(sql`c.description`, sql`seed.description`)}
                    and ${sameText(sql`c.image_url`, sql`seed.image_url`)}
                  )
                )
                and not exists (
                  select 1 from products p2
                  where p2.category_id = c.id
                    and not (p2.id::text = any(${sql.param(productIds)}::text[]))
                )
                and not exists (select 1 from offer_products op where op.category_id = c.id)
                and not exists (
                  select 1 from store_pages sp
                  where sp.store_id = c.store_id
                    and (strpos(sp.sections::text, c.id::text) > 0
                      or strpos(sp.published_sections::text, c.id::text) > 0)
                )
              order by c.slug
              for update of c
            `),
          );

    report.products = products.map((row) => ({
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
    }));
    report.categories = categories.map((row) => ({
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
    }));
    if (report.products.length === 0 && report.categories.length === 0) {
      report.dryRun = true;
      return report;
    }

    const addresses = removedSampleAddresses({
      productSlugs: report.products.map((p) => p.slug),
      categorySlugs: report.categories.map((c) => c.slug),
    });

    // --- The links to them ---------------------------------------------------
    const [menuRow] = rowsOf(
      await db.execute(sql`
        select header, footer_groups, footer_legal from store_menus
        where store_id = ${store.id}
        for update
      `),
    );
    const menus = menuRow
      ? menusWithoutRemovedSamples(
          {
            header: menuRow.header,
            footerGroups: menuRow.footer_groups,
            footerLegal: menuRow.footer_legal,
          },
          addresses,
        )
      : null;
    report.menus = !!menus;

    const [chromeRow] = rowsOf(
      await db.execute(sql`
        select draft, published from store_chrome
        where store_id = ${store.id}
        for update
      `),
    );
    const chromeDraft = chromeRow
      ? chromeWithoutRemovedSamples(chromeRow.draft, addresses)
      : null;
    const chromePublished = chromeRow
      ? chromeWithoutRemovedSamples(chromeRow.published, addresses)
      : null;
    report.chromeDraft = !!chromeDraft;
    report.chromePublished = !!chromePublished;

    const pageRows = rowsOf(
      await db.execute(sql`
        select id, slug, sections, published_sections, created_at::text as created_at,
               updated_at::text as updated_at
        from store_pages
        where store_id = ${store.id}
        order by slug
        for update
      `),
    );
    const pageEdits = pageRows.flatMap((row) => {
      const sections = sectionsWithoutRemovedSamples(row.sections, addresses);
      const published = sectionsWithoutRemovedSamples(
        row.published_sections,
        addresses,
      );
      return sections || published ? [{ row, sections, published }] : [];
    });
    report.pages = pageEdits.map((edit) => String(edit.row.slug));

    if (!options.commit) return report;

    // --- Writes --------------------------------------------------------------
    if (productIds.length > 0) {
      await db.execute(sql`
        delete from products
        where store_id = ${store.id}
          and id::text = any(${sql.param(productIds)}::text[])
      `);
    }
    const categoryIds = report.categories.map((c) => c.id);
    if (categoryIds.length > 0) {
      // ★ Re-checked in the delete itself: a category a product still sits in
      // stays, whatever was read above.
      await db.execute(sql`
        delete from categories c
        where c.store_id = ${store.id}
          and c.id::text = any(${sql.param(categoryIds)}::text[])
          and not exists (select 1 from products p where p.category_id = c.id)
      `);
    }
    if (menus) {
      await db.execute(sql`
        update store_menus
        set header = ${JSON.stringify(menus.header)}::jsonb,
            footer_groups = ${JSON.stringify(menus.footerGroups)}::jsonb,
            footer_legal = ${JSON.stringify(menus.footerLegal)}::jsonb
        where store_id = ${store.id}
      `);
    }
    if (chromeDraft || chromePublished) {
      await db.execute(sql`
        update store_chrome
        set draft = ${
          chromeDraft ? sql`${JSON.stringify(chromeDraft)}::jsonb` : sql`draft`
        },
            published = ${
              chromePublished
                ? sql`${JSON.stringify(chromePublished)}::jsonb`
                : sql`published`
            }
        where store_id = ${store.id}
      `);
    }

    let homepageRewrittenAt: string | null = null;
    for (const edit of pageEdits) {
      const [written] = rowsOf(
        await db.execute(sql`
          update store_pages
          set sections = ${
            edit.sections
              ? sql`${JSON.stringify(edit.sections)}::jsonb`
              : sql`sections`
          },
              published_sections = ${
                edit.published
                  ? sql`${JSON.stringify(edit.published)}::jsonb`
                  : sql`published_sections`
              }
          where id = ${String(edit.row.id)}
          returning updated_at::text as updated_at
        `),
      );
      const wasSeed =
        edit.row.slug === "" &&
        !homepageEditedSinceSeed(store.settings, {
          createdAt: String(edit.row.created_at),
          updatedAt: String(edit.row.updated_at),
        });
      if (wasSeed && written) homepageRewrittenAt = String(written.updated_at);
    }

    // ★ The homepage was still the theme's: say so, or its new updated_at
    // reads as the merchant personalising it.
    if (homepageRewrittenAt) {
      await db.execute(sql`
        update stores
        set settings = jsonb_set(
          settings,
          '{theme,homepageSeededAt}',
          to_jsonb(${homepageRewrittenAt}::text),
          true
        )
        where id = ${store.id}
          and jsonb_typeof(settings -> 'theme') = 'object'
      `);
    }

    report.cleaned = true;
    report.dryRun = false;
    return report;
  });
}
