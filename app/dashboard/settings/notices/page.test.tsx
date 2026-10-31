// @vitest-environment jsdom
// Settings, Notices from StoreMink (takedown stage T18a, design 7.1): the
// list of what StoreMink blocked on this store. The reads are mocks; the
// boundary that hides a block kept from the store lives in
// lib/moderation/merchant.ts and is tested there.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { StoreNoticeRow } from "@/lib/moderation/merchant";

const H = vi.hoisted(() => ({ notices: [] as unknown[] }));

vi.mock("@/app/dashboard/lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({ can: () => true })),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/moderation/merchant", () => ({
  listStoreNotices: vi.fn(async () => H.notices),
}));

import StoreNoticesPage, { metadata } from "./page";
import { requireSectionAccess } from "@/app/dashboard/lib/access";
import { listStoreNotices } from "@/lib/moderation/merchant";
import { NOTICES } from "@/lib/moderation/copy";

const BLOCK = "22222222-2222-4222-8222-222222222222";
const IMAGE = "33333333-3333-4333-8333-333333333333";
const LIFTED = "77777777-7777-4777-8777-777777777777";

function row(over: Partial<StoreNoticeRow> = {}): StoreNoticeRow {
  return {
    blockId: BLOCK,
    kind: "product",
    contentType: null,
    itemLabel: "Blue mug",
    reasonKind: "court_order",
    blockedAt: "2026-10-29T20:00:00.000Z",
    liftedAt: null,
    seen: false,
    images: [],
    ...over,
  };
}

beforeEach(() => {
  H.notices = [];
});

describe("Notices from StoreMink", () => {
  it("needs Settings view and reads the host's store", async () => {
    render(await StoreNoticesPage());
    expect(requireSectionAccess).toHaveBeenCalledWith("settings", "view");
    expect(listStoreNotices).toHaveBeenCalledWith("store-1");
    expect(metadata.title).toBe(NOTICES.title);
  });

  it("says so when nothing was ever blocked", async () => {
    render(await StoreNoticesPage());
    expect(
      screen.getByRole("heading", { level: 1, name: NOTICES.title }),
    ).toBeTruthy();
    expect(screen.getByText(NOTICES.intro)).toBeTruthy();
    expect(screen.getByText(NOTICES.empty)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("lists each notice with its date in India time, reason and state", async () => {
    H.notices = [
      row({
        images: [{ blockId: IMAGE, label: "mug.webp", lifted: false }],
      }),
      row({
        blockId: LIFTED,
        itemLabel: "report.pdf",
        kind: "file",
        reasonKind: "store_request",
        liftedAt: "2026-10-29T09:00:00.000Z",
      }),
    ];
    render(await StoreNoticesPage());
    const headers = screen
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual([
      NOTICES.columns.item,
      NOTICES.columns.blockedOn,
      NOTICES.columns.why,
      NOTICES.columns.state,
    ]);

    const mug = screen.getByRole("link", { name: "Blue mug" });
    expect(mug.getAttribute("href")).toBe(
      `/dashboard/settings/notices/${BLOCK}`,
    );
    const image = screen.getByRole("link", { name: "mug.webp" });
    expect(image.getAttribute("href")).toBe(
      `/dashboard/settings/notices/${IMAGE}`,
    );

    const first = mug.closest("tr");
    if (!first) throw new Error("no row");
    // 20:00 UTC on 29 Oct is 30 Oct in India.
    expect(within(first).getByText("30 Oct 2026")).toBeTruthy();
    expect(within(first).getByText("Court order")).toBeTruthy();
    expect(within(first).getByText(NOTICES.states.blocked)).toBeTruthy();

    const second = screen
      .getByRole("link", { name: "report.pdf" })
      .closest("tr");
    if (!second) throw new Error("no row");
    expect(within(second).getByText("You asked us to remove it")).toBeTruthy();
    expect(within(second).getByText(NOTICES.states.lifted)).toBeTruthy();
  });

  it("writes no long dash", async () => {
    H.notices = [row()];
    const { container } = render(await StoreNoticesPage());
    expect(container.textContent).not.toMatch(/[\u2013\u2014]/);
  });
});
