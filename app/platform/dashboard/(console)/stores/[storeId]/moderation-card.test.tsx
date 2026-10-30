// @vitest-environment jsdom
// The store page's "Complaints and holds" card and its hold banner (takedown
// design 6.7).
//
// ★ Every operator reads the lines and follows the links; only a superadmin
// is offered "Suspend on a complaint", "Put on hold" and "Release hold". The
// dialogs call the takedown actions with this store and show their answer.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoreModerationSummary } from "@/lib/moderation/console-read";

const h = vi.hoisted(() => ({
  setStoreHoldAction: vi.fn(),
  releaseStoreHoldAction: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/app/actions/takedown-actions", () => ({
  setStoreHoldAction: h.setStoreHoldAction,
  releaseStoreHoldAction: h.releaseStoreHoldAction,
}));
// suspend-store-dialog.tsx (for the block form's address) imports it.
vi.mock("@/app/actions/platform", () => ({ setStoreStatus: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: h.toastSuccess, error: vi.fn() },
}));

import {
  HoldBanner,
  MODERATION_CARD_TEXT,
  ModerationCard,
  holdDate,
  storeComplaintsHref,
} from "./moderation-card";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const HOLD_ID = "22222222-2222-4222-8222-222222222222";
const BLOCK_ID = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function summary(
  over: Partial<StoreModerationSummary> = {},
): StoreModerationSummary {
  return {
    activeBlocks: 2,
    openComplaints: 1,
    unfinishedArchives: 0,
    storeBlock: null,
    hold: null,
    deleteRefusal: null,
    ...over,
  };
}

const HOLD: NonNullable<StoreModerationSummary["hold"]> = {
  id: HOLD_ID,
  reason: "Police request about counterfeit goods.",
  authorityRef: "Cyber Cell, Punjab, letter 42",
  // 01:30 on 26 Oct in India, 20:00 on 25 Oct in UTC.
  setAt: "2026-10-25T20:00:00.000Z",
  setBy: "ops@storemink.com",
  reviewOn: null,
  complaintId: null,
};

function renderCard(s: StoreModerationSummary | null, canManage = true) {
  render(
    <ModerationCard
      storeId={STORE_ID}
      storeName="Echos"
      summary={s}
      canManage={canManage}
    />,
  );
}

