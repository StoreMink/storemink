// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeNoticeSummary } from "@/lib/moderation/merchant";
import {
  StoreNoticeBanner,
  StoreNoticeBannerView,
  storeNoticeHref,
} from "./store-notice-banner";

vi.mock("@/lib/moderation/merchant", () => ({
  storeNoticeSummary: vi.fn(),
}));

const STORE = "6b1c2d3e-4f50-4a61-8b72-9c83d4e5f601";
const BLOCK = "0d2c8a4e-7a77-4d1c-9f61-3f0f1b5a6c01";

async function renderBanner() {
  const element = await StoreNoticeBanner({ storeId: STORE });
  return render(<>{element}</>);
}

describe("storeNoticeHref", () => {
  it("opens the one notice, or the list when there are several", () => {
    expect(storeNoticeHref({ unopened: 1, onlyBlockId: BLOCK })).toBe(
      `/dashboard/settings/notices/${BLOCK}`,
    );
    expect(storeNoticeHref({ unopened: 3, onlyBlockId: null })).toBe(
      "/dashboard/settings/notices",
    );
    // An id is only trusted for exactly one unopened notice.
    expect(storeNoticeHref({ unopened: 2, onlyBlockId: BLOCK })).toBe(
      "/dashboard/settings/notices",
    );
    expect(storeNoticeHref({ unopened: 1, onlyBlockId: null })).toBe(
      "/dashboard/settings/notices",
    );
  });
});

describe("StoreNoticeBanner", () => {
  beforeEach(() => {
    vi.mocked(storeNoticeSummary).mockResolvedValue({
      unopened: 0,
      onlyBlockId: null,
    });
  });

  it("says 1 item and links See why to that notice", async () => {
    vi.mocked(storeNoticeSummary).mockResolvedValue({
      unopened: 1,
      onlyBlockId: BLOCK,
    });

    await renderBanner();

    expect(storeNoticeSummary).toHaveBeenCalledWith(STORE);
    const region = screen.getByRole("region", {
      name: "StoreMink has blocked 1 item on your store.",
    });
    const link = within(region).getByRole("link", { name: "See why" });
    expect(link).toHaveAttribute(
      "href",
      `/dashboard/settings/notices/${BLOCK}`,
    );
    expect(link).toHaveAccessibleDescription(
      "StoreMink has blocked 1 item on your store.",
    );
  });

  it("says N items and links See why to the list", async () => {
    vi.mocked(storeNoticeSummary).mockResolvedValue({
      unopened: 3,
      onlyBlockId: null,
    });

    await renderBanner();

    expect(
      screen.getByText("StoreMink has blocked 3 items on your store."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See why" })).toHaveAttribute(
      "href",
      "/dashboard/settings/notices",
    );
  });

  it("shows nothing when every notice has been opened, or none was told (D21)", async () => {
    const { container } = await renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing, never an error, when the read throws", async () => {
    vi.mocked(storeNoticeSummary).mockRejectedValue(new Error("db down"));
    const { container } = await renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it("has no long dash and a finger-sized See why on touch screens", () => {
    render(
      <StoreNoticeBannerView summary={{ unopened: 2, onlyBlockId: null }} />,
    );
    const region = screen.getByRole("region");
    const longDashes = String.fromCharCode(0x2013, 0x2014);
    expect(
      [...(region.textContent ?? "")].some((ch) => longDashes.includes(ch)),
    ).toBe(false);
    expect(screen.getByRole("link", { name: "See why" })).toHaveClass(
      "dash-btn",
      "pointer-coarse:min-h-11",
    );
  });
});
