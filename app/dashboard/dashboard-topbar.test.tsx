// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/dashboard",
}));

const chat = vi.hoisted(() => ({
  isChatOpen: false,
  toggleChat: vi.fn(),
  // False renders the top bar as the platform console does: no ChatProvider.
  mounted: true,
}));

vi.mock("./chat-context", () => ({
  useChat: () => chat,
  useHasChat: () => chat.mounted,
}));

// The pop-out bar has its own suite (mink-dock.test.tsx).
vi.mock("./mink-dock", () => ({
  MinkDock: () => <div data-testid="mink-dock" />,
}));

// Keep these tests about search; the real children have their own data and
// authentication concerns that are unrelated to navigating the command list.
vi.mock("./components/notification-bell", () => ({
  NotificationBell: () => <button type="button">Notifications</button>,
}));

vi.mock("./topbar-profile", () => ({
  formatRole: (role: string) => role,
  TopbarProfile: () => <div>Profile</div>,
}));

vi.mock("./location-tag", () => ({
  LocationTag: () => null,
}));

import { DashboardTopbar, type DashboardSearchGroup } from "./dashboard-topbar";
import { SECTIONS } from "./lib/permissions";

const SEARCH_GROUPS: DashboardSearchGroup[] = [
  {
    group: "Workspace",
    items: [
      { label: "Orders", href: "/dashboard/orders" },
      {
        label: "Products",
        href: "/dashboard/products",
        children: [{ label: "Inventory", href: "/dashboard/inventory" }],
      },
      {
        label: "Customers",
        href: "/dashboard/users",
        children: [{ label: "All customers", href: "/dashboard/users" }],
      },
    ],
  },
  {
    group: "Settings",
    items: [{ label: "Settings", href: "/dashboard/settings" }],
  },
];

function renderTopbar(
  searchGroups = SEARCH_GROUPS,
  storeName: string | null = "Echos",
) {
  render(
    <DashboardTopbar
      email="owner@example.com"
      role="owner"
      storeName={storeName ?? undefined}
      searchGroups={searchGroups}
    />,
  );
}

// Every suite starts on a store with a chat mounted, whatever order the
// test-order-independence job runs them in.
beforeEach(() => {
  chat.isChatOpen = false;
  chat.mounted = true;
});

function desktopResults() {
  const list = document.getElementById("dashboard-search-results");
  expect(list).not.toBeNull();
  return within(list as HTMLElement);
}

