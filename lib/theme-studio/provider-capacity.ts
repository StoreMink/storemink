import { randomUUID, createHash } from "node:crypto";
import { abortable } from "./abortable";
import {
  SHARED_RATE_LIMIT_PAUSE_MAX_MS,
  sleepUnlessAborted,
} from "./rate-limit-backoff";

export interface CapacityLease {
  id: string;
  epoch: number;
}
export const PROVIDER_LEASE_MS = 120_000;
const EXPIRY_MARGIN_MS = 5_000;

/**
 * How far apart requests on one key may START (gap_ms and next_start_at on
 * theme_studio_provider_capacity, migration 0236).
 */
export interface ProviderPacing {
  /** The gap a key starts with. Must equal the gap_ms column default. */
  initialGapMs: number;
  minGapMs: number;
  maxGapMs: number;
  /** Applied to the gap after each success (epoch-fenced, like a permit). */
  successFactor: number;
  /** Applied to the gap after each refusal. */
  rateLimitFactor: number;
}

/**
 * ★★ IMAGE MODELS ARE SPACED BY START TIME (owner's decision, 2026-10-23).
 * A request on an image model's key starts no earlier than the previous start
 * plus the gap; the gap starts at 40 s, shrinks 10% per success to 10 s and
 * grows 1.5x per 429 to 45 s. Measured on storemink-staging (one shop, one
 * night): gemini-3-pro-image accepted 11 of 12 requests sent 12 s or more
 * after the previous photo, refused 5 of 7 sent straight away, and accepted
 * starts 40 s or more apart. ★ START time, not end time, and overlap is
 * allowed: spacing from the end of the last photo ties the line's pace to
 * Google's draw latency (0.91 photos a minute at run 2's 51 s draws), while
 * a start every 40 s holds about 1.5 a minute whatever a draw takes.
 * ★★ THE BOUNDS SET THE PACE, NOT THE FACTORS (owner, 2026-10-23: "Change to
 *   10 to 45 s"; robustness audit B28). x0.9 per success and x1.5 per 429
 *   cancel at about 21% of starts refused (ln(1/0.9) / ln(1.5/0.9)): refused
 *   more often, the gap climbs to the ceiling and stays there; less often, it
 *   falls to the floor, so retuning the factors only moves the 21%. With the
 *   first build's 90 s ceiling, a line refused more often than that would
 *   start once every 90 s, half the line, even when the refusals are not
 *   about our spacing at all. 45 s sits close to one start per 39 s, the
 *   busy-hour accepted rate fitted to the 23 Oct trace (an estimate), so a
 *   pinned line keeps near what Google was taking; 10 s lets a quiet hour
 *   (Google took 9 Pro photos in 75 s that day) run near the three permits,
 *   where 25 s gave away about a third of the line (simulation estimates).
 *   ★ The 40 s start and the x0.9 descent are the gradual ramp-up Google's
 *   docs ask for.
 */
export const IMAGE_START_PACING: ProviderPacing = Object.freeze({
  initialGapMs: 40_000,
  minGapMs: 10_000,
  maxGapMs: 45_000,
  successFactor: 0.9,
  rateLimitFactor: 1.5,
});

/**
 * How one outcome moved a paced key's gap, as the store wrote it. The
 * statement that moves the gap returns it (provider-capacity-store.ts), so
 * reporting it costs no read of its own.
 */
export interface PaceChange {
  outcome: "success" | "rate_limited";
  gapBeforeMs: number;
  gapAfterMs: number;
  /** The key's epoch: every refusal it records raises it by one. */
  epoch: number;
}

/**
 * Image generation models get the start pacer; text models (plans, reviews,
 * visual QA) keep plain permits. "image" covers gemini-3-pro-image (and any
 * pinned version of it), gemini-3.1-flash-image and Imagen; Nano Banana is
 * named for its own family.
 */
export function isImageProviderModel(model: string): boolean {
  return /image|nano-banana/i.test(model);
}

