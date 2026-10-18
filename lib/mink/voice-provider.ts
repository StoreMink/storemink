export const MINK_VOICE_PROVIDERS = ["chirp_3", "saaras_v4"] as const;

export type MinkVoiceProvider = (typeof MINK_VOICE_PROVIDERS)[number];

export const DEFAULT_MINK_VOICE_PROVIDER: MinkVoiceProvider = "chirp_3";

export function isMinkVoiceProvider(
  value: unknown,
): value is MinkVoiceProvider {
  return (
    typeof value === "string" &&
    (MINK_VOICE_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Read-aloud models for voice chat. Off (the default) means the merchant's
 * browser reads answers with its own voice; on, the platform row picks one of
 * these. One choice for every store, like the transcription model above.
 */
export const MINK_SPEECH_PROVIDERS = [
  "gemini_3_8_flash_lite_tts",
  "bulbul_v4_flash",
] as const;

export type MinkSpeechProvider = (typeof MINK_SPEECH_PROVIDERS)[number];

export const DEFAULT_MINK_SPEECH_PROVIDER: MinkSpeechProvider =
  "gemini_3_8_flash_lite_tts";

export const MINK_SPEECH_PROVIDER_LABELS: Record<MinkSpeechProvider, string> = {
  gemini_3_8_flash_lite_tts: "Gemini 3.8 Flash-Lite TTS",
  bulbul_v4_flash: "Sarvam Bulbul V4 Flash",
};

export function isMinkSpeechProvider(
  value: unknown,
): value is MinkSpeechProvider {
  return (
    typeof value === "string" &&
    (MINK_SPEECH_PROVIDERS as readonly string[]).includes(value)
  );
}

export type MinkSpeechSettings = {
  enabled: boolean;
  provider: MinkSpeechProvider;
};
