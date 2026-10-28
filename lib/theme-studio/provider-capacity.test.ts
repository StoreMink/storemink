import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  coordinatedProviderCapacity,
  IMAGE_START_PACING,
  isImageProviderModel,
  providerCapacityKey,
  uncoordinatedProviderCapacity,
  type CapacityStore,
} from "./provider-capacity";
import { SHARED_RATE_LIMIT_PAUSE_MAX_MS } from "./rate-limit-backoff";

describe("shared provider capacity", () => {
  it("sleeps through a known database cooldown without polling the row lock", async () => {
    const claim = vi.fn(async (_, id: string) => ({ id, epoch: 0 }));
    claim.mockResolvedValueOnce({ retryAfterMs: 120_000 } as never);
    const sleep = vi.fn(async () => true);
    const store: CapacityStore = {
      claim,
      async renew() {
        return true;
      },
      async release() {},
      async pause() {},
    };
    await expect(
      coordinatedProviderCapacity(store, "key", { sleep }).run(
        async () => "done",
        new AbortController().signal,
      ),
    ).resolves.toBe("done");
    expect(claim).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(120_000, expect.anything());
  });

  it("retries a transient heartbeat failure while its existing lease remains valid", async () => {
    const renew = vi
      .fn(async () => true)
      .mockRejectedValueOnce(new Error("Temporary timeout"));
    const store: CapacityStore = {
      async claim(_, id) {
        return { id, epoch: 0 };
      },
      renew,
      async release() {},
      async pause() {},
    };
    const errors = vi.fn();
    await expect(
      coordinatedProviderCapacity(store, "key", {
        heartbeatMs: 5,
        onRenewalError: errors,
      }).run(async (permit) => {
        await new Promise((resolve) => setTimeout(resolve, 35));
        expect(permit.signal.aborted).toBe(false);
        return "paid bytes";
      }, new AbortController().signal),
    ).resolves.toBe("paid bytes");
    expect(errors).toHaveBeenCalledOnce();
    expect(renew.mock.calls.length).toBeGreaterThan(1);
  });

  it("fences transport before expiry when every renewal throws", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn(async () => {});
      const store: CapacityStore = {
        async claim(_, id) {
          return { id, epoch: 0 };
        },
        async renew() {
          throw new Error("DB down");
        },
        release,
        async pause() {},
      };
      const pending = coordinatedProviderCapacity(store, "key", {
        heartbeatMs: 10,
        leaseMs: 100,
      }).run(() => new Promise(() => {}), new AbortController().signal);
      const rejected = expect(pending).rejects.toThrow("lease lost");
      await vi.advanceTimersByTimeAsync(90);
      await rejected;
      expect(release).toHaveBeenCalledWith(
        "key",
        expect.anything(),
        false,
        null,
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("waits without starting paid work and releases the permit after registering a cooldown", async () => {
    const events: string[] = [];
    let claims = 0;
    const store: CapacityStore = {
      async claim(_, id) {
        events.push("claim");
        return ++claims === 1 ? null : { id, epoch: 1 };
      },
      async renew() {
        return true;
      },
      async release(_, __, success) {
        events.push(`release:${success}`);
      },
      async pause() {
        events.push("pause");
      },
    };
    const capacity = coordinatedProviderCapacity(store, "key", {
      async sleep() {
        events.push("wait");
        return true;
      },
    });
    await expect(
      capacity.run(async (permit) => {
        events.push("paid");
        await permit.rateLimited(15000);
        return "429";
      }, new AbortController().signal),
    ).resolves.toBe("429");
    expect(events).toEqual([
      "claim",
      "wait",
      "claim",
      "paid",
      "pause",
      "release:false",
    ]);
  });
  it("fails closed before transport on database failure", async () => {
    const operation = vi.fn();
    const store = {
      claim: vi.fn().mockRejectedValue(new Error("DB down")),
    } as unknown as CapacityStore;
    await expect(
      coordinatedProviderCapacity(store, "key").run(
        operation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("DB down");
    expect(operation).not.toHaveBeenCalled();
  });
  it("releases a claim that commits after cancellation", async () => {
    let resolve!: (v: { id: string; epoch: number }) => void;
    const release = vi.fn(async () => {});
    const store = {
      claim: () =>
        new Promise((r) => {
          resolve = r;
        }),
      release,
    } as unknown as CapacityStore;
    const controller = new AbortController();
    const run = coordinatedProviderCapacity(store, "key").run(
      vi.fn(),
      controller.signal,
    );
    controller.abort(new Error("cancelled"));
    await expect(run).rejects.toThrow("cancelled");
    resolve({ id: "late", epoch: 0 });
    await vi.waitFor(() =>
      expect(release).toHaveBeenCalledWith(
        "key",
        { id: "late", epoch: 0 },
        false,
      ),
    );
  });
  it("aborts in-flight transport when renewal is fenced out, while preserving paid responses on cleanup failure", async () => {
    const release = vi.fn(async () => {
      throw new Error("DB down");
    });
    const store: CapacityStore = {
      async claim(_, id) {
        return { id, epoch: 0 };
      },
      async renew() {
        return false;
      },
      release,
      async pause() {},
    };
    const capacity = coordinatedProviderCapacity(store, "key", {
      heartbeatMs: 5,
    });
    await expect(
      capacity.run(
        (permit) =>
          new Promise((_, reject) =>
            permit.signal.addEventListener("abort", () =>
              reject(permit.signal.reason),
            ),
          ),
        new AbortController().signal,
      ),
    ).rejects.toThrow("lease lost");
    expect(release).toHaveBeenCalledWith("key", expect.anything(), false, null);
    await expect(
      capacity.run(async (permit) => {
        permit.succeeded();
        return "paid bytes";
      }, new AbortController().signal),
    ).resolves.toBe("paid bytes");
  });
  it("separates project, region and model scopes without storing their names", () => {
    const key = providerCapacityKey("project", "global", "model");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toBe(providerCapacityKey("project", "us", "model"));
    expect(key).not.toBe(providerCapacityKey("project", "global", "other"));
  });

  it("★ a scope is a row of its own, and no scope is still the row written before scopes existed", () => {
    const legacy = createHash("sha256")
      .update(JSON.stringify(["project", "global", "gemini-3.8-flash"]))
      .digest("hex");
    expect(providerCapacityKey("project", "global", "gemini-3.8-flash")).toBe(
      legacy,
    );
    expect(
      providerCapacityKey("project", "global", "gemini-3.8-flash", ""),
    ).toBe(legacy);
    const planner = providerCapacityKey(
      "project",
      "global",
      "gemini-3.8-flash",
      "revamp-planner",
    );
    expect(planner).toMatch(/^[a-f0-9]{64}$/);
    expect(planner).not.toBe(legacy);
    expect(planner).not.toBe(
      providerCapacityKey("project", "global", "gemini-3.8-flash", "other"),
    );
  });

  it("★★ another request waits at most 15 s for a refusal, whatever the caller's own backoff", async () => {
    const pause = vi.fn<CapacityStore["pause"]>(async () => {});
    const store: CapacityStore = {
      async claim(_, id) {
        return { id, epoch: 0 };
      },
      async renew() {
        return true;
      },
      async release() {},
      pause,
    };
    const capacity = coordinatedProviderCapacity(store, "key");
    for (const asked of [7_500, 15_000, 60_000, 120_000]) {
      await capacity.run(async (permit) => {
        await permit.rateLimited(asked);
      }, new AbortController().signal);
    }
    expect(pause.mock.calls.map((call) => call[1])).toEqual([
      7_500,
      SHARED_RATE_LIMIT_PAUSE_MAX_MS,
      SHARED_RATE_LIMIT_PAUSE_MAX_MS,
      SHARED_RATE_LIMIT_PAUSE_MAX_MS,
    ]);
    expect(SHARED_RATE_LIMIT_PAUSE_MAX_MS).toBe(15_000);
  });

  it("★ hands the key's start pacing to every claim, release and pause, and none to an unpaced key", async () => {
    for (const pacing of [IMAGE_START_PACING, null]) {
      const claim = vi.fn(async (_key: string, id: string) => ({
        id,
        epoch: 4,
      }));
      const release = vi.fn(async () => {});
      const pause = vi.fn(async () => {});
      const store: CapacityStore = {
        claim,
        async renew() {
          return true;
        },
        release,
        pause,
      };
      await coordinatedProviderCapacity(store, "key", { pacing }).run(
        async (permit) => {
          await permit.rateLimited(30_000);
          permit.succeeded();
        },
        new AbortController().signal,
      );
      expect(claim).toHaveBeenCalledWith("key", expect.any(String), pacing);
      expect(pause).toHaveBeenCalledWith("key", 15_000, pacing);
      expect(release).toHaveBeenCalledWith(
        "key",
        { id: expect.any(String), epoch: 4 },
        true,
        pacing,
      );
    }
  });

  it("★★ sleeps exactly until a paced key's next start, without polling the row lock", async () => {
    const claim = vi.fn(async (_key: string, id: string) => ({ id, epoch: 0 }));
    claim.mockResolvedValueOnce({ retryAfterMs: 38_500 } as never);
    const sleep = vi.fn(async () => true);
    const store: CapacityStore = {
      claim,
      async renew() {
        return true;
      },
      async release() {},
      async pause() {},
    };
    await coordinatedProviderCapacity(store, "key", {
      pacing: IMAGE_START_PACING,
      sleep,
    }).run(async () => "drawn", new AbortController().signal);
    expect(sleep.mock.calls).toEqual([[38_500, expect.anything()]]);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("★★ a waiter the admission signal stops never claims again, so it takes no paced start from the others", async () => {
    const claim = vi.fn<CapacityStore["claim"]>(async (_key, id) => ({
      id,
      epoch: 0,
    }));
    // The key's next start is 40 s away; a claim after that would be admitted.
    claim.mockResolvedValueOnce({ retryAfterMs: 40_000 });
    const store: CapacityStore = {
      claim,
      async renew() {
        return true;
      },
      async release() {},
      async pause() {},
    };
    const admission = new AbortController();
    const waits: number[] = [];
    const ends: string[] = [];
    const operation = vi.fn(async () => "sent");
    const capacity = coordinatedProviderCapacity(store, "key", {
      pacing: IMAGE_START_PACING,
      // The wait for the next start (shortened to 200 ms): over when its
      // time is up, or cut short by its signal.
      sleep: (ms, signal) =>
        new Promise((resolve) => {
          waits.push(ms);
          const timer = setTimeout(() => {
            ends.push("slept");
            resolve(true);
          }, 200);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              ends.push("woken");
              resolve(false);
            },
            { once: true },
          );
        }),
    });
    const run = capacity.run(operation, new AbortController().signal, {
      admission: admission.signal,
    });
    // The drain begins while the caller waits for its next start.
    await vi.waitFor(() => expect(waits).toEqual([40_000]));
    admission.abort(new Error("drained"));
    await expect(run).rejects.toThrow("drained");
    // ★ Woken at once, never claiming again: no start stamped, no hold-up.
    expect(ends).toEqual(["woken"]);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalled();

    // An admission already over claims nothing at all.
    claim.mockClear();
    await expect(
      capacity.run(operation, new AbortController().signal, {
        admission: admission.signal,
      }),
    ).rejects.toThrow("drained");
    expect(claim).not.toHaveBeenCalled();
  });

  it("★ an admission ended while a claim is in flight lets the run go at once, and a late permit is given back", async () => {
    let admit!: (lease: { id: string; epoch: number }) => void;
    const release = vi.fn(async () => {});
    const store = {
      claim: () =>
        new Promise((resolve) => {
          admit = resolve;
        }),
      release,
    } as unknown as CapacityStore;
    const admission = new AbortController();
    const run = coordinatedProviderCapacity(store, "key").run(
      vi.fn(),
      new AbortController().signal,
      { admission: admission.signal },
    );
    admission.abort(new Error("drained"));
    const settled = await Promise.race([
      run.then(
        () => "ran",
        (error: Error) => `refused: ${error.message}`,
      ),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
    ]);
    expect(settled).toBe("refused: drained");
    admit({ id: "late", epoch: 0 });
    await vi.waitFor(() =>
      expect(release).toHaveBeenCalledWith(
        "key",
        { id: "late", epoch: 0 },
        false,
      ),
    );
  });

  it("★★ the admission signal never reaches a call already admitted: it finishes on its own signal", async () => {
    const release = vi.fn<CapacityStore["release"]>(async () => {});
    const store: CapacityStore = {
      async claim(_, id) {
        return { id, epoch: 0 };
      },
      async renew() {
        return true;
      },
      release,
      async pause() {},
    };
    const admission = new AbortController();
    await expect(
      coordinatedProviderCapacity(store, "key").run(
        async (permit) => {
          // On the wire, and billed, when the drain begins.
          admission.abort(new Error("drained"));
          await new Promise((resolve) => setTimeout(resolve, 5));
          expect(permit.signal.aborted).toBe(false);
          permit.succeeded();
          return "paid bytes";
        },
        new AbortController().signal,
        { admission: admission.signal },
      ),
    ).resolves.toBe("paid bytes");
    expect(release).toHaveBeenCalledWith("key", expect.anything(), true, null);
  });

  it("the uncoordinated capacity runs at once unless its admission is already over", async () => {
    await expect(
      uncoordinatedProviderCapacity.run(
        async () => "ran",
        new AbortController().signal,
      ),
    ).resolves.toBe("ran");
    const over = new AbortController();
    over.abort(new Error("drained"));
    const operation = vi.fn(async () => "ran");
    await expect(
      uncoordinatedProviderCapacity.run(
        operation,
        new AbortController().signal,
        { admission: over.signal },
      ),
    ).rejects.toThrow("drained");
    expect(operation).not.toHaveBeenCalled();
  });

  it("★★ paces image models from 40 s, between 31 s (Google's 2/min system limit) and 45 s; text models are not paced", () => {
    expect(IMAGE_START_PACING).toEqual({
      initialGapMs: 40_000,
      minGapMs: 31_000,
      maxGapMs: 45_000,
      successFactor: 0.9,
      rateLimitFactor: 1.5,
      recoveryFloorMs: 40_000,
      recoveryHoldMs: 600_000,
    });
    expect(Object.isFrozen(IMAGE_START_PACING)).toBe(true);
    for (const image of [
      "gemini-3-pro-image",
      "gemini-3-pro-image-001",
      "gemini-3.1-flash-image",
      "gemini-nano-banana-2.1",
      "imagen-4.0-generate-001",
    ]) {
      expect(isImageProviderModel(image)).toBe(true);
    }
    for (const text of [
      "gemini-3.8-flash",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash-lite",
      "gemini-embedding-2",
    ]) {
      expect(isImageProviderModel(text)).toBe(false);
    }
  });

  it("★ hands each gap change the store reports to onPaceChange, and a failing observer costs nothing", async () => {
    const refused = {
      outcome: "rate_limited" as const,
      gapBeforeMs: 10_000,
      gapAfterMs: 15_000,
      epoch: 3,
    };
    const narrowed = {
      outcome: "success" as const,
      gapBeforeMs: 15_000,
      gapAfterMs: 13_500,
      epoch: 3,
    };
    const store: CapacityStore = {
      async claim(_, id) {
        return { id, epoch: 3 };
      },
      async renew() {
        return true;
      },
      release: vi.fn(async () => narrowed),
      pause: vi.fn(async () => refused),
    };
    const seen = vi.fn();
    await expect(
      coordinatedProviderCapacity(store, "key", {
        pacing: IMAGE_START_PACING,
        onPaceChange: seen,
      }).run(async (permit) => {
        await permit.rateLimited(30_000);
        permit.succeeded();
        return "drawn";
      }, new AbortController().signal),
    ).resolves.toBe("drawn");
    expect(seen.mock.calls).toEqual([[refused], [narrowed]]);

    // An observer that throws neither fails the call nor skips the release.
    const cleanupError = vi.fn();
    const throwing = coordinatedProviderCapacity(store, "key", {
      pacing: IMAGE_START_PACING,
      onPaceChange: () => {
        throw new Error("logger down");
      },
      onCleanupError: cleanupError,
    });
    await expect(
      throwing.run(async (permit) => {
        await permit.rateLimited(30_000);
        permit.succeeded();
        return "drawn";
      }, new AbortController().signal),
    ).resolves.toBe("drawn");
    expect(store.release).toHaveBeenCalledTimes(2);
    expect(cleanupError).not.toHaveBeenCalled();

    // A store with nothing to report (an unpaced key, a stale success).
    const quiet = vi.fn();
    await coordinatedProviderCapacity(
      { ...store, release: async () => null, pause: async () => {} },
      "key",
      { onPaceChange: quiet },
    ).run(async (permit) => {
      await permit.rateLimited(30_000);
      permit.succeeded();
    }, new AbortController().signal);
    expect(quiet).not.toHaveBeenCalled();
  });

  it("★ the first gap is the one a new capacity row is created with (migration 0236)", () => {
    const migration = readFileSync(
      path.join(
        process.cwd(),
        "drizzle/migrations/sql/20261023_0236_theme_studio_provider_pacing.sql",
      ),
      "utf8",
    );
    expect(migration).toMatch(
      new RegExp(
        `gap_ms integer NOT NULL DEFAULT ${IMAGE_START_PACING.initialGapMs}\\b`,
      ),
    );
    // The sanity CHECK leaves room around the app's own bounds.
    const [, low, high] =
      /CHECK \(gap_ms BETWEEN (\d+) AND (\d+)\)/.exec(migration) ?? [];
    expect(Number(low)).toBeLessThan(IMAGE_START_PACING.minGapMs);
    expect(Number(high)).toBeGreaterThan(IMAGE_START_PACING.maxGapMs);
  });
  it("returns paid bytes even when permit cleanup never answers", async () => {
    const cleanupError = vi.fn();
    const store: CapacityStore = {
      async claim(_, id) {
        return { id, epoch: 0 };
      },
      async renew() {
        return true;
      },
      release: () => new Promise(() => {}),
      async pause() {},
    };
    const result = await coordinatedProviderCapacity(store, "key", {
      onCleanupError: cleanupError,
    }).run(async (permit) => {
      permit.succeeded();
      return "paid bytes";
    }, new AbortController().signal);
    expect(result).toBe("paid bytes");
    expect(cleanupError).toHaveBeenCalledOnce();
  }, 10000);
});
