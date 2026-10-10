// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/image", () => ({
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
import { ThemesClient, type ThemeCard } from "./themes-client";
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
  launched: false,
  homepage: "seeded",
  catalogueIsSampleOnly: true,
  hasBuilderChrome: false,
  brandColorIsTheme: true,
  hasDesignOverrides: false,
};

function renderClient(props: Partial<Parameters<typeof ThemesClient>[0]> = {}) {
  return render(
    <ThemesClient
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

describe("Themes page", () => {
  it("shows the current theme and the library", () => {
    renderClient();
    expect(screen.getByText("Basket")).toBeInTheDocument();
    expect(screen.getByText("Vitrine")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Customize" })).toHaveAttribute(
      "href",
      "/dashboard/builder",
    );
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
});
