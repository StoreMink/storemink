import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Header from "@/app/(storefront)/components/header/Header";
import Footer from "@/app/(storefront)/components/footer/Footer";
import AuthProvider from "@/app/(storefront)/components/auth/AuthProvider";
import CartProvider from "@/app/(storefront)/components/cart/CartProvider";
import { DeliveryLocationProvider } from "@/app/(storefront)/components/delivery/delivery-location-provider";
import CartDrawer from "@/app/(storefront)/components/cart/CartDrawer";
import AuthModalLoader from "@/app/(storefront)/components/auth/auth-modal-loader";
import { BrandProvider } from "@/app/(storefront)/components/brand-provider";
import { ChromeProvider } from "@/app/(storefront)/components/chrome-provider";
import { notFound } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getStoreBrand } from "@/lib/store/brand";
import { getStoreChrome, getDraftChromeForPreview } from "@/lib/chrome/queries";
import { resolveStorefrontAppearance } from "@/lib/chrome/types";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { isDemoStore, isStoreSearchIndexable } from "@/lib/store/launch";
import {
  storefrontAccess,
  storefrontShell,
} from "@/lib/store/storefront-access";
import { getStoreUrl } from "@/lib/site";
import { resolveInstalledThemeDefinition } from "@/lib/themes/runtime-registry";
import { readThemeSelection } from "@/lib/themes/meta";
import { designToCssVars } from "@/lib/themes/types";
import { designOverrideCssVars } from "@/lib/chrome/design";
import {
  schemeCssVars,
  schemeDesignFor,
  withPaletteOverrides,
} from "@/lib/themes/schemes";
import { Toaster } from "@/components/ui/sonner";
import { MerchantTracking } from "@/app/(storefront)/components/merchant-tracking";
import { StudioAcceptanceProbe } from "@/app/(storefront)/components/studio-acceptance-probe";
import { studioPreviewMarker } from "@/lib/theme-studio/preview-store";
import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";
import { analyticsFeatureAllowed } from "@/lib/analytics/features";
import { resolveMerchantPixelSettings } from "@/lib/analytics/merchant-pixels";
import { effectivePlan, limitsFor } from "@/lib/plans";
import { footerCreditFor } from "@/lib/store/footer-credit";
import {
  GOOGLE_VERIFICATION_TOKEN_KEY,
  normalizeGoogleVerificationToken,
} from "@/lib/seo/store-indexing";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { STOREMINK_ICONS } from "@/lib/brand-assets";
import { buttonRootClasses } from "@/lib/themes/buttons";
import {
  themeChromeDefaults,
  withThemeChromeDefaults,
} from "@/lib/themes/footer";
import { activeAnnouncement } from "@/lib/themes/announcement";
import { getPublicShopLocations } from "@/lib/storefront/store-locations";
import {
  STYLESHEET_ROOT_CLASS,
  themeStylesheetCss,
} from "@/lib/themes/stylesheet";
import { pageRootClasses } from "@/lib/themes/page";
import { motionRootClasses, revealsOnScroll } from "@/lib/themes/motion";
import { ScrollReveal } from "@/app/(storefront)/components/scroll-reveal";
import { typographyRootClasses } from "@/lib/themes/typography";
import "./storefront-theme.css";
import { StorefrontRefresh } from "./components/storefront-refresh";
import { WhatsAppChatButton } from "./components/whatsapp-chat-button";
import { getStorefrontWhatsAppChat } from "@/lib/whatsapp/storefront";

// Storefront requests always read current tenant content across Cloud Run instances.
export const dynamic = "force-dynamic";

// Per-store default title/template + canonical origin. Individual pages may set
// their own title; this is the fallback and the "%s | Brand" suffix, and
// metadataBase makes OG/canonical URLs resolve to this store's own domain.
export async function generateMetadata(): Promise<Metadata> {
  // Guard like the layout component does: on an unclaimed/suspended host the
  // layout renders the root "store doesn't exist" 404. generateMetadata runs
  // independently, so it must NOT fall back to the WholeSip brand here (that's
  // what getStoreBrand()/getStoreUrl() do) — otherwise the tab title becomes
  // "… | WholeSip" and the favicon becomes WholeSip's logo on the 404.
  const store = await getCurrentStoreOrNull();
  if (!store) {
    return {
      title: "Store not found",
      icons: STOREMINK_ICONS,
      robots: { index: false, follow: false },
    };
  }

  const [brand, siteUrl] = await Promise.all([getStoreBrand(), getStoreUrl()]);
  // The Site Verification API's META method returns a complete <meta> tag.
  // Normalize legacy records as well as current bare-token records before
  // handing the value to Next, whose API renders the tag itself.
  const googleVerification = normalizeGoogleVerificationToken(
    store.settings?.[GOOGLE_VERIFICATION_TOKEN_KEY],
  );
  const searchIndexable = isStoreSearchIndexable(store);
  return {
    metadataBase: new URL(siteUrl),
    title: { default: brand.name, template: `%s | ${brand.name}` },
    description: brand.tagline ?? undefined,
    icons: brand.logoUrl ? { icon: brand.logoUrl } : STOREMINK_ICONS,
    ...(googleVerification
      ? { verification: { google: googleVerification } }
      : {}),
    // New stores contain shared theme seed until the owner publishes something
    // real, and demo stores are permanent shared showcases. robots.txt allows
    // crawlers to fetch these public pages specifically so this directive can
    // remove any stale copies that were indexed before the launch gate existed.
    ...(searchIndexable
      ? {}
      : { robots: { index: false, follow: false, nocache: true } }),
  };
}

