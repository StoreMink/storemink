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
  homepage: "seeded",
  catalogueIsSampleOnly: true,
  catalogueIsEmpty: false,
  hasBuilderChrome: false,
  brandColorIsTheme: true,
  hasDesignOverrides: false,
};

/** A new store: signup installed nothing (settings.themePending). */
const PENDING: ThemeSwitchFacts = {
  firstTheme: true,
  launched: false,
  homepage: "missing",
  catalogueIsSampleOnly: false,
  catalogueIsEmpty: true,
  hasBuilderChrome: false,
  brandColorIsTheme: true,
  hasDesignOverrides: false,
};

function renderClient(
  props: Partial<Parameters<typeof StorefrontClient>[0]> = {},
) {
  return render(
    <StorefrontClient
      current={card("basket")}
      currentId="basket"
      library={[
        card("vitrine"),
        card("luxe", { minPlanName: "Pro", locked: true }),
      ]}
      categories={[
        { id: "all", label: "All" },
        { id: "clothing", label: "Clothing" },
      ]}
      facts={FRESH}
      canManage
      managedByOperators={false}
      unavailable={false}
      {...props}
    />,
  );
}

describe("Storefront page", () => {
  it("is headed Storefront, not Themes", () => {
    renderClient();
    expect(
      screen.getByRole("heading", { level: 1, name: "Storefront" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Choose how your store looks to customers. Your products, pages and settings stay yours when you change themes.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Your theme" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Theme library" }),
    ).toBeInTheDocument();
  });

  it("shows the current theme and the library", () => {
    renderClient();
    expect(screen.getByText("Basket")).toBeInTheDocument();
    expect(screen.getByText("In use")).toBeInTheDocument();
    expect(screen.getByText("Vitrine")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Customize" })).toHaveAttribute(
      "href",
      "/dashboard/builder",
    );
  });

  // ★ "In use" follows currentId, not the card: a store with no theme on file
  // (not pending, e.g. an older store) has nothing in use to badge.
  it("a store with no theme on file shows no In use badge", () => {
    renderClient({ current: null, currentId: null });
    expect(screen.getByText("No theme")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your store doesn't use a theme from the library. Choose one below to change how it looks.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("In use")).not.toBeInTheDocument();
  });

  it("a theme no longer in the library is still badged In use", () => {
    renderClient({ current: null, currentId: "retired" });
    expect(screen.getByText("retired")).toBeInTheDocument();
    expect(screen.getByText("In use")).toBeInTheDocument();
    expect(
      screen.getByText(/no longer in the library. It keeps working/),
    ).toBeInTheDocument();
  });

  it("a theme above the store's plan offers an upgrade, not a switch", () => {
    renderClient();
    expect(
      screen.getByRole("link", { name: "Upgrade to Pro" }),
    ).toHaveAttribute("href", "/dashboard/plans");
    expect(
      screen.getAllByRole("button", { name: "Use this theme" }),
    ).toHaveLength(1);
  });

  it("view-only staff can preview but not switch", () => {
    renderClient({ canManage: false });
    expect(
      screen.queryByRole("button", { name: "Use this theme" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Preview/ }).length).toBe(2);
  });

  it("★ the confirm dialog says what the switch will do, from the server's own rules", async () => {
    renderClient();
    fireEvent.click(screen.getByRole("button", { name: "Use this theme" }));
    expect(
      await screen.findByText(
        "Your storefront's colours, fonts and layout change to Vitrine.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The sample products and categories change to Vitrine's examples. The products stay drafts.",
      ),
    ).toBeInTheDocument();
    // A seeded homepage needs no opt-in.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("★ an edited homepage is kept unless the box is ticked, and the dialog says which", async () => {
    renderClient({ facts: { ...FRESH, homepage: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this theme" }));
    expect(
      await screen.findByText(
        "Your homepage keeps its sections and their new look. Redesign it any time in the Website Builder.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(
      screen.getByText(
        'Your edited homepage is saved as a draft page called "Homepage before Vitrine", then replaced with Vitrine\'s.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch theme" }));
    await waitFor(() =>
      expect(switchStoreTheme).toHaveBeenCalledWith("vitrine", {
        replaceEditedHomepage: true,
        expectFirstTheme: false,
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Your store now uses Vitrine.",
      ),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("a refused switch keeps the dialog open with the reason", async () => {
    vi.mocked(switchStoreTheme).mockImplementation(async () => ({
      ok: false,
      error: "Vitrine needs the Pro plan or above.",
    }));
    renderClient();
    fireEvent.click(screen.getByRole("button", { name: "Use this theme" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch theme" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Vitrine needs the Pro plan or above.",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Switch theme" }),
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
        screen.getByText(/You can switch to another any time/),
      ).toBeInTheDocument();
    });

    it("★ offers nothing that assumes a theme exists", () => {
      renderPending();
      expect(
        screen.queryByRole("link", { name: "Customize" }),
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
          "Vitrine's sample products and categories are added as examples. The products are drafts, so customers don't see them.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText("You can switch to another theme any time."),
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
          expectFirstTheme: true,
        }),
      );
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "Your store now uses Vitrine.",
        ),
      );
      expect(refresh).toHaveBeenCalled();
    });

    it("a store with products of its own is told no samples are added", async () => {
      renderPending({
        library: [card("vitrine")],
        facts: { ...PENDING, catalogueIsEmpty: false },
      });
      fireEvent.click(screen.getByRole("button", { name: "Use this theme" }));
      expect(
        await screen.findByText(
          "Your products and categories are not changed, and no samples are added.",
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
          expectFirstTheme: true,
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
      screen.queryByRole("link", { name: "Customize" }),
    ).not.toBeInTheDocument();
  });
});