describe("DashboardTopbar Mink AI button", () => {
  beforeEach(() => {
    chat.toggleChat.mockReset();
  });

  // The platform console has no chat (Mink AI works on one store's data), so a
  // button there would do nothing when pressed.
  it("shows no Mink AI button where no chat is mounted", () => {
    chat.mounted = false;
    renderTopbar();
    expect(screen.queryByRole("button", { name: "Mink AI" })).toBeNull();
    expect(screen.queryByTestId("mink-dock")).toBeNull();
  });

  // The console passes no storeName; there "/" opens the marketing site.
  it("shows My Store only on a store", () => {
    renderTopbar(SEARCH_GROUPS, null);
    expect(screen.queryByRole("button", { name: "My Store" })).toBeNull();
    cleanup();
    renderTopbar();
    expect(
      screen.getByRole("button", { name: "My Store" }),
    ).toBeInTheDocument();
  });

  it("toggles the chat and reports whether the panel is open", () => {
    renderTopbar();
    const face = screen.getByRole("button", { name: "Mink AI" });
    expect(face).toHaveAttribute("aria-expanded", "false");
    expect(face).not.toHaveAttribute("aria-controls");
    fireEvent.click(face);
    expect(chat.toggleChat).toHaveBeenCalledTimes(1);
  });

  it("says the panel is open while it is", () => {
    chat.isChatOpen = true;
    renderTopbar();
    expect(screen.getByRole("button", { name: "Mink AI" })).toHaveAttribute(
      "aria-controls",
      "mink-chat-panel",
    );
    expect(screen.getByRole("button", { name: "Mink AI" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("hangs the pop-out bar beside the face, inside its wrapper", () => {
    renderTopbar();
    const face = screen.getByRole("button", { name: "Mink AI" });
    const wrapper = face.parentElement as HTMLElement;
    expect(wrapper).toHaveClass("dash-mink-dock");
    expect(within(wrapper).getByTestId("mink-dock")).toBeInTheDocument();
  });
});

describe("DashboardTopbar search", () => {
  beforeEach(() => {
    push.mockReset();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
  });

  it("filters dashboard destinations and navigates to the selected result", () => {
    renderTopbar();
    const input = screen.getByRole("combobox", { name: "Search dashboard" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "inv" } });

    const inventory = desktopResults().getByRole("option", {
      name: /Inventory/,
    });
    expect(
      desktopResults().queryByRole("option", { name: /Orders/ }),
    ).toBeNull();

    fireEvent.click(inventory);
    expect(push).toHaveBeenCalledWith("/dashboard/inventory");
  });

  // The "Ask Mink AI" tab hangs under the face inside the top bar's stacking
  // context (z-index 1); the results must paint above it where they overlap.
  it("paints the results list above the Mink AI tab", () => {
    renderTopbar();
    const input = screen.getByRole("combobox", { name: "Search dashboard" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "inv" } });
    const list = document.getElementById("dashboard-search-results");
    expect(list?.parentElement).toHaveClass("z-[200]");
  });

  // ★ "Themes" was renamed "Storefront"; people keep typing the old word.
  it("finds a renamed page by its old name", () => {
    renderTopbar([
      {
        group: "Online store",
        items: [
          {
            label: "Storefront",
            href: "/dashboard/storefront",
            searchAliases: ["theme", "themes"],
          },
        ],
      },
    ]);
    const input = screen.getByRole("combobox", { name: "Search dashboard" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "theme" } });
    fireEvent.click(
      desktopResults().getByRole("option", { name: /Storefront/ }),
    );
    expect(push).toHaveBeenCalledWith("/dashboard/storefront");
  });

  // ★ "Point of Sale" became "POS" (26 Oct 2026), and people still call it a
  // register or a till, words the app no longer uses for it. The real catalogue
  // entry is used so its aliases cannot be dropped unnoticed.
  it.each(["register", "till", "point of sale"])(
    "finds POS by the old word %j",
    (word) => {
      const pos = SECTIONS.find((section) => section.key === "pos");
      expect(pos?.label).toBe("POS");
      renderTopbar([
        {
          group: "Sell in person",
          items: [
            {
              label: pos?.label ?? "",
              href: pos?.href ?? "",
              searchAliases: pos?.searchAliases,
            },
          ],
        },
      ]);
      const input = screen.getByRole("combobox", { name: "Search dashboard" });
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: word } });
      fireEvent.click(desktopResults().getByRole("option", { name: /POS/ }));
      expect(push).toHaveBeenCalledWith("/dashboard/pos");
    },
  );

  // The old words find a POS page as well as the section: "register settings"
  // works the way "pos settings" does.
  it.each([
    ["register settings", /POS settings/, "/dashboard/pos/settings"],
    ["till devices", /Devices/, "/dashboard/pos/devices"],
    ["register shifts", /Shifts/, "/dashboard/pos/shifts"],
  ])("finds a POS page by %j", (query, name, href) => {
    const pos = SECTIONS.find((section) => section.key === "pos");
    renderTopbar([
      {
        group: "Sell in person",
        items: [
          {
            label: pos?.label ?? "",
            href: pos?.href ?? "",
            searchAliases: pos?.searchAliases,
            children: pos?.children?.map(({ label, href }) => ({
              label,
              href,
            })),
          },
        ],
      },
    ]);
    const input = screen.getByRole("combobox", { name: "Search dashboard" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: query } });
    fireEvent.click(desktopResults().getByRole("option", { name }));
    expect(push).toHaveBeenCalledWith(href);
  });

  it("opens and focuses search with Command/Ctrl+K", async () => {
    renderTopbar();
    const input = screen.getByRole("combobox", { name: "Search dashboard" });

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(
      desktopResults().getByRole("option", { name: /Orders/ }),
    ).toBeVisible();
  });

  it("submits the active result from the keyboard", () => {
    renderTopbar();
    const input = screen.getByRole("combobox", { name: "Search dashboard" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "prod" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(push).toHaveBeenCalledWith("/dashboard/products");
  });

  it("only searches the permission-filtered groups supplied by the layout", () => {
    renderTopbar([
      {
        group: "Workspace",
        items: [{ label: "Orders", href: "/dashboard/orders" }],
      },
    ]);
    const input = screen.getByRole("combobox", { name: "Search dashboard" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "customers" } });

    expect(desktopResults().queryByRole("option")).toBeNull();
    expect(
      desktopResults().getByText(/No dashboard pages match/),
    ).toBeVisible();
  });

  it("retains duplicate child labels as aliases without duplicate results", () => {
    renderTopbar();
    const input = screen.getByRole("combobox", { name: "Search dashboard" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "all customers" } });

    const results = desktopResults().getAllByRole("option");
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveAccessibleName(/Customers/);
  });

  it("opens the touch search dialog and navigates from it", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    renderTopbar();

    fireEvent.click(
      screen.getByRole("button", { name: "Open dashboard search" }),
    );

    const dialog = screen.getByRole("dialog", { name: "Search dashboard" });
    const input = within(dialog).getByRole("combobox", {
      name: "Search dashboard pages",
    });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.change(input, { target: { value: "settings" } });
    fireEvent.click(within(dialog).getByRole("option", { name: /Settings/ }));

    expect(push).toHaveBeenCalledWith("/dashboard/settings");
  });
});
