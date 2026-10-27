import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect: nav.redirect }));
import ThemeStudioAcceptancePage from "./page";

// The old Checks address redirects into the theme page's Checks tab
// (wave TS-2, contract section 6.6); the theme page gates and falls back by
// itself.

describe("the old Checks address", () => {
  it("sends the browser to the Checks tab on that design", async () => {
    await expect(
      ThemeStudioAcceptancePage({
        params: Promise.resolve({ projectId: "p1", versionId: "v2" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenCalledWith(
      "/dashboard/themes/studio/p1?tab=checks&version=v2",
    );
  });

  it("keeps whatever is in the address inside the theme page's path", async () => {
    await expect(
      ThemeStudioAcceptancePage({
        params: Promise.resolve({
          projectId: "../x",
          versionId: "v&do=delete",
        }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenLastCalledWith(
      "/dashboard/themes/studio/..%2Fx?tab=checks&version=v%26do%3Ddelete",
    );
  });
});
