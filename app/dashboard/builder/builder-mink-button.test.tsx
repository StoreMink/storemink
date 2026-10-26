// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuilderClient } from "./builder-client";
import { useChat } from "../chat-context";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import { themeDesignDefaults } from "@/lib/chrome/design";
import { schemeDesignFor } from "@/lib/themes/schemes";

/**
 * ★★ The builder's full-screen canvas covers the dashboard topbar while the
 * builder is mounted (dashboard.css, builder-stacking.test.ts), so it covers
 * the topbar's Mink AI button too: before the builder's own top bar had one,
 * Mink AI could not be opened inside the Website Builder at any width (an
 * offline headless Chrome check with the real stylesheets found the builder's
 * top bar at the topbar button's centre at 1440, 1024 and 390 px). The
 * builder's top bar therefore carries the same toggle, whether or not a page
 * is open.
 */

const chat = vi.hoisted(() => ({
  isChatOpen: false,
  toggleChat: vi.fn(),
}));
vi.mock("../chat-context", () => ({
  useChat: vi.fn(() => chat),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("@/app/actions/page-actions", () => ({
  getPageDraft: vi.fn(async () => ({
    id: "home",
    slug: "",
    title: "Home",
    status: "draft",
    updated_at: "2026-10-26",
    sections: [],
  })),
  createPage: vi.fn(),
  deletePage: vi.fn(),
  publishPage: vi.fn(),
  unpublishPage: vi.fn(),
  updatePageMeta: vi.fn(),
}));
vi.mock("@/app/actions/chrome-actions", () => ({
  saveChromeDraft: vi.fn(),
  publishChrome: vi.fn(),
}));
vi.mock("@/app/actions/store-branding", () => ({
  saveBrandAppearance: vi.fn(),
}));
vi.mock("./use-autosave", () => ({
  useAutosave: () => ({
    status: "saved",
    markDirty: vi.fn(),
    flush: vi.fn(),
    unblock: vi.fn(),
  }),
}));
vi.mock("./outline-panel", () => ({ OutlinePanel: () => null }));
vi.mock("./inspector-panel", () => ({
  InspectorPanel: () => null,
  PageSettingsForm: () => null,
}));
vi.mock("./section-library", () => ({ SectionLibrary: () => null }));

const props = {
  products: [],
  categories: [],
  blogs: [],
  storeName: "Test store",
  initialChrome: DEFAULT_CHROME,
  initialBrand: { name: "Test store", primaryColor: "#4f46e5", logoUrl: null },
  themeDefaults: themeDesignDefaults(null),
  schemeDesign: schemeDesignFor(null),
};
const HOME = {
  id: "home",
  slug: "",
  title: "Home",
  status: "draft" as const,
  updated_at: "2026-10-26",
  published_at: null,
};

function builderTopBar(container: HTMLElement): HTMLElement {
  const bar = container.querySelector<HTMLElement>("header.sm-builder-topbar");
  if (!bar) throw new Error("The builder's top bar is missing");
  return bar;
}

beforeEach(() => {
  localStorage.clear();
  chat.isChatOpen = false;
  chat.toggleChat.mockReset();
  vi.mocked(useChat).mockClear();
});

describe("★★ Website Builder: Mink AI opens from the builder's own top bar", () => {
  it("toggles the shared chat from the top bar once a page is open, beside Publish", async () => {
    const { container } = render(
      <BuilderClient {...props} initialPages={[HOME]} />,
    );
    const bar = builderTopBar(container);
    // The page is open: its Publish button is in the same top bar.
    await within(bar).findByRole("button", { name: "Publish" });
    const mink = within(bar).getByRole("button", { name: "Mink AI" });
    expect(mink).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(mink);
    expect(chat.toggleChat).toHaveBeenCalledTimes(1);
    expect(
      within(bar).getAllByRole("button", { name: "Mink AI" }),
    ).toHaveLength(1);
  });

  it("is there with no page open, and says when the chat is open", () => {
    chat.isChatOpen = true;
    const { container } = render(
      <BuilderClient {...props} initialPages={[]} />,
    );
    const bar = builderTopBar(container);
    expect(within(bar).queryByRole("button", { name: "Publish" })).toBeNull();
    const mink = within(bar).getByRole("button", { name: "Mink AI" });
    expect(mink).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(mink);
    expect(chat.toggleChat).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button", { name: "Mink AI" })).toHaveLength(1);
  });
});
