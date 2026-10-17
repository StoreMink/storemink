import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";
import { MinkRequestError, MinkToolInputError } from "@/lib/mink/errors";
import { editProductPhoto } from "@/lib/mink/image-edit";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { isImageSpecKey } from "@/lib/media/image-specs";
import { normalizeEditInstruction } from "@/lib/media/photo-edit";
import { scenePreset, sceneInstruction } from "@/lib/media/scene-presets";
import { logError, logWarn } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cold start + one image call (up to 90 s) + fit, store and charge.
export const maxDuration = 120;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, private" },
  });

/**
 * Re-shoot a product photo in a scene: the photo editor's Scene option.
 *
 * ★ A ROUTE, NOT A SERVER ACTION, for Refine's reason: an image call takes
 *   15-30 seconds, and actions run one at a time per client, so the editor's
 *   Save would queue behind it.
 * ★ The browser names a photo, a slot KEY and either a preset id or the
 *   merchant's own words; the size comes from the server's catalogue and the
 *   actor, store and permissions are derived here, never sent. A preset is
 *   turned into its request on the server, so a preset id cannot smuggle text.
 */
export async function POST(request: Request) {
  const foreign = rejectForeignMinkOrigin(request);
  if (foreign) return foreign;

  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId);
    const body = (await readMinkBoundedJson(
      request,
      4096,
      AbortSignal.timeout(5_000),
    )) as {
      url?: unknown;
      spec?: unknown;
      preset?: unknown;
      instruction?: unknown;
    };
    if (typeof body.url !== "string" || body.url.length > 2048) {
      return json({ error: "Choose a photo first." }, 400);
    }
    if (!isImageSpecKey(body.spec)) {
      return json(
        { error: "This image slot can't be re-shot in a scene." },
        400,
      );
    }
    const preset =
      typeof body.preset === "string" ? scenePreset(body.preset) : null;
    const instruction = preset
      ? sceneInstruction(preset)
      : normalizeEditInstruction(body.instruction);
    if (!instruction) {
      return json({ error: "Choose a scene or describe one first." }, 400);
    }
    const result = await editProductPhoto({
      actor,
      sourceUrl: body.url,
      specKey: body.spec,
      instruction,
    });
    return json(result);
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("media.photo_edit: rejected", {
        requestId,
        code: error.code,
        status: error.status,
      });
      return json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof MinkToolInputError) {
      // Permission and store-switch refusals from the image-generation gate.
      return json({ error: error.message }, 403);
    }
    logError("media.photo_edit: failed", error, { requestId });
    return json(
      {
        error:
          "Creating the photo failed. Try again; a photo is only charged once it is created.",
      },
      500,
    );
  }
}
