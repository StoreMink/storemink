-- Which service draws a storefront redesign's pictures (owner, 2026-11-21).
-- Vertex allows 2 image requests a minute per project per base model, a limit
-- that cannot be raised, so a redesign's pictures queue 31 to 45 seconds
-- apart. This one platform row lets an operator switch the redesign's
-- pictures to ElevenLabs, which has no such pacing, and choose its model.
-- It starts on Vertex, so nothing changes until an operator switches it.
-- A new table, so the revision being replaced never reads it.
CREATE TABLE public.mink_image_settings (
  id               boolean PRIMARY KEY DEFAULT true,
  revamp_provider  text NOT NULL DEFAULT 'vertex',
  elevenlabs_model text NOT NULL DEFAULT 'gemini-3.1-flash-image',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text,
  CONSTRAINT mink_image_settings_id_check CHECK (id),
  CONSTRAINT mink_image_settings_revamp_provider_check
    CHECK (revamp_provider = ANY (ARRAY['vertex'::text, 'elevenlabs'::text])),
  CONSTRAINT mink_image_settings_elevenlabs_model_check
    CHECK (elevenlabs_model = ANY (ARRAY[
      'gemini-3.1-flash-image'::text,
      'gemini-3-pro-image'::text,
      'gemini-3.1-flash-lite-image'::text,
      'gpt-image-2'::text,
      'gpt-image-2.5-flare'::text,
      'gpt-image-2.5-sunburst'::text,
      'bytedance-seedream-5-lite'::text,
      'bytedance-seedream-5-pro'::text
    ]))
);

ALTER TABLE public.mink_image_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mink_image_settings FROM app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mink_image_settings TO app_service;

INSERT INTO public.mink_image_settings (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;