describe("the words and the addresses", () => {
  it("dates are India time", () => {
    expect(holdDate("2026-10-25T20:00:00.000Z")).toBe("26 Oct 2026");
  });

  it("narrows the complaints list to this store, on one tab", () => {
    expect(storeComplaintsHref(STORE_ID)).toBe(
      `/dashboard/complaints?store=${STORE_ID}`,
    );
    expect(storeComplaintsHref(STORE_ID, "blocks")).toBe(
      `/dashboard/complaints?view=blocks&store=${STORE_ID}`,
    );
    expect(storeComplaintsHref(STORE_ID, "holds")).toBe(
      `/dashboard/complaints?view=holds&store=${STORE_ID}`,
    );
  });

  it("carries no long dash", () => {
    const words = [
      ...(Object.values(MODERATION_CARD_TEXT) as unknown[]).filter(
        (v): v is string => typeof v === "string",
      ),
      MODERATION_CARD_TEXT.banner("1 Oct 2026", "a@b.c", "x"),
      MODERATION_CARD_TEXT.holdTitle("Echos"),
      MODERATION_CARD_TEXT.releaseTitle("Echos"),
      MODERATION_CARD_TEXT.suspendedByBlock("1 Oct 2026"),
      MODERATION_CARD_TEXT.onHold("1 Oct 2026"),
    ].join(" ");
    expect(words).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("ModerationCard", () => {
  it("★ says the read failed rather than showing zeroes", () => {
    renderCard(null);
    expect(screen.getByRole("status").textContent).toBe(
      MODERATION_CARD_TEXT.readFailed,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("lists blocks and complaints as links into the store's Complaints view", () => {
    renderCard(summary());
    expect(
      screen
        .getByRole("link", { name: "Blocked items: 2" })
        .getAttribute("href"),
    ).toBe(storeComplaintsHref(STORE_ID, "blocks"));
    expect(
      screen
        .getByRole("link", { name: "Open complaints: 1" })
        .getAttribute("href"),
    ).toBe(storeComplaintsHref(STORE_ID));
    expect(screen.getByText(MODERATION_CARD_TEXT.notOnHold)).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: MODERATION_CARD_TEXT.notOnHold }),
    ).toBeNull();
  });

  it("names the block that suspends the store and the hold, with links", () => {
    renderCard(
      summary({
        storeBlock: { id: BLOCK_ID, blockedAt: "2026-10-25T20:00:00.000Z" },
        hold: HOLD,
      }),
    );
    expect(
      screen
        .getByRole("link", { name: "Suspended by a block since 26 Oct 2026" })
        .getAttribute("href"),
    ).toBe(`/dashboard/complaints/blocks/${BLOCK_ID}`);
    expect(
      screen
        .getByRole("link", { name: "On hold since 26 Oct 2026" })
        .getAttribute("href"),
    ).toBe(storeComplaintsHref(STORE_ID, "holds"));
    // Already suspended by a block and already held: neither is offered again.
    expect(
      screen.queryByRole("link", {
        name: MODERATION_CARD_TEXT.suspendOnComplaint,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: MODERATION_CARD_TEXT.putOnHold }),
    ).toBeNull();
  });

  it("★ a superadmin is offered the block form and Put on hold", () => {
    renderCard(summary());
    expect(
      screen
        .getByRole("link", { name: MODERATION_CARD_TEXT.suspendOnComplaint })
        .getAttribute("href"),
    ).toBe(`/dashboard/complaints/block?store=${STORE_ID}&kind=store`);
    expect(
      screen.getByRole("button", { name: MODERATION_CARD_TEXT.putOnHold }),
    ).toBeTruthy();
  });

  it("★★ a member reads the lines and is offered nothing to do", () => {
    renderCard(summary(), false);
    expect(screen.getByRole("link", { name: "Blocked items: 2" })).toBeTruthy();
    expect(
      screen.queryByRole("link", {
        name: MODERATION_CARD_TEXT.suspendOnComplaint,
      }),
    ).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("Put on hold sends the reason and the optional fields with this store", async () => {
    h.setStoreHoldAction.mockResolvedValue({
      ok: true,
      holdId: HOLD_ID,
      message: "Store on hold.",
    });
    renderCard(summary());
    fireEvent.click(
      screen.getByRole("button", { name: MODERATION_CARD_TEXT.putOnHold }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Put Echos on hold?")).toBeTruthy();
    expect(
      within(dialog).getByText(MODERATION_CARD_TEXT.holdBody),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: "Police request" },
    });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: /Who asked/ }),
      { target: { value: "  Cyber Cell, letter 42  " } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: MODERATION_CARD_TEXT.putOnHold,
      }),
    );
    await waitFor(() =>
      expect(h.toastSuccess).toHaveBeenCalledWith("Store on hold."),
    );
    expect(h.setStoreHoldAction).toHaveBeenCalledWith({
      storeId: STORE_ID,
      reason: "Police request",
      authorityRef: "Cyber Cell, letter 42",
      complaint: null,
      reviewOn: null,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows the action's refusal in the dialog and keeps it open", async () => {
    h.setStoreHoldAction.mockResolvedValue({
      ok: false,
      error: "Write why the store is on hold.",
    });
    renderCard(summary());
    fireEvent.click(
      screen.getByRole("button", { name: MODERATION_CARD_TEXT.putOnHold }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: MODERATION_CARD_TEXT.putOnHold,
      }),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe(
        "Write why the store is on hold.",
      ),
    );
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("HoldBanner", () => {
  it("says since when, by whom and why, and that the store can't be deleted", () => {
    render(<HoldBanner storeName="Echos" hold={HOLD} canManage={false} />);
    // The reason's own full stop is not doubled.
    expect(screen.getByRole("status").textContent).toBe(
      "On hold for an investigation since 26 Oct 2026, set by ops@storemink.com: Police request about counterfeit goods. It can't be deleted.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("★ Release hold is a superadmin's, and needs the note it sends", async () => {
    h.releaseStoreHoldAction.mockResolvedValue({
      ok: true,
      message: "Hold released.",
    });
    render(<HoldBanner storeName="Echos" hold={HOLD} canManage />);
    fireEvent.click(
      screen.getByRole("button", { name: MODERATION_CARD_TEXT.release }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Release the hold on Echos?")).toBeTruthy();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Note" }), {
      target: { value: "The police closed the case." },
    });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: MODERATION_CARD_TEXT.release,
      }),
    );
    await waitFor(() =>
      expect(h.toastSuccess).toHaveBeenCalledWith("Hold released."),
    );
    expect(h.releaseStoreHoldAction).toHaveBeenCalledWith(
      HOLD_ID,
      "The police closed the case.",
    );
  });

  it("says the request failed when the release throws", async () => {
    h.releaseStoreHoldAction.mockRejectedValue(new Error("network"));
    render(<HoldBanner storeName="Echos" hold={HOLD} canManage />);
    fireEvent.click(
      screen.getByRole("button", { name: MODERATION_CARD_TEXT.release }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: MODERATION_CARD_TEXT.release,
      }),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe(
        MODERATION_CARD_TEXT.failed,
      ),
    );
  });
});
