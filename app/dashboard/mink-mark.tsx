import { MinkFace, type MinkFaceState } from "@/components/mink/mink-face";

/** Pixel size of each mark: the old robot tile's sizes, kept so no layout moves. */
export const MINK_MARK_PX = { sm: 28, md: 36, lg: 44 } as const;

/**
 * Mink AI's mark in the dashboard: the Mink face from the owner's expression
 * sheet (the saffron tile), the same face the Help Centre uses. It replaced a
 * purple robot icon on 31 Oct 2026. Decorative: every place it appears has a
 * visible name or an aria-label beside it.
 */
export function MinkMark({
  size = "md",
  state = "default",
  animated = false,
}: {
  size?: keyof typeof MINK_MARK_PX;
  /** default, listening, thinking, talking or done. */
  state?: MinkFaceState;
  /** Blink, glance and talk; off under reduced motion whatever this says. */
  animated?: boolean;
}) {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0">
      <MinkFace size={MINK_MARK_PX[size]} state={state} animated={animated} />
    </span>
  );
}
