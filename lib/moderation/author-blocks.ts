import "server-only";

/**
 * The shopper's side of a review or comment StoreMink removed (takedown design
 * 3.4, 5.7 and 7.4): while a review block names its author and product, or a
 * comment block its author and post, that author cannot post another review of
 * the product or comment on the post, or change the one that was removed.
 *
 * The database enforces it whatever the caller (`moderation_author_guard`,
 * migration 0269, BEFORE INSERT on `product_reviews` and `blog_comments`, so
 * also the insert half of the review upsert). This module lets the storefront
 * actions say so first, in the shopper's words (`SHOPPER` in copy.ts), and
 * turns the guard's own refusal into the same sentence when a block lands
 * between the check and the write.
 *
 * The check is a courtesy, never the enforcement: a read that fails answers
 * "no block" and the guard still refuses the write.
 */

import { and, eq, isNull } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { contentBlocks } from "@/drizzle/schema";
import { isSchemaNotReady, loggableError, pgErrorCode } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import { SHOPPER } from "./copy";

/** What a shopper writes that StoreMink can remove. */
export type AuthoredKind = "review" | "blog_comment";

/** The guard's errcode (`raise exception using errcode = 'P0001'`). */
const GUARD_CODE = "P0001";

/** The guard's messages, exactly as migration 0269 raises them. */
export const AUTHOR_GUARD_MESSAGES: Record<AuthoredKind, string> = {
  review: "moderation: review removed by StoreMink",
  blog_comment: "moderation: comment removed by StoreMink",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sentence a shopper reads for a removed review or comment (design 7.4). */
export function authorBlockSentence(kind: AuthoredKind): string {
  return kind === "review" ? SHOPPER.reviewRemoved : SHOPPER.commentRemoved;
}

/**
 * The live block that keeps this author from posting on this product or post
 * of this store, or null. One indexed read (`content_blocks_author_idx`)
 * through the service scope, because shoppers have no grant on
 * `content_blocks`. Opens its own scope: never call it inside another one.
 *
 * Answers null, without asking, when an id is not a UUID (the write that
 * follows fails on its own), and null when the read fails: the guard refuses
 * the write anyway.
 */
export async function liveAuthorBlock(input: {
  kind: AuthoredKind;
  storeId: string;
  authorUserId: string;
  parentItemId: string;
}): Promise<{ blockId: string } | null> {
  const author = (input.authorUserId ?? "").trim();
  if (
    !author ||
    !UUID.test(input.storeId ?? "") ||
    !UUID.test(input.parentItemId ?? "")
  ) {
    return null;
  }
  try {
    const rows = await withService((db) =>
      db
        .select({ id: contentBlocks.id })
        .from(contentBlocks)
        .where(
          and(
            isNull(contentBlocks.liftedAt),
            eq(contentBlocks.itemKind, input.kind),
            eq(contentBlocks.authorUserId, author),
            eq(contentBlocks.parentItemId, input.parentItemId),
            eq(contentBlocks.storeId, input.storeId),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    return row ? { blockId: row.id } : null;
  } catch (err) {
    if (!isSchemaNotReady(err)) {
      logError(
        "moderation.author_blocks: pre-check failed",
        loggableError(err),
        { kind: input.kind, storeId: input.storeId },
      );
    }
    return null;
  }
}

/** The message of a thrown database error, wrapped (Drizzle) or not. */
function errorMessages(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const e = err as { message?: unknown; cause?: { message?: unknown } };
  return [e.cause?.message, e.message].filter(
    (m): m is string => typeof m === "string",
  );
}

/**
 * The shopper's sentence when `err` is the author guard refusing a review or
 * comment (a block landed after the pre-check), or null for any other error.
 */
export function authorBlockRefusal(err: unknown): string | null {
  if (pgErrorCode(err) !== GUARD_CODE) return null;
  const messages = errorMessages(err);
  for (const kind of ["review", "blog_comment"] as const) {
    const guard = AUTHOR_GUARD_MESSAGES[kind];
    if (messages.some((message) => message.includes(guard))) {
      return authorBlockSentence(kind);
    }
  }
  return null;
}
