/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import { makeDbMock } from "@/app/actions/_test-helpers";
import { withService } from "@/lib/db/client";
import { readBrand } from "./campaign-actions";

const STORE = "11111111-1111-4111-8111-111111111111";
const LOGO = `https://storage.googleapis.com/sm-media/stores/${STORE}/uploads/logo.webp`;

function storeRow(logoUrl: string | null) {
  return {
    name: "Lumen Oils",
    customDomain: null,
    settings: { brand: { logoUrl, primaryColor: "#2542c7" } },
  };
}

beforeEach(() => {
  vi.stubEnv("GCS_BUCKET", "sm-media");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("takedown: the brand a coupon campaign is sent with", () => {
  it("★★ a logo StoreMink blocked is no logo, so the email prints the store's name", async () => {
    const mock = makeDbMock({
      selectByTable: { stores: [[storeRow(LOGO)]] },
      executeQueue: [[{ url: LOGO }]],
    });
    const brand = await readBrand(mock.db as any, STORE);
    expect(brand.logoUrl).toBeNull();
    expect(brand.name).toBe("Lumen Oils");
    // The rest of the identity is untouched.
    expect(brand.primaryColor).toBe("#2542c7");

    // ★ Looked up on the campaign's own connection: no scope of its own.
    expect(vi.mocked(withService)).not.toHaveBeenCalled();
    const query = new PgDialect().sqlToQuery(mock.calls.execute[0]);
    expect(query.sql).toContain("public.content_blocks");
    expect(query.sql).toContain("blocked.lifted_at is null");
    expect(query.params).toEqual([
      [LOGO],
      [`stores/${STORE}/uploads/logo.webp`],
    ]);
  });

  it("keeps a logo nobody blocked", async () => {
    const mock = makeDbMock({
      selectByTable: { stores: [[storeRow(LOGO)]] },
      executeQueue: [[]],
    });
    const brand = await readBrand(mock.db as any, STORE);
    expect(brand.logoUrl).toBe(LOGO);
  });

  it("asks nothing when the store has no logo", async () => {
    const mock = makeDbMock({
      selectByTable: { stores: [[storeRow(null)]] },
    });
    const brand = await readBrand(mock.db as any, STORE);
    expect(brand.logoUrl).toBeNull();
    expect(mock.calls.execute).toHaveLength(0);
  });
});
