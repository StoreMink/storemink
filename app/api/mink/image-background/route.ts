import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";
import { MinkRequestError, MinkToolInputError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { isImageSpecKey } from "@/lib/media/image-specs";
import { parseBackground } from "@/lib/media/background-layout";
import { replaceProductBackground } from "@/lib/media/background-edit";
import { logError, logWarn } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cold start + one cut-out (up to the client's 90 s ceiling) + compose.
export const maxDuration = 120;

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
 * ★ NOT GATED ON MINK BEING ENABLED: no model is asked anything; the cut-out
 *   comes from the image-matting service, whose own switch is
 *   IMAGE_MATTING_URL. A scene is a separate route (/api/mink/image-edit),
 *   because it is a Mink image call with image generation's gates.
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
      return json({ error: "Choose white, a colour or transparent." }, 400);
    }
    const result = await replaceProductBackground({
      actor,
      sourceUrl: body.url,
      specKey: body.spec,
      background,
      shadow: body.shadow === true,
    });
    return json(result);
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
