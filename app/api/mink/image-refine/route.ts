import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError, MinkToolInputError } from "@/lib/mink/errors";
import { refineStoreImage } from "@/lib/mink/image-refine";
import { REFINE_STOP_TOKEN_PATTERN } from "@/lib/mink/refine-stop-types";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { isImageSpecKey } from "@/lib/media/image-specs";
import { logError, logWarn } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Above REFINE_DEADLINE_MS, so the deadline below is what stops a refine.
export const maxDuration = 180;

/**
 * How long a merchant waits for one refine. ★ The model's chain stops before
 * it (`requestMinkImage`'s deadline): two quick 429s, their 5 to 15 s waits
 * and a full 60 s try (about 95 s) fit, with room left for the resize, the
 * upload and the charge (`REFINE_POST_RESERVE_MS`).
 */
const REFINE_DEADLINE_MS = 150_000;

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
 * ★ And a random stop token (`stopToken`), which it sends to
 *   /api/mink/image-refine/stop when the merchant leaves: the refine's own
 *   row decides between that stop and the charge (lib/mink/refine-stop.ts).
 *   A tab loaded before the token existed sends none; the server makes one.
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
    )) as { url?: unknown; spec?: unknown; stopToken?: unknown };
    if (typeof body.url !== "string" || body.url.length > 2048) {
      return json({ error: "Choose a photo to refine." }, 400);
    }
    if (!isImageSpecKey(body.spec)) {
      return json({ error: "This image slot can't be refined." }, 400);
    }
    if (
      body.stopToken !== undefined &&
      (typeof body.stopToken !== "string" ||
        !REFINE_STOP_TOKEN_PATTERN.test(body.stopToken))
    ) {
      return json(
        {
          error:
            "This refine couldn't be started. Reload the page and try again.",
        },
        400,
      );
    }
    // ★ The deadline stops the provider call in flight, and nothing is
    //   stored or charged after it. A merchant leaving is the stop token's
    //   job: behind the load balancer `request.signal` never fires (it still
    //   does locally).
    const deadlineAt = Date.now() + REFINE_DEADLINE_MS;
    const refined = await refineStoreImage({
      actor,
      sourceUrl: body.url,
      specKey: body.spec,
      stopToken: body.stopToken,
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(REFINE_DEADLINE_MS),
      ]),
      deadlineAt,
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
