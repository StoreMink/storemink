// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsHomeRedirect, isHidden } from "./settings-home-redirect";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

describe("SettingsHomeRedirect", () => {
  beforeEach(() => replace.mockReset());

  it("opens General when the page column shows", () => {
    render(
      <div className="sm-settings">
        <main className="sm-settings-main">
          <SettingsHomeRedirect />
        </main>
      </div>,
    );
    expect(replace).toHaveBeenCalledWith("/dashboard/settings/general");
  });

  it("★ stays on the menu when the page column is hidden (a narrow frame)", () => {
    render(
      <div className="sm-settings">
        <main className="sm-settings-main" style={{ display: "none" }}>
          <SettingsHomeRedirect />
        </main>
      </div>,
    );
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("isHidden", () => {
  it("sees display: none on the element or any ancestor", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("span");
    outer.appendChild(inner);
    document.body.appendChild(outer);
    expect(isHidden(inner)).toBe(false);
    outer.style.display = "none";
    expect(isHidden(inner)).toBe(true);
    outer.remove();
  });
});
