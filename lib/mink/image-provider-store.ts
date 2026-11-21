import "server-only";

import { eq } from "drizzle-orm";
import { minkImageSettings } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { isSchemaNotReady } from "@/lib/db/errors";
import { logError, logWarn } from "@/lib/observability/logger";
import {
  DEFAULT_REVAMP_IMAGE_SETTINGS,
  isElevenLabsImageModel,
  isRevampImageProvider,
  type ElevenLabsImageModel,
  type RevampImageSettings,
} from "./image-provider-settings";

// ---------------------------------------------------------------------------
// The operator's switch for a storefront redesign's pictures
// (mink_image_settings, migration 0278), read when a redesign's photos or
// product photos start.
//
// ★ VERTEX WHEN IN DOUBT. A failed read, the table not there yet (before the
//   migration), or ElevenLabs chosen on a server with no key all draw with
//   Vertex, which is how every redesign worked before the switch existed.
//   The last one is logged as an error: an operator chose ElevenLabs and is
//   not getting it.
// ---------------------------------------------------------------------------

/** The ElevenLabs key, trimmed, or null. Never logged. */
export function elevenLabsApiKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const key = env.ELEVENLABS_API_KEY?.trim().replace(/^["']|["']$/g, "");
  return key ? key : null;
}

export function elevenLabsConfigured(): boolean {
  return elevenLabsApiKey() !== null;
}

/** The stored choice, or the default (Vertex) when it cannot be read. */
export async function getRevampImageSettings(): Promise<RevampImageSettings> {
  try {
    const [row] = await withService((db) =>
      db
        .select({
          provider: minkImageSettings.revampProvider,
          model: minkImageSettings.elevenlabsModel,
        })
        .from(minkImageSettings)
        .where(eq(minkImageSettings.id, true))
        .limit(1),
    );
    return {
      provider: isRevampImageProvider(row?.provider)
        ? row.provider
        : DEFAULT_REVAMP_IMAGE_SETTINGS.provider,
      elevenLabsModel: isElevenLabsImageModel(row?.model)
        ? row.model
        : DEFAULT_REVAMP_IMAGE_SETTINGS.elevenLabsModel,
    };
  } catch (error) {
    if (!isSchemaNotReady(error)) {
      logWarn("mink.image_provider: settings read failed, using Vertex", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return DEFAULT_REVAMP_IMAGE_SETTINGS;
  }
}

export type RevampImageTarget =
  | { kind: "vertex" }
  | { kind: "elevenlabs"; model: ElevenLabsImageModel; apiKey: string };

/** What draws this redesign's pictures right now. Never throws. */
export async function resolveRevampImageTarget(): Promise<RevampImageTarget> {
  const settings = await getRevampImageSettings();
  if (settings.provider !== "elevenlabs") return { kind: "vertex" };
  const apiKey = elevenLabsApiKey();
  if (!apiKey) {
    logError(
      "mink.image_provider: ElevenLabs is chosen but ELEVENLABS_API_KEY is not set, using Vertex",
      new Error("ELEVENLABS_API_KEY missing"),
    );
    return { kind: "vertex" };
  }
  return { kind: "elevenlabs", model: settings.elevenLabsModel, apiKey };
}
