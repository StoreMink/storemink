/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";

// requireStorefrontStore() is the one function every storefront page calls,
// so its order of checks IS the storefront's gate: unknown host → 404, then
// the password, then a store still waiting for its first theme.

const H = vi.hoisted(() => ({
  rows: [] as any[],
  access: "unlocked" as "open" | "unlocked" | "locked",
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
// "unlocked" is also exactly what the builder's preview header resolves to for
// staff (storefront-access.ts), so the unlocked cases below cover it too.
vi.mock("@/lib/store/storefront-access", () => ({
  storefrontAccess: vi.fn(async () => H.access),
}));

import { storefrontAccess } from "@/lib/store/storefront-access";
import { requireStorefrontStore, requireStorefrontStoreId } from "./resolve";

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

beforeEach(() => {
  H.rows = [];
  H.access = "unlocked";
});

describe("requireStorefrontStore — the store-in-progress gate", () => {
  it("404s an unknown host before anything else", async () => {
    await expect(requireStorefrontStore()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("asks for the password first, even when no theme is chosen", async () => {
    // ★ A locked visitor must not learn the store has no theme yet.
    H.rows = [store({ launched: false, themePending: true })];
    H.access = "locked";
    await expect(requireStorefrontStore()).rejects.toThrow(
      "NEXT_REDIRECT /password",
    );
  });

  it("sends a visitor past the password to the in-progress page", async () => {
    H.rows = [store({ launched: false, themePending: true })];
    await expect(requireStorefrontStore()).rejects.toThrow(
      "NEXT_REDIRECT /in-progress",
    );
    await expect(requireStorefrontStoreId()).rejects.toThrow(
      "NEXT_REDIRECT /in-progress",
    );
  });

  it("does the same for a launched store that is somehow pending", async () => {
    // A pending store cannot launch (the checklist blocks it); handled anyway.
    H.rows = [store({ launched: true, themePending: true })];
    await expect(requireStorefrontStore()).rejects.toThrow(
      "NEXT_REDIRECT /in-progress",
    );
    expect(storefrontAccess).not.toHaveBeenCalled();
  });

  it("lets an unlocked visitor into a store that has a theme", async () => {
    H.rows = [store({ launched: false, theme: { presetId: "basket" } })];
    await expect(requireStorefrontStore()).resolves.toMatchObject({
      id: "s1",
    });
  });

  it("leaves a legacy store with no themePending key untouched", async () => {
    H.rows = [store({})];
    await expect(requireStorefrontStoreId()).resolves.toBe("s1");
    // A launched store never even loads the access module.
    expect(storefrontAccess).not.toHaveBeenCalled();
  });

  it("only an explicit true counts as pending", async () => {
    for (const themePending of [false, "true", 1, null]) {
      H.rows = [store({ themePending })];
      await expect(requireStorefrontStore()).resolves.toMatchObject({
        id: "s1",
      });
    }
  });
});
