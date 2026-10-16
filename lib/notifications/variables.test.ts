import { describe, expect, it } from "vitest";
import { EVENTS } from "./events";
import { formatVariable } from "./format";
import {
  sampleValuesFor,
  variableNamesFor,
  variablesFor,
  withVariableFallbacks,
} from "./variables";

// The amount a COD customer pays. Store credit is a payment, so it never
// lowers orders.total (CODEBASE §29), and "Amount to pay on delivery" quoting
// the total told a customer with ₹200 of credit on a ₹500 order to pay ₹500.

describe("amount_due on order.placed", () => {
  it("is declared beside the total, sampled as money", () => {
    const amountDue = variablesFor("order.placed").find(
      (v) => v.name === "amount_due",
    );
    expect(amountDue).toBeDefined();
    expect(amountDue?.sample).toBe(formatVariable("amount_due", 1240));
    expect(sampleValuesFor("order.placed").amount_due).toBe("₹1,240.00");
  });

  it("★ falls back to the total, which carries no credit to take off", () => {
    const amountDue = variablesFor("order.placed").find(
      (v) => v.name === "amount_due",
    );
    expect(amountDue?.fallback).toBe("total");
  });

  it("is offered only where the emitter carries it", () => {
    expect(variableNamesFor("order.placed").has("amount_due")).toBe(true);
    expect(variableNamesFor("order.cancelled").has("amount_due")).toBe(false);
  });
});

describe("withVariableFallbacks", () => {
  it("★★ an event without amount_due reads the total instead of a blank", () => {
    // Emitted before checkout carried amountDue, or by another emitter.
    expect(
      withVariableFallbacks("order.placed", { total: "₹500.00" }).amount_due,
    ).toBe("₹500.00");
    // Blank is what a WhatsApp parameter would print as "-".
    expect(
      withVariableFallbacks("order.placed", {
        total: "₹500.00",
        amount_due: "  ",
      }).amount_due,
    ).toBe("₹500.00");
  });

  it("★ never overrides an amount the event carried", () => {
    expect(
      withVariableFallbacks("order.placed", {
        total: "₹500.00",
        amount_due: "₹300.00",
      }).amount_due,
    ).toBe("₹300.00");
  });

  it("invents nothing when the fallback is missing too", () => {
    expect(withVariableFallbacks("order.placed", {})).toEqual({});
    expect(
      withVariableFallbacks("order.placed", { total: "" }),
    ).not.toHaveProperty("amount_due");
  });

  it("returns a new map and leaves its input alone", () => {
    const values = { total: "₹500.00" };
    const out = withVariableFallbacks("order.placed", values);
    expect(out).not.toBe(values);
    expect(values).toEqual({ total: "₹500.00" });
  });

  it("changes nothing for an event that declares no fallback", () => {
    const values = { refund_due: "₹40.00" };
    expect(withVariableFallbacks("order.cancelled", values)).toEqual(values);
  });

  // The formatted text is what is copied, so a fallback between two
  // variables formatted differently would print one in the other's shape.
  it("★ every fallback names another variable of its event, formatted alike", () => {
    let fallbacks = 0;
    for (const def of EVENTS) {
      const names = variableNamesFor(def.key);
      for (const v of variablesFor(def.key)) {
        if (!v.fallback) continue;
        fallbacks++;
        const where = `${def.key}/${v.name}`;
        expect(v.fallback, where).not.toBe(v.name);
        expect(names.has(v.fallback), where).toBe(true);
        expect(formatVariable(v.name, 1240.5), where).toBe(
          formatVariable(v.fallback, 1240.5),
        );
      }
    }
    expect(fallbacks).toBeGreaterThan(0);
  });
});
