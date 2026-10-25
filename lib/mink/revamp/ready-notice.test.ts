import { describe, expect, it } from "vitest";
import {
  REVAMP_READY_URL,
  revampReadyEvent,
  revampReadyUrl,
} from "./ready-notice";

const REVAMP = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const CHAT = "33333333-3333-4333-8333-333333333333";

describe("★★ the redesign-ready notice opens the chat with the card (B20)", () => {
  it("points at the requester's chat, in the full view", () => {
    expect(revampReadyUrl(CHAT)).toBe(`/dashboard?chat=${CHAT}`);
    const event = revampReadyEvent({
      id: REVAMP,
      storeId: STORE,
      adminId: "owner-1",
      conversationId: CHAT,
    });
    expect(event).toEqual({
      type: "mink.revamp_ready",
      storeId: STORE,
      actor: { type: "system", label: "Mink AI" },
      subject: {
        type: "mink_revamp",
        id: REVAMP,
        label: "Storefront redesign",
      },
      payload: { url: `/dashboard?chat=${CHAT}` },
      // ★ To the admin who asked, and nobody else.
      restrictToAdminIds: ["owner-1"],
    });
  });

  it("falls back to the dashboard when there is no chat to open", () => {
    expect(REVAMP_READY_URL).toBe("/dashboard");
    for (const conversationId of [null, undefined, "", "not-a-chat"]) {
      expect(revampReadyUrl(conversationId)).toBe(REVAMP_READY_URL);
      expect(
        revampReadyEvent({
          id: REVAMP,
          storeId: STORE,
          adminId: "owner-1",
          conversationId,
        }).payload,
      ).toEqual({ url: REVAMP_READY_URL });
    }
    // A caller that has no chat field at all (the older shape).
    expect(
      revampReadyEvent({ id: REVAMP, storeId: STORE, adminId: "owner-1" })
        .payload,
    ).toEqual({ url: REVAMP_READY_URL });
  });
});
