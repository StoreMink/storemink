// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getViewerAccess } from "@/app/dashboard/lib/access";
import SettingsPage from "./page";

vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerAccess: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("./general-settings", () => ({
  GeneralSettings: ({ storeId }: { storeId: string }) => (
    <div>General for {storeId}</div>
  ),
}));

function access(allowed: Record<string, ("view" | "manage")[]>) {
  return {
    can: (section: string, action: "view" | "manage") =>
      allowed[section]?.includes(action) ?? false,
  } as never;
}

async function renderPage() {
  const page = await SettingsPage();
  return render(<>{page}</>);
}

describe("Settings home", () => {
  beforeEach(() => {
    vi.mocked(getViewerAccess).mockResolvedValue(
      access({ settings: ["view"] }),
    );
  });

  it("shows General beside the settings menu", async () => {
    await renderPage();
    expect(screen.getByText("General for store-1")).toBeInTheDocument();
  });

  it("points a role without Settings view at the menu instead", async () => {
    vi.mocked(getViewerAccess).mockResolvedValue(
      access({ notifications: ["view"] }),
    );
    await renderPage();
    expect(screen.queryByText(/General for/)).toBeNull();
    expect(
      screen.getByText("Choose a page from the settings menu."),
    ).toBeInTheDocument();
  });

  it("renders nothing without a profile (the layout explains that)", async () => {
    vi.mocked(getViewerAccess).mockResolvedValue(null);
    expect(await SettingsPage()).toBeNull();
  });
});
