// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MinkFace } from "./mink-face";
import {
  MINK_FACE_COLORS,
  MINK_FACE_STATES,
  minkFaceParts,
  normalizeMinkFaceState,
} from "./mink-face-geometry";

describe("minkFaceParts", () => {
  it("draws two open eyes for every state but done", () => {
    for (const state of MINK_FACE_STATES) {
      const { eyes } = minkFaceParts(state);
      expect(eyes).toHaveLength(2);
      expect(eyes.every((eye) => eye.kind === "open")).toBe(state !== "done");
    }
  });

  it("gives each state the sheet's mouth", () => {
    expect(minkFaceParts("default").mouth.kind).toBe("stroke");
    expect(minkFaceParts("listening").mouth.kind).toBe("stroke");
    expect(minkFaceParts("thinking").mouth.kind).toBe("stroke");
    expect(minkFaceParts("talking").mouth.kind).toBe("ellipse");
    expect(minkFaceParts("done").mouth.kind).toBe("fill");
  });

  it("looks up and to the side while thinking", () => {
    const [still] = minkFaceParts("default").eyes;
    const [thinking] = minkFaceParts("thinking").eyes;
    if (still.kind !== "open" || thinking.kind !== "open")
      throw new Error("expected open eyes");
    expect(thinking.px).toBeGreaterThan(still.px);
    expect(thinking.py).toBeLessThan(still.py);
  });

  it("reads anything unknown as the default face", () => {
    expect(normalizeMinkFaceState("angry")).toBe("default");
    expect(normalizeMinkFaceState(undefined)).toBe("default");
    expect(normalizeMinkFaceState("talking")).toBe("talking");
  });
});

describe("MinkFace", () => {
  it("is decorative unless it is given a title", () => {
    const { container, rerender } = render(<MinkFace />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();

    rerender(<MinkFace title="Mink AI" />);
    const named = container.querySelector("svg")!;
    expect(named.getAttribute("role")).toBe("img");
    expect(named.getAttribute("aria-label")).toBe("Mink AI");
    expect(named.getAttribute("aria-hidden")).toBeNull();
  });

  it("paints the saffron tile only when asked", () => {
    const { container, rerender } = render(<MinkFace tile />);
    expect(container.querySelector("rect")?.getAttribute("fill")).toBe(
      MINK_FACE_COLORS.saffron,
    );
    rerender(<MinkFace tile={false} />);
    expect(container.querySelector("rect")).toBeNull();
  });

  it("names its state for the motion styles", () => {
    const { container } = render(<MinkFace state="talking" size={48} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("data-state")).toBe("talking");
    expect(svg.getAttribute("width")).toBe("48");
    expect(container.querySelector("ellipse")).not.toBeNull();
  });

  it("closes the eyes when done", () => {
    const { container } = render(<MinkFace state="done" />);
    // Two arcs, no pupils.
    expect(container.querySelectorAll("circle")).toHaveLength(0);
  });
});
