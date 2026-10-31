// @vitest-environment jsdom
// One notice from StoreMink (takedown stage T18a, design 7.1). The read is a
// mock (the "not found" boundary is tested in lib/moderation/merchant.ts);
// the reply form and the seen mark are stubs, tested in notice-reply.test.tsx.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { StoreNotice } from "@/lib/moderation/merchant";

const H = vi.hoisted(() => ({
  notice: null as unknown,
  allowed: new Set<string>(),
}));

vi.mock("@/app/dashboard/lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({
    can: (section: string, action: string) =>
      H.allowed.has(`${section}:${action}`),
  })),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/moderation/merchant", () => ({
  getStoreNotice: vi.fn(async () => H.notice),
}));
vi.mock("./notice-reply", () => ({
  NoticeReply: (props: { blockId: string; tickLabel: string }) => (
    <div data-testid="reply" data-block={props.blockId}>
      {props.tickLabel}
    </div>
  ),
  NoticeSeen: (props: { blockId: string }) => (
    <span data-testid="seen" data-block={props.blockId} />
  ),
}));

import StoreNoticePage from "./page";
import { requireSectionAccess } from "@/app/dashboard/lib/access";
import { getStoreNotice } from "@/lib/moderation/merchant";
import {
  NOTICE,
  NOTICES,
  NOTICE_REPLY,
  whatThisMeans,
  whatYouCanDo,
} from "@/lib/moderation/copy";

const BLOCK = "22222222-2222-4222-8222-222222222222";
const IMAGE = "33333333-3333-4333-8333-333333333333";
const PRODUCT = "11111111-1111-4111-8111-111111111111";

function notice(over: Partial<StoreNotice> = {}): StoreNotice {
  return {
    blockId: BLOCK,
    parentBlockId: null,
    kind: "product",
    contentType: null,
    itemLabel: "Blue mug",
    reasonKind: "listed_content",
    blockedAt: "2026-10-29T20:00:00.000Z",
    liftedAt: null,
    seen: false,
    images: [{ blockId: IMAGE, label: "mug.webp", lifted: false }],
    complaintId: "88888888-8888-4888-8888-888888888888",
    reference: "SM-000123",
    storeMessage: "We blocked this product after a complaint.",
    liftNote: "",
    edit: { href: `/dashboard/products/${PRODUCT}`, section: "products" },
    messages: [
      {
        id: "m1",
        fromStoreMink: true,
        author: NOTICE.storeMinkAuthor,
        body: "Please send proof.",
        asksReview: false,
        createdAt: "2026-10-29T11:00:00.000Z",
      },
      {
        id: "m2",
        fromStoreMink: false,
        author: "owner@shop.test",
        body: "We fixed it.",
        asksReview: true,
        createdAt: "2026-10-29T12:30:00.000Z",
      },
    ],
    ...over,
  };
}

async function show(blockId = BLOCK) {
  return render(
    await StoreNoticePage({ params: Promise.resolve({ blockId }) }),
  );
}

beforeEach(() => {
  H.notice = notice();
  H.allowed = new Set(["settings:view", "settings:manage", "products:view"]);
});

