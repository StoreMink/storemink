import "server-only";

import { eq } from "drizzle-orm";
import { minkVoiceSettings } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import {
  DEFAULT_MINK_SPEECH_PROVIDER,
  DEFAULT_MINK_VOICE_PROVIDER,
  isMinkSpeechProvider,
  isMinkVoiceProvider,
  type MinkSpeechSettings,
  type MinkVoiceProvider,
} from "./voice-provider";

/** Resolve the single platform-wide voice model. */
export async function getMinkVoiceProvider(): Promise<MinkVoiceProvider> {
  const [row] = await withService((db) =>
    db
      .select({ provider: minkVoiceSettings.provider })
      .from(minkVoiceSettings)
      .where(eq(minkVoiceSettings.id, true))
      .limit(1),
  );
  return isMinkVoiceProvider(row?.provider)
    ? row.provider
    : DEFAULT_MINK_VOICE_PROVIDER;
}

/**
 * Whether voice chat answers are read aloud by a model, and which one.
 * ★ A failed read means the browser voice, never an error: reading aloud is a
 * nicety, and the browser fallback is how every store works when it is off.
 */
export async function getMinkSpeechSettings(): Promise<MinkSpeechSettings> {
  try {
    const [row] = await withService((db) =>
      db
        .select({
          enabled: minkVoiceSettings.speechEnabled,
          provider: minkVoiceSettings.speechProvider,
        })
        .from(minkVoiceSettings)
        .where(eq(minkVoiceSettings.id, true))
        .limit(1),
    );
    return {
      enabled: row?.enabled === true,
      provider: isMinkSpeechProvider(row?.provider)
        ? row.provider
        : DEFAULT_MINK_SPEECH_PROVIDER,
    };
  } catch {
    return { enabled: false, provider: DEFAULT_MINK_SPEECH_PROVIDER };
  }
}
