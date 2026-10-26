/**
 * What `POST /api/mink/image-refine/stop` answered. Client-safe (no server
 * imports), so the dashboard's image editor can read it without pulling in
 * the database client: the run-stop-types.ts split.
 *
 * ★ A stop is a REQUEST the refine's own row decides, not an aborted fetch.
 * Behind the production load balancer an aborted fetch never reaches Cloud
 * Run, so a merchant who left mid-refine was still charged (25 Oct 2026). The
 * browser gives every refine a random stop token and sends it here when it
 * leaves or loses the answer; the server decides whether the stop or the
 * charge came first (lib/mink/refine-stop.ts).
 */
export type RefineStopAnswer =
  /** A refine had begun with this token, and now it can never be charged. */
  | { outcome: "stopped" }
  /**
   * No refine has begun with this token yet: the stop is kept, and a refine
   * that arrives later refuses to start. ★ It promises nothing: during a
   * deploy an old instance may still charge a refine it never names.
   */
  | { outcome: "recorded" }
  /** The charge came first; `url` is the refined photo when it is known. */
  | { outcome: "too_late"; url: string | null }
  /** The browser could not find out. */
  | { outcome: "unknown" };

/** A random (v1 to v8) UUID, as `crypto.randomUUID()` and minkRandomUuid() make. */
export const REFINE_STOP_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The longest refined-photo URL the browser keeps from a stop answer. */
const MAX_URL_LENGTH = 2_048;

/**
 * Reads a stop answer strictly. Anything it does not recognise is `unknown`:
 * "Nothing was charged" may only follow an explicit `stopped`. A URL is kept
 * only when it is an https URL of a sane length.
 */
export function readRefineStopAnswer(value: unknown): RefineStopAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { outcome: "unknown" };
  }
  const record = value as Record<string, unknown>;
  switch (record.outcome) {
    case "stopped":
      return { outcome: "stopped" };
    case "recorded":
      return { outcome: "recorded" };
    case "too_late": {
      const url = record.url;
      return {
        outcome: "too_late",
        url:
          typeof url === "string" &&
          url.startsWith("https://") &&
          url.length <= MAX_URL_LENGTH
            ? url
            : null,
      };
    }
    default:
      return { outcome: "unknown" };
  }
}