describe("a notice from StoreMink", () => {
  it("needs Settings view and reads the notice for the host's store", async () => {
    await show();
    expect(requireSectionAccess).toHaveBeenCalledWith("settings", "view");
    expect(getStoreNotice).toHaveBeenCalledWith("store-1", BLOCK);
  });

  it("says it could not be found, with the way back, and marks nothing", async () => {
    H.notice = null;
    await show("not-a-notice");
    expect(screen.getByText(NOTICE.notFound)).toBeTruthy();
    const back = screen.getByRole("link", { name: NOTICES.title });
    expect(back.getAttribute("href")).toBe("/dashboard/settings/notices");
    expect(screen.queryByTestId("seen")).toBeNull();
    expect(screen.queryByTestId("reply")).toBeNull();
  });

  it("shows the title, the facts and the message", async () => {
    await show();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Product blocked by StoreMink",
      }),
    ).toBeTruthy();
    const item = screen.getByRole("link", { name: "Blue mug" });
    expect(item.getAttribute("href")).toBe(`/dashboard/products/${PRODUCT}`);
    expect(
      screen.getByRole("link", { name: "mug.webp" }).getAttribute("href"),
    ).toBe(`/dashboard/settings/notices/${IMAGE}`);
    expect(screen.getByText("30 Oct 2026")).toBeTruthy();
    expect(screen.getByText("SM-000123")).toBeTruthy();
    expect(screen.getByText(NOTICE.facts.reference)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: NOTICE.messageHeading }),
    ).toBeTruthy();
    expect(
      screen.getByText("We blocked this product after a complaint."),
    ).toBeTruthy();
  });

  it("explains what it means and what the store can do", async () => {
    await show();
    for (const paragraph of whatThisMeans("product")) {
      expect(screen.getByText(paragraph)).toBeTruthy();
    }
    for (const paragraph of whatYouCanDo({
      reasonKind: "listed_content",
      complaintId: "x",
    })) {
      expect(screen.getByText(paragraph)).toBeTruthy();
    }
  });

  it("shows the conversation in India time with the store's review request", async () => {
    await show();
    expect(screen.getByText(NOTICE.storeMinkAuthor)).toBeTruthy();
    expect(screen.getByText("owner@shop.test")).toBeTruthy();
    expect(screen.getByText("29 Oct 2026, 18:00")).toBeTruthy();
    // The tick text appears under the store's message and in the reply stub.
    expect(screen.getAllByText(NOTICE_REPLY.reviewTick)).toHaveLength(2);
  });

  it("offers the reply form with Settings manage and marks the notice seen", async () => {
    await show();
    const reply = screen.getByTestId("reply");
    expect(reply.getAttribute("data-block")).toBe(BLOCK);
    expect(reply.textContent).toBe(NOTICE_REPLY.reviewTick);
    expect(screen.getByTestId("seen").getAttribute("data-block")).toBe(BLOCK);
  });

  it("says who may reply when the viewer only reads Settings", async () => {
    H.allowed = new Set(["settings:view", "products:view"]);
    await show();
    expect(screen.queryByTestId("reply")).toBeNull();
    expect(screen.getByText(NOTICE_REPLY.errors.noPermission)).toBeTruthy();
    expect(screen.getByTestId("seen")).toBeTruthy();
  });

  it("names the item without a link when the viewer cannot open it, or it is gone", async () => {
    H.allowed = new Set(["settings:view"]);
    await show();
    expect(screen.queryByRole("link", { name: "Blue mug" })).toBeNull();
    expect(screen.getByText("Blue mug")).toBeTruthy();

    H.allowed = new Set(["settings:view", "products:view"]);
    H.notice = notice({ edit: null });
    await show();
    expect(screen.queryByRole("link", { name: "Blue mug" })).toBeNull();
  });

  it("asks to show it again for the store's own request", async () => {
    H.notice = notice({
      kind: "review",
      reasonKind: "store_request",
      complaintId: null,
      reference: null,
      itemLabel: "Review by Asha",
      edit: null,
      messages: [],
    });
    await show();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Review removed at your request",
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("reply").textContent).toBe(NOTICE_REPLY.showTick);
    expect(screen.queryByText(NOTICE.facts.reference)).toBeNull();
  });

  it("shows the lift and no reply form once lifted", async () => {
    H.notice = notice({
      liftedAt: "2026-10-30T19:00:00.000Z",
      liftNote: "The complaint was withdrawn.",
    });
    await show();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Product unblocked by StoreMink",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "StoreMink lifted this block on 31 Oct 2026. The complaint was withdrawn.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: NOTICE.canDoHeading }),
    ).toBeNull();
    expect(screen.queryByTestId("reply")).toBeNull();
    expect(screen.getByText(NOTICE_REPLY.errors.lifted)).toBeTruthy();
  });

  it("names an image by what it is", async () => {
    H.notice = notice({
      kind: "file",
      contentType: "image/webp",
      itemLabel: "mug.webp",
      images: [],
      edit: { href: "/dashboard/media", section: "media" },
    });
    await show();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Image blocked by StoreMink",
      }),
    ).toBeTruthy();
    for (const paragraph of whatThisMeans("file", "image/webp")) {
      expect(screen.getByText(paragraph)).toBeTruthy();
    }
  });

  it("writes no long dash", async () => {
    const { container } = await show();
    expect(container.textContent).not.toMatch(/[\u2013\u2014]/);
  });
});
