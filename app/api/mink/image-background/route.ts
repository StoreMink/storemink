import { NextResponse } from "next/server";
import { can } from "@/app/dashboard/lib/permissions";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";
import { MinkRequestError, MinkToolInputError } from "@/lib/mink/errors";
import { listStoreScenes } from "@/lib/mink/image-scenes";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { IMAGE_SPECS, isImageSpecKey } from "@/lib/media/image-specs";
import { parseBackground } from "@/lib/media/background-layout";
import { replaceProductBackground } from "@/lib/media/background-edit";
import { logError, logWarn } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cold start + one cut-out (up to the client's 90 s ceiling) + one scene (up
// to 60 s) + compose.
export const maxDuration = 180;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, private" },
  });

/**
 * Change a photo's background: the upload widget's Background button.
 *
 * ★ A ROUTE, NOT A SERVER ACTION, for Refine's reason: a cut-out takes 15-30
 *   seconds, and actions run one at a time per client, so the editor's Save
 *   would queue behind it.
 * ★ WHITE, COLOUR AND TRANSPARENT ARE NOT GATED ON MINK BEING ENABLED: no
 *   model is asked anything; the cut-out comes from the image-matting service,
 *   whose own switch is IMAGE_MATTING_URL. A NEW SCENE is a Mink image call
 *   and carries image generation's gates (lib/mink/image-scenes.ts).
 * ★ The browser names a photo, a slot KEY and a background; the size comes from
 *   the server's catalogue and the actor, store and permissions are derived
 *   here, never sent.
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
      background?: unknown;
      shadow?: unknown;
      newScene?: unknown;
    };
    if (typeof body.url !== "string" || body.url.length > 2048) {
      return json({ error: "Choose a photo first." }, 400);
    }
    if (!isImageSpecKey(body.spec)) {
      return json(
        { error: "This image slot can't change its background." },
        400,
      );
    }
    const background = parseBackground(body.background);
    if (!background) {
      return json(
        { error: "Choose white, a colour, transparent or a scene." },
        400,
      );
    }
    const result = await replaceProductBackground({
      actor,
      sourceUrl: body.url,
      specKey: body.spec,
      background,
      shadow: body.shadow === true,
      newScene: body.newScene === true,
    });
    return json(result);
  } catch (error) {
    return failure(error, requestId);
  }
}

/**
 * The store's saved scenes for one slot, newest per preset, so the editor can
 * show which scenes are ready to use for free.
 */
export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId);
    if (!can(actor.permissions, "media", "view", actor.isSuperadmin)) {
      return json({ error: "You need Media permission to see scenes." }, 403);
    }
    const spec = new URL(request.url).searchParams.get("spec");
    if (!isImageSpecKey(spec) || !IMAGE_SPECS[spec].background) {
      return json({ error: "This image slot has no scenes." }, 400);
    }
    const scenes = await listStoreScenes(actor.storeId, IMAGE_SPECS[spec]);
    return json({
      scenes: scenes.map((scene) => ({ preset: scene.preset, url: scene.url })),
    });
  } catch (error) {
    return failure(error, requestId);
  }
}

function failure(error: unknown, requestId: string) {
  if (error instanceof MinkRequestError) {
    logWarn("media.background: rejected", {
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
  logError("media.background: failed", error, { requestId });
  // Not "nothing was charged": this can fail after the cut-out was paid for.
  // A retry reuses it free, which is what the merchant needs to know.
  return json(
    {
      error:
        "Changing the background failed. Try again; a photo is only ever charged once.",
    },
    500,
  );
}
