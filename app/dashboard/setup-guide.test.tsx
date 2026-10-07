// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SetupGuide } from "./setup-guide";
import type { LaunchChecklistItem } from "@/lib/store/launch-checklist-rules";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/launch-actions", () => ({
  launchStore: vi.fn(async () => ({ success: true })),
  regenerateStorefrontPassword: vi.fn(async () => ({ password: "newpass22" })),
}));

const item = (
  key: string,
  required: boolean,
  done: boolean,
): LaunchChecklistItem => ({
  key,
  title: `Task ${key}`,
  description: `Do ${key}`,
  href: `/dashboard/${key}`,
  action: `Go ${key}`,
  required,
  done,
});

function renderGuide(items: LaunchChecklistItem[], overrides = {}) {
  const required = items.filter((i) => i.required);
  const missing = required.filter((i) => !i.done).map((i) => i.title);
  return render(
    <SetupGuide
      items={items}
      requiredDone={required.length - missing.length}
      requiredTotal={required.length}
      ready={missing.length === 0}
      missing={missing}
      canLaunch
      password="bsjchm49"
      previewUrl="https://acme.storemink.com/password"
      {...overrides}
    />,
  );
}

describe("SetupGuide", () => {
  it("opens the first unfinished required task and nothing else", () => {
    renderGuide([
      item("a", true, true),
      item("b", true, false),
      item("c", true, false),
    ]);
    // Only the open task shows its description and button.
    expect(screen.getByText("Do b")).toBeTruthy();
    expect(screen.queryByText("Do c")).toBeNull();
    expect(screen.getByRole("link", { name: "Go b" })).toBeTruthy();
    // A done task offers Review, never the primary action, once opened.
    fireEvent.click(screen.getByRole("button", { name: /Task a/ }));
    expect(screen.getByRole("link", { name: "Review" })).toBeTruthy();
  });

  it("★ hides Recommended until every required task is done, then folds it", () => {
    const { rerender, unmount } = renderGuide([
      item("a", true, false),
      item("r", false, false),
    ]);
    expect(screen.queryByText(/Recommended/)).toBeNull();
    unmount();
    void rerender;

    renderGuide([item("a", true, true), item("r", false, false)]);
    const toggle = screen.getByRole("button", { name: /Recommended/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Task r")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Task r")).toBeTruthy();
  });

  it("keeps Go live disabled until ready, and names what is missing", () => {
    renderGuide([item("a", true, false)]);
    const btn = screen.getByRole("button", { name: /Go live/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute("title")).toContain("Task a");
  });

  it("enables Go live for the owner once ready, and shows the password", () => {
    renderGuide([item("a", true, true)]);
    const btn = screen.getByRole("button", { name: /Go live/ });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("bsjchm49")).toBeTruthy();
  });

  it("never offers Go live or New password to a non-owner", () => {
    renderGuide([item("a", true, true)], { canLaunch: false });
    expect(
      (screen.getByRole("button", { name: /Go live/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: /New/ })).toBeNull();
  });
});
