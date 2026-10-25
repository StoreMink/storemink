-- Mink AI storefront revamp (docs/mink-storefront-revamp.md).
--
-- "Customise my store for my business" now rebuilds what shoppers see in a
-- background job: the whole site planned by one model call, every page
-- written, a shoot of photographs drawn and reviewed, then ONE review card.
-- This migration adds the job and its photographs, and lets a store's first
-- revamp card be free (owner's decision, 2026-10-21).
--
-- ★ NO VOCABULARY IS WIDENED FOR THE CARD. Its draft keeps kind
--   storefront_personalization and its approval keeps tool
--   apply_storefront_personalization (0232), with the stored plan's
--   schemaVersion 2 telling the apply path it holds a revamp. Only the free
--   card needs the credit check below.
--
-- Both tables are service-only (RLS on, no policies, app_user has no grants),
-- like every other Mink ledger.

-- ---- The job ----------------------------------------------------------------
-- ★ ONE ACTIVE REVAMP PER STORE, enforced by a partial unique index rather
--   than by the tool: two "customise my store" messages a second apart must
--   not start two paid builds of the same store.
-- ★ `free` is decided in the insert that creates the job (the tool's
--   transaction), so two first revamps cannot both be free.
CREATE TABLE IF NOT EXISTS public.mink_revamps (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id text NOT NULL,
  -- ★ The runner has no session, so it rebuilds the requester's authority
  --   from the database at every claim (the workflow runtime's rule). A
  --   platform operator has no admins row; the email is how they are found.
  requester_email text,
  conversation_id uuid REFERENCES public.mink_conversations(id) ON DELETE SET NULL,
  origin_run_id uuid REFERENCES public.mink_runs(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES public.mink_revamps(id) ON DELETE SET NULL,
  superseded_by uuid REFERENCES public.mink_revamps(id) ON DELETE SET NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  step text NOT NULL DEFAULT 'snapshot',
  progress jsonb NOT NULL DEFAULT '[]'::jsonb,
  request jsonb NOT NULL,
  snapshot jsonb,
  plan jsonb,
  result jsonb,
  draft_id uuid REFERENCES public.mink_drafts(id) ON DELETE SET NULL,
  free boolean NOT NULL DEFAULT false,
  -- What a paid revamp may spend, read from the store's balance when it was
  -- started; NULL when free or on an unmetered plan. The plan is trimmed to
  -- fit it before any photo is drawn.
  budget_credits integer,
  credits integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 4,
  last_kick_at timestamptz,
  cancel_requested_at timestamptz,
  error_code text,
  error_detail text,
  applied_at timestamptz,
  published_at timestamptz,
  undone_at timestamptz,
  apply_snapshot jsonb,
  publish_snapshot jsonb,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT mink_revamps_kind_check CHECK (kind IN ('full', 'refine')),
  CONSTRAINT mink_revamps_status_check
    CHECK (status IN ('queued', 'running', 'ready', 'failed', 'cancelled', 'superseded')),
  CONSTRAINT mink_revamps_step_check
    CHECK (step IN ('snapshot', 'plan', 'compile', 'photos', 'products', 'assemble', 'checks', 'card')),
  -- Only a full revamp can be the store's free one.
  CONSTRAINT mink_revamps_free_check CHECK (NOT free OR kind = 'full'),
  -- A refinement always builds on an earlier revamp.
  CONSTRAINT mink_revamps_parent_check CHECK (kind = 'full' OR parent_id IS NOT NULL),
  CONSTRAINT mink_revamps_credits_check
    CHECK (credits BETWEEN 0 AND 200 AND (NOT free OR credits = 0)),
  -- ★ coalesce: a NULL budget is "no budget", and the arm must be true then,
  --   not NULL by accident (0103's lesson works both ways).
  CONSTRAINT mink_revamps_budget_check
    CHECK (coalesce(budget_credits, 0) >= 0 AND (NOT free OR budget_credits IS NULL)),
  CONSTRAINT mink_revamps_attempts_check
    CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10),
  -- ★ Each arm is false, never NULL, when its condition fails (0103's lesson:
  --   a CHECK is satisfied by NULL).
  CONSTRAINT mink_revamps_ready_check
    CHECK (status <> 'ready' OR draft_id IS NOT NULL),
  CONSTRAINT mink_revamps_failed_check
    CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CONSTRAINT mink_revamps_lease_check
    CHECK ((lease_token IS NULL AND lease_until IS NULL) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT mink_revamps_request_check
    CHECK (jsonb_typeof(request) = 'object'),
  CONSTRAINT mink_revamps_progress_check
    CHECK (jsonb_typeof(progress) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS mink_revamps_one_active_idx
  ON public.mink_revamps (store_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS mink_revamps_store_idx
  ON public.mink_revamps (store_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mink_revamps_conversation_idx
  ON public.mink_revamps (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

-- The sweep that resumes a job whose runner died reads only active rows.
CREATE INDEX IF NOT EXISTS mink_revamps_active_lease_idx
  ON public.mink_revamps (lease_until)
  WHERE status IN ('queued', 'running');

ALTER TABLE public.mink_revamps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mink_revamps FROM PUBLIC;
REVOKE ALL ON public.mink_revamps FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mink_revamps TO app_service;

-- ---- The photographs ----------------------------------------------------------
-- ★ EVERY DRAWN PHOTO IS PAID FOR, so it is stored the moment it settles and
--   recorded here: a runner that dies half way resumes with the photos it
--   already has (and the anchor as the shoot's reference) instead of paying
--   for them again.
CREATE TABLE IF NOT EXISTS public.mink_revamp_images (
  id uuid PRIMARY KEY,
  revamp_id uuid NOT NULL REFERENCES public.mink_revamps(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  role text NOT NULL,
  slot_id text NOT NULL,
  url text NOT NULL,
  path text NOT NULL,
  sha256 text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  review text NOT NULL DEFAULT 'unreviewed',
  problems jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mink_revamp_images_slot_key UNIQUE (revamp_id, role, slot_id),
  CONSTRAINT mink_revamp_images_role_check CHECK (role IN ('anchor', 'slot', 'product')),
  CONSTRAINT mink_revamp_images_review_check
    CHECK (review IN ('passed', 'flagged', 'unreviewed')),
  CONSTRAINT mink_revamp_images_sha_check CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT mink_revamp_images_size_check
    CHECK (width BETWEEN 1 AND 8192 AND height BETWEEN 1 AND 8192)
);

CREATE INDEX IF NOT EXISTS mink_revamp_images_store_idx
  ON public.mink_revamp_images (store_id, created_at DESC);

ALTER TABLE public.mink_revamp_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mink_revamp_images FROM PUBLIC;
REVOKE ALL ON public.mink_revamp_images FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mink_revamp_images TO app_service;

-- ---- The free first revamp ----------------------------------------------------
-- ★ A store's first revamp card carries no charge (owner, 2026-10-21). Its
--   draft is written with expected_credits 0 and credit_source 'free', and
--   the charge function is not called, so the credit ledger gets no row.
--   Only a storefront_personalization draft may be free, and a free draft
--   charges nothing. `coalesce` keeps the free arm false, never NULL, for a
--   draft whose source is not yet written (0103's lesson).
ALTER TABLE public.mink_drafts DROP CONSTRAINT IF EXISTS mink_drafts_credit_check;
ALTER TABLE public.mink_drafts ADD CONSTRAINT mink_drafts_credit_check CHECK (
  (
    expected_credits >= 1
    OR (
      kind = 'storefront_personalization'
      AND expected_credits = 0
      AND coalesce(credit_source, '') = 'free'
    )
  )
  AND expected_credits <= (CASE WHEN kind = 'storefront_personalization' THEN 200 ELSE 20 END)
  AND charged_credits >= 0
  AND charged_credits <= (CASE WHEN kind = 'storefront_personalization' THEN 200 ELSE 20 END)
  AND (credit_source IS NULL OR credit_source = ANY (ARRAY['plan', 'credit', 'mixed', 'plan_unlimited', 'free']::text[]))
  AND (
    credit_source IS DISTINCT FROM 'free'
    OR (kind = 'storefront_personalization' AND charged_credits = 0 AND expected_credits = 0)
  )
);
