// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getViewerAccess } from "@/app/dashboard/lib/access";
import SettingsPage from "./page";

vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerAccess: vi.fn(),
}));
vi.mock("./settings-home-redirect", () => ({
  SettingsHomeRedirect: () => <div>Opening General</div>,
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

  it("opens General beside the menu, without reading it here", async () => {
    await renderPage();
    expect(screen.getByText("Opening General")).toBeInTheDocument();
  });

  it("points a role without Settings view at the menu instead", async () => {
    vi.mocked(getViewerAccess).mockResolvedValue(
      access({ channels: ["view"] }),
    );
    await renderPage();
    expect(screen.queryByText("Opening General")).toBeNull();
    expect(
      screen.getByText("Choose a page from the settings menu."),
    ).toBeInTheDocument();
  });

  it("renders nothing without a profile (the layout explains that)", async () => {
    vi.mocked(getViewerAccess).mockResolvedValue(null);
    expect(await SettingsPage()).toBeNull();
  });
});
