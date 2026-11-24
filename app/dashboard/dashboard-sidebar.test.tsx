// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardSidebar,
  resolveActiveSection,
  withStoreNoticesBadge,
} from "./dashboard-sidebar";
import {
  UnreadCountsProvider,
  useReportUnreadCounts,
} from "./components/unread-counts-context";

const path = vi.hoisted(() => ({ current: "/dashboard/locations/fulfilment" }));

vi.mock("next/navigation", () => ({
  usePathname: () => path.current,
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  path.current = "/dashboard/locations/fulfilment";
});

// ---------------------------------------------------------------------------
// The sub-nav panel is chosen by this function, so getting it wrong swaps the
// left panel out from under someone mid-journey. That is what happened: every
// section nested via `parent:` (twelve of them) landed on Home.
// ---------------------------------------------------------------------------

// Shaped like the folded nav: nested sections become CHILDREN of their parent
// and are absent from the top level, even though they live at top-level paths.
const NAV = [
  { href: "/dashboard", label: "Home" },
  {
    href: "/dashboard/users",
    label: "Customers",
    children: [
      { href: "/dashboard/users", label: "All customers" },
      { href: "/dashboard/users/user_groups", label: "Groups" },
    ],
  },
  {
    href: "/dashboard/settings",
    label: "Settings",
    children: [
      { href: "/dashboard/settings/account", label: "Account" },
      { href: "/dashboard/settings/domain", label: "Domain" },
      // Top-level PATH, nested POSITION — the case that broke.
      { href: "/dashboard/admins", label: "Staff" },
      { href: "/dashboard/billing", label: "Billing" },
    ],
  },
  {
    href: "/dashboard/locations",
    label: "Locations",
    children: [
      { href: "/dashboard/locations", label: "All locations" },
      {
        href: "/dashboard/locations/fulfilment",
        label: "Online fulfilment & pickup",
      },
    ],
  },
  { href: "/dashboard/orders", label: "Orders" },
];

describe("resolveActiveSection", () => {
  it("★ keeps the Settings panel open on a nested section at a top-level path", () => {
    // The reported bug: Settings → Staff opened the page but reverted the panel
    // to Home's. `/dashboard/admins` shares no prefix with `/dashboard/settings`,
    // so only walking the children can relate them.
    expect(resolveActiveSection(NAV, "/dashboard/admins")?.label).toBe(
      "Settings",
    );
    expect(resolveActiveSection(NAV, "/dashboard/billing")?.label).toBe(
      "Settings",
    );
  });

  it("still resolves a nested section's own sub-paths to the parent", () => {
    expect(resolveActiveSection(NAV, "/dashboard/admins/new")?.label).toBe(
      "Settings",
    );
  });

  it("keeps fulfilment inside the Locations sub-navigation", () => {
    expect(resolveActiveSection(NAV, "/dashboard/locations")?.label).toBe(
      "Locations",
    );
    expect(
      resolveActiveSection(NAV, "/dashboard/locations/fulfilment")?.label,
    ).toBe("Locations");
  });

  it("★ prefers a DIRECT match over a parent that lists the same child", () => {
    // Customers is both a top-level section and lists /dashboard/users as a
    // child. If child-matching ran first, a parent could steal its own panel.
    expect(resolveActiveSection(NAV, "/dashboard/users")?.label).toBe(
      "Customers",
    );
    expect(
      resolveActiveSection(NAV, "/dashboard/users/user_groups")?.label,
    ).toBe("Customers");
  });

  it("resolves ordinary top-level sections unchanged", () => {
    expect(resolveActiveSection(NAV, "/dashboard/orders")?.label).toBe(
      "Orders",
    );
    expect(resolveActiveSection(NAV, "/dashboard/settings")?.label).toBe(
      "Settings",
    );
    expect(resolveActiveSection(NAV, "/dashboard")?.label).toBe("Home");
  });

  it("does not let Home's exact href swallow every other path", () => {
    // `matches` exempts "/dashboard" from prefix matching for this reason: it is
    // a prefix of literally every dashboard route.
    expect(resolveActiveSection(NAV, "/dashboard/orders")?.label).not.toBe(
      "Home",
    );
  });

  it("falls back to Home for an unknown path rather than nothing", () => {
    // A route with no nav entry (a detail page, a deep link) should leave the
    // sidebar in a sane state, not blank it.
    expect(resolveActiveSection(NAV, "/dashboard/nowhere")?.label).toBe("Home");
  });

  it("survives a nav with no Home entry, and an empty nav", () => {
    // A restricted role may not see Home at all; the sidebar must still render.
    const noHome = NAV.filter((i) => i.href !== "/dashboard");
    expect(resolveActiveSection(noHome, "/dashboard/nowhere")?.label).toBe(
      "Customers",
    );
    expect(resolveActiveSection([], "/dashboard")).toBeUndefined();
  });
});

describe("DashboardSidebar child labels", () => {
  it("wraps long destination names instead of hiding them behind an ellipsis", () => {
    render(
      <DashboardSidebar
        groups={[
          {
            group: "Sell in person",
            items: [
              {
                href: "/dashboard/locations",
                label: "Locations",
                icon: "location",
                children: [
                  {
                    href: "/dashboard/locations",
                    label: "All locations",
                    icon: "location",
                  },
                  {
                    href: "/dashboard/locations/fulfilment",
                    label: "Online fulfilment & pickup",
                    icon: "shipping",
                  },
                ],
              },
            ],
          },
        ]}
      />,
    );

    const link = screen.getByRole("link", {
      name: "Online fulfilment & pickup",
    });
    const label = within(link).getByText("Online fulfilment & pickup");
    expect(link).toHaveClass("items-start");
    expect(label).toHaveClass("whitespace-normal", "break-words");
    expect(label).not.toHaveClass("truncate");
  });
});

// ---------------------------------------------------------------------------
// The Notices from StoreMink badge (takedown design 7.1, plan A14): the
// StoreMink count the bell already polls, handed over by the provider. The
// sidebar reads nothing of its own.
// ---------------------------------------------------------------------------

const NOTICES_HREF = "/dashboard/settings/notices";

const SETTINGS_NAV = [
  {
    group: "Workspace",
    items: [{ href: "/dashboard", label: "Home", icon: "dashboard" as const }],
  },
  {
    group: "Settings",
    items: [
      {
        href: "/dashboard/settings",
        label: "Settings",
        icon: "settings" as const,
        children: [
          {
            href: "/dashboard/settings/account",
            label: "Account",
            icon: "settings" as const,
          },
          {
            href: NOTICES_HREF,
            label: "Notices from StoreMink",
            icon: "mail" as const,
          },
        ],
      },
    ],
  },
];

function Report({ storemink }: { storemink: number }) {
  const report = useReportUnreadCounts();
  useEffect(() => {
    report({ total: storemink + 1, storemink });
  }, [report, storemink]);
  return null;
}

describe("withStoreNoticesBadge", () => {
  it("returns the nav untouched when nothing from StoreMink is unread", () => {
    expect(withStoreNoticesBadge(SETTINGS_NAV, 0)).toBe(SETTINGS_NAV);
  });

  it("badges the Notices child and bubbles to Settings, without touching the shared nav", () => {
    const before = JSON.stringify(SETTINGS_NAV);
    const out = withStoreNoticesBadge(SETTINGS_NAV, 2);

    const settings = out[1].items[0];
    expect(settings.badge).toBe("2");
    expect(settings.badgeTone).toBe("amber");
    const notices = settings.children?.find((c) => c.href === NOTICES_HREF);
    expect(notices?.badge).toBe("2");
    expect(notices?.badgeTone).toBe("amber");
    expect(
      settings.children?.find((c) => c.href.endsWith("/account"))?.badge,
    ).toBeUndefined();
    // Unrelated groups keep their identity; the input is never mutated.
    expect(out[0]).toBe(SETTINGS_NAV[0]);
    expect(JSON.stringify(SETTINGS_NAV)).toBe(before);
  });

  it("keeps a parent's own badge and caps the count like the bell", () => {
    const nav = [
      {
        group: "Settings",
        items: [
          {
            ...SETTINGS_NAV[1].items[0],
            badge: "Pro",
            badgeTone: "accent" as const,
          },
        ],
      },
    ];
    const settings = withStoreNoticesBadge(nav, 120)[0].items[0];
    expect(settings.badge).toBe("Pro");
    expect(settings.badgeTone).toBe("accent");
    expect(settings.children?.find((c) => c.href === NOTICES_HREF)?.badge).toBe(
      "99+",
    );
  });

  it("does nothing for a nav without the Notices page (a role without Settings)", () => {
    const nav = [SETTINGS_NAV[0]];
    expect(withStoreNoticesBadge(nav, 3)).toEqual(nav);
  });
});

describe("DashboardSidebar Notices badge", () => {
  it("shows no badge without a provider (the operator console)", () => {
    path.current = "/dashboard/settings";
    render(<DashboardSidebar groups={SETTINGS_NAV} />);
    const link = screen.getByRole("link", { name: /Notices from StoreMink/ });
    expect(link).toHaveTextContent(/^Notices from StoreMink$/);
  });

  it("shows the StoreMink count on Settings in the root nav", () => {
    path.current = "/dashboard";
    render(
      <UnreadCountsProvider>
        <Report storemink={2} />
        <DashboardSidebar groups={SETTINGS_NAV} />
      </UnreadCountsProvider>,
    );
    const link = screen.getByRole("link", { name: /Settings/ });
    expect(within(link).getByText("2")).toHaveClass("dash-nav-badge", "amber");
  });

  it("shows it on the Notices child inside Settings, and drops it once read", () => {
    path.current = "/dashboard/settings";
    const { rerender } = render(
      <UnreadCountsProvider>
        <Report storemink={1} />
        <DashboardSidebar groups={SETTINGS_NAV} />
      </UnreadCountsProvider>,
    );
    const link = screen.getByRole("link", { name: /Notices from StoreMink/ });
    expect(within(link).getByText("1")).toHaveClass("dash-nav-badge", "amber");

    act(() => {
      rerender(
        <UnreadCountsProvider>
          <Report storemink={0} />
          <DashboardSidebar groups={SETTINGS_NAV} />
        </UnreadCountsProvider>,
      );
    });
    expect(
      screen.getByRole("link", { name: /Notices from StoreMink/ }),
    ).toHaveTextContent(/^Notices from StoreMink$/);
  });
});

// ---------------------------------------------------------------------------
// Settings pages carry their own settings menu (settings-frame.tsx), so the
// merchant sidebar shows the main nav there, with the owning item highlighted.
// The operator console never passes `settingsFrame`, and keeps its panels.
// ---------------------------------------------------------------------------

const FRAME_NAV = [
  {
    group: "Online store",
    items: [
      {
        href: "/dashboard/storefront",
        label: "Storefront",
        icon: "themes" as const,
        children: [
          {
            href: "/dashboard/branding",
            label: "Branding",
            icon: "colors" as const,
          },
        ],
      },
    ],
  },
  {
    group: "Settings",
    items: [
      {
        href: "/dashboard/settings",
        label: "Settings",
        icon: "settings" as const,
        children: [
          {
            href: "/dashboard/settings/account",
            label: "Account",
            icon: "settings" as const,
          },
          { href: "/dashboard/admins", label: "Staff", icon: "users" as const },
        ],
      },
    ],
  },
];

describe("DashboardSidebar on a settings page", () => {
  it("shows the main nav, not a Settings panel, and highlights Settings", () => {
    path.current = "/dashboard/admins";
    render(<DashboardSidebar groups={FRAME_NAV} settingsFrame />);

    expect(screen.queryByRole("link", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Staff" })).toBeNull();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveClass(
      "active",
    );
    expect(screen.getByRole("link", { name: "Storefront" })).not.toHaveClass(
      "active",
    );
  });

  it("highlights Storefront while Branding is open", () => {
    path.current = "/dashboard/branding";
    render(<DashboardSidebar groups={FRAME_NAV} settingsFrame />);

    expect(screen.getByRole("link", { name: "Storefront" })).toHaveClass(
      "active",
    );
    expect(screen.getByRole("link", { name: "Settings" })).not.toHaveClass(
      "active",
    );
  });

  it("★ highlights Branding itself for a role with Branding but not Storefront", () => {
    // foldNestedSections leaves an orphan top-level when its parent was
    // filtered out, so this role sees Branding as its own item. Forcing the
    // Storefront href (not in this nav) would leave nothing highlighted.
    path.current = "/dashboard/branding";
    render(
      <DashboardSidebar
        groups={[
          {
            group: "Online store",
            items: [
              {
                href: "/dashboard/branding",
                label: "Branding",
                icon: "colors",
              },
            ],
          },
          {
            group: "Settings",
            items: [
              {
                href: "/dashboard/settings",
                label: "Settings",
                icon: "settings",
              },
            ],
          },
        ]}
        settingsFrame
      />,
    );

    expect(screen.getByRole("link", { name: "Branding" })).toHaveClass(
      "active",
    );
    expect(screen.getByRole("link", { name: "Settings" })).not.toHaveClass(
      "active",
    );
  });

  it("★ highlights Staff itself for a role with Staff but not Settings", () => {
    path.current = "/dashboard/admins";
    render(
      <DashboardSidebar
        groups={[
          {
            group: "Settings",
            items: [
              { href: "/dashboard/admins", label: "Staff", icon: "users" },
            ],
          },
        ]}
        settingsFrame
      />,
    );

    expect(screen.getByRole("link", { name: "Staff" })).toHaveClass("active");
  });

  it("★ highlights nothing, not Home, for a role without Settings on Account Settings", () => {
    path.current = "/dashboard/settings/account";
    render(
      <DashboardSidebar
        groups={[
          {
            group: "Workspace",
            items: [{ href: "/dashboard", label: "Home", icon: "home" }],
          },
          {
            group: "Online store",
            items: [
              {
                href: "/dashboard/storefront",
                label: "Storefront",
                icon: "themes",
              },
            ],
          },
        ]}
        settingsFrame
      />,
    );

    expect(screen.getByRole("link", { name: "Home" })).not.toHaveClass(
      "active",
    );
    expect(screen.getByRole("link", { name: "Storefront" })).not.toHaveClass(
      "active",
    );
  });

  it("opens General from the sidebar's Settings item, and keeps it lit on the home", () => {
    path.current = "/dashboard/settings";
    render(<DashboardSidebar groups={FRAME_NAV} settingsFrame />);

    const settings = screen.getByRole("link", { name: "Settings" });
    expect(settings).toHaveAttribute("href", "/dashboard/settings/general");
    expect(settings).toHaveClass("active");
  });

  it("keeps the Settings item's own address where the frame is not used", () => {
    path.current = "/dashboard";
    render(
      <DashboardSidebar
        groups={[
          {
            group: "Workspace",
            items: [{ href: "/dashboard", label: "Home", icon: "home" }],
          },
          ...FRAME_NAV,
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/dashboard/settings",
    );
  });

  it("★ keeps the Settings panel on a printable invoice, which has no frame", () => {
    path.current = "/dashboard/plans/invoices/abc";
    render(
      <DashboardSidebar
        groups={[
          {
            group: "Settings",
            items: [
              {
                href: "/dashboard/settings",
                label: "Settings",
                icon: "settings",
                children: [
                  {
                    href: "/dashboard/plans",
                    label: "Plans & Billing",
                    icon: "ai",
                  },
                ],
              },
            ],
          },
        ]}
        settingsFrame
      />,
    );

    expect(screen.getByRole("link", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Plans & Billing" })).toHaveClass(
      "bg-white",
    );
  });

  it("highlights Storefront on Website settings, below the Builder's address", () => {
    path.current = "/dashboard/builder/settings";
    render(
      <DashboardSidebar
        groups={[
          ...FRAME_NAV,
          {
            group: "Website",
            items: [
              {
                href: "/dashboard/builder",
                label: "Website Builder",
                icon: "homepage",
              },
            ],
          },
        ]}
        settingsFrame
      />,
    );

    expect(screen.getByRole("link", { name: "Storefront" })).toHaveClass(
      "active",
    );
    expect(
      screen.getByRole("link", { name: "Website Builder" }),
    ).not.toHaveClass("active");
  });

  it("keeps the Settings panel where the frame is not used (the operator console)", () => {
    path.current = "/dashboard/admins";
    render(<DashboardSidebar groups={FRAME_NAV} />);

    expect(screen.getByRole("link", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Staff" })).toBeInTheDocument();
  });

  it("leaves other sections' panels alone", () => {
    path.current = "/dashboard/locations/fulfilment";
    render(
      <DashboardSidebar
        groups={[
          {
            group: "Sell in person",
            items: [
              {
                href: "/dashboard/locations",
                label: "Locations",
                icon: "location",
                children: [
                  {
                    href: "/dashboard/locations/fulfilment",
                    label: "Online fulfilment & pickup",
                    icon: "shipping",
                  },
                ],
              },
            ],
          },
        ]}
        settingsFrame
      />,
    );
    expect(screen.getByRole("link", { name: "Back" })).toBeInTheDocument();
  });
});