export interface CapacityStore {
  /** `pacing` null: plain permits. Otherwise the key is also start-paced. */
  claim(
    key: string,
    id: string,
    pacing?: ProviderPacing | null,
  ): Promise<CapacityLease | { retryAfterMs: number } | null>;
  renew(key: string, lease: CapacityLease): Promise<boolean>;
  /** Answers a paced key's gap change when a success moved it. */
  release(
    key: string,
    lease: CapacityLease,
    succeeded: boolean,
    pacing?: ProviderPacing | null,
  ): Promise<PaceChange | null | void>;
  /** `delayMs` is how long the OTHER requests on the key wait (15 s at most).
   *  Answers a paced key's gap change. */
  pause(
    key: string,
    delayMs: number,
    pacing?: ProviderPacing | null,
  ): Promise<PaceChange | null | void>;
}
export interface ProviderPermit {
  signal: AbortSignal;
  succeeded(): void;
  rateLimited(delayMs: number): Promise<void>;
}
export interface ProviderRunOptions {
  /**
   * Ends only the WAIT for a permit (and, on a paced key, for its next
   * start); a call it finds admitted is untouched and finishes on `signal`.
   * How a caller says "start nothing new" (the revamp's deadline drain)
   * without cutting off a request already on the wire.
   */
  admission?: AbortSignal;
}

export interface ProviderCapacity {
  run<T>(
    operation: (permit: ProviderPermit) => Promise<T>,
    signal: AbortSignal,
    options?: ProviderRunOptions,
  ): Promise<T>;
}

export class ProviderCapacityLost extends Error {
  constructor() {
    super("Provider capacity lease lost");
  }
}

/**
 * The capacity row a call queues on: one per project, location and model.
 * ★ A `scope` splits one model into its own permits, pause and pace (the
 *   storefront revamp's planner, so a 97 to 244 s planning call never holds a
 *   permit its photo checks need). No scope hashes the original three parts,
 *   so every row written before scopes existed is still the same row.
 */
export function providerCapacityKey(
  project: string,
  location: string,
  model: string,
  scope?: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        scope ? [project, location, model, scope] : [project, location, model],
      ),
    )
    .digest("hex");
}

/** Admission is shared by DB leases. No transaction spans an SDK request or
 * a cooldown. Confirmed lease loss/expiry aborts transport; admission fails closed. */
