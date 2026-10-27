-- Read-aloud voice for Mink AI's voice chat (owner's request, 2026-10-18).
-- Beside the existing speech-to-text choice, the one platform row now says
-- whether answers are read aloud by a text-to-speech model at all
-- (speech_enabled; off means the merchant's browser voice, which is how every
-- store works today) and which model when it is on: Google Gemini 3.8
-- Flash-Lite TTS or Sarvam Bulbul V4 Flash. Additive columns with defaults, so
-- the revision being replaced keeps reading the row unchanged.

ALTER TABLE public.mink_voice_settings
  ADD COLUMN IF NOT EXISTS speech_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS speech_provider text NOT NULL
    DEFAULT 'gemini_3_8_flash_lite_tts';

ALTER TABLE public.mink_voice_settings
  DROP CONSTRAINT IF EXISTS mink_voice_settings_speech_provider_check;
ALTER TABLE public.mink_voice_settings
  ADD CONSTRAINT mink_voice_settings_speech_provider_check
    CHECK (speech_provider = ANY (ARRAY['gemini_3_8_flash_lite_tts'::text, 'bulbul_v4_flash'::text]));
