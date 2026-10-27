/**
 * A POST that must outlive the page: the editor's Refine stop and the Mink
 * composer's discard of a staged upload. Client-safe.
 *
 * ★ The beacon first: it is the API built for a page that is going away, and
 * the unload cannot cancel it. A same-origin keepalive fetch only when the
 * beacon is refused (its queue is full) or THROWS (older Chromium threw a
 * SecurityError for a JSON Blob, crbug 490015), so one throwing beacon never
 * skips the requests after it.
 * ★ NEVER THROWS: it runs inside `pagehide` handlers and loops, where a throw
 * would stop every request after this one.
 */
export function sendPageExitRequest(url: string, body: string | Blob): void {
  let queued = false;
  try {
    queued =
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(url, body);
  } catch {
    queued = false;
  }
  if (queued) return;
  try {
    void fetch(url, {
      method: "POST",
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    // Nothing left to try.
  }
}
