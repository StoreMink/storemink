import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect: nav.redirect }));
import ThemeStudioVersionPreviewPage from "./page";

// The old preview address redirects into the theme page's Preview tab
// (contract section 6.6); the theme page gates and falls back by itself.

describe("the old preview address", () => {
  it("sends the browser to the Preview tab on that design", async () => {
    await expect(
      ThemeStudioVersionPreviewPage({
        params: Promise.resolve({ projectId: "p1", versionId: "v2" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenCalledWith(
      "/dashboard/themes/studio/p1?tab=preview&version=v2",
    );
  });

  it("keeps whatever is in the address inside the theme page's path", async () => {
    await expect(
      ThemeStudioVersionPreviewPage({
        params: Promise.resolve({
          projectId: "../evil",
          versionId: "x&do=delete",
        }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenLastCalledWith(
      "/dashboard/themes/studio/..%2Fevil?tab=preview&version=x%26do%3Ddelete",
    );
  });
});
