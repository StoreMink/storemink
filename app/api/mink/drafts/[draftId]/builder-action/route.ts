import { revalidatePath, revalidateTag } from "next/cache";
import { after } from "next/server";
import { notifyStoreContentPublished } from "@/lib/seo/store-indexing";
import { emitEvent } from "@/lib/notifications/record";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import {
  approveMinkBuilderProposal,
  readMinkBuilderReview,
} from "@/lib/mink/builder-actions";
import { MinkRequestError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { rateLimit } from "@/lib/rate-limit";
import { TAGS } from "@/lib/storefront/tags";
import { STORE_TAG } from "@/lib/store/resolve";
import { logError } from "@/lib/observability/logger";

export const runtime = "nodejs";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMIT = 32768;
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
async function body(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader)
    throw new MinkRequestError(
      "mink_builder_body",
      "A review approval is required.",
      400,
    );
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > LIMIT) {
        await reader.cancel();
        throw new MinkRequestError(
          "mink_builder_size",
          "Builder request is too large.",
          413,
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(merged));
  } catch {
    throw new MinkRequestError(
      "mink_builder_body",
      "Invalid approval request.",
      400,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MinkRequestError(
      "mink_builder_body",
      "Invalid approval request.",
      400,
    );
  return value as Record<string, unknown>;
}
async function handle(
  request: Request,
  context: { params: Promise<{ draftId: string }> },
  approve: boolean,
) {
  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;
  const { draftId } = await context.params;
  if (!UUID.test(draftId))
    return json({ error: "Invalid Builder proposal." }, 400);
  const config = getMinkConfig();
  if (!config.enabled) return json({ error: "Mink AI is unavailable." }, 404);
  try {
    const actor = await getMinkActorContext(crypto.randomUUID(), {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-builder-${approve ? "approve" : "read"}:${actor.storeId}:${actor.adminId}`,
      { max: approve ? 10 : 20, windowSeconds: 60 },
    );
    if (!limited.allowed)
      return json(
        { error: "Too many Builder requests. Please try again shortly." },
        429,
      );
    if (!approve)
      return json({ review: await readMinkBuilderReview(actor, draftId) });
    const input = await body(request);
    if (
      Object.keys(input).some(
        (key) => !["action", "idempotencyKey", "browserChecks"].includes(key),
      ) ||
      input.action !== "approve" ||
      typeof input.idempotencyKey !== "string" ||
      !UUID.test(input.idempotencyKey)
    )
      return json(
        { error: "Review and approve the exact Builder change." },
        400,
      );
    const result = await approveMinkBuilderProposal(
      actor,
      draftId,
      input.idempotencyKey,
      input.browserChecks,
    );
    revalidatePath("/dashboard/builder");
    revalidatePath("/", "layout");
    revalidateTag(TAGS.chrome, { expire: 0 });
    revalidateTag(TAGS.pages, { expire: 0 });
    revalidateTag(STORE_TAG, { expire: 0 });
    if (result.operation === "page_publish") {
      const path = result.pageSlug === "home" ? "/" : `/${result.pageSlug}`;
      after(() =>
        notifyStoreContentPublished({
          storeId: actor.storeId,
          paths: path === "/" ? ["/"] : [path, "/"],
        }),
      );
      if (!result.repeated && result.resultId)
        emitEvent({
          type: "page.published",
          storeId: actor.storeId,
          actor: { type: "admin", id: actor.adminId, label: actor.email },
          subject: {
            type: "page",
            id: result.resultId,
            label: result.pageSlug,
          },
          payload: { source: "mink_ai", page: result.pageSlug, url: path },
        });
    }
    return json({ result });
  } catch (error) {
    if (error instanceof MinkRequestError)
      return json({ error: error.message }, error.status);
    logError("mink.builder_action failed", error, { draftId });
    return json(
      {
        error:
          "Could not complete this Builder request. Your saved proposal is available for retry.",
      },
      503,
    );
  }
}
export const GET = (
  request: Request,
  context: { params: Promise<{ draftId: string }> },
) => handle(request, context, false);
export const POST = (
  request: Request,
  context: { params: Promise<{ draftId: string }> },
) => handle(request, context, true);
