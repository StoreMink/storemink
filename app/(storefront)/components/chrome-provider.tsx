"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  previewBrandFrom,
  usePreviewBrandSetter,
} from "@/app/(storefront)/components/brand-provider";
import { DEFAULT_CHROME, type StoreChrome } from "@/lib/chrome/types";
import { resolveStorefrontAppearance } from "@/lib/chrome/types";
import type { ThemeLayout } from "@/lib/themes/types";
import {
  withThemeChromeDefaults,
  type ThemeChromeDefaults,
} from "@/lib/themes/footer";
import {
  DESIGN_FONT_NAMES,
  DESIGN_PALETTE_TOKENS,
  DESIGN_SHAPE_KEYS,
  designOverrideCssVars,
  type StorefrontDesignOverrides,
} from "@/lib/chrome/design";

/** Every token the design layer can write, used to work out which inline
 *  properties this component owns — and therefore which to put back. */
const ALL_DESIGN_TOKENS: StorefrontDesignOverrides = {
  palette: Object.fromEntries(DESIGN_PALETTE_TOKENS.map((t) => [t, "#000000"])),
  fonts: { body: DESIGN_FONT_NAMES[0], display: DESIGN_FONT_NAMES[0] },
  shape: Object.fromEntries(DESIGN_SHAPE_KEYS.map((k) => [k, 0])),
};

const ChromeContext = createContext<StoreChrome | null>(null);

/**
 * The current store's header + footer configuration.
 *
 * Supersedes MenuProvider, which carried only the link lists. The chrome now
 * also decides whether the search box, cart, newsletter, contact strip, social
 * row and badges render at all, so Header and Footer read this one object
 * instead of reaching into three different sources.
 *
 * In the builder's preview iframe it also listens for `sm-chrome` postMessages
 * so header/footer edits paint instantly, the same way DraftCanvas handles
 * page sections. Without that, editing the header would need a full iframe
 * reload per keystroke and the builder would feel broken next to the rest of
 * its own UI.
 *
 * ★ The same listener takes `sm-brand`: the colour is repainted here, and the
 *   tagline and footer description (which Mink's redesign preview sends, and
 *   which go live at Apply with no draft) are handed to BrandProvider. It is
 *   the one place that knows the preview gate (`live`), and BrandProvider
 *   sits outside it in the layout, so the words travel through its setter.
 *
 * ★★ CHROME A FRAME WAS HANDED OUTLIVES A SERVER REFRESH. A preview frame
 *   refreshes itself (StorefrontRefresh on focus, so one click inside it, and
 *   PreviewBridge when the Builder pings after Publish), and the server then
 *   answers with the SAVED draft. Taking that answer put the old header and
 *   footer back under the redesign preview's sections and words, which stay
 *   (DraftCanvas, BrandProvider): its proposal is saved nowhere, so nothing
 *   ever sent it again. So a frame keeps what it was handed until the next
 *   `sm-chrome`, and only a frame handed nothing renders the server's.
 *
 * ★★ CHROME A FRAME IS HANDED IS READ THE WAY THE LIVE STORE READS IT. The
 *   storefront layout lays the theme's announcement bar and newsletter words
 *   over the store's chrome (withThemeChromeDefaults), and hands this
 *   provider the same defaults (`themeChrome`) for chrome it is sent, so a
 *   bar left on with no text shows the theme's line here as it does live.
 *   Without it the frame showed no bar and the platform's newsletter copy
 *   while the store showed the theme's: the preview was not what goes live.
 *
 * ★ Only the window that frames this page may send: the Website Builder and
 *   the redesign dialog both post from it (previewBrandFrom's and the draft
 *   canvas's rule). A sibling frame, a pop-up or a frame this page embeds is
 *   not the editor, and what it sends would now outlast a refresh.
 */
