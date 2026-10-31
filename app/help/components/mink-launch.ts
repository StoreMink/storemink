"use client";

/**
 * Opens the Help Centre's Mink AI drawer from anywhere on a Help page (the
 * hero, the "Still need help?" card). The drawer lives in the layout's
 * header, so pages ask for it with a window event rather than sharing state.
 * ★ Dispatched synchronously inside the click, so "talk" still counts as a
 * tap when the drawer starts the microphone and primes speech.
 */
export const OPEN_HELP_MINK_EVENT = "sm-help:open-mink";

export type OpenHelpMinkDetail = {
  /** "talk" opens straight into a spoken conversation. */
  mode?: "chat" | "talk";
  /** A question to ask as soon as the drawer opens. */
  question?: string;
  /** Open in the full view (the header's Mink AI link) rather than the drawer. */
  expand?: boolean;
};

export function openHelpMink(detail: OpenHelpMinkDetail = {}) {
  window.dispatchEvent(
    new CustomEvent<OpenHelpMinkDetail>(OPEN_HELP_MINK_EVENT, { detail }),
  );
}

export function readOpenHelpMinkDetail(event: Event): OpenHelpMinkDetail {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return {};
  const { mode, question, expand } = detail as Record<string, unknown>;
  return {
    mode: mode === "talk" ? "talk" : "chat",
    question:
      typeof question === "string" && question.trim()
        ? question.trim().slice(0, 400)
        : undefined,
    // Only ever present when true, so an ordinary open reads as it always has.
    ...(expand === true ? { expand: true } : {}),
  };
}
