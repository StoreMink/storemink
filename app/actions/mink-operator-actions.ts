"use server";

import { revalidatePath } from "next/cache";
import { getPlatformViewer } from "@/app/actions/platform";
import { minkImageSettings, minkVoiceSettings } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import {
  isElevenLabsImageModel,
  isRevampImageProvider,
  type RevampImageSettings,
} from "@/lib/mink/image-provider-settings";
import { elevenLabsConfigured } from "@/lib/mink/image-provider-store";
import { logError, logInfo } from "@/lib/observability/logger";
import {
  isMinkSpeechProvider,
  isMinkVoiceProvider,
  type MinkSpeechSettings,
  type MinkVoiceProvider,
} from "@/lib/mink/voice-provider";

export async function setMinkVoiceProvider(
  provider: unknown,
): Promise<{ success?: true; provider?: MinkVoiceProvider; error?: string }> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin")
    return { error: "Only a platform superadmin can change the voice model." };
  if (!isMinkVoiceProvider(provider))
    return { error: "Choose Google Chirp 3 or Sarvam Saaras v4." };
  try {
    const now = new Date().toISOString();
    await withService((db) =>
      db
        .insert(minkVoiceSettings)
        .values({
          id: true,
          provider,
          updatedAt: now,
          updatedBy: viewer.email,
        })
        .onConflictDoUpdate({
          target: minkVoiceSettings.id,
          set: { provider, updatedAt: now, updatedBy: viewer.email },
        }),
    );
    revalidatePath("/platform/dashboard/(console)/mink", "page");
    logInfo("mink.voice.settings.changed", {
      provider,
      operator: viewer.email,
    });
    return { success: true, provider };
  } catch (error) {
    logError("mink.voice.settings.change_failed", error, { provider });
    return { error: "Could not change the voice model. Try again." };
  }
}

/**
 * Read-aloud for voice chat, for every store: off means each merchant's
 * browser voice; on, the chosen model reads the answers.
 */
export async function setMinkSpeechSettings(input: {
  enabled: unknown;
  provider: unknown;
}): Promise<{ success?: true; settings?: MinkSpeechSettings; error?: string }> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin")
    return {
      error: "Only a platform superadmin can change the read-aloud voice.",
    };
  if (typeof input?.enabled !== "boolean")
    return { error: "Choose whether a text-to-speech model reads answers." };
  if (!isMinkSpeechProvider(input.provider))
    return {
      error: "Choose Gemini 3.8 Flash-Lite TTS or Sarvam Bulbul V4 Flash.",
    };
  const settings: MinkSpeechSettings = {
    enabled: input.enabled,
    provider: input.provider,
  };
  try {
    const now = new Date().toISOString();
    await withService((db) =>
      db
        .insert(minkVoiceSettings)
        .values({
          id: true,
          speechEnabled: settings.enabled,
          speechProvider: settings.provider,
          updatedAt: now,
          updatedBy: viewer.email,
        })
        .onConflictDoUpdate({
          target: minkVoiceSettings.id,
          set: {
            speechEnabled: settings.enabled,
            speechProvider: settings.provider,
            updatedAt: now,
            updatedBy: viewer.email,
          },
        }),
    );
    revalidatePath("/platform/dashboard/(console)/mink", "page");
    logInfo("mink.speech.settings.changed", {
      ...settings,
      operator: viewer.email,
    });
    return { success: true, settings };
  } catch (error) {
    logError("mink.speech.settings.change_failed", error, settings);
    return { error: "Could not change the read-aloud voice. Try again." };
  }
}

/**
 * Which service draws a storefront redesign's pictures (mink_image_settings).
 * ★ ElevenLabs is refused on a server with no ELEVENLABS_API_KEY: the read
 *   side would fall back to Vertex anyway, and a switch that says ElevenLabs
 *   while Vertex draws is worse than one that refuses.
 */
export async function setRevampImageSettings(input: {
  provider: unknown;
  model: unknown;
}): Promise<{
  success?: true;
  settings?: RevampImageSettings;
  error?: string;
}> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin")
    return {
      error: "Only a platform superadmin can change who draws redesign photos.",
    };
  if (!isRevampImageProvider(input?.provider))
    return { error: "Choose Google Vertex AI or ElevenLabs." };
  if (!isElevenLabsImageModel(input.model))
    return { error: "Choose an ElevenLabs image model." };
  if (input.provider === "elevenlabs" && !elevenLabsConfigured())
    return {
      error:
        "ElevenLabs needs ELEVENLABS_API_KEY on this server. Add it, then switch.",
    };
  const settings: RevampImageSettings = {
    provider: input.provider,
    elevenLabsModel: input.model,
  };
  try {
    const now = new Date().toISOString();
    await withService((db) =>
      db
        .insert(minkImageSettings)
        .values({
          id: true,
          revampProvider: settings.provider,
          elevenlabsModel: settings.elevenLabsModel,
          updatedAt: now,
          updatedBy: viewer.email,
        })
        .onConflictDoUpdate({
          target: minkImageSettings.id,
          set: {
            revampProvider: settings.provider,
            elevenlabsModel: settings.elevenLabsModel,
            updatedAt: now,
            updatedBy: viewer.email,
          },
        }),
    );
    revalidatePath("/platform/dashboard/(console)/mink", "page");
    logInfo("mink.image_provider.changed", {
      ...settings,
      operator: viewer.email,
    });
    return { success: true, settings };
  } catch (error) {
    logError("mink.image_provider.change_failed", error, { ...settings });
    return { error: "Could not change who draws redesign photos. Try again." };
  }
}
