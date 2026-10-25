-- Start-time pacing for image model keys on the shared provider capacity
-- (storefront revamp speed plan, Phase 0; owner's decision 2026-10-23).
--
-- A request on an image model's key may start no earlier than next_start_at,
-- which the app keeps at the latest admission plus gap_ms. The gap starts at
-- 40 s, shrinks 10% after each success down to 10 s and grows 1.5x after
-- each refusal up to 45 s (lib/theme-studio/provider-capacity.ts,
-- IMAGE_START_PACING; the 40000 default below is its initialGapMs). Text
-- model keys never read either column. The CHECK is a sanity bound, wider
-- than the app's 10 to 45 s, so the pace can be tuned without a migration.
--
-- Expand-only: both columns carry defaults, so rows the running revision
-- creates through theme_studio_capacity_lock get a pace, and its own claim,
-- release and pause statements name neither column and keep working.
ALTER TABLE public.theme_studio_provider_capacity
  ADD COLUMN next_start_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN gap_ms integer NOT NULL DEFAULT 40000
    CONSTRAINT theme_studio_provider_capacity_gap_ms_check
    CHECK (gap_ms BETWEEN 1000 AND 300000);
