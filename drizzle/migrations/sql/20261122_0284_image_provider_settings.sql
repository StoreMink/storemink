-- A second image provider for Theme Studio and the storefront redesign
-- (owner, 22 Nov 2026): GPT Image 2.5 Sunburst through ElevenLabs' Image API,
-- chosen by a platform operator, beside Google's Nano Banana 2.1.
--
-- Google's image limit is a system limit of two starts a minute for the whole
-- project, which is what makes a redesign's photos take minutes. Measured on
-- 22 Nov 2026, ElevenLabs accepted five and ten images at once and returned
-- each in 13 to 24 seconds.
--
-- 1. image_generation_settings: ONE row, like mink_voice_settings. Which
--    provider draws those photos, and for ElevenLabs the quality (low or
--    medium) and the resolution (1K or 2K). The default is Google, so nothing
--    changes until an operator switches.
--
-- 2. image_provider_generations: one row per job submitted to the async
--    provider. ElevenLabs' API has no idempotency key, and a job that has
--    been submitted is paid for whether or not anyone collects its picture.
--    The row is what lets a draw that was cut off (a deadline, a restart, a
--    lost answer) be COLLECTED by the next try for the same picture, where
--    without it the next try would pay for a second one.
--
-- Expand only. Service access only; no merchant reads either table.

CREATE TABLE public.image_generation_settings (
  id                    boolean PRIMARY KEY DEFAULT true,
  provider              text NOT NULL DEFAULT 'google',
  elevenlabs_quality    text NOT NULL DEFAULT 'low',
  elevenlabs_resolution text NOT NULL DEFAULT '1K',
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text,
  CONSTRAINT image_generation_settings_id_check CHECK (id),
  CONSTRAINT image_generation_settings_provider_check
    CHECK (provider = ANY (ARRAY['google'::text, 'elevenlabs'::text])),
  CONSTRAINT image_generation_settings_quality_check
    CHECK (elevenlabs_quality = ANY (ARRAY['low'::text, 'medium'::text])),
  CONSTRAINT image_generation_settings_resolution_check
    CHECK (elevenlabs_resolution = ANY (ARRAY['1K'::text, '2K'::text]))
);

ALTER TABLE public.image_generation_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.image_generation_settings FROM app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE public.image_generation_settings TO app_service;

INSERT INTO public.image_generation_settings (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE public.image_provider_generations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,
  -- Whose picture this is: a redesign's id or a Theme Studio run's id. A job
  -- is only ever collected inside the scope that submitted it.
  scope          text NOT NULL,
  -- sha256 of everything that decides the picture (model, quality,
  -- resolution, shape, prompt, references).
  request_digest text NOT NULL,
  generation_id  text NOT NULL,
  state          text NOT NULL DEFAULT 'submitted',
  -- Set while a draw is waiting on this job, so two tries never collect the
  -- same picture at once.
  claimed_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT image_provider_generations_provider_check
    CHECK (provider = 'elevenlabs'),
  CONSTRAINT image_provider_generations_state_check
    CHECK (state = ANY (ARRAY['submitted'::text, 'delivered'::text, 'failed'::text])),
  CONSTRAINT image_provider_generations_digest_check
    CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT image_provider_generations_generation_key
    UNIQUE (provider, generation_id)
);

CREATE INDEX image_provider_generations_pending_idx
  ON public.image_provider_generations (provider, scope, request_digest, created_at)
  WHERE state = 'submitted';

CREATE INDEX image_provider_generations_created_idx
  ON public.image_provider_generations (created_at);

ALTER TABLE public.image_provider_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.image_provider_generations FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.image_provider_generations TO app_service;
