// ---------------------------------------------------------------------------
// The error a revamp step throws, with no server import, so the pure
// modules (the site compiler) can throw it and the runner can recognise it
// by class. `ports.ts` re-exports it.
// ---------------------------------------------------------------------------

export type RevampStepErrorCode =
  | "model_unavailable"
  | "model_refused"
  | "plan_invalid"
  // ★ Only ever a wait (transient): a permanent photo failure carries the
  //   code whose sentence is true for it (photos.ts `anchorFailureError`).
  | "photos_unavailable"
  // ★ A shoot that can never finish: every shot left is a photograph its
  //   check blocked, with nothing kept to crop from (photos.ts
  //   `nothingToCropFrom`), or the anchor failed its check after every
  //   redraw. Never transient; `photos_unavailable` keeps the waits on
  //   Google.
  | "photos_failed"
  | "store_changed"
  | "theme_missing"
  | "not_allowed"
  | "limit_reached"
  | "internal";

export class RevampStepError extends Error {
  constructor(
    readonly code: RevampStepErrorCode,
    message: string,
    /** True when retrying the same step later may succeed. */
    readonly transient = false,
  ) {
    super(message);
    this.name = "RevampStepError";
  }
}
