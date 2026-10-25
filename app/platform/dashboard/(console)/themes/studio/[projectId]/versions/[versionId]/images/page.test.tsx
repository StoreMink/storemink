import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect: nav.redirect }));
import ThemeStudioSlotImagesPage from "./page";

// The old Images address redirects into the theme page's Pictures tab
// (wave TS-2, contract section 6.6).

describe("the old Images address", () => {
  it("sends the browser to the Pictures tab on that design", async () => {
    await expect(
      ThemeStudioSlotImagesPage({
        params: Promise.resolve({ projectId: "p1", versionId: "v2" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenCalledWith(
      "/dashboard/themes/studio/p1?tab=pictures&version=v2",
    );
  });

  it("keeps whatever is in the address inside the theme page's path", async () => {
    await expect(
      ThemeStudioSlotImagesPage({
        params: Promise.resolve({ projectId: "a/b", versionId: "?x=1" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenLastCalledWith(
      "/dashboard/themes/studio/a%2Fb?tab=pictures&version=%3Fx%3D1",
    );
  });
});
