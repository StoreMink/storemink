/**
 * The "your storefront redesign is ready" notice (`mink.revamp_ready`), built
 * in ONE place for every path that turns a revamp ready (ops-4): the runner's
 * card step, and each settlement that finishes a card an earlier invocation
 * already made and paid for (jobs.ts `finishMadeCard`: the claim, a failure,
 * a Stop, the status poll and the sweep).
 *
 * ★★ Two hand-built copies would drift, and the one that drifted is the one
 *   nobody reads: a merchant who left the chat while the card was being made
 *   learns it is ready from this notice alone, whichever path finished it.
 *
 * Pure, so the runner's tests and the jobs' tests compare against the same
 * event.
 */
import type { EmitEventInput } from "@/lib/notifications/record";
import { minkChatHref } from "../chat-session";

/**
 * Where the notice points when the revamp has no chat to open (one started
 * outside a conversation, or whose conversation was deleted): the dashboard.
 */
export const REVAMP_READY_URL = "/dashboard";

/**
 * ★★ Where the notice points (robustness audit B20): the chat the card is in,
 *   opened in the full view (`/dashboard?chat=<id>`, which the dashboard's
 *   chat provider reads once). It used to be plain `/dashboard`, which opened
 *   Home and left the merchant to find the chat in History. ★ Only ever the
 *   requester's own chat: the notice goes to the requester alone, and the
 *   dashboard opens a chat only through the history API, which is scoped to
 *   the viewer, so an address naming any other chat opens a new one.
 */
export function revampReadyUrl(
  conversationId: string | null | undefined,
): string {
  return conversationId ? minkChatHref(conversationId) : REVAMP_READY_URL;
}

/** The ready notice for one revamp, to the admin who asked for it. */
export function revampReadyEvent(job: {
  id: string;
  storeId: string;
  adminId: string;
  /** The chat the card is in; the notice opens it. */
  conversationId?: string | null;
}): EmitEventInput {
  return {
    type: "mink.revamp_ready",
    storeId: job.storeId,
    actor: { type: "system", label: "Mink AI" },
    subject: {
      type: "mink_revamp",
      id: job.id,
      label: "Storefront redesign",
    },
    payload: { url: revampReadyUrl(job.conversationId) },
    // ★ To the admin who asked, and nobody else (the workflow rule): the
    //   event's section is the Website Builder, which the whole team may
    //   view, and this is about one person's request.
    restrictToAdminIds: [job.adminId],
  };
}
