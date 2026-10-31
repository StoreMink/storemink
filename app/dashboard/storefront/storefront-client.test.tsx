// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- stands in for next/image in jsdom
  default: ({ src, alt }: any) => <img src={src} alt={alt} />,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
const startExpandedChat = vi.fn();
const chat = { enabled: true };
vi.mock("@/app/dashboard/chat-context", () => ({
  useChat: () => ({ startExpandedChat, enabled: chat.enabled }),
}));
vi.mock("@/app/actions/theme-actions", () => ({
  switchStoreTheme: vi.fn(async () => ({
    ok: true,
    themeName: "Vitrine",
    plan: {},
    warnings: [],
  })),
}));

import { toast } from "sonner";
import { switchStoreTheme } from "@/app/actions/theme-actions";
import { StorefrontClient, type ThemeCard } from "./storefront-client";
import type { ThemeSwitchFacts } from "@/lib/themes/switch-rules";

function card(id: string, extra: Partial<ThemeCard> = {}): ThemeCard {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    description: `${id} description`,
    previewImage: `/themes/${id}.webp`,
    industries: ["clothing"],
    minPlanName: null,
    locked: false,
    previewSlug: `demo-${id}`,
    previewUnavailableReason: null,
    ...extra,
  };
}

const FRESH: ThemeSwitchFacts = {
  firstTheme: false,
  launched: false,
  homepage: "missing",
  hasBuilderChrome: false,
  brandColorUnset: false,
  hasDesignOverrides: false,
};

/** A new store: signup installed nothing (settings.themePending). */
const PENDING: ThemeSwitchFacts = {
  firstTheme: true,
  launched: false,
  homepage: "missing",
  hasBuilderChrome: false,
  brandColorUnset: true,
  hasDesignOverrides: false,
};

function renderClient(
  props: Partial<Parameters<typeof StorefrontClient>[0]> = {},
) {
  return render(
    <StorefrontClient
      current={card("basket")}
      currentId="basket"
      library={[]}
      categories={[
        { id: "all", label: "All" },
        { id: "clothing", label: "Clothing" },
      ]}
      facts={FRESH}
      canManage
      canCustomise
      canEditBranding
      managedByOperators={false}
      unavailable={false}
      {...props}
    />,
  );
}

