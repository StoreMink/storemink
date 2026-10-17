import { describe, expect, it } from "vitest";
import {
  MINK_GUIDE_TARGETS,
  MINK_GUIDE_TARGET_KEYS,
  isMinkGuideTarget,
  readMinkHighlight,
} from "./guide-targets";

describe("Mink guide targets", () => {
  it("every target has a valid pattern, a label and a hint", () => {
    for (const key of MINK_GUIDE_TARGET_KEYS) {
      const target = MINK_GUIDE_TARGETS[key];
      expect(() => new RegExp(target.text, "i")).not.toThrow();
      expect(target.label.length).toBeGreaterThan(2);
      expect(target.hint.length).toBeGreaterThan(5);
      expect(["button", "control"]).toContain(target.role);
      expect(target.destination).toMatch(/^[a-z_]+$/);
    }
    expect(isMinkGuideTarget("add_product")).toBe(true);
    expect(isMinkGuideTarget("delete_store")).toBe(false);
  });

  it("reads a highlight off the wire with the registry's own words as fallback", () => {
    expect(readMinkHighlight({ target: "go_live" })).toEqual({
      target: "go_live",
      label: "Go live",
      hint: MINK_GUIDE_TARGETS.go_live.hint,
    });
    expect(
      readMinkHighlight({
        target: "go_live",
        label: "The Go live button",
        hint: "x".repeat(300),
      }),
    ).toEqual({
      target: "go_live",
      label: "The Go live button",
      hint: MINK_GUIDE_TARGETS.go_live.hint,
    });
    expect(readMinkHighlight({ target: "nope" })).toBeNull();
    expect(readMinkHighlight("go_live")).toBeNull();
  });
});