export default async function StorefrontLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // An unclaimed subdomain / unknown custom domain must NOT fall back to the
  // WholeSip storefront — render a proper "store not found" 404 instead. This
  // one guard covers every storefront page (they all render inside this layout).
  const store = await getCurrentStoreOrNull();
  if (!store) notFound();

  // A store that has not opened yet: every page redirects itself to /password
  // (requireStorefrontStore), so when the visitor is locked out the only child
  // this layout renders is the password page — and it should not sit inside
  // the shop's header, menus and cart, which would all lead straight back to
  // the password page. Admins and password holders are "unlocked" and see the
  // ordinary layout.
  //
  // A store whose owner has not chosen a theme yet is the same case one step
  // later: past the password every page redirects itself to the in-progress
  // page (requireStorefrontStore), so that page, or /password before it, is
  // the only child, and it gets the same bare shell.
  //
  // The choice itself is storefrontShell() (lib/store/storefront-access.ts).
  // storefrontAccess() answers "open" at once for a store that is not gated,
  // so a launched store pays nothing for asking.
  const bareShell =
    storefrontShell(store, await storefrontAccess(store)) === "bare";

  // Anonymous storefronts do not need Firebase's browser SDK on their initial
  // route. A server cookie means identity must be restored immediately; with
  // no cookie the provider starts Firebase only if the account UI is opened.
  const hasCustomerSession = (await cookies()).has(SESSION_COOKIE);

  // Chrome: the PUBLISHED header/footer, except inside the builder's preview
  // iframe where the admin is shown their unsaved draft.
  //
  // The ?preview=1 flag arrives as a header because a LAYOUT cannot read
  // searchParams (Next 16) and this layout is what renders Header/Footer — see
  // the note in proxy.ts. The header is only a hint: getDraftChromeForPreview
  // runs the same getManagerUserId("builder") gate as the page-draft loader and
  // returns null for everyone else, so forging it leaks nothing.
  const previewing = (await headers()).get("x-sm-preview") === "1";
  const [brand, publishedChrome, draftChrome, analyticsFeatures] =
    await Promise.all([
      getStoreBrand(),
      getStoreChrome(store.id),
      previewing ? getDraftChromeForPreview(store.id) : Promise.resolve(null),
      getPlatformAnalyticsFeatures(),
    ]);

  // Merchant pixels are independently gated by platform rollout, the store's
  // effective plan (including expiry), its saved enable switch, and finally the
  // visitor's browser-side consent. Builder previews never collect analytics.
  const pixelSettings = resolveMerchantPixelSettings(store.settings);
  const plan = effectivePlan(store);
  const ga4MeasurementId =
    !previewing &&
    pixelSettings.ga4Enabled &&
    analyticsFeatureAllowed(analyticsFeatures, "googleAnalytics4", plan)
      ? pixelSettings.ga4MeasurementId
      : null;
  const metaPixelId =
    !previewing &&
    pixelSettings.metaPixelEnabled &&
    analyticsFeatureAllowed(analyticsFeatures, "metaPixel", plan)
      ? pixelSettings.metaPixelId
      : null;
  const firstPartyEnabled =
    !previewing &&
    analyticsFeatureAllowed(analyticsFeatures, "storefrontConversion", plan);

  // The footer's last line: StoreMink's "Powered by" badge on a Free store,
  // the store's own credit line (or nothing) on Basic and Pro. ★ Decided HERE,
  // from the store row's EFFECTIVE plan (an expired timed plan reads as Free,
  // a live comp as its plan), and handed to the footer as a plain object: the
  // footer is a client component and only draws what it is given
  // (lib/store/footer-credit.ts). The builder preview and Theme Studio preview
  // stores render through this same layout, so they follow the same rule.
  const footerCredit = footerCreditFor({
    removeBadge: limitsFor(plan).removeBadge,
    creditLine: brand.creditLine,
  });
  // ★ The browser gets the brand WITHOUT the saved credit line: the footer is
  // handed its answer above and nothing in the browser reads the line itself,
  // so a line the plan keeps off the page (a Free store's own words, or a paid
  // store's copy of the badge's) never reaches it, not even its source.
  const clientBrand = { ...brand, creditLine: null };

  // The visual skin: resolve the store's pinned theme release (falling back to
  // the legacy settings.template id) and flatten
  // its palette/fonts/shape into CSS custom properties written inline on
  // .storefront-root. Inline-style specificity beats the globals.css :root
  // defaults, so the whole storefront re-skins with no per-component wiring.
  // A store with NO real theme id (the WholeSip fallback, legacy stores) gets
  // only --brand-primary — the globals.css defaults ARE the WholeSip look, so
  // it stays exactly as today.
  const themeSelection = readThemeSelection(store.settings);
  // The WhatsApp chat button: the switch and plan are read off the store row
  // the layout already holds, so a store with it off costs no query. Never in
  // the builder preview, where a floating link over the canvas is in the way.
  const [theme, whatsappChat] = await Promise.all([
    resolveInstalledThemeDefinition(themeSelection),
    previewing ? Promise.resolve(null) : getStorefrontWhatsAppChat(store),
  ]);
  const design = theme?.preset.design ?? null;
  // The theme's own style rules, compiled to CSS scoped under the root
  // (lib/themes/stylesheet.ts). "" for a theme with none, which is every
  // release made before 22 Nov 2026.
  const themeCss = themeStylesheetCss(theme?.preset.stylesheet);
  // ★★ The theme's bar and newsletter words, laid over the store's chrome by
  //   the ONE function ChromeProvider also lays over chrome a preview frame
  //   is sent (lib/themes/footer.ts), so the frame shows what goes live.
  const themeChrome = themeChromeDefaults(theme);
  const chrome = withThemeChromeDefaults(
    draftChrome ?? publishedChrome,
    themeChrome,
  );
  // ★★ THE PRESET'S OWN MAP, KEPT SEPARATE FROM THE MERGED ONE. The inline
  // style below wants the merchant's overrides ON TOP; ChromeProvider wants
  // the map WITHOUT them, because its job when an override is CLEARED in the
  // builder is to put the theme's value back. Handing it the merged map made
  // it restore the very override that had just been cleared, so Reset
  // repainted the old colour and looked broken until a reload.
  const presetVars: Record<string, string> = design
    ? designToCssVars(design, brand.primaryColor)
    : { "--brand-primary": brand.primaryColor };
  // The merchant's own palette, type and shape sit ON TOP of the preset. Spread
  // LAST so an override wins; it emits only tokens actually set, so an
  // un-overridden store keeps inheriting the theme and a later preset upgrade
  // still reaches it.
  const designOverrides = designOverrideCssVars(chrome.design);
  // Section colour schemes, from the palette this store really paints —
  // the theme's with the merchant's overrides on top, or the storefront
  // defaults with no theme. Only the colours CSS cannot derive on its own
  // are written (lib/themes/schemes.ts); they are read only inside a
  // section that wears a scheme, so a store using none is unaffected.
  const schemeVars = schemeCssVars(
    withPaletteOverrides(schemeDesignFor(design), chrome.design.palette),
    brand.primaryColor,
  );
  const themeVars: Record<string, string> = {
    ...presetVars,
    ...designOverrides,
    ...schemeVars,
  };

  // Theme defaults + the merchant's published builder overrides resolve into
  // one appearance. Root classes let CSS switch treatments without forking
  // components; the same resolver runs client-side for instant builder preview.
  const appearance = resolveStorefrontAppearance(
    design?.layout,
    chrome.appearance,
  );
  // The store's shops, for the footer's "Our stores" link (cached five
  // minutes; a failed read is "none"). Not read at all where there is no
  // footer, or where the merchant switched the page off.
  const shopLocations =
    bareShell || !appearance.storeLocator
      ? []
      : await getPublicShopLocations(store.id);
  const rootClass = [
    "storefront-root",
    `sm-header-${appearance.header}`,
    `sm-card-${appearance.card}`,
    appearance.cardQuickAdd ? "sm-card-quickadd" : "",
    appearance.cardPhoto === "square" ? "sm-cardphoto-square" : "",
    appearance.cardHoverImage ? "sm-card-hoverimg" : "",
    appearance.stickyAddToCart ? "sm-atc-sticky" : "",
    appearance.gridColumnsMobile === 2 ? "sm-grid-m2" : "",
    appearance.gridColumnsDesktop !== 4
      ? `sm-grid-d${appearance.gridColumnsDesktop}`
      : "",
    // Only when a face is actually being imposed — see the `.sm-themed-type`
    // note in storefront-theme.css. ★ A FONT OVERRIDE COUNTS, not just a
    // theme: the class is what makes untokenised descendants inherit the
    // chosen face, so an un-themed store that picks a font would otherwise
    // render half in it and half in Tailwind's default — the two-family
    // defect §11 records for Vitrine. An un-themed store that overrides
    // NOTHING still gets no class, so its inherited font is untouched.
    design || chrome.design.fonts.body ? "sm-themed-type" : "",
    // Heading face, weight, case and spacing the theme chose. A class per
    // property, and none when the theme sets nothing — lib/themes/typography.ts.
    ...typographyRootClasses(design?.typography),
    // Button shape, fill, case, weight, spacing and hover — the same one
    // class per property, none when unset. lib/themes/buttons.ts.
    ...buttonRootClasses(design?.buttons),
    // Page width: a class only so a "Full width" section can opt out of it.
    // lib/themes/page.ts.
    ...pageRootClasses(design?.page),
    // Sections revealed on scroll; none when the theme sets no motion, and
    // none in the builder, where a hidden section is one you cannot edit.
    ...(previewing ? [] : motionRootClasses(design?.motion)),
    `sm-pdp-${appearance.productDetail}`,
    `sm-cart-${appearance.cart}`,
    `sm-footer-${appearance.footer}`,
    // The announcement bar above the header: the class is what the server
    // paints the bar's height into --sm-announce-h with before the header
    // hook measures (storefront-theme.css); the bar itself keeps it live in
    // the builder (header/announcement-bar.jsx).
    activeAnnouncement(chrome) ? "sm-announce" : "",
    // The merchant's wishlist switch: every card renders its heart, and this
    // class is what shows it (storefront-theme.css).
    appearance.wishlist ? "sm-wishlist" : "",
    // The merchant's quick view switch, shown the same way: every card
    // renders its eye, and this class is what shows it.
    appearance.quickView ? "sm-quickview" : "",
    // The scope every compiled theme style rule is written under.
    themeCss ? STYLESHEET_ROOT_CLASS : "",
    appearance.card === "grocery" ||
    appearance.productDetail === "grocery" ||
    appearance.cart === "grocery"
      ? "sm-storefront-grocery"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (bareShell) {
    return (
      <BrandProvider brand={clientBrand}>
        <div className={rootClass} style={themeVars as CSSProperties}>
          {themeCss ? (
            <style
              data-sm="theme-styles"
              dangerouslySetInnerHTML={{ __html: themeCss }}
            />
          ) : null}
          {children}
        </div>
      </BrandProvider>
    );
  }

  return (
    <AuthProvider initialHasSession={hasCustomerSession}>
      <DeliveryLocationProvider>
        <MerchantTracking
          storeName={store.name}
          ga4MeasurementId={ga4MeasurementId}
          metaPixelId={metaPixelId}
          firstPartyEnabled={firstPartyEnabled}
        >
          <CartProvider>
            <BrandProvider brand={clientBrand}>
              <ChromeProvider
                chrome={chrome}
                // Only a preview frame is ever sent chrome to lay it over.
                themeChrome={previewing ? themeChrome : undefined}
                themeLayout={design?.layout}
                themeVars={presetVars}
                live={previewing}
              >
                <div className={rootClass} style={themeVars as CSSProperties}>
                  {themeCss ? (
                    // Vocabulary only: the compiler writes this text from a
                    // closed catalogue, never from anything a theme typed.
                    <style
                      data-sm="theme-styles"
                      dangerouslySetInnerHTML={{ __html: themeCss }}
                    />
                  ) : null}
                  <Header />
                  <StorefrontRefresh />
                  {children}
                  <Footer
                    credit={footerCredit}
                    // The "Our stores" page exists only for a store with a
                    // shop location whose merchant keeps the page on.
                    storesLink={
                      appearance.storeLocator && shopLocations.length > 0
                    }
                  />
                  {whatsappChat ? (
                    <WhatsAppChatButton href={whatsappChat.href} />
                  ) : null}
                </div>
                {!previewing && revealsOnScroll(design?.motion) ? (
                  <ScrollReveal />
                ) : null}
                {/* Theme Studio acceptance measures only preview stores. */}
                {studioPreviewMarker(store.settings) ? (
                  <StudioAcceptanceProbe />
                ) : null}
              </ChromeProvider>
              {/* Inside the brand context: outside it the sign-in dialog read
                  the default brand and greeted shoppers "Welcome to Store". */}
              <AuthModalLoader demoStore={isDemoStore(store)} />
            </BrandProvider>
            <CartDrawer />
            <Toaster richColors />
          </CartProvider>
        </MerchantTracking>
      </DeliveryLocationProvider>
    </AuthProvider>
  );
}
