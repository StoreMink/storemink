// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/dashboard/products"),
}));

import { MinkSpotlight, findMinkGuideElement } from "./mink-spotlight";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("MinkSpotlight", () => {
  it("finds the control by its label, rings it and leaves on a click", () => {
    document.body.innerHTML =
      '<main><a href="/dashboard/products/new">New product</a></main>';
    expect(findMinkGuideElement("add_product")?.textContent).toBe(
      "New product",
    );
    const onDone = vi.fn();
    render(
      createElement(MinkSpotlight, {
        highlight: {
          target: "add_product",
          label: "New product",
          hint: "Opens the product form.",
        },
        onDone,
      }),
    );
    expect(screen.getByTestId("mink-spotlight")).toHaveTextContent(
      "New product",
    );
    expect(screen.getByTestId("mink-spotlight")).toHaveTextContent(
      "Opens the product form.",
    );
    fireEvent.pointerDown(document.body);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("prefers a data-mink-target hook and never a control inside the chat panel", () => {
    document.body.innerHTML =
      '<aside class="mink-chat-surface"><button>Go live</button></aside><main><button data-mink-target="go_live">Open the shop</button></main>';
    expect(findMinkGuideElement("go_live")?.textContent).toBe("Open the shop");
    document.body.innerHTML =
      '<aside class="mink-chat-surface"><button>Go live</button></aside><main><p>nothing</p></main>';
    expect(findMinkGuideElement("go_live")).toBeNull();
  });

  it("never rings a control inside the top-bar Mink AI pop-out", () => {
    document.body.innerHTML =
      "<main><div data-mink-dock><button>Go live</button></div><p>nothing</p></main>";
    expect(findMinkGuideElement("go_live")).toBeNull();
  });

  it("says so when the control is not on the screen, then goes away", () => {
    document.body.innerHTML = "<main><p>Empty</p></main>";
    const onDone = vi.fn();
    render(
      createElement(MinkSpotlight, {
        highlight: { target: "go_live", label: "Go live", hint: "" },
        onDone,
      }),
    );
    act(() => {
      vi.advanceTimersByTime(6_500);
    });
    expect(screen.getByTestId("mink-spotlight-missing")).toHaveTextContent(
      "Go live is not on this screen.",
    );
    act(() => {
      vi.advanceTimersByTime(4_100);
    });
    expect(onDone).toHaveBeenCalled();
  });
});
