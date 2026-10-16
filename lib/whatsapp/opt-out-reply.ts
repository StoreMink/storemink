import "server-only";

import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { stores } from "@/drizzle/schema";
import { replyInChat } from "./auto-reply";

// ---------------------------------------------------------------------------
// The answer to a customer's STOP or START (plan §10).
//
// The opt-out itself is recorded with the message (inbox.ts); this only tells
// the customer it worked. Without an answer nothing came back at all, which
// reads as being ignored.
//
// ★ IT SAYS WHAT STOP DOES AND DOES NOT DO. STOP ends offers, not order
// updates (those are about the customer's own orders), and saying so is what
// stops a customer thinking they will no longer hear about a parcel.
// ⚠ It does NOT offer "reply START": START re-opts in only somebody who had
// agreed to offers before (inbox.ts), so for anyone else that line is false.
// ---------------------------------------------------------------------------

export type OptOutIntent = "stop" | "start";

/** What the customer is told. Pure. */
export function optOutReplyText(
  intent: OptOutIntent,
  storeName: string | null,
): string {
  const shop = storeName?.trim() || "this shop";
  return intent === "stop"
    ? `You will not get offers from ${shop} on WhatsApp any more. You will still get updates about your orders.`
    : `You will get offers from ${shop} on WhatsApp again. Reply STOP at any time to stop them.`;
}

export async function answerOptOut(input: {
  storeId: string;
  conversationId: string;
  phone: string;
  intent: OptOutIntent;
}): Promise<void> {
  const storeName = await withService((db) =>
    db
      .select({ name: stores.name })
      .from(stores)
      .where(eq(stores.id, input.storeId))
      .limit(1),
  )
    .then((rows) => rows[0]?.name ?? null)
    .catch(() => null);
  await replyInChat({
    storeId: input.storeId,
    conversationId: input.conversationId,
    to: input.phone,
    body: optOutReplyText(input.intent, storeName),
    reason: `opt-out:${input.intent}`,
  });
}
