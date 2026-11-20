import { randomUuid } from "@/lib/random-uuid";
import { toast } from "sonner";
import type { ImageSpecKey } from "@/lib/media/image-specs";
import { sendPageExitRequest } from "@/lib/http/page-exit-request";
import {
  readRefineStopAnswer,
  type RefineStopAnswer,
} from "@/lib/mink/refine-stop-types";

// ---------------------------------------------------------------------------
// ★★ A REFINE BELONGS TO ITS PAGE AND ITS SLOT, NOT TO A REACT INSTANCE
// (26 Oct 2026). Behind the production load balancer an aborted fetch never
// reaches Cloud Run, so an editor that unmounted (or a tab that closed) mid-
// refine was still charged. Every refine now carries a random stop token, and
// this module (one per tab, no React) owns it:
//   - it STOPS when the document goes away (every `pagehide`), the dashboard
//     route changes away from where it started, the dashboard unmounts, the
//     merchant signs out, a dialog hosting it closes, or its slot is
//     destroyed (ImageRefineScope, the builder's sweep, a changed slot size);
//     a stop is a request to /api/mink/image-refine/stop, and the server
//     decides whether it or the charge came first;
//   - an unmount caused only by layout (a collapsed group, another builder
//     section) neither stops it nor shows its photo elsewhere: a box finds its
//     refine by (scope, slot size, the photo it shows now).
// ★ A request that dies while the page stays open (a mobile network, an iOS
// background) is not a failure to show: the editor asks the stop route what
// happened, which is also a stop. The merchant then sees the photo (the
// charge had won) or is told nothing was charged (the stop won), and a retry
// can no longer charge twice.
// ---------------------------------------------------------------------------

const REFINE_URL = "/api/mink/image-refine";
const STOP_URL = "/api/mink/image-refine/stop";
/** How long the editor waits for a refine; the server's own deadline is 150 s. */
export const REFINE_CLIENT_WAIT_MS = 200_000;
/** One more outcome request after an unknown answer, this much later. */
const OUTCOME_RETRY_MS = 2_000;
const OUTCOME_TIMEOUT_MS = 10_000;

export const REFINE_READY_TOAST =
  "Your refined photo is ready. Go back to that image to compare it with the original, or find it in your Media Library.";
const LEFT_PAGE_TEXT =
  "Refining was stopped because you left the page. Nothing was charged.";
const DROPPED_TEXT =
  "The connection dropped, so refining was stopped. Nothing was charged; try again.";
const TOO_LONG_TEXT =
  "Refining took too long, so it was stopped. Nothing was charged; try again.";
const RECORDED_TEXT = "Refining failed. Check your connection and try again.";
const UNKNOWN_TEXT =
  "We couldn't confirm whether your refined photo was saved. Check your Media Library before you try again.";

/** What a box shows for its refine. Immutable: replaced on every change. */
export type RefineView =
  | { status: "running" }
  | { status: "done"; resultUrl: string }
  | { status: "failed"; message: string };

type Entry = {
  matchKey: string;
  token: string;
  scope: string;
  pathname: string;
  spec: ImageSpecKey;
  sourceUrl: string;
  status: RefineView["status"];
  controller: AbortController;
  /** A `pagehide` with `persisted: true` happened while it ran. */
  hiddenWhileRunning: boolean;
  watchdog?: ReturnType<typeof setTimeout>;
  /** Why the dead-request path ran, for its text. */
  lostBy?: "watchdog" | "connection";
  /** Whether a box has shown this entry's failure. */
  shown: boolean;
  view: RefineView;
};

const entries = new Map<string, Entry>();
/** Boxes watching each key now (a box may watch before any refine exists). */
const viewers = new Map<string, number>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

export function refineMatchKey(
  scope: string,
  spec: ImageSpecKey,
  sourceUrl: string,
): string {
  return `${scope}\n${spec}\n${sourceUrl}`;
}

/** The stop, as a request that outlives the page (beacon first). */
function sendRefineStop(token: string) {
  sendPageExitRequest(STOP_URL, JSON.stringify({ stopToken: token }));
}

/**
 * What became of a refine whose answer this page cannot receive. ★ Asking IS
 * a stop: a stop that still wins is the right outcome for a request nobody
 * can hear. Anything but a decided 200 is `unknown`; `unknown` is asked once
 * more, two seconds later.
 */
async function askRefineOutcome(token: string): Promise<RefineStopAnswer> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, OUTCOME_RETRY_MS));
    }
    let answer: RefineStopAnswer = { outcome: "unknown" };
    try {
      const res = await fetch(STOP_URL, {
        method: "POST",
        body: JSON.stringify({ stopToken: token }),
        credentials: "same-origin",
        keepalive: true,
        ...(typeof AbortSignal.timeout === "function"
          ? { signal: AbortSignal.timeout(OUTCOME_TIMEOUT_MS) }
          : {}),
      });
      if (res.status === 200) {
        answer = readRefineStopAnswer(JSON.parse(await res.text()));
      }
    } catch {
      answer = { outcome: "unknown" };
    }
    if (answer.outcome !== "unknown") return answer;
  }
  return { outcome: "unknown" };
}

