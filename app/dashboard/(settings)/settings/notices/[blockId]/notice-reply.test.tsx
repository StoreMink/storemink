// @vitest-environment jsdom
// The store's reply form and the seen mark on a notice from StoreMink
// (takedown stage T18a, design 7.1). The actions are mocks; they are tested
// in app/actions/store-notice-actions.test.ts over the real merchant module.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const H = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("@/app/actions/store-notice-actions", () => ({
  replyToStoreNoticeAction: vi.fn(async () => ({ ok: true })),
  markStoreNoticeSeenAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: H.refresh }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NoticeReply, NoticeSeen } from "./notice-reply";
import {
  markStoreNoticeSeenAction,
  replyToStoreNoticeAction,
} from "@/app/actions/store-notice-actions";
import { toast } from "sonner";
import { NOTICE, NOTICE_REPLY } from "@/lib/moderation/copy";

const BLOCK = "22222222-2222-4222-8222-222222222222";

function form() {
  render(<NoticeReply blockId={BLOCK} tickLabel={NOTICE_REPLY.reviewTick} />);
  return {
    box: screen.getByLabelText(NOTICE_REPLY.label) as HTMLTextAreaElement,
    tick: screen.getByRole("checkbox", { name: NOTICE_REPLY.reviewTick }),
    send: screen.getByRole("button", { name: NOTICE_REPLY.button }),
  };
}

beforeEach(() => {
  H.refresh = vi.fn();
});

describe("NoticeReply", () => {
  it("shows the label, placeholder, tick and button", () => {
    const { box, tick, send } = form();
    expect(box.placeholder).toBe(NOTICE_REPLY.placeholder);
    expect(tick).toBeTruthy();
    expect(send).toBeTruthy();
  });

  it("asks for a reply before sending anything", async () => {
    const { send } = form();
    await userEvent.click(send);
    expect(screen.getByRole("alert").textContent).toBe(
      NOTICE_REPLY.errors.empty,
    );
    expect(replyToStoreNoticeAction).not.toHaveBeenCalled();
  });

  it("refuses a reply over 4,000 characters", async () => {
    const { box, send } = form();
    await userEvent.click(box);
    await userEvent.paste("x".repeat(4001));
    await userEvent.click(send);
    expect(screen.getByRole("alert").textContent).toBe(
      NOTICE_REPLY.errors.tooLong,
    );
    expect(replyToStoreNoticeAction).not.toHaveBeenCalled();
  });

  it("sends the reply with the tick, says so, clears and refreshes", async () => {
    const { box, tick, send } = form();
    await userEvent.type(box, "  We fixed it.  ");
    await userEvent.click(tick);
    await userEvent.click(send);
    await waitFor(() =>
      expect(replyToStoreNoticeAction).toHaveBeenCalledWith(
        BLOCK,
        "We fixed it.",
        true,
      ),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(NOTICE_REPLY.sent),
    );
    expect(H.refresh).toHaveBeenCalled();
    expect(box.value).toBe("");
    expect((tick as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the server's refusal and keeps the text", async () => {
    vi.mocked(replyToStoreNoticeAction).mockResolvedValueOnce({
      ok: false,
      error: NOTICE_REPLY.errors.lifted,
    });
    const { box, send } = form();
    await userEvent.type(box, "Hello");
    await userEvent.click(send);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        NOTICE_REPLY.errors.lifted,
      ),
    );
    expect(box.value).toBe("Hello");
    expect(toast.success).not.toHaveBeenCalled();
    expect(H.refresh).not.toHaveBeenCalled();
  });

  it("says the reply was not sent when the action throws", async () => {
    vi.mocked(replyToStoreNoticeAction).mockRejectedValueOnce(
      new Error("network"),
    );
    const { box, send } = form();
    await userEvent.type(box, "Hello");
    await userEvent.click(send);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(NOTICE_REPLY.failed),
    );
  });

  it("gives the tick a touch-sized row", () => {
    const { tick } = form();
    expect(tick.closest("label")?.className).toContain("min-h-11");
  });
});

describe("NoticeSeen", () => {
  it("marks the notice seen once it is on screen", async () => {
    render(<NoticeSeen blockId={BLOCK} />);
    await waitFor(() =>
      expect(markStoreNoticeSeenAction).toHaveBeenCalledWith(BLOCK),
    );
  });

  it("stays quiet when marking fails", async () => {
    vi.mocked(markStoreNoticeSeenAction).mockRejectedValueOnce(
      new Error(NOTICE.notFound),
    );
    const { container } = render(<NoticeSeen blockId={BLOCK} />);
    await waitFor(() => expect(markStoreNoticeSeenAction).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
