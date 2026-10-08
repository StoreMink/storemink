import { expect, it } from "vitest";
import { closingSectionType } from "./closing-section";

it("names the last ENABLED section, not the last stored one", () => {
  expect(
    closingSectionType([
      { type: "hero", enabled: true },
      { type: "newsletter", enabled: true },
      { type: "faq_accordion", enabled: false },
    ]),
  ).toBe("newsletter");
});

it("treats an absent enabled flag as enabled, like the renderer does", () => {
  expect(closingSectionType([{ type: "hero" }, { type: "usp_bar" }])).toBe(
    "usp_bar",
  );
});

it("is null for an empty or fully disabled page", () => {
  expect(closingSectionType([])).toBeNull();
  expect(closingSectionType([{ type: "hero", enabled: false }])).toBeNull();
});