function clearWatchdog(entry: Entry) {
  if (entry.watchdog) clearTimeout(entry.watchdog);
  entry.watchdog = undefined;
}

/** Still the refine its box is waiting for. */
function stillWaiting(entry: Entry): boolean {
  return entries.get(entry.matchKey) === entry && entry.status === "running";
}

function settle(entry: Entry, view: RefineView) {
  clearWatchdog(entry);
  entry.status = view.status;
  entry.view = view;
  const watching = viewers.get(entry.matchKey) ?? 0;
  if (view.status === "failed" && watching > 0) entry.shown = true;
  if (view.status === "done" && watching === 0) toast(REFINE_READY_TOAST);
  notify();
}

/** The request died, or never answered: ask the server what happened. */
function lose(entry: Entry, by: "watchdog" | "connection") {
  entry.lostBy ??= by;
  clearWatchdog(entry);
  void askRefineOutcome(entry.token).then((answer) => {
    if (!stillWaiting(entry)) return;
    switch (answer.outcome) {
      case "stopped":
        settle(entry, {
          status: "failed",
          message: entry.lostBy === "watchdog" ? TOO_LONG_TEXT : DROPPED_TEXT,
        });
        return;
      case "too_late":
        settle(
          entry,
          answer.url
            ? { status: "done", resultUrl: answer.url }
            : { status: "failed", message: UNKNOWN_TEXT },
        );
        return;
      case "recorded":
        // ★ No promise: during a deploy an old instance may still charge.
        settle(entry, { status: "failed", message: RECORDED_TEXT });
        return;
      default:
        settle(entry, { status: "failed", message: UNKNOWN_TEXT });
    }
  });
}

async function run(entry: Entry) {
  // ★ Ignored unless still the current refine for its key and not stopped
  //   by this page (a released or replaced refine's late answer is nobody's).
  const current = () => stillWaiting(entry) && !entry.controller.signal.aborted;
  let res: Response;
  try {
    res = await fetch(REFINE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: entry.sourceUrl,
        spec: entry.spec,
        stopToken: entry.token,
      }),
      signal: entry.controller.signal,
    });
  } catch {
    if (current()) lose(entry, "connection");
    return;
  }
  // ★ Read whatever its Content-Type: our route answers only JSON, and an
  //   edge failure (an HTML 502, plain text, nothing) never parses to an
  //   object with a string `url` or `error`.
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(await res.text());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }
  if (!current()) return;
  if (res.ok && body && typeof body.url === "string") {
    settle(entry, { status: "done", resultUrl: body.url });
    return;
  }
  // ★ "Already being refined" can only reach this page when the same POST
  //   reached the server twice (one token per click): the answer this page
  //   can read is not the one doing the work, so it is a lost answer.
  if (body && body.code === "refine_duplicate") {
    lose(entry, "connection");
    return;
  }
  // A definitive refusal from our route keeps its own text and sends no stop.
  if (!res.ok && body && typeof body.error === "string") {
    settle(entry, { status: "failed", message: body.error });
    return;
  }
  lose(entry, "connection");
}

export function startImageRefine(input: {
  scope: string;
  pathname: string;
  spec: ImageSpecKey;
  sourceUrl: string;
}): void {
  const matchKey = refineMatchKey(input.scope, input.spec, input.sourceUrl);
  const existing = entries.get(matchKey);
  if (existing?.status === "running") return;
  const view: RefineView = { status: "running" };
  const entry: Entry = {
    matchKey,
    token: randomUuid(),
    scope: input.scope,
    pathname: input.pathname,
    spec: input.spec,
    sourceUrl: input.sourceUrl,
    status: "running",
    controller: new AbortController(),
    hiddenWhileRunning: false,
    shown: false,
    view,
  };
  entries.set(matchKey, entry);
  entry.watchdog = setTimeout(() => {
    if (!stillWaiting(entry)) return;
    // ★ The fetch first, so its own failure reads as this page's stop.
    entry.controller.abort();
    lose(entry, "watchdog");
  }, REFINE_CLIENT_WAIT_MS);
  notify();
  void run(entry);
}

/** "Use refined photo" or "Keep original": the refine is finished with. */
export function settleImageRefine(matchKey: string): void {
  const entry = entries.get(matchKey);
  if (!entry) return;
  if (entry.status === "running") {
    releaseImageRefines((refine) => refine.matchKey === matchKey);
    return;
  }
  entries.delete(matchKey);
  notify();
}

/**
 * Let go of the refines the predicate names: a running one is stopped (its
 * fetch aborted and the stop sent), a finished one simply forgotten (its photo
 * stays in the Media Library). ★ Fails safe: a release only ever stops a
 * refine, and a stopped refine charges nothing unless its charge came first.
 */
