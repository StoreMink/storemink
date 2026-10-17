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
 * ★ Three flags, because they have different gates: Refine and scenes are
 *   Mink model calls, background removal is the image-matting service. A
 *   scene does not need background removal: Mink AI re-shoots the whole
 *   photo, so it works while the matting service is off.
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
  /** Re-shooting a product photo in a scene with Mink AI. */
  scenes?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ refine: available, background, scenes }),
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