export function ChromeProvider({
  chrome,
  themeChrome,
  themeLayout,
  themeVars,
  live = false,
  children,
}: {
  chrome: StoreChrome;
  /** What the pinned theme lays over a store's own header and footer, for
   *  chrome a preview frame is sent (the server's `chrome` already has it). */
  themeChrome?: ThemeChromeDefaults;
  themeLayout?: ThemeLayout;
  /** The pinned theme's own CSS variables, so clearing an override can put the
   *  theme value back rather than falling through to the globals.css default.
   *  ⚠ THE PRESET'S MAP, NOT THE MERGED ONE the layout writes inline. Passing
   *  the merged map makes the restore below put back the override that was
   *  just cleared, which is Reset silently doing nothing. */
  themeVars?: Record<string, string>;
  /** Preview mode: accept live updates from the builder. */
  live?: boolean;
  children: React.ReactNode;
}) {
  // The header and footer the window framing this preview handed it, if it
  // has: the Website Builder's latest edit, or the redesign's proposal.
  const [pushed, setPushed] = useState<StoreChrome | null>(null);
  // ★★ Handed chrome wins while this is a preview (the ★★ note above). For
  //   the Builder too: the saved draft a refresh brings can be older than
  //   the edit still inside its save debounce. Derived, not copied into
  //   state, so wherever nothing was handed in (the redesign's "before"
  //   frame, the draft after Apply, every storefront outside a preview) the
  //   server's chrome is never a stale copy, and a frame that leaves
  //   `?preview=1` (a link clicked inside it) shows the store's own again.
  //   ★★ Handed chrome gets the theme's bar and newsletter words the way the
  //   layout gives the server's (the note above).
  const value = useMemo(
    () =>
      live && pushed ? withThemeChromeDefaults(pushed, themeChrome) : chrome,
    [live, pushed, themeChrome, chrome],
  );
  // The brand colour as last pushed by the builder, if at all — see the design
  // effect below for why it has to be remembered rather than re-read.
  const livePrimary = useRef<string | null>(null);
  // Where the brand's words go (stable, so it never re-runs the listener).
  const showPreviewBrand = usePreviewBrandSetter();

  useEffect(() => {
    if (!live) return;
    const appearance = resolveStorefrontAppearance(
      themeLayout,
      value.appearance,
    );
    const root = document.querySelector<HTMLElement>(".storefront-root");
    if (!root) return;
    for (const prefix of [
      "sm-header-",
      "sm-card-",
      "sm-pdp-",
      "sm-cart-",
      "sm-footer-",
    ]) {
      for (const cls of Array.from(root.classList)) {
        if (cls.startsWith(prefix)) root.classList.remove(cls);
      }
    }
    root.classList.remove(
      "sm-card-quickadd",
      "sm-storefront-grocery",
      "sm-cardphoto-square",
    );
    root.classList.add(
      `sm-header-${appearance.header}`,
      `sm-card-${appearance.card}`,
      `sm-pdp-${appearance.productDetail}`,
      `sm-cart-${appearance.cart}`,
      `sm-footer-${appearance.footer}`,
    );
    if (appearance.cardQuickAdd) root.classList.add("sm-card-quickadd");
    if (appearance.cardPhoto === "square")
      root.classList.add("sm-cardphoto-square");
    if (
      appearance.card === "grocery" ||
      appearance.productDetail === "grocery" ||
      appearance.cart === "grocery"
    ) {
      root.classList.add("sm-storefront-grocery");
    }
  }, [live, themeLayout, value.appearance]);

  // The merchant's palette, type and corners, repainted as they edit.
  //
  // ★ IT RESTORES, IT DOES NOT ONLY SET. Clearing an override has to put the
  // theme's value back; simply stopping writing the property would leave the
  // last override stuck (the layout wrote it inline server-side), so "Reset"
  // would look broken. `managed` is the full token namespace precisely so a
  // cleared token is still visited.
  useEffect(() => {
    if (!live) return;
    const root = document.querySelector<HTMLElement>(".storefront-root");
    if (!root) return;
    const overrides = designOverrideCssVars(value.design);
    const managed = designOverrideCssVars(ALL_DESIGN_TOKENS);
    for (const key of Object.keys(managed)) {
      if (overrides[key] !== undefined) {
        root.style.setProperty(key, overrides[key]);
        continue;
      }
      // ★★ --brand-primary IS SHARED with the `sm-brand` message below, which
      // the builder sends on every brand-colour keystroke. Restoring it from
      // the server-rendered theme value would silently undo a colour the
      // merchant had just picked, so the live value wins when there is no
      // accent override.
      const fallback =
        key === "--brand-primary" && livePrimary.current
          ? livePrimary.current
          : themeVars?.[key];
      if (fallback) root.style.setProperty(key, fallback);
      else root.style.removeProperty(key);
    }
  }, [live, themeVars, value.design]);

  useEffect(() => {
    if (!live) return;
    const onMessage = (e: MessageEvent) => {
      // Same-origin only. The preview iframe is served from the store's own
      // host, so anything from elsewhere is not the builder.
      if (e.origin !== window.location.origin) return;
      // ★ And only the window that frames this one (the note above): the
      //   Builder and the redesign dialog post from the parent window.
      if (e.source !== window.parent) return;
      const data = e.data as {
        type?: string;
        chrome?: StoreChrome;
        brand?: { primaryColor?: string; logoUrl?: string | null };
      } | null;
      if (data?.type === "sm-chrome" && data.chrome) setPushed(data.chrome);
      // Brand colour is a CSS variable written inline on .storefront-root by
      // the layout, so a live change is one setProperty — no re-render, and
      // the whole theme skin (buttons, links, accents) repaints with it.
      if (data?.type === "sm-brand" && data.brand?.primaryColor) {
        const root = document.querySelector<HTMLElement>(".storefront-root");
        // Remembered so a later design edit restores THIS, not the value the
        // server rendered before the merchant touched the picker.
        livePrimary.current = data.brand.primaryColor;
        root?.style.setProperty("--brand-primary", data.brand.primaryColor);
      }
      // ★ The brand's WORDS are no CSS variable: the footer description and
      //   the shop hero's tagline render from useBrand(), so they go to
      //   BrandProvider, which lays them over the store's own lines.
      //   previewBrandFrom holds the rules (this host, only the window that
      //   frames this page, bounded text, those two lines and nothing else),
      //   so the builder's colour-and-logo message hands it nothing.
      const text = previewBrandFrom(e);
      if (text) showPreviewBrand?.(text);
    };
    window.addEventListener("message", onMessage);
    // Tell the builder we're ready for draft pushes — it may have mounted
    // first and sent its state before this listener existed.
    window.parent?.postMessage(
      { type: "sm-chrome-ready" },
      window.location.origin,
    );
    return () => window.removeEventListener("message", onMessage);
  }, [live, showPreviewBrand]);

  return (
    <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>
  );
}

/** Falls back to the defaults outside a provider, so no consumer can crash. */
export function useChrome(): StoreChrome {
  return useContext(ChromeContext) ?? DEFAULT_CHROME;
}
