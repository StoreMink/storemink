import { describe, expect, it } from "vitest";
import { accountShellClass } from "./account-shell-class";

// Plan Phase 2e: the account template's shell renders nothing around the
// pages unless it changes something.
describe("accountShellClass", () => {
  it("is empty for the plain layout with the page's own colours", () => {
    expect(accountShellClass({ layout: "plain", scheme: "" })).toBe("");
  });
  it("names the layout and the scheme the CSS reads", () => {
    expect(accountShellClass({ layout: "tabs", scheme: "" })).toBe(
      "sm-account layout-tabs",
    );
    expect(accountShellClass({ layout: "sidebar", scheme: "inverse" })).toBe(
      "sm-account layout-sidebar sm-scheme sm-scheme-inverse",
    );
    expect(accountShellClass({ layout: "plain", scheme: "soft" })).toBe(
      "sm-account layout-plain sm-scheme sm-scheme-soft",
    );
  });
});
