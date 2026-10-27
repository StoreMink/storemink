import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect: nav.redirect }));
import ThemeStudioComparePage from "./page";

// The old compare address (`?from=&to=`) redirects into the theme page's
// Changes tab on the `to` design (wave TS-2, contract section 6.6): the tab
// compares a design with the design it was made from, so `from` is dropped.

function open(query: Record<string, string | string[] | undefined>) {
  return ThemeStudioComparePage({
    params: Promise.resolve({ projectId: "p1" }),
    searchParams: Promise.resolve(query),
  });
}

describe("the old compare address", () => {
  it("shows the Changes tab on the `to` design, dropping `from`", async () => {
    await expect(open({ from: "v1", to: "v2" })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(nav.redirect).toHaveBeenCalledWith(
      "/dashboard/themes/studio/p1?tab=changes&version=v2",
    );
  });

  it("takes the first `to`, and opens the current design without one", async () => {
    await expect(open({ to: ["v3", "v4"] })).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenLastCalledWith(
      "/dashboard/themes/studio/p1?tab=changes&version=v3",
    );
    await expect(open({ from: "v1" })).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenLastCalledWith(
      "/dashboard/themes/studio/p1?tab=changes",
    );
    await expect(open({ to: "x&do=delete" })).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirect).toHaveBeenLastCalledWith(
      "/dashboard/themes/studio/p1?tab=changes&version=x%26do%3Ddelete",
    );
  });
});
