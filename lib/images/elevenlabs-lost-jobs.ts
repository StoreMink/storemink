import "server-only";

/**
 * Finding the job of a submit whose answer was lost.
 *
 * ElevenLabs' Image API takes no idempotency key, and its job list shows no
 * prompt: a row is an id, a status and the picture's address. What it does
 * have (read on 22 Nov 2026, free calls): the list is ordered newest first by
 * CREATION time, and the paging cursor after a page is that page's last row,
 * `<creation time>|<job id>`, base64. A page of one row therefore gives one
 * job and the instant it was made. Checked against five jobs submitted at
 * once that finished 13 to 16 seconds apart: their times were within half a
 * second of each other, so it is the creation time, not the completion time.
 *
 * ★★ A JOB IS A LOST SUBMIT'S ONLY WHEN NOTHING ELSE COULD HAVE MADE IT:
 *    1. it was made inside the window the submit was out for (widened by the
 *       clock slack on both sides);
 *    2. the record of submitted jobs does not hold it (every answered submit
 *       of this environment is recorded there, in the statement that closes
 *       the submit);
 *    3. no other unanswered submit was out at the same time;
 *    4. it is the ONLY such job.
 *    Anything less is `unsure`, and an unsure search takes nothing: the
 *    caller behaves as it did before this module existed. A wrong picture on
 *    a store is worse than a picture paid for twice.
 * ★ The cursor's shape is theirs and undocumented. Every read of it is
 *   checked (it must name the row it came with, and hold a time); a cursor
 *   that does not parse makes the search `unsure`, never a guess.
 * ★★ The record is this environment's. A job made in the same seconds by
 *   ANOTHER environment using the same ElevenLabs key is not in it, and
 *   would pass rules 1 to 4 if our own submit made nothing. A job shows no
 *   prompt (list and single read alike, checked 22 Nov 2026), so nothing can
 *   tell it apart. The search therefore runs ONLY where the environment has
 *   declared its key is not shared (`ELEVENLABS_KEY_EXCLUSIVE=true`,
 *   `elevenLabsKeyIsExclusive`); the draw never calls this otherwise.
 * ★ Rule 2 holds because a submit that cannot be written down is not sent
 *   (elevenlabs-images.ts): every job this environment makes is either held
 *   in the record or covered by an open submit row, which is a rival.
 */

import { logInfo, logWarn } from "@/lib/observability/logger";
import {
  SUBMIT_CLOCK_SLACK_MS,
  type GenerationStore,
  type LostSubmit,
} from "./elevenlabs-generations";

/** The most list rows one search reads before it gives up as unsure. */
export const LOST_JOB_WALK_ROWS = 40;
const LIST_TIMEOUT_MS = 15_000;

export type LostJobSearch =
  /** Exactly one job fits, and nothing else could have made it. */
  | { kind: "found"; generationId: string }
  /** A clear view of the whole window, and no job of ours in it. */
  | { kind: "none" }
  /** Could not tell (a rival submit, two candidates, an unreadable list). */
  | { kind: "unsure"; why: string };

/** One row of the provider's list with the instant it was made. */
export interface ListedJob {
  id: string;
  createdAt: number;
}

/** `<creation time>|<job id>`, base64, as the list's cursor carries it. */
export function decodeListCursor(cursor: string): ListedJob | null {
  let text: string;
  try {
    text = Buffer.from(
      cursor.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
  } catch {
    return null;
  }
  const bar = text.indexOf("|");
  if (bar <= 0 || bar === text.length - 1) return null;
  const stamp = text.slice(0, bar);
  const id = text.slice(bar + 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(stamp)) return null;
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) return null;
  // A stamp with no zone is UTC (their documented example has none).
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp) ? stamp : `${stamp}Z`;
  const createdAt = Date.parse(zoned);
  return Number.isFinite(createdAt) ? { id, createdAt } : null;
}

interface ListBody {
  generations?: unknown;
  next_cursor?: unknown;
  has_more?: unknown;
}

interface ListDeps {
  apiKey: string;
  apiBase: string;
  fetch: typeof fetch;
}

