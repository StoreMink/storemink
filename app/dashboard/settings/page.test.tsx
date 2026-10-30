// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getViewerAccess } from "@/app/dashboard/lib/access";
import { NOTICES } from "@/lib/moderation/copy";
import SettingsPage from "./page";

vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerAccess: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/analytics/settings", () => ({
  getStoreAnalyticsTimeZone: vi.fn(async () => "Asia/Kolkata"),
}));
vi.mock("./business-time-zone-form", () => ({
  BusinessTimeZoneForm: () => null,
}));

function access(allowed: Record<string, ("view" | "manage")[]>) {
  return {
    can: (section: string, action: "view" | "manage") =>
      allowed[section]?.includes(action) ?? false,
  } as never;
}

async function renderPage() {
  return render(await SettingsPage());
}

describe("Settings landing page", () => {
  beforeEach(() => {
    vi.mocked(getViewerAccess).mockResolvedValue(
      access({ settings: ["view"] }),
    );
  });

  it("lists Notices from StoreMink with the Settings child's wording, link and a line", async () => {
    await renderPage();

    const link = screen.getByRole("link", {
      name: new RegExp(NOTICES.navLabel),
    });
    expect(link).toHaveAttribute("href", "/dashboard/settings/notices");
    expect(within(link).getByText(NOTICES.navLabel)).toBeInTheDocument();
    expect(within(link).getByText(NOTICES.intro)).toBeInTheDocument();
  });

  it("does not list it for a role without Settings view", async () => {
    vi.mocked(getViewerAccess).mockResolvedValue(
      access({ notifications: ["view"] }),
    );

    await renderPage();

    expect(screen.queryByText(NOTICES.navLabel)).not.toBeInTheDocument();
  });
});
