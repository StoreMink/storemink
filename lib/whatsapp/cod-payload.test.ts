import { describe, expect, it } from "vitest";
import {
  codButtonPayloads,
  codOrderFromPayloads,
  parseCodPayload,
} from "./cod-payload";

const ORDER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("COD button payloads", () => {
  it("are Confirm then Cancel, in the template's button order", () => {
    expect(codButtonPayloads(ORDER)).toEqual([
      `cod:confirm:${ORDER}`,
      `cod:cancel:${ORDER}`,
    ]);
  });

  it("round-trip through the parser", () => {
    const [confirm, cancel] = codButtonPayloads(ORDER);
    expect(parseCodPayload(confirm)).toEqual({
      action: "confirm",
      orderId: ORDER,
    });
    expect(parseCodPayload(cancel)).toEqual({
      action: "cancel",
      orderId: ORDER,
    });
  });

  it("lower-cases the order id, so a tap matches the stored uuid", () => {
    expect(parseCodPayload(`cod:confirm:${ORDER.toUpperCase()}`)?.orderId).toBe(
      ORDER,
    );
  });

  it("★ refuses anything this module did not write", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "",
      "Confirm order",
      `cod:refund:${ORDER}`,
      `cod:confirm:not-a-uuid`,
      `cod:confirm:${ORDER}:extra`,
      `pay:confirm:${ORDER}`,
      `cod:confirm:${ORDER}' or 1=1`,
    ]) {
      expect(parseCodPayload(bad), String(bad)).toBeNull();
    }
  });

  it("names the order a queued row is about, or nothing", () => {
    expect(codOrderFromPayloads(codButtonPayloads(ORDER))).toBe(ORDER);
    expect(codOrderFromPayloads(["x", `cod:cancel:${ORDER}`])).toBe(ORDER);
    expect(codOrderFromPayloads(null)).toBeNull();
    expect(codOrderFromPayloads(["x"])).toBeNull();
    expect(codOrderFromPayloads("cod:confirm:" + ORDER)).toBeNull();
  });
});
