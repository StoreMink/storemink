import "server-only";

/**
 * The record of every takedown action (design 3.8): one append-only row in
 * `moderation_events` per thing that happened, written on the caller's own
 * connection so it commits or rolls back with the action it records.
 *
 * `app_service` may read and add rows, never change or delete one (migration
 * 0269), so a mistake here cannot be corrected later: everything is checked
 * before the insert. A wrong action, an empty actor or a malformed id is a
 * programming error and throws; an oversized `detail` is replaced with a
 * small note rather than letting the table's 16 KB CHECK abort the caller's
 * transaction.
 *
 * Never call this inside a scope you did not open for it: pass the `db` of
 * the transaction the action runs in (CODEBASE §5 item 2).
 */

import type { Db } from "@/lib/db/client";
import { moderationEvents } from "@/drizzle/schema";
import { MODERATION_ACTIONS, isOneOf, type ModerationAction } from "./kinds";

/** What one event says. */
export type ModerationEventInput = {
  /**
   * Who did it: an operator's email, "system" for the platform's own work,
   * or another short label the caller documents. 1 to 320 characters.
   */
  actor: string;
  action: ModerationAction;
  complaintId?: string | null;
  blockId?: string | null;
  holdId?: string | null;
  storeId?: string | null;
  /** Small facts about the event; ids and codes, never customer content. */
  detail?: Record<string, unknown> | null;
};

/** The longest actor the table accepts (`moderation_events_actor_check`). */
export const ACTOR_MAX = 320;

/**
 * The most `detail` may hold, as JSON text and as values. The table refuses a
 * `detail` over 16 KB in its stored (jsonb) form, which can be larger than the
 * JSON text when there are many small values, so both are bounded well below
 * it.
 */
export const DETAIL_MAX_BYTES = 8192;
export const DETAIL_MAX_VALUES = 512;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedId(name: string, value: string | null | undefined) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`recordModerationEvent: ${name} must be a UUID.`);
  }
  return value.toLowerCase();
}

function countValues(value: unknown): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    count += 1;
    if (next !== null && typeof next === "object") {
      for (const child of Object.values(next as object)) stack.push(child);
    }
  }
  return count;
}

/**
 * The `detail` as it will be stored: a plain JSON object (undefined values
 * and functions dropped), or a note saying it was too large.
 */
export function boundedDetail(
  detail: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (
    detail === null ||
    detail === undefined ||
    typeof detail !== "object" ||
    Array.isArray(detail)
  ) {
    return {};
  }
  let text: string;
  try {
    text = JSON.stringify(detail);
  } catch {
    return { detailUnreadable: true };
  }
  const plain = JSON.parse(text) as Record<string, unknown>;
  const bytes = Buffer.byteLength(text, "utf8");
  const values = countValues(plain);
  if (bytes <= DETAIL_MAX_BYTES && values <= DETAIL_MAX_VALUES) return plain;
  return {
    detailTooLarge: true,
    bytes,
    values,
    keys: Object.keys(plain).slice(0, 20),
  };
}

/** The row to insert, checked. Throws on a programming error. */
export function moderationEventRow(input: ModerationEventInput) {
  if (!isOneOf(MODERATION_ACTIONS, input.action)) {
    throw new Error(
      `recordModerationEvent: unknown action ${String(input.action)}.`,
    );
  }
  const actor = typeof input.actor === "string" ? input.actor.trim() : "";
  if (!actor) throw new Error("recordModerationEvent: actor is required.");
  return {
    actor: actor.slice(0, ACTOR_MAX),
    action: input.action,
    complaintId: checkedId("complaintId", input.complaintId),
    blockId: checkedId("blockId", input.blockId),
    holdId: checkedId("holdId", input.holdId),
    storeId: checkedId("storeId", input.storeId),
    detail: boundedDetail(input.detail),
  };
}

/**
 * Add one event on the caller's connection and answer its id. Throws what
 * the insert throws, so the caller's transaction decides what a failure
 * means.
 */
export async function recordModerationEvent(
  db: Db,
  input: ModerationEventInput,
): Promise<string> {
  const row = moderationEventRow(input);
  const [inserted] = await db
    .insert(moderationEvents)
    .values(row)
    .returning({ id: moderationEvents.id });
  return inserted.id;
}
