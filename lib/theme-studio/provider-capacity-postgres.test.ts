// Opt-in local integration: actual concurrent transactions, no provider calls.
import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const scoped = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withService: scoped.run }));
import { postgresCapacityStore } from "./provider-capacity-store";
import {
  IMAGE_START_PACING,
  providerCapacityKey,
  type CapacityLease,
} from "./provider-capacity";

function requireLease(
  value: Awaited<ReturnType<typeof postgresCapacityStore.claim>>,
): CapacityLease {
  if (!value || !("id" in value)) throw new Error("Expected a provider permit");
  return value;
}

it.skipIf(process.env.THEME_STUDIO_CAPACITY_DB_TEST !== "1")(
  "coordinates concurrent instances, cooldown recovery, expiry and service-only grants",
  async () => {
    const pool = new Pool({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: "postgres",
      password: process.env.DB_ADMIN_PASSWORD,
      max: 8,
      connectionTimeoutMillis: 5000,
    });
    const key = providerCapacityKey(randomUUID(), "local", "test");
    const clockKey = providerCapacityKey(randomUUID(), "local", "clock");
    const pacedKey = providerCapacityKey(randomUUID(), "local", "test-image");
    scoped.run.mockImplementation(async (work) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local role app_service");
        const result = await work(drizzle(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    });
    try {
      // The capacity row can be committed after a claim transaction begins.
      // Its initial pause is already over in wall time; transaction-start now()
      // must not incorrectly deny admission. Force that ordering explicitly.
      scoped.run.mockImplementationOnce(async (work) => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query("set local role app_service");
          await pool.query("select pg_sleep(0.02)");
          await pool.query(
            "insert into theme_studio_provider_capacity(scope_key) values($1)",
            [clockKey],
          );
          const result = await work(drizzle(client));
          await client.query("commit");
          return result;
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      });
      const first = await postgresCapacityStore.claim(clockKey, randomUUID());
      expect(first).not.toBeNull();
      await postgresCapacityStore.release(clockKey, requireLease(first), false);
      const claimed = await Promise.all(
        Array.from({ length: 8 }, () =>
          postgresCapacityStore.claim(key, randomUUID()),
        ),
      );
      const leases = claimed.filter(
        (v): v is CapacityLease => v !== null && "id" in v,
      );
      expect(leases).toHaveLength(3);
      expect(
        (
          await pool.query(
            "select count(*)::int as n from theme_studio_provider_leases where scope_key=$1",
            [key],
          )
        ).rows[0].n,
      ).toBe(3);
      // ★★ A refusal holds the others back 15 s at most, even when its caller
      //   asks for two minutes, and cuts back a longer pause already there
      //   (the replaced revision paused for its caller's whole backoff).
      await pool.query(
        "update theme_studio_provider_capacity set pause_until=clock_timestamp()+interval '100 seconds' where scope_key=$1",
        [key],
      );
      await postgresCapacityStore.pause(key, 120_000);
      await Promise.all(
        leases.map((lease) => postgresCapacityStore.release(key, lease, true)),
      );
      const paused = await postgresCapacityStore.claim(key, randomUUID());
      expect(paused).toHaveProperty("retryAfterMs");
      const pausedFor =
        paused && "retryAfterMs" in paused && paused.retryAfterMs;
      expect(pausedFor).toBeGreaterThan(10_000);
      expect(pausedFor).toBeLessThanOrEqual(15_000);
      // Stale successes (admitted before the refusal) restored nothing.
      expect(
        (
          await pool.query(
            "select capacity,successes from theme_studio_provider_capacity where scope_key=$1",
            [key],
          )
        ).rows[0],
      ).toEqual({ capacity: 1, successes: 0 });
      await pool.query(
        "update theme_studio_provider_capacity set pause_until=now() where scope_key=$1",
        [key],
      );
      // ★★ One permit back per success: 1, then 2, then 3, never more.
      const one = await postgresCapacityStore.claim(key, randomUUID());
      expect(await postgresCapacityStore.claim(key, randomUUID())).toBeNull();
      await postgresCapacityStore.release(key, requireLease(one), true);
      // Duplicate or stale release cannot count another success.
      await postgresCapacityStore.release(key, requireLease(one), true);
      const capacityNow = async () =>
        (
          await pool.query(
            "select capacity,successes from theme_studio_provider_capacity where scope_key=$1",
            [key],
          )
        ).rows[0];
      expect(await capacityNow()).toEqual({ capacity: 2, successes: 0 });
      const two = [
        requireLease(await postgresCapacityStore.claim(key, randomUUID())),
        requireLease(await postgresCapacityStore.claim(key, randomUUID())),
      ];
      expect(await postgresCapacityStore.claim(key, randomUUID())).toBeNull();
      await postgresCapacityStore.release(key, two[0], true);
      expect(await capacityNow()).toEqual({ capacity: 3, successes: 0 });
      await postgresCapacityStore.release(key, two[1], true);
      expect(await capacityNow()).toEqual({ capacity: 3, successes: 0 });
      // An unpaced key's pace columns are never touched.
      expect(
        (
          await pool.query(
            "select gap_ms from theme_studio_provider_capacity where scope_key=$1",
            [key],
          )
        ).rows[0],
      ).toEqual({ gap_ms: IMAGE_START_PACING.initialGapMs });
      await pool.query(
        "update theme_studio_provider_capacity set capacity=2 where scope_key=$1",
        [key],
      );
      const expired = requireLease(
        await postgresCapacityStore.claim(key, randomUUID()),
      );
      const ttl = (
        await pool.query(
          "select extract(epoch from (expires_at-clock_timestamp())) as seconds from theme_studio_provider_leases where id=$1",
          [expired.id],
        )
      ).rows[0].seconds;
      expect(Number(ttl)).toBeGreaterThan(110);
      expect(Number(ttl)).toBeLessThanOrEqual(120);
      await pool.query(
        "update theme_studio_provider_leases set expires_at=now()-interval '1 second' where id=$1",
        [expired.id],
      );
      expect(await postgresCapacityStore.renew(key, expired)).toBe(false);
      const replacement = requireLease(
        await postgresCapacityStore.claim(key, randomUUID()),
      );
      expect(replacement).not.toBeNull();
      await postgresCapacityStore.release(key, expired, true);
      expect(await postgresCapacityStore.renew(key, replacement!)).toBe(true);

      // ★★ An image model's key is start-paced (migration 0236): the next
      //   start is the latest admission plus the gap, overlap allowed.
      const paced = IMAGE_START_PACING;
      const pace = async () =>
        (
          await pool.query(
            "select gap_ms, capacity, epoch, round(extract(epoch from (next_start_at-clock_timestamp()))*1000)::int as next_in_ms from theme_studio_provider_capacity where scope_key=$1",
            [pacedKey],
          )
        ).rows[0];
      const startNow = () =>
        pool.query(
          "update theme_studio_provider_capacity set next_start_at=clock_timestamp() where scope_key=$1",
          [pacedKey],
        );
      const opening = requireLease(
        await postgresCapacityStore.claim(pacedKey, randomUUID(), paced),
      );
      // A second start waits the gap although two more permits are free.
      const spaced = await postgresCapacityStore.claim(
        pacedKey,
        randomUUID(),
        paced,
      );
      expect(spaced).toHaveProperty("retryAfterMs");
      const firstWait = (spaced as { retryAfterMs: number }).retryAfterMs;
      expect(firstWait).toBeGreaterThan(38_000);
      expect(firstWait).toBeLessThanOrEqual(40_000);
      expect(await pace()).toMatchObject({ gap_ms: 40_000, capacity: 3 });
      // A success narrows the gap 10% and brings the next start in with it,
      // and the statement that moved it says so (the pace log's source).
      expect(
        await postgresCapacityStore.release(pacedKey, opening, true, paced),
      ).toEqual({
        outcome: "success",
        gapBeforeMs: 40_000,
        gapAfterMs: 36_000,
        epoch: 0,
      });
      const narrowed = await pace();
      expect(narrowed.gap_ms).toBe(36_000);
      expect(narrowed.next_in_ms).toBeGreaterThan(34_000);
      expect(narrowed.next_in_ms).toBeLessThanOrEqual(36_000);
      // Overlap is allowed: a start once the gap has passed, with the
      // earlier request still drawing.
      await startNow();
      const drawing = requireLease(
        await postgresCapacityStore.claim(pacedKey, randomUUID(), paced),
      );
      await startNow();
      const overlapping = requireLease(
        await postgresCapacityStore.claim(pacedKey, randomUUID(), paced),
      );
      // A refusal widens the gap 1.5x (from the latest start) but never past
      // the 45 s ceiling (36 s x1.5 would be 54 s), drops to one permit and
      // pauses the others 15 s at most.
      expect(
        await postgresCapacityStore.pause(pacedKey, 120_000, paced),
      ).toEqual({
        outcome: "rate_limited",
        gapBeforeMs: 36_000,
        gapAfterMs: 45_000,
        epoch: 1,
      });
      const widened = await pace();
      expect(widened).toMatchObject({ gap_ms: 45_000, capacity: 1, epoch: 1 });
      expect(widened.next_in_ms).toBeGreaterThan(43_000);
      expect(widened.next_in_ms).toBeLessThanOrEqual(45_000);
      // Stale successes from before the refusal neither narrow nor restore,
      // and report no change.
      expect(
        await postgresCapacityStore.release(pacedKey, drawing, true, paced),
      ).toBeNull();
      expect(
        await postgresCapacityStore.release(pacedKey, overlapping, true, paced),
      ).toBeNull();
      expect(await pace()).toMatchObject({ gap_ms: 45_000, capacity: 1 });
      const held = await postgresCapacityStore.claim(
        pacedKey,
        randomUUID(),
        paced,
      );
      const heldFor = held && "retryAfterMs" in held && held.retryAfterMs;
      expect(heldFor).toBeGreaterThan(40_000);
      expect(heldFor).toBeLessThanOrEqual(45_000);
      // Repeated refusals stay at the 45 s ceiling (each still counted in the
      // epoch, which the pace log reports as refusals)...
      await postgresCapacityStore.pause(pacedKey, 7_500, paced);
      expect(await postgresCapacityStore.pause(pacedKey, 7_500, paced)).toEqual(
        {
          outcome: "rate_limited",
          gapBeforeMs: 45_000,
          gapAfterMs: 45_000,
          epoch: 3,
        },
      );
      expect((await pace()).gap_ms).toBe(45_000);
      expect((await pace()).next_in_ms).toBeLessThanOrEqual(45_000);
      // Fresh transactions (as after a restart) retain the recovery floor.
      await pool.query(
        "update theme_studio_provider_capacity set pause_until=clock_timestamp()-interval '1 second' where scope_key=$1",
        [pacedKey],
      );
      for (const expectedGap of [40_500, 40_000, 40_000]) {
        await startNow();
        const fresh = requireLease(
          await postgresCapacityStore.claim(pacedKey, randomUUID(), paced),
        );
        const change = await postgresCapacityStore.release(
          pacedKey,
          fresh,
          true,
          paced,
        );
        expect(change?.gapAfterMs).toBe(expectedGap);
        const heldPace = await pace();
        expect(heldPace.next_in_ms).toBeGreaterThan(expectedGap - 2_000);
        expect(heldPace.next_in_ms).toBeLessThanOrEqual(expectedGap);
      }
      // Once ten minutes since cooldown have passed, cautious exploration resumes.
      await pool.query(
        "update theme_studio_provider_capacity set pause_until=clock_timestamp()-interval '11 minutes' where scope_key=$1",
        [pacedKey],
      );
      await startNow();
      const afterHold = requireLease(
        await postgresCapacityStore.claim(pacedKey, randomUUID(), paced),
      );
      expect(
        (await postgresCapacityStore.release(pacedKey, afterHold, true, paced))
          ?.gapAfterMs,
      ).toBe(36_000);
      // Even a refusal at the minimum (31 s, the provider's two a minute)
      // widens at once, past the recovery floor and onto the ceiling.
      await pool.query(
        "update theme_studio_provider_capacity set gap_ms=31000 where scope_key=$1",
        [pacedKey],
      );
      expect(
        (await postgresCapacityStore.pause(pacedKey, 7_500, paced))?.gapAfterMs,
      ).toBe(45_000);
      // ...and successes settle on the 31 s floor after the recovery hold
      // expires: never faster than the limit.
      await pool.query(
        "update theme_studio_provider_capacity set gap_ms=31500, pause_until=clock_timestamp()-interval '11 minutes', next_start_at=clock_timestamp() where scope_key=$1",
        [pacedKey],
      );
      const near = requireLease(
        await postgresCapacityStore.claim(pacedKey, randomUUID(), paced),
      );
      expect(
        await postgresCapacityStore.release(pacedKey, near, true, paced),
      ).toEqual({
        outcome: "success",
        gapBeforeMs: 31_500,
        gapAfterMs: 31_000,
        epoch: 4,
      });
      expect(await pace()).toMatchObject({ gap_ms: 31_000, capacity: 2 });
      // ★★ Only an admission moves the next start. A claim refused for its
      //   start (two permits free, the start 5 s away) leaves it where it
      //   was and writes no lease; one that restamped it would push the
      //   start a gap past every other waiter's wake time.
      await pool.query(
        "update theme_studio_provider_capacity set next_start_at=clock_timestamp()+interval '5 seconds' where scope_key=$1",
        [pacedKey],
      );
      const pacedLeases = async () =>
        (
          await pool.query(
            "select count(*)::int as n from theme_studio_provider_leases where scope_key=$1",
            [pacedKey],
          )
        ).rows[0].n;
      const inFlight = await pacedLeases();
      expect(
        await postgresCapacityStore.claim(pacedKey, randomUUID(), paced),
      ).toHaveProperty("retryAfterMs");
      const unmoved = await pace();
      expect(unmoved.next_in_ms).toBeGreaterThan(3_000);
      expect(unmoved.next_in_ms).toBeLessThanOrEqual(5_000);
      expect(await pacedLeases()).toBe(inFlight);
      // An unpaced key's release and pause answer no change at all.
      expect(
        await postgresCapacityStore.release(key, replacement, true),
      ).toBeNull();
      expect(await postgresCapacityStore.pause(key, 7_500)).toBeNull();
      // The CHECK is a sanity bound under the app's own floor and ceiling.
      await expect(
        pool.query(
          "update theme_studio_provider_capacity set gap_ms=0 where scope_key=$1",
          [pacedKey],
        ),
      ).rejects.toThrow(/theme_studio_provider_capacity_gap_ms_check/);

      const permissions = (
        await pool.query(
          "select has_table_privilege('app_user','theme_studio_provider_leases','SELECT') as readable, has_function_privilege('app_user','theme_studio_capacity_lock(text)','EXECUTE') as callable",
        )
      ).rows[0];
      expect(permissions).toEqual({ readable: false, callable: false });
    } finally {
      await pool.query(
        "delete from theme_studio_provider_capacity where scope_key=any($1::text[])",
        [[key, clockKey, pacedKey]],
      );
      await pool.end();
    }
  },
  20000,
);
