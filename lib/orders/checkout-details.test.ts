// Is a waiting order the one the shopper is asking for now? (PR #303
// follow-up review, 22 Nov 2026.) The first resume matched on the products
// alone, so a shopper who came back to correct their address, or to switch
// to collection, was handed the old order to pay.
import { describe, expect, it } from "vitest";
import {
  checkoutChanges,
  comparableCode,
  type WaitingOrderDetails,
  type WantedCheckout,
} from "./checkout-details";

const ADDRESS = {
  firstName: "Asha",
  lastName: "Rao",
  addressLine1: "12 MG Road",
  addressLine2: "",
  city: "Bengaluru",
  state: "Karnataka",
  postalCode: "560001",
  country: "India",
  email: "asha@example.com",
  phone: "+919876543210",
};

const order = (
  over: Partial<WaitingOrderDetails> = {},
): WaitingOrderDetails => ({
  shippingAddress: { ...ADDRESS },
  billingAddress: null,
  notes: null,
  appliedCouponCode: null,
  pickupLocationId: null,
  shippingOption: { id: "flat:standard", amount: 60 },
  shipping: "60.00",
  ...over,
});

const wanted = (over: Partial<WantedCheckout> = {}): WantedCheckout => ({
  shippingAddress: { ...ADDRESS },
  billingAddress: null,
  notes: null,
  couponCode: null,
  pickupLocationId: null,
  shippingRateId: "flat:standard",
  shippingAmount: 60,
  ...over,
});

describe("checkoutChanges", () => {
  it("★★ the same choices are the same order: nothing differs", () => {
    expect(checkoutChanges(order(), wanted())).toEqual([]);
    // Text is compared trimmed, and a missing field is an empty one.
    expect(
      checkoutChanges(
        order({ shippingAddress: { ...ADDRESS, addressLine2: null } }),
        wanted({ shippingAddress: { ...ADDRESS, city: " Bengaluru " } }),
      ),
    ).toEqual([]);
    // The page may send no price beside the delivery option.
    expect(checkoutChanges(order(), wanted({ shippingAmount: null }))).toEqual(
      [],
    );
  });

  it("★★ a corrected house number is a different order", () => {
    expect(
      checkoutChanges(
        order(),
        wanted({ shippingAddress: { ...ADDRESS, addressLine1: "21 MG Road" } }),
      ),
    ).toEqual(["address"]);
  });

  it("a changed delivery phone", () => {
    expect(
      checkoutChanges(
        order(),
        wanted({ shippingAddress: { ...ADDRESS, phone: "+919123456789" } }),
      ),
    ).toEqual(["phone"]);
  });

  it("★★ switching a delivery to collection (the review's example)", () => {
    expect(
      checkoutChanges(
        order(),
        wanted({
          pickupLocationId: "loc-1",
          shippingRateId: null,
          shippingAmount: null,
        }),
      ),
    ).toEqual(["fulfilment"]);
    // And back again.
    expect(
      checkoutChanges(
        order({
          pickupLocationId: "loc-1",
          shippingOption: { id: "pickup:free", amount: 0 },
          shipping: 0,
        }),
        wanted(),
      ),
    ).toEqual(["fulfilment"]);
  });

  it("another shop to collect from", () => {
    const collected = order({
      pickupLocationId: "loc-1",
      shippingOption: { id: "pickup:free", amount: 0 },
      shipping: 0,
    });
    const asks = (shop: string) =>
      wanted({
        pickupLocationId: shop,
        shippingRateId: null,
        shippingAmount: null,
      });
    expect(checkoutChanges(collected, asks("loc-2"))).toEqual(["pickup_shop"]);
    // The same shop: a collection has no delivery option to compare.
    expect(checkoutChanges(collected, asks("loc-1"))).toEqual([]);
  });

  it("another delivery option, or the same one at another price", () => {
    expect(
      checkoutChanges(
        order(),
        wanted({ shippingRateId: "flat:express", shippingAmount: 120 }),
      ),
    ).toEqual(["delivery_option", "delivery_price"]);
    expect(checkoutChanges(order(), wanted({ shippingAmount: 80 }))).toEqual([
      "delivery_price",
    ]);
  });

  it("a coupon added, removed or swapped; the same code typed another way is the same", () => {
    expect(checkoutChanges(order(), wanted({ couponCode: "SAVE10" }))).toEqual([
      "coupon",
    ]);
    expect(
      checkoutChanges(order({ appliedCouponCode: "SAVE10" }), wanted()),
    ).toEqual(["coupon"]);
    expect(
      checkoutChanges(
        order({ appliedCouponCode: "SAVE10" }),
        wanted({ couponCode: "SAVE20" }),
      ),
    ).toEqual(["coupon"]);
    expect(
      checkoutChanges(
        order({ appliedCouponCode: " save10 " }),
        wanted({ couponCode: "SAVE10" }),
      ),
    ).toEqual([]);
    expect(comparableCode(" save 10 ")).toBe("SAVE10");
    expect(comparableCode(null)).toBe("");
  });

  it("a billing address added, removed or changed; a note changed", () => {
    const billing = { addressLine1: "4 Park Street", city: "Kolkata" };
    expect(
      checkoutChanges(order(), wanted({ billingAddress: billing })),
    ).toEqual(["billing_address"]);
    expect(
      checkoutChanges(order({ billingAddress: billing }), wanted()),
    ).toEqual(["billing_address"]);
    expect(
      checkoutChanges(
        order({ billingAddress: billing }),
        wanted({ billingAddress: { ...billing, city: "Howrah" } }),
      ),
    ).toEqual(["billing_address"]);
    expect(
      checkoutChanges(
        order({ billingAddress: billing }),
        wanted({ billingAddress: { ...billing } }),
      ),
    ).toEqual([]);
    expect(
      checkoutChanges(order(), wanted({ notes: "Leave at the gate" })),
    ).toEqual(["notes"]);
  });

  it("★★ fails toward CHANGED: an order whose details cannot be read is never the same order", () => {
    expect(checkoutChanges(order({ shippingAddress: null }), wanted())).toEqual(
      expect.arrayContaining(["address", "phone"]),
    );
    expect(
      checkoutChanges(order({ shippingAddress: "12 MG Road" }), wanted()),
    ).toEqual(expect.arrayContaining(["address"]));
    expect(checkoutChanges(order({ shippingOption: null }), wanted())).toEqual([
      "delivery_option",
    ]);
    expect(checkoutChanges(order({ shipping: null }), wanted())).toEqual([
      "delivery_price",
    ]);
  });
});
