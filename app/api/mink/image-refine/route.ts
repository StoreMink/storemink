import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError, MinkToolInputError } from "@/lib/mink/errors";
import { refineStoreImage } from "@/lib/mink/image-refine";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { isImageSpecKey } from "@/lib/media/image-specs";
import { logError, logWarn } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, private" },
  });

/**
 * Refine with Mink AI — the upload widget's button.
 *
 * ★ A ROUTE, NOT A SERVER ACTION, for the reason `/api/pos/live` gives: actions
 *   are dispatched one at a time per client, so a ~30 s image call would queue
 *   every other action on the page (the product editor's Save among them)
 *   behind it.
 * ★ The browser names a photo and a slot KEY, never a size: width, height and
 *   ratio come from the server's own catalogue, and the actor, store and
 *   permissions are derived here, never sent.
 */
export async function POST(request: Request) {
  const foreign = rejectForeignMinkOrigin(request);
  if (foreign) return foreign;
  const config = getMinkConfig();
  if (!config.enabled) return json({ error: "Mink AI is not enabled." }, 404);

  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const body = (await readMinkBoundedJson(
      request,
      4096,
      AbortSignal.timeout(5_000),
    )) as { url?: unknown; spec?: unknown };
    if (typeof body.url !== "string" || body.url.length > 2048) {
      return json({ error: "Choose a photo to refine." }, 400);
    }
    if (!isImageSpecKey(body.spec)) {
      return json({ error: "This image slot can't be refined." }, 400);
    }
    const refined = await refineStoreImage({
      actor,
      sourceUrl: body.url,
      specKey: body.spec,
    });
    return json(refined);
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.image-refine: rejected", {
        requestId,
        code: error.code,
        status: error.status,
      });
      return json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof MinkToolInputError) {
      // Permission / feature-switch refusals from the shared image gate.
      return json({ error: error.message }, 403);
    }
    logError("mink.image-refine: failed", error, { requestId });
    return json(
      { error: "Refining failed. Nothing was charged; try again." },
      500,
    );
  }
}