describe("Storefront page", () => {
  it("is headed Storefront, with no theme library once a theme is chosen", () => {
    renderClient();
    expect(
      screen.getByRole("heading", { level: 1, name: "Storefront" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "How your store looks to customers. Customise it with Mink AI, or edit any page in the Website Builder.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Your theme" }),
    ).toBeInTheDocument();
    // ★★ A theme is chosen once: no library, no way to pick another.
    expect(
      screen.queryByRole("heading", { level: 2, name: "Theme library" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use this theme" }),
    ).not.toBeInTheDocument();
  });

  it("★ shows the theme in use with Customise storefront, the Website Builder and the store", () => {
    renderClient();
    expect(screen.getByText("Basket")).toBeInTheDocument();
    expect(screen.getByText("In use")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Customise storefront" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Edit in Website Builder" }),
    ).toHaveAttribute("href", "/dashboard/builder");
    expect(
      screen.getByRole("link", { name: /View your store/ }),
    ).toHaveAttribute("href", "/");
  });

  it("Customise storefront is hidden without permission, or while Mink AI is off", () => {
    const { unmount } = renderClient({ canCustomise: false });
    expect(
      screen.queryByRole("button", { name: "Customise storefront" }),
    ).not.toBeInTheDocument();
    // The Website Builder takes the main button instead.
    expect(
      screen.getByRole("link", { name: "Edit in Website Builder" }),
    ).toBeInTheDocument();
    unmount();

    chat.enabled = false;
    try {
      renderClient();
      expect(
        screen.queryByRole("button", { name: "Customise storefront" }),
      ).not.toBeInTheDocument();
    } finally {
      chat.enabled = true;
    }
  });

  it("★ Branding sits on the Storefront page for anyone who may open it", () => {
    const { unmount } = renderClient();
    expect(
      screen.getByRole("heading", { level: 2, name: "Branding" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit branding" })).toHaveAttribute(
      "href",
      "/dashboard/branding",
    );
    unmount();
    renderClient({ canEditBranding: false });
    expect(
      screen.queryByRole("link", { name: "Edit branding" }),
    ).not.toBeInTheDocument();
  });

  // ★ "In use" follows currentId, not the card: a store with no theme on file
  // (not pending, e.g. an older store) has nothing in use to badge.
  it("a store with no theme on file shows no In use badge", () => {
    renderClient({ current: null, currentId: null });
    expect(screen.getByText("No theme")).toBeInTheDocument();
    expect(
      screen.getByText("Your store doesn't use a theme from the library."),
    ).toBeInTheDocument();
    expect(screen.queryByText("In use")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Theme library" }),
    ).not.toBeInTheDocument();
  });

  it("a theme no longer in the library is still badged In use", () => {
    renderClient({ current: null, currentId: "retired" });
    expect(screen.getByText("retired")).toBeInTheDocument();
    expect(screen.getByText("In use")).toBeInTheDocument();
    expect(
      screen.getByText(/no longer in the library. It keeps working/),
    ).toBeInTheDocument();
  });

  describe("a store that has not chosen a theme yet", () => {
    function renderPending(
      props: Partial<Parameters<typeof StorefrontClient>[0]> = {},
    ) {
      return renderClient({
        current: null,
        currentId: null,
        library: [
          card("basket"),
          card("vitrine"),
          card("luxe", { minPlanName: "Pro", locked: true }),
        ],
        facts: PENDING,
        ...props,
      });
    }

    it("★ says no theme is chosen and what shoppers see meanwhile", () => {
      renderPending();
      expect(
        screen.getByText("You haven't chosen a theme yet"),
      ).toBeInTheDocument();
      expect(screen.getByText(/store in progress/)).toBeInTheDocument();
      expect(
        screen.getByText(/You choose it once: after that/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { level: 2, name: "Theme library" }),
      ).toBeInTheDocument();
    });

    it("★ offers nothing that assumes a theme exists", () => {
      renderPending();
      expect(
        screen.queryByRole("button", { name: "Customise storefront" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Edit in Website Builder" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: /View your store/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("In use")).not.toBeInTheDocument();
      expect(screen.queryByText("No theme")).not.toBeInTheDocument();
    });

    it("keeps the whole library, plan locks included", () => {
      renderPending();
      expect(screen.getByText("Basket")).toBeInTheDocument();
      expect(screen.getByText("Vitrine")).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "Upgrade to Pro" }),
      ).toHaveAttribute("href", "/dashboard/plans");
      expect(
        screen.getAllByRole("button", { name: "Use this theme" }),
      ).toHaveLength(2);
      expect(
        screen.getByText(
          "Preview any theme on its demo store before you choose.",
        ),
      ).toBeInTheDocument();
    });

    it("view-only staff are told someone else chooses, and get no button", () => {
      renderPending({ canManage: false });
      expect(
        screen.getByText(/Someone who manages your storefront can choose one/),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Use this theme" }),
      ).not.toBeInTheDocument();
    });

    it("★ the dialog describes a first install, from the server's own rules", async () => {
      renderPending({ library: [card("vitrine")] });
      fireEvent.click(screen.getByRole("button", { name: "Use this theme" }));
      expect(
        await screen.findByRole("heading", { name: "Use Vitrine?" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Your storefront gets Vitrine's colours, fonts and layout, and stops showing the store-in-progress page.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Vitrine's starting pages are added where your store doesn't have a page yet. Pages you've already written, like your policies, are not changed.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "No sample products or categories are added, so your dashboard shows only what you add.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "You can't switch to another theme later, but you can change how your store looks any time with Customise storefront and the Website Builder.",
        ),
      ).toBeInTheDocument();
      // Not the switch wording.
      expect(
        screen.queryByText(
          "Your storefront's colours, fonts and layout change to Vitrine.",
        ),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Switch theme" }),
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Use Vitrine" }));
      await waitFor(() =>
        expect(switchStoreTheme).toHaveBeenCalledWith("vitrine", {
          replaceEditedHomepage: false,
        }),
      );
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "Your store now uses Vitrine.",
        ),
      );
      expect(refresh).toHaveBeenCalled();
    });

    it("a refused install keeps the dialog open with the reason", async () => {
      vi.mocked(switchStoreTheme).mockImplementation(async () => ({
        ok: false,
        error: "Vitrine needs the Pro plan or above.",
      }));
      renderPending({ library: [card("vitrine")] });
      fireEvent.click(screen.getByRole("button", { name: "Use this theme" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Use Vitrine" }),
      );
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Vitrine needs the Pro plan or above.",
        ),
      );
      expect(
        screen.getByRole("button", { name: "Use Vitrine" }),
      ).toBeInTheDocument();
    });

    it("★ the confirm dialog says no samples are added", async () => {
      renderPending({ library: [card("vitrine")], facts: PENDING });
      fireEvent.click(screen.getByRole("button", { name: "Use this theme" }));
      expect(
        await screen.findByText(
          "No sample products or categories are added, so your dashboard shows only what you add.",
        ),
      ).toBeInTheDocument();
    });

    it("★ a homepage the owner already built is kept unless the box is ticked", async () => {
      renderPending({
        library: [card("vitrine")],
        facts: { ...PENDING, homepage: "edited" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Use this theme" }));
      expect(
        await screen.findByText(
          "Your homepage keeps its sections and their new look. Redesign it any time in the Website Builder.",
        ),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: "Use Vitrine" }));
      await waitFor(() =>
        expect(switchStoreTheme).toHaveBeenCalledWith("vitrine", {
          replaceEditedHomepage: true,
        }),
      );
    });
  });

  it("an unreadable store shows the warning and no theme card", () => {
    renderClient({
      current: null,
      currentId: null,
      facts: null,
      canManage: false,
      unavailable: true,
    });
    expect(
      screen.getByText(/We couldn't read your store's theme just now/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Your theme" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Edit in Website Builder" }),
    ).not.toBeInTheDocument();
  });
});
