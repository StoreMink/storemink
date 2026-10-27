"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import {
  addImageRefineViewer,
  getImageRefineView,
  handlePageHide,
  handlePageShow,
  releaseImageRefines,
  releaseImageRefinesOffPath,
  stopAllImageRefines,
  subscribeImageRefines,
  type RefineView,
} from "./image-refine-registry";

/**
 * Which photo tools can work for the signed-in admin: Refine with Mink AI,
 * and changing a product photo's background. (A product in a scene is made
 * in Mink AI chat, never from the upload box.)
 *
 * ★ Both default to FALSE, so the shared `ImageUpload` offers no button
 *   anywhere the dashboard layout has not explicitly said it may (the
 *   storefront, the platform console). The server re-checks every gate; this
 *   only keeps a button that would always fail off the screen.
 * ★ Two flags, not one, because they have different gates: Refine is a Mink
 *   model call, background removal is the image-matting service.
 */
const ImageToolsContext = createContext({
  refine: false,
  background: false,
});

/**
 * ★★ IT ALSO OWNS EVERY REFINE ON THE PAGE (image-refine-registry.ts): a
 * refine belongs to its page and slot, not to the box that started it. The
 * provider is mounted once, by the dashboard layout, and survives client
 * navigation, so it is where the page's exits are heard: every `pagehide`
 * sends the refine's stop (and `pageshow` asks what became of it), a route
 * change stops the refines started on another path, and the layout going
 * away stops them all. An editor unmounting only detaches its box.
 */
export function ImageRefineProvider({
  available,
  background = false,
  children,
}: {
  /** Refine with Mink AI. */
  available: boolean;
  /** Changing a product photo's background. */
  background?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ refine: available, background }),
    [available, background],
  );
  useEffect(() => {
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      // The dashboard layout unmounting is leaving the dashboard.
      void stopAllImageRefines();
    };
  }, []);
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) releaseImageRefinesOffPath(pathname);
  }, [pathname]);
  return (
    <ImageToolsContext.Provider value={value}>
      {children}
    </ImageToolsContext.Provider>
  );
}

export function useImageRefineAvailable(): boolean {
  return useContext(ImageToolsContext).refine;
}

export function useImageBackgroundAvailable(): boolean {
  return useContext(ImageToolsContext).background;
}

const ImageRefineScopeContext = createContext<string | null>(null);

/**
 * Where the refines of the boxes inside belong: a builder section, the
 * builder's header and footer, a product, a dialog. A box outside any scope
 * belongs to its route. ★ `releaseOnUnmount` is for a scope whose unmount
 * means its slots are gone (a dialog closing); a builder section unmounts on
 * ordinary editing and leaves that decision to the builder's own sweep. A
 * changed `id` releases the old id's refines when the flag is set.
 */
export function ImageRefineScope({
  id,
  releaseOnUnmount = false,
  children,
}: {
  id: string;
  releaseOnUnmount?: boolean;
  children: ReactNode;
}) {
  useEffect(
    () =>
      releaseOnUnmount
        ? () => releaseImageRefines((refine) => refine.scope === id)
        : undefined,
    [id, releaseOnUnmount],
  );
  return (
    <ImageRefineScopeContext.Provider value={id}>
      {children}
    </ImageRefineScopeContext.Provider>
  );
}

export function useImageRefineScope(): string | null {
  return useContext(ImageRefineScopeContext);
}

/**
 * The refine a box shows, by its key, and the box counted as watching it
 * while mounted. ★ The server snapshot is null: nothing starts a refine
 * while rendering on the server.
 */
export function useImageRefineView(matchKey: string | null): RefineView | null {
  const view = useSyncExternalStore(
    subscribeImageRefines,
    () => getImageRefineView(matchKey),
    () => null,
  );
  useEffect(
    () => (matchKey ? addImageRefineViewer(matchKey) : undefined),
    [matchKey],
  );
  return view;
}
