"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { StoreBrand } from "@/lib/store/brand";

const BrandContext = createContext<StoreBrand | null>(null);

/**
 * The brand lines a live preview may show before they are saved: the tagline
 * (the shop hero) and the footer description. ★ Nothing else a message names
 * is ever taken, so a preview can never rename the store, swap its logo or
 * change its contact details.
 */
export type PreviewBrandText = Partial<Pick<StoreBrand, "tagline" | "blurb">>;

const PreviewBrandContext = createContext<
  ((text: PreviewBrandText) => void) | null
>(null);

/**
 * The longest tagline and footer description a preview message may carry.
 * Above the revamp's own limits (80 and 300, REVAMP_TEXT_LIMITS) so a looser
 * limit there never silently drops the preview's words; a longer line is
 * ignored whole rather than cut, the draft canvas's rule for its datasets.
 */
export const MAX_PREVIEW_TAGLINE = 200;
export const MAX_PREVIEW_BLURB = 1000;

/** One line: undefined leaves the store's own; null is no line at all. */
function previewLine(value: unknown, max: number): string | null | undefined {
  if (typeof value !== "string" || value.length > max) return undefined;
  // Read the way the storefront reads the saved brand (lib/store/brand.ts):
  // trimmed, and an empty line is no line. So the preview shows exactly what
  // the shop shows once the words are written, and "" keeps meaning "clear
  // it", the sender's contract.
  return value.trim() || null;
}

/**
 * The tagline and footer description of an `sm-brand` message, validated. A
 * field that is missing, null, not text or too long is left out, so the
 * store's own line stands; null when nothing usable is left.
 */
export function readPreviewBrand(value: unknown): PreviewBrandText | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const text: PreviewBrandText = {};
  const tagline = previewLine(row.tagline, MAX_PREVIEW_TAGLINE);
  const blurb = previewLine(row.blurb, MAX_PREVIEW_BLURB);
  if (tagline !== undefined) text.tagline = tagline;
  if (blurb !== undefined) text.blurb = blurb;
  return "tagline" in text || "blurb" in text ? text : null;
}

/**
 * The brand words a message event carries, or null when it must change
 * nothing. ★ Only this host's own pages, and only the window that frames this
 * one (the Website Builder or the redesign preview): a sibling frame, a
 * pop-up or a frame this page embeds is not the editor, the draft canvas's
 * rule for the data it is handed.
 */
export function previewBrandFrom(event: MessageEvent): PreviewBrandText | null {
  if (event.origin !== window.location.origin) return null;
  if (event.source !== window.parent) return null;
  const data = event.data as { type?: unknown; brand?: unknown } | null;
  if (data?.type !== "sm-brand") return null;
  return readPreviewBrand(data.brand);
}

export function BrandProvider({
  brand,
  children,
}: {
  brand: StoreBrand;
  children: React.ReactNode;
}) {
  // ★ The words a live preview laid over the server's brand. Only the live
  //   listener ever writes them (ChromeProvider, behind the same preview gate
  //   as its `sm-chrome` handler: the layout hands that gate to it, not here),
  //   so outside a preview this stays null and every consumer gets the
  //   server's own brand object, exactly as before.
  const [preview, setPreview] = useState<PreviewBrandText | null>(null);
  // Each message lays its halves over the last: a half it leaves out keeps
  // what the store, or an earlier message, said. Stable, so the listener that
  // holds it never has to be torn down and re-announce itself.
  const showPreviewBrand = useCallback(
    (text: PreviewBrandText) =>
      setPreview((current) => ({ ...current, ...text })),
    [],
  );
  const value = useMemo(
    () => (preview ? { ...brand, ...preview } : brand),
    [brand, preview],
  );
  return (
    <PreviewBrandContext.Provider value={showPreviewBrand}>
      <BrandContext.Provider value={value}>{children}</BrandContext.Provider>
    </PreviewBrandContext.Provider>
  );
}

/**
 * For the live preview listener only: lays brand words over the server's.
 * Null outside a BrandProvider, so a listener there simply has nowhere to put
 * them.
 */
export function usePreviewBrandSetter():
  | ((text: PreviewBrandText) => void)
  | null {
  return useContext(PreviewBrandContext);
}

// The current store's brand. Falls back to a neutral default if used outside
// the provider (shouldn't happen in the storefront).
export function useBrand(): StoreBrand {
  return (
    useContext(BrandContext) ?? {
      name: "Store",
      logoUrl: null,
      primaryColor: "#17130f",
      tagline: null,
      blurb: null,
      legalName: null,
      creditLine: null,
      email: null,
      phone: null,
      hours: null,
      social: { instagram: null, youtube: null, whatsapp: null },
      badges: [],
      domain: "storemink.com",
    }
  );
}
