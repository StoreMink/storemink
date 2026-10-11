import { describe, expect, it, vi } from "vitest";

// storefrontShell() is pure; these stubs only keep the module's server
// imports (database, session) from loading anything real.
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({ getCurrentStoreOrNull: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(), cookies: vi.fn() }));

import { storefrontShell, type StorefrontAccess } from "./storefront-access";

// Which shell the storefront layout wraps a page in. "bare" (brand colours
// and the page, no header, footer, cart or sign-in) is for the two pages a
// visitor can be confined to: /password while locked, and /in-progress while
// the owner has not chosen a theme. Everything else gets the whole shop.

function store(settings: Record<string, unknown> | null) {
  return { settings };
}

describe("storefrontShell", () => {
  it("is bare for a locked visitor, whatever the theme state", () => {
    // The password page is the only page they can reach.
    expect(
      storefrontShell(store({ launched: false, themePending: true }), "locked"),
    ).toBe("bare");
    expect(
      storefrontShell(
        store({ launched: false, theme: { presetId: "basket" } }),
        "locked",
      ),
    ).toBe("bare");
  });

  it("is bare past the password while no theme is chosen", () => {
    // ★ The owner included: the owner sees what visitors see.
    expect(
      storefrontShell(
        store({ launched: false, themePending: true }),
        "unlocked",
      ),
    ).toBe("bare");
  });

  it("is bare for an open store that is somehow still pending", () => {
    // Go live is blocked while a theme is pending, so this should not occur;
    // if it does, the in-progress page still gets the calm shell.
    expect(
      storefrontShell(store({ launched: true, themePending: true }), "open"),
    ).toBe("bare");
  });

  it("is full once a theme is chosen", () => {
    // Choosing a theme deletes the key.
    expect(
      storefrontShell(
        store({ launched: false, theme: { presetId: "basket" } }),
        "unlocked",
      ),
    ).toBe("full");
    expect(
      storefrontShell(
        store({ launched: true, theme: { presetId: "basket" } }),
        "open",
      ),
    ).toBe("full");
  });

  it("is full for legacy, fallback and demo stores, which carry no key", () => {
    // Every store created before themePending existed must look exactly as
    // it did.
    expect(storefrontShell(store({}), "open")).toBe("full");
    expect(storefrontShell(store({ template: "basket" }), "open")).toBe("full");
    expect(storefrontShell(store(null), "open")).toBe("full");
    expect(
      storefrontShell(store({ launched: false, demo: true }), "open"),
    ).toBe("full");
  });

  it("counts only an explicit true as pending", () => {
    for (const v of [false, "true", 1, null]) {
      expect(
        storefrontShell(store({ launched: true, themePending: v }), "open"),
        String(v),
      ).toBe("full");
    }
  });

  it("answers for every access state", () => {
    const states: StorefrontAccess[] = ["open", "unlocked", "locked"];
    expect(states.map((a) => storefrontShell(store({}), a))).toEqual([
      "full",
      "full",
      "bare",
    ]);
  });
});
