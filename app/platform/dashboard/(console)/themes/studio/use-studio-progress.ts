"use client";

import { useMemo, useRef, useState } from "react";
import { usePoll } from "@/lib/pos/use-poll";
import type { ThemeStudioProgress } from "@/lib/theme-studio/progress";
import { studioStatus, type StudioStatus } from "./studio-status";

// ---------------------------------------------------------------------------
// The theme page's live progress (wave TS-2, plan section 4 "Progress without
// slowing your clicks"; contract in
// revamp-handoff/scratchpad/progress/ts2-contract.md).
//
// ★ A GET ROUTE, NOT A SERVER ACTION. Next.js runs server actions one at a
// time per browser, so a poll in flight would hold back Publish, Send and
// Stop (CODEBASE.md, "THE POLLS ARE A ROUTE HANDLER, NOT SERVER ACTIONS").
// The hook asks GET /api/platform/theme-studio/projects/[projectId]/progress
// through lib/pos/use-poll.ts (visible tab and online only, never stacked,
// a returning tab catches up at once), every STUDIO_PROGRESS_POLL_MS,
// stretching the interval while nothing changes (`backOff`), and only while
// the theme changes by itself (status rows 2, 5 and 6). The page refreshes
// fully only when the revision or the version list changed.
//
// ★ A FAILED POLL IS NOT AN EVENT: the screen keeps the last answer. Only a
// lost session (401), a lost superadmin role (403) or a deleted theme (404)
// stops the poll for good, and says so in `problem`.
// ---------------------------------------------------------------------------

/** How often the theme page asks while something is working. */
export const STUDIO_PROGRESS_POLL_MS = 3_000;

/** The status rows that change by themselves: publishing, working, stuck. */
export const STUDIO_POLLED_ROWS: readonly number[] = [2, 5, 6];

/** Why the poll stopped for good: the session ended (401), the operator is
 * no longer a superadmin (403), or the theme no longer exists (404). */
export type StudioProgressProblem = "signed_out" | "forbidden" | "missing";

export interface StudioProgressState {
  /** The newest answer: `initial` until a poll lands, and `initial` again
   * whenever the page re-renders with a revision at least as new. */
  progress: ThemeStudioProgress;
  /** studioStatus(progress.status). */
  status: StudioStatus;
  /** `progress.revision` differs from `initial.revision`: the page's own
   * server data is out of date. The page calls router.refresh() once per
   * new revision. */
  revisionChanged: boolean;
  /** `progress.versionIds` differs from `initial.versionIds` (a design was
   * added or revealed): the page refreshes the same way. */
  versionsChanged: boolean;
  /** Set once the route answered 401, 403 or 404; the poll then stops. */
  problem: StudioProgressProblem | null;
  /** The timer is running: something is working, publishing or stuck, and
   * no problem was met. */
  polling: boolean;
}

const PROBLEM_BY_STATUS: Readonly<Record<number, StudioProgressProblem>> = {
  401: "signed_out",
  403: "forbidden",
  404: "missing",
};

/** The address the hook polls. */
export function studioProgressUrl(projectId: string): string {
  return `/api/platform/theme-studio/projects/${encodeURIComponent(projectId)}/progress`;
}

/** An answer with its read time left out, so a poll that only moved the
 * clock reads as "nothing changed" and the interval stretches. */
function sameExceptNow(
  a: ThemeStudioProgress,
  b: ThemeStudioProgress,
): boolean {
  const strip = (p: ThemeStudioProgress) =>
    JSON.stringify({ ...p, status: { ...p.status, now: "" } });
  return strip(a) === strip(b);
}

function timeOf(iso: string | undefined): number {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : -Infinity;
}

/** The newer of two answers: the higher revision, ties to the newer read. */
function newer(
  polled: ThemeStudioProgress | null,
  initial: ThemeStudioProgress,
): ThemeStudioProgress {
  if (!polled || polled.projectId !== initial.projectId) return initial;
  if (polled.revision !== initial.revision)
    return polled.revision > initial.revision ? polled : initial;
  return timeOf(polled.status.now) > timeOf(initial.status.now)
    ? polled
    : initial;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Poll one theme's progress. `initial` is the server-rendered answer of
 * readThemeStudioProgress for the same project, so the first frame needs no
 * request.
 */
export function useStudioProgress(
  projectId: string,
  initial: ThemeStudioProgress,
): StudioProgressState {
  const [polled, setPolled] = useState<ThemeStudioProgress | null>(null);
  const [problem, setProblem] = useState<{
    projectId: string;
    problem: StudioProgressProblem;
  } | null>(null);
  const progress = newer(polled, initial);
  const status = useMemo(() => studioStatus(progress.status), [progress]);
  const stopped = problem?.projectId === projectId ? problem.problem : null;
  const polling = stopped === null && STUDIO_POLLED_ROWS.includes(status.row);
  // The last answer this hook saw, to tell a changed answer from a tick.
  const last = useRef<ThemeStudioProgress>(progress);

  // ★ A RESTART ASKS AFTER 3 S, NEVER AFTER AN OLD SLOW-DOWN. use-poll.ts
  // keeps its count of unchanged answers while polling is off, and keeps a
  // timer it already stretched when the page changes under it, so after a
  // quiet step (up to 48 s between asks) a Stop then Continue building, or a
  // Stop and check again, would leave the card on its server snapshot for
  // that long. A restart is polling turning on again in this page, or the
  // page re-rendering with a new revision while it polls (after an action,
  // or the refresh a new revision asks for); the first mount is none, the
  // server has just rendered it. Until the first answer after a restart
  // lands, back-off is off (the first ask comes after 3 s), and that answer
  // counts as news, which clears the count.
  const restartKey = polling ? initial.revision : null;
  const [restart, setRestart] = useState<{
    key: number | null;
    fresh: boolean;
  }>(() => ({ key: restartKey, fresh: false }));
  if (restart.key !== restartKey)
    setRestart({ key: restartKey, fresh: restartKey !== null });
  const fresh =
    restart.key === restartKey ? restart.fresh : restartKey !== null;

  usePoll(
    async (run) => {
      let response: Response;
      try {
        response = await fetch(studioProgressUrl(projectId), {
          cache: "no-store",
          signal: run.signal,
          headers: { accept: "application/json" },
        });
      } catch {
        return false;
      }
      if (!run.isCurrent()) return false;
      const lost = PROBLEM_BY_STATUS[response.status];
      if (lost) {
        setProblem({ projectId, problem: lost });
        return false;
      }
      if (!response.ok) return false;
      let next: ThemeStudioProgress;
      try {
        next = (await response.json()) as ThemeStudioProgress;
      } catch {
        return false;
      }
      if (!run.isCurrent() || next?.projectId !== projectId) return false;
      const changed = fresh || !sameExceptNow(next, last.current);
      last.current = next;
      setPolled(next);
      if (fresh)
        setRestart((now) =>
          now.key === restartKey && now.fresh
            ? { key: restartKey, fresh: false }
            : now,
        );
      return changed;
    },
    { ms: STUDIO_PROGRESS_POLL_MS, enabled: polling, backOff: !fresh },
  );

  return {
    progress,
    status,
    revisionChanged: progress.revision !== initial.revision,
    versionsChanged: !sameIds(progress.versionIds, initial.versionIds),
    problem: stopped,
    polling,
  };
}
