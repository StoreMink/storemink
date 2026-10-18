"use client";

import { useEffect, useRef, type RefObject } from "react";

const BARS = 120;
const TICK_MS = 70;
const REST = 0.12;

/**
 * A chunk's loudness (RMS, 0 to 1) as a bar height from 0 to 1. Speech sits
 * roughly between 0.02 and 0.2, so the square root spreads ordinary talking
 * across the bar instead of leaving everything but a shout near the floor.
 */
export function minkWaveformHeight(level: number) {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.min(1, Math.sqrt(level / 0.2));
}

/** Seconds as the composer's clock: 0:07, 1:05. */
export function formatMinkClock(seconds: number) {
  const whole =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The live microphone waveform, ChatGPT-style: newest bar on the right,
 * older ones drifting left. `size` picks the composer's slim strip or the
 * voice view's stage.
 *
 * ★ IT NEVER RE-RENDERS. The recorder reports a level about 125 times a
 * second, far too often for React state, so the composer keeps a decaying peak
 * in `levelRef` and this samples it on a timer and paints the bars through the
 * DOM directly. While `live` is false (starting, thinking, speaking) the
 * bars rest as a flat dotted line.
 */
export function MinkWaveform({
  levelRef,
  live,
  className = "",
  size = "sm",
}: {
  levelRef: RefObject<number>;
  live: boolean;
  className?: string;
  size?: "sm" | "lg";
}) {
  const height = size === "lg" ? "h-16" : "h-6";
  const bar = size === "lg" ? "h-16 w-1" : "h-6 w-[3px]";
  const barsRef = useRef<HTMLDivElement>(null);
  const history = useRef<number[]>(Array(BARS).fill(0));

  useEffect(() => {
    const paint = () => {
      const bars = barsRef.current?.children;
      if (!bars) return;
      history.current.forEach((height, index) => {
        const bar = bars[index] as HTMLElement | undefined;
        if (bar) bar.style.transform = `scaleY(${REST + height * (1 - REST)})`;
      });
    };
    history.current = Array(BARS).fill(0);
    paint();
    if (!live) return;
    const timer = window.setInterval(() => {
      history.current.push(minkWaveformHeight(levelRef.current ?? 0));
      history.current.shift();
      paint();
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [live, levelRef]);

  return (
    <div
      ref={barsRef}
      aria-hidden="true"
      data-testid="mink-waveform"
      className={`flex ${height} min-w-0 items-center justify-end gap-[3px] overflow-hidden ${className}`}
    >
      {Array.from({ length: BARS }, (_, index) => (
        <span
          key={index}
          className={`block ${bar} shrink-0 rounded-full bg-current transition-transform duration-75 motion-reduce:transition-none`}
          style={{ transform: `scaleY(${REST})` }}
        />
      ))}
    </div>
  );
}
