-- Refine with Mink AI: leaving mid-refine charges nothing (owner, 25 Oct 2026).
--
-- ★★ A STOP THE BROWSER SENDS NOW REACHES THE REFINE, ON WHICHEVER INSTANCE
-- RUNS IT. Behind Google's load balancer an aborted browser fetch never
-- reaches Cloud Run, so a merchant who left mid-refine was still charged for a
-- photo nobody waited for. The browser gives every refine a random stop token
-- and, when it leaves, sends POST /api/mink/image-refine/stop with that token;
-- this table decides (lib/mink/refine-stop.ts).
--
-- ★★ EXACTLY ONE OF {THE STOP, THE CHARGE} WINS. One row per refine, keyed by
-- what both requests know: the store, the admin and the stop token. The stop
-- sets stop_requested_at only while charge_claimed_at is NULL; the charge
-- transaction sets charge_claimed_at only while stop_requested_at is NULL, as
-- its first statement, before consume_mink_refine_credits. Both take this
-- row's lock, and a waiting statement re-reads the newest committed row before
-- it decides (READ COMMITTED). mink_refine_requests_stop_or_charge_check is the
-- backstop if a later writer drops a predicate.
--
-- refinement_id is the server's own refine id (mink_image_refinements.id), set
-- when the refine starts. It is NULL only on a row a stop created before its
-- refine arrived; that refine then finds the row and refuses to start. The
-- browser's token is never the charge's idempotency key.
--
-- ★ NULL-SAFE BY CONSTRUCTION. Every CHECK arm is IS [NOT] NULL, which never
-- yields NULL.
--
-- ★ EXPAND ONLY. A new service-only table (RLS on, no policies, app_user has
-- no grants) that the revision being replaced never names. During the deploy
-- window a new browser may send its refine to an old instance, which ignores
-- the token and charges, and its stop to a new one, which records the stop on
-- a row no refine will claim and answers `recorded`, never `stopped`.
-- Acceptable for one deploy window: `recorded` promises nothing.

CREATE TABLE IF NOT EXISTS public.mink_refine_requests (
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id text NOT NULL,
  stop_token uuid NOT NULL,
  refinement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  stop_requested_at timestamptz,
  charge_claimed_at timestamptz,
  CONSTRAINT mink_refine_requests_pkey
    PRIMARY KEY (store_id, admin_id, stop_token),
  CONSTRAINT mink_refine_requests_refinement_key UNIQUE (refinement_id),
  CONSTRAINT mink_refine_requests_stop_or_charge_check
    CHECK (stop_requested_at IS NULL OR charge_claimed_at IS NULL),
  CONSTRAINT mink_refine_requests_charge_has_refinement_check
    CHECK (charge_claimed_at IS NULL OR refinement_id IS NOT NULL),
  CONSTRAINT mink_refine_requests_started_or_stopped_check
    CHECK (refinement_id IS NOT NULL OR stop_requested_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS mink_refine_requests_created_idx
  ON public.mink_refine_requests (created_at);

ALTER TABLE public.mink_refine_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mink_refine_requests FROM PUBLIC;
REVOKE ALL ON public.mink_refine_requests FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mink_refine_requests TO app_service;
