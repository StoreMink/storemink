import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { BrandMark } from "@/app/platform/brand-mark";
import { PLATFORM_URL, THEMES_URL } from "@/lib/site";
import { ROOT_DOMAIN } from "@/lib/store/host";
import { serializeJsonLd } from "@/lib/seo/json-ld";
import {
  canPreviewTheme,
  isThemeSelectable,
  newestThemesFirst,
  themeCategoriesFor,
  type ThemeCategory,
  type ThemeIndustry,
  type ThemeMeta,
} from "@/lib/themes/meta";
import { getThemeCatalog } from "@/lib/themes/runtime-registry";

// ---------------------------------------------------------------------------
// themes.storemink.com: the public theme catalogue.
//
// ★ A PLAIN GRID, NOT A SHOWCASE (owner, 23 Nov 2026: "no need of theme
//   descriptions to show on the page. the overall vibe should be a bit like
//   shopify's themes page"). The page used to be an editorial piece: a serif
//   headline beside a rotating stage, one sideways rail of cards each
//   carrying a paragraph, four feature ticks, a number and two badges, then a
//   dark "standard" band and an art-led closing. A shopper comparing themes
//   reads none of that; they look at the picture and the name. So:
//     * the hero is a headline, one sentence and one button, and SHORT: the
//       first row of themes is on screen before any scrolling on a laptop
//       (owner, 23 Nov: "themes are visible with a scroll ... reduce this so
//       that themes are visible on the first glance"), so the catalogue has
//       a heading, a count and the filters above it and nothing else;
//     * every theme is on the page at once, three across, as its picture,
//       its name, which plans it is on, and what it suits;
//     * a card has no description, no feature list, no number and no badge.
// ★ The picture is the way in: it opens the live demo store when there is a
//   healthy one. The two text links under the name say the same in words, so
//   nothing depends on hover.
// ---------------------------------------------------------------------------

const STANDARD_ITEMS = [
  {
    title: "Composed for every screen",
    body: "Layouts are shaped for mobile from the start, with tap targets, typography and merchandising that feel intentional at every size.",
  },
  {
    title: "Built around the buying journey",
    body: "Discovery, product options, cart states and content extremes are reviewed with real catalog data before release.",
  },
  {
    title: "Made to become yours",
    body: "Change color, type, imagery and sections without code, while the theme keeps the details coherent.",
  },
] as const;

function demoUrl(slug: string) {
  return `https://${slug}.${ROOT_DOMAIN}`;
}

/** What a theme suits, in the filter's own words ("Food & Beverages"). */
function industryLabel(
  theme: ThemeMeta,
  categories: readonly ThemeCategory[],
): string {
  return theme.catalog.industries
    .map(
      (id) =>
        categories.find((category) => category.id === id)?.label ??
        id.replaceAll("-", " "),
    )
    .join(", ");
}

/** Which plans may use it, in the plans' own names (Free, Basic, Pro). */
function planLabel(theme: ThemeMeta): string {
  if (theme.catalog.minPlan === "pro") return "Pro only";
  if (theme.catalog.minPlan === "basic") return "Basic and Pro";
  return "All plans";
}

