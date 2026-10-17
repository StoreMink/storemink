// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  hasMinkPrefillParam,
  minkPrefillPath,
  readMinkFormPrefill,
  readMinkPrefill,
  storeMinkPrefill,
  takeMinkPrefill,
  MINK_PREFILL_TTL_MS,
} from "./form-prefill";

describe("readMinkPrefill", () => {
  it("bounds every form's fields and accepts snake_case keys", () => {
    expect(
      readMinkPrefill("offer", {
        name: "  Diwali 10  ",
        reward_type: "percent_off",
        reward_value: "10",
        min_subtotal: 500,
        delivery: "code",
        code: "diwali 10",
        valid_until: "2026-11-01",
        budget: -5,
      }),
    ).toEqual({
      name: "Diwali 10",
      rewardType: "percent_off",
      rewardValue: 10,
      minSubtotal: 500,
      delivery: "code",
      code: "DIWALI10",
      validUntil: "2026-11-01",
    });
    expect(
      readMinkPrefill("shipping", {
        mode: "flat",
        flat_rate: 49,
        free_above: null,
        manual_min_days: 2,
        manual_max_days: 99,
      }),
    ).toEqual({
      mode: "flat",
      flatRate: 49,
      freeAbove: null,
      manualMinDays: 2,
    });
    expect(
      readMinkPrefill("blog", {
        title: "Hello",
        tags: ["a", "", 3, "b"],
      }),
    ).toEqual({ title: "Hello", tags: ["a", "b"] });
    expect(readMinkPrefill("category", { status: "deleted" })).toBeNull();
    expect(readMinkPrefill("product", "nope")).toBeNull();
  });

  it("reads a kind and fields pair off the wire", () => {
    expect(
      readMinkFormPrefill({ kind: "category", fields: { name: "Winter" } }),
    ).toEqual({ kind: "category", fields: { name: "Winter" } });
    expect(readMinkFormPrefill({ kind: "page", fields: {} })).toBeNull();
    expect(readMinkFormPrefill({ kind: "offer", fields: {} })).toBeNull();
  });
});

describe("storage", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("stores under the kind's key, takes once and clears", () => {
    expect(storeMinkPrefill({ kind: "offer", fields: { name: "Sale" } })).toBe(
      true,
    );
    expect(takeMinkPrefill("category")).toBeNull();
    expect(takeMinkPrefill("offer")).toEqual({ name: "Sale" });
    expect(takeMinkPrefill("offer")).toBeNull();
  });

  it("keeps an explicit null through the storage round trip", () => {
    // null means "clear the free-delivery threshold"; it must not read as
    // "not given" once the form takes it back out of sessionStorage.
    storeMinkPrefill({
      kind: "shipping",
      fields: { mode: "flat", flatRate: 49, freeAbove: null },
    });
    expect(takeMinkPrefill("shipping")).toEqual({
      mode: "flat",
      flatRate: 49,
      freeAbove: null,
    });
  });

  it("ignores a stale prefill and reads the older product envelope", () => {
    storeMinkPrefill({ kind: "blog", fields: { title: "Late" } });
    expect(
      takeMinkPrefill("blog", Date.now() + MINK_PREFILL_TTL_MS + 1),
    ).toBeNull();
    window.sessionStorage.setItem(
      "storemink:mink-prefill:product",
      JSON.stringify({ name: "Old shape" }),
    );
    expect(takeMinkPrefill("product")).toEqual({ name: "Old shape" });
  });

  it("names the page and the query flag", () => {
    expect(minkPrefillPath("shipping")).toBe(
      "/dashboard/settings/shipping?prefill=mink",
    );
    expect(hasMinkPrefillParam("?prefill=mink")).toBe(true);
    expect(hasMinkPrefillParam(new URLSearchParams("?prefill=no"))).toBe(false);
  });
});
