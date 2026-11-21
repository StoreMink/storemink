import "server-only";

/**
 * The record of every job submitted to ElevenLabs' Image API (migration
 * 0284), and the one rule it exists for:
 *
 * ★★ A JOB THAT WAS SUBMITTED IS PAID FOR, SO IT IS COLLECTED, NEVER DRAWN
 *    AGAIN. ElevenLabs' API takes no idempotency key and its job list carries
 *    no reference of ours, so the only way to find a job again is to have
 *    written its id down. A draw that is cut off after its submit (the
 *    redesign's deadline, a restart, a clock) leaves its row `submitted`; the
 *    next try for the SAME picture in the SAME scope claims that row and
 *    waits for that job, where without it it would pay for a second picture.
 *
 * ★ "The same picture" is the request's digest (model, quality, resolution,
 *   shape, prompt, references) inside one scope (a redesign, a Theme Studio
 *   project, so a Retry run collects what its earlier run paid for). A picture that was DELIVERED is never handed out again: a second
 *   request with the same digest is then a deliberate redraw and gets a new
 *   job.
 * ★ A claim is one conditional write, so two tries never collect one job; a
 *   claim whose process died is taken over after a few minutes.
 * ★ Rows are pruned after 14 days (lib/retention/prune.ts).
 * ★ Every write here is best effort. A database that cannot be reached costs
 *   the saving, never the picture: the draw goes on without the record.
 */

import { and, eq, sql } from "drizzle-orm";
import { imageProviderGenerations } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logWarn } from "@/lib/observability/logger";

/** How long after its submit a job may still be collected. */
export const GENERATION_ADOPT_WINDOW_MS = 6 * 60 * 60_000;
/** A claim older than this belongs to a process that is gone. */
export const GENERATION_CLAIM_STALE_MS = 4 * 60_000;

export interface GenerationStore {
  /** The id of a submitted, uncollected job for this picture, now claimed. */
  claimUndelivered(
    scope: string,
    digest: string,
    now: Date,
  ): Promise<string | null>;
  recordSubmitted(
    scope: string,
    digest: string,
    generationId: string,
    now: Date,
  ): Promise<void>;
  settle(
    generationId: string,
    state: "delivered" | "failed",
    now: Date,
  ): Promise<void>;
  /** Give up a claim without settling, so the next try may collect the job. */
  release(generationId: string, now: Date): Promise<void>;
}

const PROVIDER = "elevenlabs";

async function quiet<T>(what: string, run: () => Promise<T>, fallback: T) {
  try {
    return await run();
  } catch (error) {
    logWarn("images.elevenlabs: generation record unavailable", {
      what,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return fallback;
  }
}

export const postgresGenerationStore: GenerationStore = {
  claimUndelivered(scope, digest, now) {
    const since = new Date(now.getTime() - GENERATION_ADOPT_WINDOW_MS);
    const stale = new Date(now.getTime() - GENERATION_CLAIM_STALE_MS);
    return quiet(
      "claim",
      () =>
        withService(async (db) => {
          const result = await db.execute(sql`
            update public.image_provider_generations g
               set claimed_at = ${now.toISOString()},
                   updated_at = ${now.toISOString()}
             where g.id = (
               select id from public.image_provider_generations
                where provider = ${PROVIDER}
                  and scope = ${scope}
                  and request_digest = ${digest}
                  and state = 'submitted'
                  and created_at > ${since.toISOString()}
                  and (claimed_at is null or claimed_at < ${stale.toISOString()})
                order by created_at asc
                limit 1
                for update skip locked)
            returning g.generation_id`);
          const row = (result.rows as { generation_id?: unknown }[])[0];
          return typeof row?.generation_id === "string"
            ? row.generation_id
            : null;
        }),
      null,
    );
  },
  recordSubmitted(scope, digest, generationId, now) {
    return quiet(
      "record",
      () =>
        withService(async (db) => {
          await db
            .insert(imageProviderGenerations)
            .values({
              provider: PROVIDER,
              scope,
              requestDigest: digest,
              generationId,
              state: "submitted",
              // Held by the draw that submitted it, until it settles or lets go.
              claimedAt: now.toISOString(),
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            })
            .onConflictDoNothing();
        }),
      undefined,
    );
  },
  settle(generationId, state, now) {
    return quiet(
      "settle",
      () =>
        withService(async (db) => {
          await db
            .update(imageProviderGenerations)
            .set({ state, claimedAt: null, updatedAt: now.toISOString() })
            .where(
              and(
                eq(imageProviderGenerations.provider, PROVIDER),
                eq(imageProviderGenerations.generationId, generationId),
                eq(imageProviderGenerations.state, "submitted"),
              ),
            );
        }),
      undefined,
    );
  },
  release(generationId, now) {
    return quiet(
      "release",
      () =>
        withService(async (db) => {
          await db
            .update(imageProviderGenerations)
            .set({ claimedAt: null, updatedAt: now.toISOString() })
            .where(
              and(
                eq(imageProviderGenerations.provider, PROVIDER),
                eq(imageProviderGenerations.generationId, generationId),
                eq(imageProviderGenerations.state, "submitted"),
              ),
            );
        }),
      undefined,
    );
  },
};

/** A store that remembers nothing: for a caller with no database. */
export const noGenerationStore: GenerationStore = {
  claimUndelivered: async () => null,
  recordSubmitted: async () => {},
  settle: async () => {},
  release: async () => {},
};
