// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The store-in-progress page, and the three storefront gates walked together:
// every content page (requireStorefrontStore), /password and /in-progress.
// The real resolver and both real pages run here; only the database, the
// password check and the brand are stubbed.

const H = vi.hoisted(() => ({
  rows: [] as any[],
  access: "unlocked" as "open" | "unlocked" | "locked",
  logoUrl: null as string | null,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: "acme.storemink.com" })),
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("@/lib/db/client", () => ({
  withAnon: vi.fn(async (fn: (db: any) => Promise<any>) =>
    fn({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => H.rows }) }),
      }),
    }),
  ),
}));
vi.mock("@/lib/store/storefront-access", () => ({
  storefrontAccess: vi.fn(async () => H.access),
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: vi.fn(async () => ({
    name: "Acme Teas",
    logoUrl: H.logoUrl,
    primaryColor: "#123456",
  })),
}));
vi.mock("../password/password-form", () => ({ PasswordForm: () => null }));

import InProgressPage, { metadata } from "./page";
import PasswordPage from "../password/page";
import { requireStorefrontStore } from "@/lib/store/resolve";

function store(settings: Record<string, unknown>) {
  return {
    id: "s1",
    slug: "acme",
    name: "Acme",
    status: "active",
    plan: "free",
    plan_expires_at: null,
    comp_plan: null,
    comp_expires_at: null,
    custom_domain: null,
    settings,
  };
}

const PENDING = { launched: false, themePending: true };
const THEMED = { launched: false, theme: { presetId: "basket" } };

beforeEach(() => {
  H.rows = [];
  H.access = "unlocked";
  H.logoUrl = null;
});

// Any storefront content page: the homepage, a product, a page, the cart…
// all of them call requireStorefrontStore() before rendering anything.
const CONTENT = "/shop";

async function visit(path: string): Promise<{ redirect?: string }> {
  try {
    if (path === "/in-progress") await InProgressPage();
    else if (path === "/password")
      await PasswordPage({ searchParams: Promise.resolve({}) });
    else await requireStorefrontStore();
    return {};
  } catch (err) {
    const match = /^NEXT_REDIRECT (.+)$/.exec((err as Error).message);
    if (!match) throw err;
    return { redirect: match[1] };
  }
}

/** Follow redirects from `start` to the page that renders. */
async function land(start: string): Promise<string> {
  let path = start;
  for (let hop = 0; hop < 4; hop++) {
    const { redirect } = await visit(path);
    if (!redirect) return path;
    path = redirect;
  }
  throw new Error(`redirect loop starting at ${start}`);
}

describe("the store-in-progress page", () => {
  it("is noindex", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("shows the brand, a calm message and the owner's way out", async () => {
    H.rows = [store(PENDING)];
    render(await InProgressPage());
    expect(screen.getByText("Acme Teas")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Store in progress" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This store is being set up. Please check back soon."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Choose a theme in your dashboard" }),
    ).toHaveAttribute("href", "/dashboard/storefront");
  });

  it("uses the store's logo when it has one", async () => {
    H.rows = [store(PENDING)];
    H.logoUrl = "https://storage.googleapis.com/b/stores/s1/logo.webp";
    render(await InProgressPage());
    expect(screen.getByRole("img", { name: "Acme Teas" })).toHaveAttribute(
      "src",
      H.logoUrl,
    );
  });

  it("404s on an unknown host rather than redirecting", async () => {
    await expect(InProgressPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("the storefront gates, walked end to end", () => {
  const STARTS = [CONTENT, "/", "/in-progress", "/password"];

  it("a locked visitor always lands on the password page", async () => {
    H.access = "locked";
    for (const settings of [PENDING, THEMED]) {
      H.rows = [store(settings)];
      for (const start of STARTS) {
        expect(await land(start)).toBe("/password");
      }
    }
  });

  it("past the password, a pending store shows only the in-progress page", async () => {
    H.rows = [store(PENDING)];
    for (const start of STARTS) {
      expect(await land(start)).toBe("/in-progress");
    }
  });

  it("an open (launched) store that is pending does the same", async () => {
    H.rows = [store({ launched: true, themePending: true })];
    H.access = "open";
    for (const start of STARTS) {
      expect(await land(start)).toBe("/in-progress");
    }
  });

  it("a store with a theme is unaffected, and /in-progress sends to the shop", async () => {
    H.rows = [store(THEMED)];
    expect(await land(CONTENT)).toBe(CONTENT);
    expect(await land("/in-progress")).toBe("/");
    expect(await land("/password")).toBe("/");
  });

  it("a legacy store with no themePending key is unaffected", async () => {
    H.rows = [store({})];
    H.access = "open";
    expect(await land(CONTENT)).toBe(CONTENT);
    expect(await land("/in-progress")).toBe("/");
  });

  it("the moment a theme is chosen, the in-progress page lets go", async () => {
    H.rows = [store(PENDING)];
    expect(await land("/in-progress")).toBe("/in-progress");
    // switchStoreTheme deletes the key in the same write that pins the theme.
    H.rows = [store(THEMED)];
    expect(await land("/in-progress")).toBe("/");
    expect(await land(CONTENT)).toBe(CONTENT);
  });
});
