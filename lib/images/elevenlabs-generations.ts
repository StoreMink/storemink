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
 * ★★ A SUBMIT WHOSE ANSWER WAS LOST CAN STILL BE FOUND (migration 0285).
 *    When a submit gets no answer, a job may exist and nobody holds its id.
 *    The provider's job list shows no prompt, but it is ordered by creation
 *    time and its cursor carries that time. So every submit is written down
 *    BEFORE it leaves (`openSubmit`) and its row is deleted in the statement
 *    that records the job. A row that is left behind is a submit that was
 *    never answered, with the window it was out for; elevenlabs-lost-jobs.ts
 *    finds the one job made inside that window that this record does not
 *    hold and that no other unanswered submit could have made.
 * ★ Rows are pruned after 14 days (lib/retention/prune.ts).
 * ★ Every write here is best effort, with ONE exception the draw enforces:
 *   a submit that could not be written down (`openSubmit` answered null) is
 *   not sent (PR #303 re-review, 22 Nov 2026). Every other failed write costs
 *   only the saving: a job that was recorded as sent but whose answer could
 *   not be recorded keeps its `sending` row, which every other search counts
 *   as a rival, so nobody else takes its job.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  imageProviderGenerations,
  imageProviderSubmits,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logWarn } from "@/lib/observability/logger";

/** How long after its submit a job may still be collected. */
export const GENERATION_ADOPT_WINDOW_MS = 6 * 60 * 60_000;
/** A claim older than this belongs to a process that is gone. */
export const GENERATION_CLAIM_STALE_MS = 4 * 60_000;

/** How long one submit may be out (elevenlabs-images.ts keeps the same clock). */
export const SUBMIT_OUT_MS = 30_000;
/** A `sending` row this old belongs to a process that died mid-submit. */
export const SUBMIT_ABANDONED_MS = 60_000;
/**
 * The most the provider's clock and ours are taken to differ by. Measured on
 * 22 Nov 2026: under a second. A job is a submit's only when it was made
 * inside the submit's window widened by this on both sides.
 */
export const SUBMIT_CLOCK_SLACK_MS = 5_000;

/** A submit that got no answer, and the window it was out for. */
export interface LostSubmit {
  id: string;
  sentAt: number;
  lostAt: number;
}

