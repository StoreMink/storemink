-- Mink run stop (25 Oct 2026).
--
-- ★★ A STOP ASKED FOR IN THE BROWSER NOW REACHES THE RUN, ON WHICHEVER
-- INSTANCE RUNS IT. Behind Google's load balancer an aborted browser fetch
-- never reaches Cloud Run, so a reply the merchant stopped (or a voice
-- barge-in dropped) kept going on the server: on 25 Oct one started a
-- storefront redesign and stored its card after the browser had let go of it,
-- and the card never showed. The browser now asks
-- POST /api/mink/runs/[runId]/stop, and the run's own row decides.
--
-- ★★ EXACTLY ONE OF {THE STOP, THE RUN'S FIRST SIDE EFFECT} WINS. The stop
-- route sets stop_requested_at only while acted_at is null; every tool that
-- writes or charges first sets acted_at only while stop_requested_at is null
-- (lib/mink/run-stop.ts). Both are conditional UPDATEs of this one row, so
-- the second waits on the first's row lock and re-reads the row before it
-- decides. A run that acted always finishes and answers; a stopped run
-- answers nothing, is charged nothing and changes nothing.
--   mink_runs_stop_or_act_check is the backstop if a later writer forgets a
--   predicate. mink_runs_stopped_never_succeeds_check keeps a stopped run from
--   ever storing an answer: completeMinkRun also asks for stop_requested_at
--   IS NULL, and this makes the rule hold for any other writer.
--
-- ★ NULL-SAFE BY CONSTRUCTION. A CHECK is satisfied when it evaluates to
-- NULL, which has let a malformed row through four times in this schema.
-- These two cannot: IS NULL never yields NULL, and status is NOT NULL, so
-- `<>` never does either.
--
-- ★ EXPAND ONLY, SAFE BESIDE THE REVISION BEING REPLACED. Two nullable
-- columns and two CHECKs every existing row satisfies (both columns NULL).
-- The old revision never writes either column. If a new browser stops a run
-- an old instance is running, the stop can win though that run already acted
-- (old code never claims); its completeMinkRun then fails the second CHECK
-- and the run closes through its own failure path, which keeps a redesign
-- card (B4). Acceptable for one deploy window.
--
-- ★ LOCKS AND GRANTS. The ADDs validate in-statement under ACCESS EXCLUSIVE;
-- mink_runs is small and every row passes, well inside the runner's 5 s
-- lock_timeout. app_service already holds table-level UPDATE (0035), which
-- covers new columns, so no grant. No index: every read and write here is by
-- primary key.

ALTER TABLE public.mink_runs
  ADD COLUMN stop_requested_at TIMESTAMPTZ,
  ADD COLUMN acted_at TIMESTAMPTZ;

ALTER TABLE public.mink_runs
  ADD CONSTRAINT mink_runs_stop_or_act_check
    CHECK (stop_requested_at IS NULL OR acted_at IS NULL),
  ADD CONSTRAINT mink_runs_stopped_never_succeeds_check
    CHECK (stop_requested_at IS NULL OR status <> 'succeeded');
