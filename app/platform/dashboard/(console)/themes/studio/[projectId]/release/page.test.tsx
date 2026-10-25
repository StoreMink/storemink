import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect: nav.redirect }));
import ThemeStudioReleasePage from "./page";

// The old Publish page redirects into the theme page's Log tab, where the
// publish history and the catalog record are; Publish itself sits in the
// header on every tab (wave TS-2, contract section 6.6).

describe("the old Publish address", () => {
  it("sends the browser to the Log tab", async () => {
    await expect(
      ThemeStudioReleasePage({ params: Promise.resolve({ projectId: "p1" }) }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenCalledWith(
      "/dashboard/themes/studio/p1?tab=log",
    );
  });

  it("keeps whatever is in the address inside the theme page's path", async () => {
    await expect(
      ThemeStudioReleasePage({ params: Promise.resolve({ projectId: "a?b" }) }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenLastCalledWith(
      "/dashboard/themes/studio/a%3Fb?tab=log",
    );
  });
});