/**
 * The newest jobs, one row a read, back to `until`. Null when the list
 * cannot be read with certainty.
 */
async function walkNewestJobs(
  until: number,
  signal: AbortSignal,
  deps: ListDeps,
): Promise<{ jobs: ListedJob[]; reachedUntil: boolean } | null> {
  const jobs: ListedJob[] = [];
  let cursor: string | null = null;
  for (let read = 0; read < LOST_JOB_WALK_ROWS; read += 1) {
    if (signal.aborted) return null;
    const query: string =
      "?page_size=1" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    let body: ListBody;
    try {
      const response = await deps.fetch(
        `${deps.apiBase}/v1/flows/image${query}`,
        {
          headers: { "xi-api-key": deps.apiKey },
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(LIST_TIMEOUT_MS),
          ]),
          cache: "no-store",
        },
      );
      if (!response.ok) return null;
      body = ((await response.json()) ?? {}) as ListBody;
    } catch {
      return null;
    }
    const rows = Array.isArray(body.generations) ? body.generations : null;
    if (!rows) return null;
    // The list ran out: every job there is has been seen.
    if (rows.length === 0) return { jobs, reachedUntil: true };
    const id = (rows[0] as { id?: unknown } | null)?.id;
    if (rows.length !== 1 || typeof id !== "string") return null;
    const next = typeof body.next_cursor === "string" ? body.next_cursor : null;
    const placed = next ? decodeListCursor(next) : null;
    // ★ The cursor must name the row it came with, or it is not a time we
    //   can attach to that row.
    if (!placed || placed.id !== id) return null;
    if (placed.createdAt < until) return { jobs, reachedUntil: true };
    jobs.push(placed);
    if (body.has_more === false) return { jobs, reachedUntil: true };
    cursor = next;
  }
  // More jobs since the window opened than one search reads.
  return { jobs, reachedUntil: false };
}

/**
 * Look for the job a lost submit made. Reads only: the provider's list (free)
 * and the record. Takes nothing; the caller adopts what it finds.
 */
export async function findLostJob(
  submit: LostSubmit,
  signal: AbortSignal,
  deps: {
    apiKey: string;
    apiBase: string;
    fetch: typeof fetch;
    store: GenerationStore;
    scope: string;
  },
): Promise<LostJobSearch> {
  const from = submit.sentAt - SUBMIT_CLOCK_SLACK_MS;
  const to = submit.lostAt + SUBMIT_CLOCK_SLACK_MS;
  const end = (result: LostJobSearch): LostJobSearch => {
    const line = {
      scope: deps.scope,
      submitId: submit.id,
      result: result.kind,
      ...(result.kind === "unsure" ? { why: result.why } : {}),
      ...(result.kind === "found" ? { generationId: result.generationId } : {}),
    };
    if (result.kind === "unsure") {
      logWarn("images.elevenlabs: lost job search", line);
    } else {
      logInfo("images.elevenlabs: lost job search", line);
    }
    return result;
  };

  const walked = await walkNewestJobs(from, signal, deps);
  if (!walked) return end({ kind: "unsure", why: "list_unreadable" });
  if (!walked.reachedUntil)
    return end({ kind: "unsure", why: "list_too_long" });
  const inWindow = walked.jobs.filter(
    (job) => job.createdAt >= from && job.createdAt <= to,
  );
  const view = await deps.store.inspectWindow(
    submit,
    inWindow.map((job) => job.id),
  );
  if (!view) return end({ kind: "unsure", why: "record_unreadable" });
  // ★ Another unanswered submit was out at the same time: a job in this
  //   window could be its job. Nobody takes anything.
  if (view.rivals > 0) return end({ kind: "unsure", why: "rival_submit" });
  const unheld = inWindow.filter((job) => !view.known.has(job.id));
  if (unheld.length === 0) return end({ kind: "none" });
  if (unheld.length > 1) return end({ kind: "unsure", why: "several_jobs" });
  return end({ kind: "found", generationId: unheld[0].id });
}
