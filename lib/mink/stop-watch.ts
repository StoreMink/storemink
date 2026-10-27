import "server-only";

import { logError, logWarn } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// ★ Seeing a stop asked for on another instance, shared by a Mink run
// (run-stop.ts) and a Refine with Mink AI request (refine-stop.ts). Both
// record the stop on their own row, because behind Google's load balancer an
// aborted browser fetch never reaches Cloud Run; whichever instance is doing
// the work reads that row here, and the instance that recorded the stop
// reaches it at once through the live registry below.
// ---------------------------------------------------------------------------

/** How often a watch looks for a stop: every second at first, then every two. */
export const STOP_WATCH_FAST_MS = 1_000;
export const STOP_WATCH_FAST_FOR_MS = 15_000;
export const STOP_WATCH_SLOW_MS = 2_000;
/** ±15%, so watches started together do not read in step. */
export const STOP_WATCH_JITTER = 0.15;

export interface StopWatch {
  /** No new read starts; idempotent. */
  close(): void;
  /**
   * Resolves once no read is in flight, so no pooled connection is held by
   * this watch. Never rejects.
   */
  settled(): Promise<void>;
  /**
   * One read now, after any read in flight (never two at once). Calls
   * `onStop` once if it sees a stop. A failed read answers false and is logged
   * like a failed tick (once per watch).
   */
  checkNow(): Promise<boolean>;
}

/** A log line: the message, and the content-free fields it carries. */
export interface StopWatchLog {
  message: string;
  fields: Record<string, unknown>;
}

/**
 * Watch for a stop and call `onStop` once when one is seen. ★ One read per
 * tick (the caller's primary-key read, each in its own `withService`, never
 * inside another scope's callback), the next tick armed only after the last
 * one settled, so ticks never stack. A failed tick (a busy pool, a dropped
 * connection) is skipped and logged once per watch. Timers are unref'd, so a
 * watcher never holds a process open. `close()` ends it.
 *
 * ★ EVERY READ, THE TIMER'S AND `checkNow()`'S, GOES THROUGH ONE `readOnce()`
 * that starts after the read in flight has settled (a failed read never breaks
 * the chain), so two reads never overlap and `settled()` has exactly one
 * promise to wait for. A read cannot be cancelled once its scope holds a
 * connection, so the guarantee is on the pair: after `close()` no new read
 * starts, and `settled()` resolves once the one that may be in flight has
 * released its connection.
 */
export function watchForStop(input: {
  read: () => Promise<boolean>;
  onStop: () => void;
  /** Logged once per watch for a failed read, with the error's kind added. */
  skippedLog: StopWatchLog;
  /** Logged when `onStop` throws. */
  failedLog: StopWatchLog;
}): StopWatch {
  const startedAt = Date.now();
  let closed = false;
  let stopSeen = false;
  let warned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<boolean> | null = null;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const start = (): Promise<boolean> => {
    // ★ A read chained behind one in flight starts only if the watch is
    //   still open: close() means no NEW read, whoever asked for it.
    if (closed) return Promise.resolve(false);
    try {
      return input.read();
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const readOnce = (): Promise<boolean> => {
    const previous = inflight;
    const current = previous ? previous.then(start, start) : start();
    inflight = current;
    const forget = () => {
      if (inflight === current) inflight = null;
    };
    void current.then(forget, forget);
    return current;
  };
  const skipped = (error: unknown) => {
    if (warned) return;
    warned = true;
    // Content-free: the caller's ids and the error's kind.
    logWarn(input.skippedLog.message, {
      ...input.skippedLog.fields,
      reason: error instanceof Error ? error.name : "unknown",
    });
  };
  const fire = () => {
    if (stopSeen) return;
    stopSeen = true;
    closed = true;
    clearTimer();
    // ★ Never an unhandled rejection: a tick is a detached promise.
    try {
      input.onStop();
    } catch (error) {
      logError(input.failedLog.message, error, input.failedLog.fields);
    }
  };
  const arm = () => {
    if (closed) return;
    // ★ At most one timer is ever armed, whoever re-arms it.
    clearTimer();
    const base =
      Date.now() - startedAt < STOP_WATCH_FAST_FOR_MS
        ? STOP_WATCH_FAST_MS
        : STOP_WATCH_SLOW_MS;
    const jitter = 1 + (Math.random() * 2 - 1) * STOP_WATCH_JITTER;
    timer = setTimeout(() => void tick(), Math.round(base * jitter));
    timer.unref?.();
  };
  /** One read; true when it saw a stop. A failed read is skipped and logged. */
  const look = async (): Promise<boolean> => {
    let stopped = false;
    try {
      stopped = await readOnce();
    } catch (error) {
      skipped(error);
    }
    if (closed) return stopSeen;
    if (stopped) {
      fire();
      return true;
    }
    arm();
    return false;
  };
  const tick = async () => {
    timer = undefined;
    if (closed) return;
    await look();
  };

  arm();
  return {
    close() {
      closed = true;
      clearTimer();
    },
    settled() {
      return inflight
        ? inflight.then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve();
    },
    async checkNow() {
      if (closed) return stopSeen;
      clearTimer();
      return look();
    },
  };
}

/**
 * The same-instance fast path: work this process is doing, by key, so a stop
 * recorded here reaches it at once rather than at its watcher's next tick.
 *
 * ★ ON globalThis, NOT A MODULE `Map`: a Next build carries this module in
 * several server chunks (the reason lib/db/client.ts keeps its pool there),
 * and a stop route and the route doing the work are different handlers, so a
 * module-level map would give each its own and the stop would find nothing.
 * Each caller names its own symbol, so a run id never meets a refine key.
 */
export function createLiveStopRegistry(
  symbolName: string,
  failedLog: string,
): {
  /** Note live work; returns the unregister call. */
  register(key: string, onStop: () => void): () => void;
  /** Stop live work on this process. Work elsewhere is left to its watcher. */
  stop(key: string, fields: Record<string, unknown>): void;
} {
  const symbol = Symbol.for(symbolName);
  const processGlobal = globalThis as typeof globalThis &
    Record<symbol, Map<string, () => void> | undefined>;
  const live = (): Map<string, () => void> => {
    let entries = processGlobal[symbol];
    if (!entries) {
      entries = new Map();
      processGlobal[symbol] = entries;
    }
    return entries;
  };
  return {
    register(key, onStop) {
      const entries = live();
      entries.set(key, onStop);
      return () => {
        if (entries.get(key) === onStop) entries.delete(key);
      };
    },
    stop(key, fields) {
      const onStop = live().get(key);
      if (!onStop) return;
      try {
        onStop();
      } catch (error) {
        logError(failedLog, error, fields);
      }
    },
  };
}
