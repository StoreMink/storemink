import { and, asc, desc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { blogs, categories, products, stores } from "@/drizzle/schema";
import { requireSectionAccess, getActingStoreId } from "../lib/access";
import { listPages, ensureHomepage } from "@/app/actions/page-actions";
import { getStoreBrandForEditing } from "@/lib/store/brand";
import { blockedItemIds } from "@/lib/moderation/merchant";
import { getDraftChromeForEditor } from "@/lib/chrome/queries";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import { themeDesignDefaults } from "@/lib/chrome/design";
import { themeTemplates } from "@/lib/themes/templates";
import { resolveInstalledThemeDefinition } from "@/lib/themes/runtime-registry";
import { readThemeSelection } from "@/lib/themes/meta";
import { schemeDesignFor } from "@/lib/themes/schemes";
import { isThemePending } from "@/lib/store/launch-state";
import { BuilderClient } from "./builder-client";
import { ChooseThemeFirst } from "./choose-theme-first";
import type { BlogOption, CategoryOption, ProductOption } from "./section-form";
import "./builder.css";

// The website builder is a full-viewport experience opened in a new tab. It
// still lives under /dashboard so the proxy auth gate applies.
export default async function BuilderPage() {
  const access = await requireSectionAccess("builder", "view");

  const storeId = await getActingStoreId();

  // Read first: the store's settings decide whether there is anything to edit
  // at all. (Moved up from below the loaders, so no extra sequential step.)
  const [storeRow] = await withService((db) =>
    db
      .select({ settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  );

  // ★ A store with no theme yet gets a prompt, not the editor — and the check
  // comes BEFORE ensureHomepage, which would otherwise create a blank homepage
  // row on a store whose first theme is about to install one. The storefront
  // shows a store-in-progress page until a theme is chosen, so the builder's
  // preview would have nothing to show either.
  // The column is untyped jsonb; isThemePending reads one key, null-safely.
  const settings = storeRow?.settings as
    | Record<string, unknown>
    | null
    | undefined;
  if (isThemePending({ settings })) {
    // Only offer the button to someone who can open the Storefront page.
    return <ChooseThemeFirst canChoose={access.can("themes", "view")} />;
  }

  const [homepage, pages, storeData, brand, blockedPages] = await Promise.all([
    ensureHomepage(),
    listPages(),
    withService(async (db) => {
      const productRows = await db
        .select({
          id: products.id,
          name: products.name,
          slug: products.slug,
          image_url: products.imageUrl,
          featured: products.featured,
        })
        .from(products)
        .where(eq(products.storeId, storeId))
        .orderBy(asc(products.sortOrder), asc(products.name));
      const categoryRows = await db
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
          image_url: categories.imageUrl,
        })
        .from(categories)
        .where(eq(categories.storeId, storeId))
        .orderBy(asc(categories.sortOrder), asc(categories.name));
      const blogRows = await db
        .select({ id: blogs.id, title: blogs.title, slug: blogs.slug })
        .from(blogs)
        .where(and(eq(blogs.storeId, storeId), eq(blogs.status, "published")))
        .orderBy(desc(blogs.publishedAt));
      return { productRows, categoryRows, blogRows };
    }).catch(() => ({
      productRows: [] as ProductOption[],
      categoryRows: [] as CategoryOption[],
      blogRows: [] as { id: string; title: string; slug: string }[],
    })),
    // ★ THE BRAND AS SAVED, NOT MASKED (takedown): the Brand panel saves
    // `logoUrl` back with every brand change, so the masked brand (a blocked
    // logo is null there) would erase a blocked logo from the store's
    // settings for good, and lifting the block could not bring it back.
    getStoreBrandForEditing(),
    // The pages StoreMink blocked and told the store about (D21: a block kept
    // from the store is not in it), each with the notice its "See why" opens.
    // Its own scope, read once, never inside another scope's callback; it
    // never throws, and a failed read marks nothing.
    blockedItemIds(storeId, "page").catch(() => new Map<string, string>()),
  ]);

  // The header + footer the merchant edits. Loaded here rather than fetched by
  // the client so the builder opens with its chrome already in hand — the
  // outline shows Header and Footer rows immediately, with no second spinner.
  const chrome = (await getDraftChromeForEditor(storeId)) ?? DEFAULT_CHROME;

  // What the pinned preset supplies for each overridable design token. The
  // panel needs it to show a real fallback rather than an empty box — a colour
  // input has no null, so without this a merchant cannot tell "I have not
  // chosen" from "I chose exactly this".
  const themeSelection = readThemeSelection(storeRow?.settings);
  const themeDefinition = await resolveInstalledThemeDefinition(themeSelection);
  const themeDefaults = themeDesignDefaults(
    themeDefinition?.preset.design ?? null,
    themeDefinition ? themeTemplates(themeDefinition.preset) : undefined,
  );
  // The colours each section scheme is built from, so the Style tab can show
  // real swatches. The merchant's own palette edits are layered on in the
  // browser, where they change live.
  const schemeDesign = schemeDesignFor(themeDefinition?.preset.design ?? null);

  const blogOptions: BlogOption[] = storeData.blogRows.map((b) => ({
    id: b.id,
    name: b.title,
    slug: b.slug,
  }));

  // The homepage sentinel (slug "") is pinned first in the builder; listPages
  // excludes it, so prepend it explicitly.
  const initialPages = homepage ? [homepage, ...pages] : pages;

  return (
    <BuilderClient
      initialPages={initialPages}
      products={storeData.productRows as ProductOption[]}
      categories={storeData.categoryRows as CategoryOption[]}
      blogs={blogOptions}
      storeName={brand.name}
      initialChrome={chrome}
      themeDefaults={themeDefaults}
      schemeDesign={schemeDesign}
      initialBrand={{
        name: brand.name,
        primaryColor: brand.primaryColor,
        logoUrl: brand.logoUrl,
      }}
      blockedByStoreMink={Object.fromEntries(blockedPages)}
      canSeeNotices={access.can("settings", "view")}
    />
  );
}