export function releaseImageRefines(
  predicate: (refine: {
    matchKey: string;
    scope: string;
    pathname: string;
    sourceUrl: string;
    spec: ImageSpecKey;
    status: RefineView["status"];
  }) => boolean,
): void {
  let changed = false;
  for (const entry of [...entries.values()]) {
    if (!predicate(entry)) continue;
    if (entry.status === "running") {
      clearWatchdog(entry);
      sendRefineStop(entry.token);
      entry.controller.abort();
    }
    entries.delete(entry.matchKey);
    changed = true;
  }
  if (changed) notify();
}

/** The dashboard route changed: refines started on another path go. */
export function releaseImageRefinesOffPath(pathname: string): void {
  releaseImageRefines((refine) => refine.pathname !== pathname);
}

/**
 * Stop every running refine and forget every refine: the dashboard is going
 * away (sign-out, the layout unmounting). The stops are keepalive fetches,
 * not beacons, so they can be waited for: resolves once every stop answered
 * or `waitMs` passed (default 0: does not wait). Never throws.
 */
export function stopAllImageRefines(
  options: { waitMs?: number } = {},
): Promise<void> {
  const stops: Promise<unknown>[] = [];
  for (const entry of entries.values()) {
    if (entry.status !== "running") continue;
    clearWatchdog(entry);
    entry.controller.abort();
    try {
      stops.push(
        fetch(STOP_URL, {
          method: "POST",
          body: JSON.stringify({ stopToken: entry.token }),
          credentials: "same-origin",
          keepalive: true,
        }).catch(() => undefined),
      );
    } catch {
      // A fetch that throws at once has nothing to wait for.
    }
  }
  const hadEntries = entries.size > 0;
  entries.clear();
  if (hadEntries) notify();
  const waitMs = options.waitMs ?? 0;
  if (stops.length === 0 || waitMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    void Promise.allSettled(stops).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * ★ EVERY `pagehide` SENDS THE STOP. A same-tab navigation fires it with
 * `persisted: true` too (back/forward cache, even on a no-store page), and
 * Back may never come. The fetch is aborted only when the page is being
 * discarded: aborting it on a page that comes back would leave its spinner
 * running for ever. That page is told what happened on `pageshow`.
 */
export function handlePageHide(event: PageTransitionEvent): void {
  let changed = false;
  for (const entry of [...entries.values()]) {
    if (entry.status !== "running") continue;
    sendRefineStop(entry.token);
    if (event.persisted) {
      entry.hiddenWhileRunning = true;
    } else {
      clearWatchdog(entry);
      entry.controller.abort();
      entries.delete(entry.matchKey);
      changed = true;
    }
  }
  if (changed) notify();
}

/**
 * A page back from the back/forward cache asks what became of each refine
 * it stopped on the way out. `stopped` and `too_late` with a photo are
 * decided; `recorded`, `unknown` and a `too_late` without a photo leave the
 * fetch to finish, because only the server's own answer is true there.
 */
export function handlePageShow(event: PageTransitionEvent): void {
  if (!event.persisted) return;
  for (const entry of [...entries.values()]) {
    if (entry.status !== "running" || !entry.hiddenWhileRunning) continue;
    entry.hiddenWhileRunning = false;
    void askRefineOutcome(entry.token).then((answer) => {
      if (!stillWaiting(entry)) return;
      if (answer.outcome === "stopped") {
        settle(entry, { status: "failed", message: LEFT_PAGE_TEXT });
        entry.controller.abort();
      } else if (answer.outcome === "too_late" && answer.url) {
        settle(entry, { status: "done", resultUrl: answer.url });
        entry.controller.abort();
      }
    });
  }
}

export function subscribeImageRefines(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The view for a key: the same object until the refine changes. */
export function getImageRefineView(matchKey: string | null): RefineView | null {
  if (!matchKey) return null;
  return entries.get(matchKey)?.view ?? null;
}

/**
 * A box watching a key, while it is mounted. The "ready" toast is shown only
 * when none is; a failure a box has shown is forgotten when its last box goes,
 * so an old message never comes back on that photo later.
 */
export function addImageRefineViewer(matchKey: string): () => void {
  viewers.set(matchKey, (viewers.get(matchKey) ?? 0) + 1);
  const entry = entries.get(matchKey);
  if (entry?.status === "failed") entry.shown = true;
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    const left = Math.max(0, (viewers.get(matchKey) ?? 0) - 1);
    if (left === 0) viewers.delete(matchKey);
    else viewers.set(matchKey, left);
    const current = entries.get(matchKey);
    if (left > 0 || current?.status !== "failed" || !current.shown) return;
    // ★ Forgotten a moment later, not now: React runs every effect cleanup of
    //   a commit before any setup, so a box that detaches and attaches again
    //   in one commit (Strict Mode's second mount, two boxes swapping photos)
    //   would otherwise lose a message it still shows.
    queueMicrotask(() => {
      if ((viewers.get(matchKey) ?? 0) > 0) return;
      if (entries.get(matchKey) !== current) return;
      entries.delete(matchKey);
      notify();
    });
  };
}

export function resetImageRefinesForTests(): void {
  for (const entry of entries.values()) {
    clearWatchdog(entry);
    entry.controller.abort();
  }
  entries.clear();
  viewers.clear();
}
