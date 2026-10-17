"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Which photo tools can work for the signed-in admin: Refine with Mink AI,
 * and changing a product photo's background.
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
  scenes: false,
});

export function ImageRefineProvider({
  available,
  background = false,
  scenes = false,
  children,
}: {
  /** Refine with Mink AI. */
  available: boolean;
  /** Changing a product photo's background. */
  background?: boolean;
  /** Drawing a new scene behind it (a Mink image call). */
  scenes?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ refine: available, background, scenes: background && scenes }),
    [available, background, scenes],
  );
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

export function useImageScenesAvailable(): boolean {
  return useContext(ImageToolsContext).scenes;
}
