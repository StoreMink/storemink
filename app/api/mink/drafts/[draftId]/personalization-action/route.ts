import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import {
  executeMinkStorefrontPersonalizationAction,
  getLatestMinkStorefrontPersonalizationAction,
  previewMinkStorefrontPersonalizationAction,
} from "@/lib/mink/storefront-personalization-actions";
import { STORE_TAG } from "@/lib/store/resolve";
import { TAGS } from "@/lib/storefront/tags";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4_096;

/**
 * What this personalisation has already done, for a card restored from
 * history: without it a reloaded card offers Apply for a storefront that was
 * personalised an hour ago (the layout card's reason).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;
  const { draftId } = await params;
  if (!UUID_PATTERN.test(draftId)) {
    return privateJson(
      { error: "Invalid Mink AI storefront personalisation." },
      400,
    );
  }
  const config = getMinkConfig();
  if (!config.enabled) {
    return privateJson({ error: "Mink AI is not enabled." }, 404);
  }
  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-personalization-read:${actor.storeId}:${actor.adminId}`,
      { max: 20, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return privateJson(
        { error: "Mink storefront actions are receiving too many requests." },
        429,
      );
    }
    return privateJson({
      result: await getLatestMinkStorefrontPersonalizationAction(
        actor,
        draftId,
      ),
    });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      // ★ A restored card asking about a draft that no longer validates is not
      //   an error worth showing: it simply has nothing to report.
      logWarn("mink.personalization_action: read rejected", {
        requestId,
        draftId,
        code: error.code,
      });
      return privateJson({ result: null });
    }
    logError("mink.personalization_action: read failed", error, {
      requestId,
      draftId,
    });
    return privateJson(
      { error: "Mink AI couldn't load that personalisation." },
      503,
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;
  const { draftId } = await params;
  if (!UUID_PATTERN.test(draftId)) {
    return privateJson(
      { error: "Invalid Mink AI storefront personalisation." },
      400,
    );
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return privateJson({ error: "Mink storefront request is too large." }, 413);
  }
  let mutation: ActionMutation;
  try {
    mutation = readMutation(await readBoundedJson(request));
  } catch (error) {
    return privateJson(
      {
        error:
          error instanceof BodyTooLargeError
            ? "Mink storefront request is too large."
            : error instanceof Error
              ? error.message
              : "Invalid storefront action request.",
      },
      error instanceof BodyTooLargeError ? 413 : 400,
    );
  }
  const config = getMinkConfig();
  if (!config.enabled) {
    return privateJson({ error: "Mink AI is not enabled." }, 404);
  }
  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-personalization-action:${actor.storeId}:${actor.adminId}`,
      { max: 6, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return privateJson(
        { error: "Mink storefront actions are receiving too many requests." },
        429,
      );
    }
    if (mutation.action === "preview") {
      const approval = await previewMinkStorefrontPersonalizationAction({
        actor,
        draftId,
        expectedDraftVersion: mutation.expectedDraftVersion,
        idempotencyKey: mutation.idempotencyKey,
      });
      return privateJson({ approval });
    }
    const result = await executeMinkStorefrontPersonalizationAction({
      actor,
      draftId,
      approvalId: mutation.approvalId,
    });
    revalidatePath("/dashboard/builder");
    if (!result.repeated) {
      // ★ The parts with no draft layer are live now: categories, the theme's
      //   sample products and the store's tagline and description. Their
      //   caches expire at once rather than serving the theme's for a minute.
      revalidateTag(TAGS.categories, { expire: 0 });
      // ★ A revamp (plan version 2) also PUBLISHES the merchant's own
      //   products, so the shop's listing must show them at once.
      revalidateTag(TAGS.products, { expire: 0 });
      revalidateTag(STORE_TAG, { expire: 0 });
      revalidatePath("/dashboard/categories");
      revalidatePath("/dashboard/products");
      revalidatePath("/shop");
    }
    return privateJson({ result });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.personalization_action: request rejected", {
        requestId,
        draftId,
        action: mutation.action,
        code: error.code,
        status: error.status,
      });
      return privateJson(
        { error: error.message, code: error.code },
        error.status,
      );
    }
    logError("mink.personalization_action: request failed", error, {
      requestId,
      draftId,
      action: mutation.action,
    });
    return privateJson(
      { error: "Mink AI couldn't apply that personalisation." },
      503,
    );
  }
}

type ActionMutation =
  | { action: "preview"; expectedDraftVersion: number; idempotencyKey: string }
  | { action: "execute"; approvalId: string };

function readMutation(value: unknown): ActionMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Mink storefront request must be a JSON object.");
  }
  const row = value as Record<string, unknown>;
  if (row.action === "preview") {
    assertOnlyKeys(row, ["action", "expectedDraftVersion", "idempotencyKey"]);
    if (row.expectedDraftVersion !== 0) {
      throw new SyntaxError("The private proposal version is invalid.");
    }
    return {
      action: "preview",
      expectedDraftVersion: Number(row.expectedDraftVersion),
      idempotencyKey: readUuid(row.idempotencyKey, "idempotencyKey"),
    };
  }
  if (row.action === "execute") {
    assertOnlyKeys(row, ["action", "approvalId"]);
    return {
      action: "execute",
      approvalId: readUuid(row.approvalId, "approvalId"),
    };
  }
  throw new SyntaxError("Unknown Mink storefront action request.");
}

class BodyTooLargeError extends Error {}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new SyntaxError("Mink storefront request is empty.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  return JSON.parse(body);
}

function readUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new SyntaxError(`${label} must be a UUID.`);
  }
  return value;
}

function assertOnlyKeys(row: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(row).some((key) => !allowed.includes(key))) {
    throw new SyntaxError("Mink storefront request has unsupported fields.");
  }
}

function privateJson(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
