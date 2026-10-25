import { describe, expect, it } from "vitest";
import {
  STUDIO_PAGE_PARAMS,
  STUDIO_TAB_KEYS,
  studioIntentFromParam,
  studioPageHref,
  studioTabFromParam,
} from "./tab-types";

// The theme page's address (contract section 6.1): ?tab=&version=&do=.

describe("the theme page's address", () => {
  it("keeps the contract's names", () => {
    expect(STUDIO_TAB_KEYS).toEqual([
      "preview",
      "checks",
      "pictures",
      "changes",
      "log",
    ]);
    expect(STUDIO_PAGE_PARAMS).toEqual({
      tab: "tab",
      version: "version",
      intent: "do",
    });
  });

  it("reads the open tab, and an unknown or missing one is the Preview", () => {
    expect(studioTabFromParam("checks")).toBe("checks");
    expect(studioTabFromParam(["log", "checks"])).toBe("log");
    expect(studioTabFromParam(undefined)).toBe("preview");
    expect(studioTabFromParam("")).toBe("preview");
    expect(studioTabFromParam("chat")).toBe("preview");
    expect(studioTabFromParam("<script>")).toBe("preview");
  });

  it("reads an intent from the closed list only", () => {
    expect(studioIntentFromParam("describe_fix")).toBe("describe_fix");
    expect(studioIntentFromParam(["stop", "delete"])).toBe("stop");
    expect(studioIntentFromParam("run_everything")).toBeNull();
    expect(studioIntentFromParam(null)).toBeNull();
    expect(studioIntentFromParam(undefined)).toBeNull();
  });

  it("changes only the parameters it names and keeps the rest", () => {
    const current = new URLSearchParams("tab=log&version=v1&do=stop&x=1");
    expect(studioPageHref("p", current, { tab: "checks" })).toBe(
      "/dashboard/themes/studio/p?tab=checks&version=v1&do=stop&x=1",
    );
    expect(
      studioPageHref("p", current, { versionId: null, intent: null }),
    ).toBe("/dashboard/themes/studio/p?tab=log&x=1");
    expect(studioPageHref("p", "", {})).toBe("/dashboard/themes/studio/p");
    expect(
      studioPageHref("p", "?tab=preview", { intent: "describe_fix" }),
    ).toBe("/dashboard/themes/studio/p?tab=preview&do=describe_fix");
  });

  it("never leaves the theme page's path", () => {
    expect(studioPageHref("../../x", "", {})).toBe(
      "/dashboard/themes/studio/..%2F..%2Fx",
    );
  });
});