export interface GenerationStore {
  /**
   * True ONLY for a store that keeps no record by design (a caller with no
   * database). A recording store that cannot write a submit down answers
   * null from `openSubmit`, and that submit is then NOT sent
   * (elevenlabs-images.ts): an unrecorded job is one another try's search
   * could take as its own.
   */
  readonly unrecorded?: true;
  /** The id of a submitted, uncollected job for this picture, now claimed. */
  claimUndelivered(
    scope: string,
    digest: string,
    now: Date,
  ): Promise<string | null>;
  /**
   * Written before a submit leaves. Null when the record is unavailable, and
   * the submit is then not sent (unless the store is `unrecorded` by design).
   */
  openSubmit(scope: string, digest: string, now: Date): Promise<string | null>;
  /** The submit was answered with a job: record the job and close the submit,
   *  together, so a job is never both unrecorded and unlooked-for. */
  recordSubmitted(
    scope: string,
    digest: string,
    generationId: string,
    now: Date,
    submitId?: string | null,
  ): Promise<void>;
  /** The submit was provably refused: no job was made. */
  dropSubmit(submitId: string): Promise<void>;
  /** No answer came: a job may exist. */
  markSubmitLost(submitId: string, now: Date): Promise<void>;
  /** The newest unanswered submit for this picture, if one is unresolved. */
  findLostSubmit(
    scope: string,
    digest: string,
    now: Date,
  ): Promise<LostSubmit | null>;
  /**
   * For a search: which of these job ids the record already holds, and how
   * many OTHER unanswered submits were out at the same time. Null when the
   * record cannot be read (the search is then inconclusive).
   */
  inspectWindow(
    submit: LostSubmit,
    generationIds: readonly string[],
  ): Promise<{ known: Set<string>; rivals: number } | null>;
  /** Take a found job for its submit. False when another try already holds it. */
  adoptFound(
    submit: LostSubmit,
    scope: string,
    digest: string,
    generationId: string,
    now: Date,
  ): Promise<boolean>;
  /** Looked for with a clear view, and no job was there. */
  giveUpSubmit(submitId: string, now: Date): Promise<void>;
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
  openSubmit(scope, digest, now) {
    return quiet(
      "open",
      () =>
        withService(async (db) => {
          const rows = await db
            .insert(imageProviderSubmits)
            .values({
              provider: PROVIDER,
              scope,
              requestDigest: digest,
              state: "sending",
              sentAt: now.toISOString(),
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            })
            .returning({ id: imageProviderSubmits.id });
          return rows[0]?.id ?? null;
        }),
      null,
    );
  },
  recordSubmitted(scope, digest, generationId, now, submitId = null) {
    return quiet(
      "record",
      () =>
        // ★ One transaction: the job is recorded and its submit closed
        //   together. Were the submit closed first, a failed record would
        //   leave a job nobody holds and nobody looks for.
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
          if (submitId) {
            await db
              .delete(imageProviderSubmits)
              .where(eq(imageProviderSubmits.id, submitId));
          }
        }),
      undefined,
    );
  },
  dropSubmit(submitId) {
    return quiet(
      "drop",
      () =>
        withService(async (db) => {
          await db
            .delete(imageProviderSubmits)
            .where(eq(imageProviderSubmits.id, submitId));
        }),
      undefined,
    );
  },
  markSubmitLost(submitId, now) {
    return quiet(
      "lost",
      () =>
        withService(async (db) => {
          await db
            .update(imageProviderSubmits)
            .set({
              state: "lost",
              lostAt: now.toISOString(),
              updatedAt: now.toISOString(),
            })
            .where(
              and(
                eq(imageProviderSubmits.id, submitId),
                eq(imageProviderSubmits.state, "sending"),
              ),
            );
        }),
      undefined,
    );
  },
  findLostSubmit(scope, digest, now) {
    const since = new Date(now.getTime() - GENERATION_ADOPT_WINDOW_MS);
    const abandoned = new Date(now.getTime() - SUBMIT_ABANDONED_MS);
    return quiet(
      "find-lost",
      () =>
        withService(async (db) => {
          // A `sending` row left by a process that died is a lost submit too:
          // it was out for at most one submit's clock.
          const result = await db.execute(sql`
            select id,
                   sent_at,
                   coalesce(lost_at, sent_at + ${SUBMIT_OUT_MS} * interval '1 millisecond') as lost_at
              from public.image_provider_submits
             where provider = ${PROVIDER}
               and scope = ${scope}
               and request_digest = ${digest}
               and sent_at > ${since.toISOString()}
               and (state = 'lost'
                    or (state = 'sending' and sent_at < ${abandoned.toISOString()}))
             order by sent_at desc
             limit 1`);
          const row = (
            result.rows as {
              id?: unknown;
              sent_at?: unknown;
              lost_at?: unknown;
            }[]
          )[0];
          if (!row || typeof row.id !== "string") return null;
          const sentAt = new Date(String(row.sent_at)).getTime();
          const lostAt = new Date(String(row.lost_at)).getTime();
          if (!Number.isFinite(sentAt) || !Number.isFinite(lostAt)) return null;
          return { id: row.id, sentAt, lostAt };
        }),
      null,
    );
  },
  inspectWindow(submit, generationIds) {
    const from = new Date(submit.sentAt - 2 * SUBMIT_CLOCK_SLACK_MS);
    const to = new Date(submit.lostAt + 2 * SUBMIT_CLOCK_SLACK_MS);
    return quiet(
      "inspect",
      () =>
        withService(async (db) => {
          const known = new Set<string>();
          if (generationIds.length > 0) {
            const rows = await db
              .select({ id: imageProviderGenerations.generationId })
              .from(imageProviderGenerations)
              .where(
                and(
                  eq(imageProviderGenerations.provider, PROVIDER),
                  inArray(imageProviderGenerations.generationId, [
                    ...generationIds,
                  ]),
                ),
              );
            for (const row of rows) known.add(row.id);
          }
          // ★ Any other submit that was out at the same time and is not
          //   settled could have made the job instead. `found` ones are not
          //   counted: their job is in the record, so it is `known`.
          const result = await db.execute(sql`
            select count(*)::int as rivals
              from public.image_provider_submits
             where provider = ${PROVIDER}
               and id <> ${submit.id}::uuid
               and state <> 'found'
               and sent_at <= ${to.toISOString()}
               and coalesce(lost_at, sent_at + ${SUBMIT_OUT_MS} * interval '1 millisecond')
                   >= ${from.toISOString()}`);
          const rivals = Number(
            (result.rows as { rivals?: unknown }[])[0]?.rivals ?? Number.NaN,
          );
          if (!Number.isFinite(rivals)) throw new Error("no rival count");
          return { known, rivals };
        }),
      null,
    );
  },
  adoptFound(submit, scope, digest, generationId, now) {
    return quiet(
      "adopt",
      () =>
        withService(async (db) => {
          // ★ The unique key on the job id is what keeps two tries from
          //   taking one job: only the insert that lands owns it.
          const taken = await db
            .insert(imageProviderGenerations)
            .values({
              provider: PROVIDER,
              scope,
              requestDigest: digest,
              generationId,
              state: "submitted",
              claimedAt: now.toISOString(),
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            })
            .onConflictDoNothing()
            .returning({ id: imageProviderGenerations.id });
          if (taken.length === 0) return false;
          await db
            .update(imageProviderSubmits)
            .set({
              state: "found",
              generationId,
              lostAt: new Date(submit.lostAt).toISOString(),
              updatedAt: now.toISOString(),
            })
            .where(
              and(
                eq(imageProviderSubmits.id, submit.id),
                inArray(imageProviderSubmits.state, ["sending", "lost"]),
              ),
            );
          return true;
        }),
      false,
    );
  },
  giveUpSubmit(submitId, now) {
    return quiet(
      "give-up",
      () =>
        withService(async (db) => {
          await db
            .update(imageProviderSubmits)
            .set({
              state: "given_up",
              // A `sending` row a dead process left has no lost_at yet.
              lostAt: sql`coalesce(${imageProviderSubmits.lostAt}, ${now.toISOString()})`,
              updatedAt: now.toISOString(),
            })
            .where(
              and(
                eq(imageProviderSubmits.id, submitId),
                inArray(imageProviderSubmits.state, ["sending", "lost"]),
              ),
            );
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

/**
 * A store that remembers nothing: for a caller with no database (a script, a
 * test). ⚠ Its jobs are in no record, so never use it in an environment whose
 * key another environment's lost-job search can see.
 */
export const noGenerationStore: GenerationStore = {
  unrecorded: true,
  claimUndelivered: async () => null,
  openSubmit: async () => null,
  recordSubmitted: async () => {},
  dropSubmit: async () => {},
  markSubmitLost: async () => {},
  findLostSubmit: async () => null,
  inspectWindow: async () => null,
  adoptFound: async () => false,
  giveUpSubmit: async () => {},
  settle: async () => {},
  release: async () => {},
};