export function coordinatedProviderCapacity(
  store: CapacityStore,
  key: string,
  options: {
    /** Start-time pacing for an image model's key; omitted: plain permits. */
    pacing?: ProviderPacing | null;
    /** Each gap change the store reports (sharedProviderCapacity logs it). */
    onPaceChange?: (change: PaceChange) => void;
    pollMs?: number;
    heartbeatMs?: number;
    /** Short clocks for expiry regressions; production uses the DB lease TTL. */
    leaseMs?: number;
    sleep?: typeof sleepUnlessAborted;
    onCleanupError?: (error: unknown) => void;
    onRenewalError?: (error: unknown) => void;
  } = {},
): ProviderCapacity {
  const sleep = options.sleep ?? sleepUnlessAborted;
  const pacing = options.pacing ?? null;
  // ★ A log line never costs a paid response, a pause or a permit.
  const reportPace = (change: PaceChange | null | void) => {
    if (!change) return;
    try {
      options.onPaceChange?.(change);
    } catch {}
  };
  return {
    async run(operation, outer, runOptions) {
      const id = randomUUID();
      let lease: CapacityLease | null = null;
      let claimedAt = 0;
      let waits = 0;
      // ★★ A WAITER THE ADMISSION SIGNAL STOPS NEVER CLAIMS AGAIN. On a paced
      //   key an admission stamps the next start, so a caller admitted only
      //   to send nothing (the revamp's deadline drain) still pushed every
      //   other caller on the key a whole gap back: Theme Studio's photos and
      //   other redesigns lost that start with no call made. The wait ends at
      //   either signal; the operation keeps `outer` and the lease, so a call
      //   already sent still finishes. ⚠ A claim already on its way back when
      //   the admission signal fires can still stamp one start: its late
      //   lease is released below, and the caller's own check at the permit
      //   refuses to send.
      const waiting = runOptions?.admission
        ? AbortSignal.any([outer, runOptions.admission])
        : outer;
      while (!lease) {
        waiting.throwIfAborted();
        // Observe a late DB claim and release it if the caller cancelled while
        // the transaction was committing. Never orphan a paid-call permit.
        const started = Date.now();
        // ★ A paced key answers with the wait until its next start, which
        //   the sleep below honours exactly: no polling while it is spaced.
        const claim = store.claim(key, id, pacing);
        try {
          const admitted = await abortable(() => claim, waiting);
          if (admitted && "id" in admitted) {
            lease = admitted;
            claimedAt = started;
          } else {
            const delay =
              admitted?.retryAfterMs ??
              Math.min(
                5000,
                (options.pollMs ?? 1000) * 2 ** Math.min(waits++, 3),
              );
            if (!(await sleep(Math.max(1, Math.min(120_000, delay)), waiting)))
              waiting.throwIfAborted();
          }
        } catch (error) {
          void claim
            .then((late) => {
              if (late && "id" in late) return store.release(key, late, false);
            })
            .catch(() => {});
          throw error;
        }
      }
      const held = lease;
      const lost = new AbortController();
      const signal = AbortSignal.any([outer, lost.signal]);
      let succeeded = false;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;
      let renewing: Promise<void> | undefined;
      const leaseMs = options.leaseMs ?? PROVIDER_LEASE_MS;
      const margin = Math.min(EXPIRY_MARGIN_MS, leaseMs / 10);
      const expireAt = (started: number) => {
        clearTimeout(expiryTimer);
        if (started + leaseMs - margin <= Date.now()) {
          lost.abort(new ProviderCapacityLost());
          return;
        }
        expiryTimer = setTimeout(
          () => lost.abort(new ProviderCapacityLost()),
          Math.max(0, started + leaseMs - margin - Date.now()),
        );
        expiryTimer.unref?.();
      };
      const heartbeat = (delay = options.heartbeatMs ?? 30_000) => {
        timer = setTimeout(() => {
          const started = Date.now();
          let next = options.heartbeatMs ?? 30_000;
          renewing = store
            .renew(key, held)
            .then((ok) => {
              if (!ok) lost.abort(new ProviderCapacityLost());
              else if (!stopped && !signal.aborted) expireAt(started);
            })
            .catch((error) => {
              // An exception is not evidence that our still-valid lease was lost.
              // Retry briefly; the independent expiry clock always fences transport.
              next = Math.min(5000, options.heartbeatMs ?? 30_000);
              options.onRenewalError?.(error);
            })
            .finally(() => {
              if (!stopped && !signal.aborted) heartbeat(next);
            });
        }, delay);
        timer.unref?.();
      };
      expireAt(claimedAt);
      heartbeat();
      try {
        return await abortable(
          () =>
            operation({
              signal,
              succeeded: () => {
                succeeded = true;
              },
              // ★ Others wait at most the shared ceiling, whatever this
              //   caller's own backoff is (NaN or a negative still throws in
              //   the store, which validates).
              rateLimited: async (delayMs) =>
                reportPace(
                  await store.pause(
                    key,
                    Math.min(delayMs, SHARED_RATE_LIMIT_PAUSE_MAX_MS),
                    pacing,
                  ),
                ),
            }),
          signal,
        );
      } finally {
        stopped = true;
        clearTimeout(timer);
        clearTimeout(expiryTimer);
        // A cleanup outage must not discard an already paid provider response.
        // The lease expires conservatively and new admission still fails closed.
        await abortable(async () => {
          await renewing;
          reportPace(
            await store.release(
              key,
              held,
              succeeded && !signal.aborted,
              pacing,
            ),
          );
        }, AbortSignal.timeout(6000)).catch((error) =>
          options.onCleanupError?.(error),
        );
      }
    },
  };
}

/** Standalone evals have no DB. Production worker factories explicitly supply
 * the shared coordinator; test transports remain database independent. */
export const uncoordinatedProviderCapacity: ProviderCapacity = {
  // Nothing to wait for, so only an admission already ended refuses.
  run: async (operation, signal, options) => {
    options?.admission?.throwIfAborted();
    return operation({ signal, succeeded() {}, async rateLimited() {} });
  },
};
