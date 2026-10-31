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
  /** Keep a conservative floor after a refusal's shared cooldown ends. */
  recoveryFloorMs?: number;
  recoveryHoldMs?: number;
}

/**
 * Start-time pacing stays between 31 and 45 seconds. A new key starts at
 * 40 seconds and a success gradually probes faster capacity down to the
 * floor. A 429 widens to at least 40 seconds, then holds that floor for ten
 * minutes after the shared cooldown ends. The database's epoch/pause_until
 * keep this memory across processes and restarts. A success from before the
 * refusal is stale.
 * ★★ THE FLOOR IS THE PROVIDER'S OWN LIMIT, NOT A GUESS (read in the Quotas
 *   console on 2026-10-28): "Generate content with image generation
 *   requests" is a SYSTEM LIMIT of 2 per minute per project per base model
 *   on the global endpoint, and 2 per minute per region, and the console
 *   says it is not adjustable. The old 10 s floor let the pacer probe to six
 *   starts a minute, and the 28% of nano-banana draws refused last week
 *   were exactly that probing. 31 s, not 30, so that no sixty-second window
 *   can hold a third start when two land on its edges. Every image caller
 *   (a redesign's photos, Theme Studio's) shares the one key per project,
 *   location and model, so the floor bounds the project, not a caller.
 */
export const IMAGE_START_PACING: ProviderPacing = Object.freeze({
  initialGapMs: 40_000,
  minGapMs: 31_000,
  maxGapMs: 45_000,
  successFactor: 0.9,
  rateLimitFactor: 1.5,
  recoveryFloorMs: 40_000,
  recoveryHoldMs: 10 * 60_000,
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
