// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MINK_MARK_PX, MinkMark } from "./mink-mark";

afterEach(cleanup);

describe("MinkMark", () => {
  it("draws the Mink face on its saffron tile, not the old robot", () => {
    const { container } = render(<MinkMark />);
    const face = container.querySelector("svg[data-mink-face]");
    expect(face).not.toBeNull();
    expect(face?.querySelector("rect")?.getAttribute("fill")).toBe("#FFB224");
    expect(container.querySelector(".lucide-bot")).toBeNull();
  });

  it("keeps the old robot tile's sizes, so no layout moves", () => {
    expect(MINK_MARK_PX).toEqual({ sm: 28, md: 36, lg: 44 });
    for (const size of ["sm", "md", "lg"] as const) {
      const { container } = render(<MinkMark size={size} />);
      expect(container.querySelector("svg")?.getAttribute("width")).toBe(
        String(MINK_MARK_PX[size]),
      );
      cleanup();
    }
  });

  it("is decorative and passes its expression through", () => {
    const { container } = render(<MinkMark state="thinking" animated />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
    expect(
      container.querySelector("[data-mink-face]")?.getAttribute("data-state"),
    ).toBe("thinking");
  });
});
