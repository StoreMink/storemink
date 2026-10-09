"use client";

import { useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// The homepage's one-row theme rail. Touch and trackpad scrolling stay
// native (scroll-snap on the track); the two buttons move exactly one card
// and wrap at either end. Same behaviour as the themes catalogue's carousel,
// restyled for the dark marketing system.

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

export function ThemeRail({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const move = (direction: -1 | 1) => {
    const track = trackRef.current;
    if (!track) return;
    const firstCard = track.querySelector<HTMLElement>(".smh-theme-card");
    const styles = window.getComputedStyle(track);
    const gap = Number.parseFloat(styles.columnGap || styles.gap) || 0;
    const cardWidth = firstCard?.getBoundingClientRect().width || 360;
    const step = cardWidth + gap;
    const maxLeft = Math.max(0, track.scrollWidth - track.clientWidth);
    const atStart = track.scrollLeft <= 2;
    const atEnd = track.scrollLeft >= maxLeft - 2;
    const nextLeft =
      direction === -1 && atStart
        ? maxLeft
        : direction === 1 && atEnd
          ? 0
          : Math.min(maxLeft, Math.max(0, track.scrollLeft + direction * step));
    track.scrollTo({
      left: nextLeft,
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  };

  return (
    <div className="smh-theme-rail">
      <div className="smh-theme-rail-bar">
        <p>
          <strong>{count}</strong> {count === 1 ? "theme" : "themes"}, newest
          first. Swipe, or use the arrows.
        </p>
        <div className="smh-theme-rail-controls" aria-label="Browse themes">
          <button
            type="button"
            onClick={() => move(-1)}
            aria-label="Previous theme"
            aria-controls="smh-theme-track"
          >
            <ChevronLeft size={20} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => move(1)}
            aria-label="Next theme"
            aria-controls="smh-theme-track"
          >
            <ChevronRight size={20} aria-hidden />
          </button>
        </div>
      </div>
      <div
        className="smh-theme-track"
        id="smh-theme-track"
        ref={trackRef}
        role="region"
        tabIndex={0}
        aria-label="Latest themes"
      >
        {children}
      </div>
    </div>
  );
}
