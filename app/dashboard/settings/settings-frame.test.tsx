// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getViewerAccess } from "@/app/dashboard/lib/access";
import {
  UnreadCountsProvider,
  useReportUnreadCounts,
} from "../components/unread-counts-context";
import { SettingsFrame, type SettingsRailGroup } from "./settings-frame";
import { SettingsShell } from "./settings-shell";

const path = vi.hoisted(() => ({ current: "/dashboard/settings" }));

vi.mock("next/navigation", () => ({
  usePathname: () => path.current,
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerAccess: vi.fn(),
}));

const GROUPS: SettingsRailGroup[] = [
  {
    label: "Store",
    items: [
      {
        key: "general",
        label: "General",
        href: "/dashboard/settings/general",
        icon: "settings",
        newTab: false,
        viewOnly: false,
        keywords: ["time zone"],
      },
      {
        key: "domain",
        label: "Domain",
        href: "/dashboard/settings/domain",
        icon: "globe",
        newTab: false,
        viewOnly: true,
        keywords: ["dns"],
      },
    ],
  },
  {
    label: "Online store",
    items: [
      {
        key: "builder",
        label: "Website Builder",
        href: "/dashboard/builder",
        icon: "homepage",
        newTab: true,
        viewOnly: false,
        keywords: [],
      },
    ],
  },
  {
    label: "Messages",
    items: [
      {
        key: "notices",
        label: "Notices from StoreMink",
        href: "/dashboard/settings/notices",
        icon: "mail",
        newTab: false,
        viewOnly: false,
        keywords: [],
      },
    ],
  },
];

beforeEach(() => {
  path.current = "/dashboard/settings";
});

describe("SettingsFrame", () => {
  it("lists the groups and marks the open page", () => {
    path.current = "/dashboard/settings/domain";
    render(
      <SettingsFrame groups={GROUPS}>
        <p>Page</p>
      </SettingsFrame>,
    );

    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).getByText("Store")).toBeInTheDocument();
    const domain = within(nav).getByRole("link", { name: /Domain/ });
    expect(domain).toHaveAttribute("aria-current", "page");
    expect(domain).toHaveTextContent("View only");
    expect(
      within(nav).getByRole("link", { name: /General/ }),
    ).not.toHaveAttribute("aria-current");
    expect(screen.getByText("Page")).toBeInTheDocument();
  });

  it("marks General as open on the Settings home, and says which view it is", () => {
    const { container } = render(
      <SettingsFrame groups={GROUPS}>
        <p>Page</p>
      </SettingsFrame>,
    );
    expect(screen.getByRole("link", { name: /General/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(container.querySelector(".sm-settings")).toHaveAttribute(
      "data-home",
      "true",
    );
  });

  it("opens the Website Builder in a new tab and says so", () => {
    render(
      <SettingsFrame groups={GROUPS}>
        <p>Page</p>
      </SettingsFrame>,
    );
    const link = screen.getByRole("link", { name: /Website Builder/ });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveTextContent("(opens in a new tab)");
  });

  it("filters by label or keyword, and says when nothing matches", () => {
    render(
      <SettingsFrame groups={GROUPS}>
        <p>Page</p>
      </SettingsFrame>,
    );
    const search = screen.getByRole("searchbox", { name: "Search settings" });

    fireEvent.change(search, { target: { value: "dns" } });
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
    expect(within(nav).getByRole("link", { name: /Domain/ })).toBeVisible();

    fireEvent.change(search, { target: { value: "nothing here" } });
    expect(screen.getByText("No settings match.")).toBeInTheDocument();

    fireEvent.keyDown(search, { key: "Escape" });
    expect(within(nav).getAllByRole("link")).toHaveLength(4);
  });

  it("shows the unread notices from StoreMink on their item", () => {
    function Report() {
      const report = useReportUnreadCounts();
      useEffect(() => report({ total: 3, storemink: 2 }), [report]);
      return null;
    }
    render(
      <UnreadCountsProvider>
        <Report />
        <SettingsFrame groups={GROUPS}>
          <p>Page</p>
        </SettingsFrame>
      </UnreadCountsProvider>,
    );
    const link = screen.getByRole("link", { name: /Notices from StoreMink/ });
    expect(within(link).getByText("2")).toHaveClass("sm-settings-badge");
  });
});

describe("SettingsShell", () => {
  function access(allowed: Record<string, ("view" | "manage")[]>) {
    return {
      can: (section: string, action: "view" | "manage") =>
        allowed[section]?.includes(action) ?? false,
    } as never;
  }

  async function renderShell() {
    const shell = await SettingsShell({ children: <p>Page</p> });
    return render(<>{shell}</>);
  }

  it("lists only the pages the viewer can open", async () => {
    vi.mocked(getViewerAccess).mockResolvedValue(
      access({ settings: ["view", "manage"], branding: ["view"] }),
    );
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "Settings" });

    expect(within(nav).getByRole("link", { name: /General/ })).toBeVisible();
    expect(within(nav).getByRole("link", { name: /Account/ })).toBeVisible();
    expect(
      within(nav).getByRole("link", { name: /Branding/ }),
    ).toHaveTextContent("View only");
    expect(within(nav).queryByRole("link", { name: /Staff/ })).toBeNull();
    expect(within(nav).queryByRole("link", { name: /Storefront/ })).toBeNull();
    expect(within(nav).queryByText("People")).toBeNull();
  });

  it("does not mark a page with nothing to change as view only (Roles)", async () => {
    vi.mocked(getViewerAccess).mockResolvedValue(access({ roles: ["view"] }));
    await renderShell();
    expect(
      screen.getByRole("link", { name: /Roles & permissions/ }),
    ).not.toHaveTextContent("View only");
  });

  it("still lists Account for someone with no Settings permission", async () => {
    vi.mocked(getViewerAccess).mockResolvedValue(access({}));
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
    expect(within(nav).getByRole("link", { name: /Account/ })).toBeVisible();
  });

  it("renders only the page without a profile", async () => {
    vi.mocked(getViewerAccess).mockResolvedValue(null);
    await renderShell();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByText("Page")).toBeInTheDocument();
  });
});
