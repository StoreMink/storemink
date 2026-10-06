"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether "Refine with Mink AI" can work for the signed-in admin.
 *
 * ★ Defaults to FALSE, so the shared `ImageUpload` offers no button anywhere
 *   the dashboard layout has not explicitly said it may (the storefront, the
 *   platform console). The server re-checks every gate — this only keeps a
 *   button that would always fail off the screen.
 */
const ImageRefineContext = createContext(false);

export function ImageRefineProvider({
  available,
  children,
}: {
  available: boolean;
  children: ReactNode;
}) {
  return (
    <ImageRefineContext.Provider value={available}>
      {children}
    </ImageRefineContext.Provider>
  );
}

export function useImageRefineAvailable(): boolean {
  return useContext(ImageRefineContext);
}