export default async function ThemesPage({
  searchParams,
}: {
  searchParams: Promise<{ industry?: string }>;
}) {
  const themeCatalog = await getThemeCatalog();
  const themeCategories = themeCategoriesFor(themeCatalog);
  const requested = (await searchParams).industry;
  const selected: ThemeIndustry | "all" = themeCategories.some(
    (category) => category.id === requested,
  )
    ? (requested as ThemeIndustry | "all")
    : "all";
  const selectedLabel =
    themeCategories.find((category) => category.id === selected)?.label ?? "";
  const selectableThemes = newestThemesFirst(
    themeCatalog.filter(isThemeSelectable),
  );
  const themes = selectableThemes.filter(
    (theme) =>
      selected === "all" || theme.catalog.industries.includes(selected),
  );

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "StoreMink Themes",
    url: THEMES_URL,
    description:
      "A curated catalog of responsive, commerce-ready StoreMink storefront themes.",
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: themes.length,
      itemListElement: themes.map((theme, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: theme.name,
        url: `${THEMES_URL}/#${theme.id}`,
      })),
    },
  };

  return (
    <>
      {/* ★ Through serializeJsonLd, never a bare JSON.stringify: a theme
          name is a Theme Studio release's text, any characters up to 100,
          and a "</script>" in one would end this element. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />

      <aside className="themes-announcement">
        <span>StoreMink themes</span>
        <p>Beautiful by default. Unmistakably yours.</p>
        <a href="#catalog">
          Explore the collection <ArrowRight size={14} aria-hidden />
        </a>
      </aside>

      {/* Full-bleed shell so the inset row can stick without the page
          scrolling past either side of it — the same wrapper
          .smh-header / .posx-nav-shell / .hc-topbar provide. */}
      <div className="themes-nav-shell">
        <header className="themes-nav">
          <Link
            href={THEMES_URL}
            className="themes-wordmark"
            aria-label="StoreMink Themes home"
          >
            <BrandMark size={29} priority />
            <span aria-hidden="true">
              Store<em>Mink</em>
            </span>
            <i aria-hidden="true">Themes</i>
          </Link>
          <nav aria-label="Theme catalog navigation">
            <a href="#catalog">Browse themes</a>
            <a href="#standard">Why StoreMink</a>
            <a href="https://help.storemink.com">Help</a>
            <Link href={`${PLATFORM_URL}/signup`} className="themes-nav-cta">
              Start your store <ArrowUpRight size={15} aria-hidden />
            </Link>
          </nav>
        </header>
      </div>

      <main>
        <section className="themes-hero">
          <h1>Make your store impossible to scroll past.</h1>
          <div className="themes-hero-aside">
            <p>
              Pick a theme, preview the real storefront, then make every detail
              yours without touching code.
            </p>
            <Link href={`${PLATFORM_URL}/signup`} className="themes-button">
              Start your store
            </Link>
          </div>
        </section>

        <section className="themes-catalog" id="catalog">
          <div className="themes-catalog-head">
            <h2>
              {selected === "all" ? "All themes" : `${selectedLabel} themes`}
            </h2>
            <p className="themes-count">
              {themes.length} {themes.length === 1 ? "theme" : "themes"}
            </p>
          </div>

          <nav
            className="themes-filters"
            aria-label="Filter themes by industry"
          >
            {themeCategories.map((category) => (
              <Link
                key={category.id}
                href={
                  category.id === "all"
                    ? "/#catalog"
                    : `/?industry=${category.id}#catalog`
                }
                aria-current={selected === category.id ? "page" : undefined}
              >
                {category.label}
              </Link>
            ))}
          </nav>

          <ul className="themes-grid" aria-label="Theme collection">
            {themes.map((theme, index) => {
              const previewable = canPreviewTheme(theme);
              const picture = (
                <Image
                  src={theme.catalog.previewImage}
                  alt={`${theme.name} theme storefront preview`}
                  fill
                  sizes="(max-width: 640px) 92vw, (max-width: 1024px) 46vw, 420px"
                  loading={index < 3 ? "eager" : "lazy"}
                />
              );
              return (
                <li className="theme-card" id={theme.id} key={theme.id}>
                  {previewable ? (
                    <a
                      className="theme-card-visual"
                      href={demoUrl(theme.demo.slug)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Preview ${theme.name} theme`}
                    >
                      {picture}
                      <span className="theme-card-cue" aria-hidden="true">
                        Live preview <ArrowUpRight size={15} />
                      </span>
                    </a>
                  ) : (
                    <div className="theme-card-visual">{picture}</div>
                  )}

                  <div className="theme-card-info">
                    <h3>{theme.name}</h3>
                    <span>{planLabel(theme)}</span>
                    <p>{industryLabel(theme, themeCategories)}</p>
                  </div>

                  <div className="theme-card-actions">
                    {previewable ? (
                      <a
                        href={demoUrl(theme.demo.slug)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        View live store <ArrowUpRight size={14} aria-hidden />
                      </a>
                    ) : (
                      <span
                        className="theme-preview-offline"
                        title={theme.demo.unavailableReason}
                      >
                        Live preview being restored
                      </span>
                    )}
                    <Link href={`${PLATFORM_URL}/signup`}>
                      Start with {theme.name}{" "}
                      <ArrowRight size={14} aria-hidden />
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="themes-standard" id="standard">
          <div className="themes-standard-head">
            <h2>More than a beautiful first impression.</h2>
            <p>
              The details people notice, and the ones they never have to, are
              already considered. Your job is to make it feel like your brand.
            </p>
          </div>
          <div className="themes-standard-grid">
            {STANDARD_ITEMS.map((item) => (
              <article key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="themes-closing">
          <h2>Launch beautifully. Grow confidently.</h2>
          <p>
            Start with a polished storefront today, then keep shaping it as your
            catalog, customers and ambition grow.
          </p>
          <Link href={`${PLATFORM_URL}/signup`} className="themes-button">
            Start your free store
          </Link>
        </section>
      </main>

      <footer className="themes-footer">
        <div>
          <div className="themes-wordmark">
            <BrandMark size={26} />
            <span>
              Store<em>Mink</em>
            </span>
            <i>Themes</i>
          </div>
          <p>Professional storefronts. No code required.</p>
        </div>
        <nav aria-label="Footer navigation">
          <Link href={PLATFORM_URL}>StoreMink</Link>
          <a href="#catalog">Themes</a>
          <a href="https://help.storemink.com">Help Centre</a>
          <Link href={`${PLATFORM_URL}/signup`}>Create a store</Link>
        </nav>
        <p className="themes-footer-note">Made for independent brands.</p>
      </footer>
    </>
  );
}
