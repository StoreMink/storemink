import { describe, expect, it } from "vitest";
import {
  CREDITS_LOW_FRACTION,
  MAX_MINK_HOME_SUGGESTIONS,
  MINK_HOME_SUGGESTION_ORDER,
  SALES_DROP_PERCENT,
  SALES_MIN_BASELINE_ORDERS,
  SUGGESTION_ASK_MAX,
  SUGGESTION_DETAIL_MAX,
  SUGGESTION_HREF_MAX,
  SUGGESTION_TITLE_MAX,
  minkHomeSuggestionLinkLabel,
  rankMinkHomeSuggestions,
  type MinkHomeSignals,
} from "./home-suggestion-rules";

const EM_DASH = "—";

function quiet(overrides: Partial<MinkHomeSignals> = {}): MinkHomeSignals {
  return {
    currency: "INR",
    sales: null,
    staleOrders: null,
    stock: null,
    inbox: null,
    enquiries: null,
    catalogue: null,
    offers: null,
    credits: null,
    ...overrides,
  };
}

/** Every signal firing at once. */
function everything(): MinkHomeSignals {
  return {
    currency: "INR",
    sales: {
      current: 40_000,
      previous: 100_000,
      currentOrders: 8,
      previousOrders: 20,
    },
    staleOrders: { pending: 2, processing: 1 },
    stock: { out: 3, low: 4 },
    inbox: { needsReply: 2 },
    enquiries: { unread: 5 },
    catalogue: { gaps: 6, missingDescription: 4, missingImage: 3, samples: 2 },
    offers: { endingSoon: 1, finished: 1 },
    credits: { remaining: 2, cap: 100 },
  };
}

describe("rankMinkHomeSuggestions", () => {
  it("says nothing when every signal is quiet or hidden", () => {
    expect(rankMinkHomeSuggestions(quiet())).toEqual([]);
    expect(
      rankMinkHomeSuggestions(
        quiet({
          sales: {
            current: 100,
            previous: 100,
            currentOrders: 10,
            previousOrders: 10,
          },
          staleOrders: { pending: 0, processing: 0 },
          stock: { out: 0, low: 0 },
          inbox: { needsReply: 0 },
          enquiries: { unread: 0 },
          catalogue: {
            gaps: 0,
            missingDescription: 0,
            missingImage: 0,
            samples: 0,
          },
          offers: { endingSoon: 0, finished: 0 },
          credits: { remaining: 100, cap: 100 },
        }),
      ),
    ).toEqual([]);
  });

  it("ranks in the fixed severity order and caps at five", () => {
    const out = rankMinkHomeSuggestions(everything());
    expect(out).toHaveLength(MAX_MINK_HOME_SUGGESTIONS);
    expect(out.map((s) => s.id)).toEqual(
      MINK_HOME_SUGGESTION_ORDER.slice(0, MAX_MINK_HOME_SUGGESTIONS),
    );
  });

  it("lets lower-severity suggestions through once the urgent ones are quiet", () => {
    const out = rankMinkHomeSuggestions({
      ...everything(),
      sales: null,
      staleOrders: null,
      stock: null,
    });
    expect(out.map((s) => s.id)).toEqual([
      "inbox_needs_reply",
      "enquiries_new",
      "product_gaps",
      "sample_products",
      "offers_attention",
    ]);
    const tail = rankMinkHomeSuggestions(
      quiet({ credits: { remaining: 2, cap: 100 } }),
    );
    expect(tail.map((s) => s.id)).toEqual(["credits_low"]);
  });

  it("is deterministic for the same input", () => {
    expect(rankMinkHomeSuggestions(everything())).toEqual(
      rankMinkHomeSuggestions(everything()),
    );
  });

  describe("sales threshold", () => {
    const base = { currentOrders: 6, previousOrders: 10, previous: 100 };

    it("flags a drop at exactly the threshold and not one point under", () => {
      expect(
        rankMinkHomeSuggestions(
          quiet({ sales: { ...base, current: 100 - SALES_DROP_PERCENT } }),
        ).map((s) => s.id),
      ).toEqual(["sales_down"]);
      expect(
        rankMinkHomeSuggestions(
          quiet({ sales: { ...base, current: 100 - SALES_DROP_PERCENT + 1 } }),
        ),
      ).toEqual([]);
    });

    it("needs a baseline of at least five orders, not a current one", () => {
      expect(
        rankMinkHomeSuggestions(
          quiet({
            sales: {
              current: 10,
              previous: 100,
              currentOrders: 1,
              previousOrders: SALES_MIN_BASELINE_ORDERS - 1,
            },
          }),
        ),
      ).toEqual([]);
      // A week that collapsed to nothing is exactly the case to flag.
      expect(
        rankMinkHomeSuggestions(
          quiet({
            sales: {
              current: 0,
              previous: 100,
              currentOrders: 0,
              previousOrders: SALES_MIN_BASELINE_ORDERS,
            },
          }),
        ).map((s) => s.id),
      ).toEqual(["sales_down"]);
    });

    it("ignores growth and an empty baseline", () => {
      expect(
        rankMinkHomeSuggestions(quiet({ sales: { ...base, current: 150 } })),
      ).toEqual([]);
      expect(
        rankMinkHomeSuggestions(
          quiet({
            sales: {
              current: 0,
              previous: 0,
              currentOrders: 0,
              previousOrders: 9,
            },
          }),
        ),
      ).toEqual([]);
    });

    it("writes the drop, both totals and the analytics link", () => {
      const [s] = rankMinkHomeSuggestions(
        quiet({
          sales: {
            current: 40_000,
            previous: 100_000,
            currentOrders: 8,
            previousOrders: 20,
          },
        }),
      );
      expect(s.title).toBe("Sales are down 60% on the week before");
      expect(s.detail).toContain("₹40,000");
      expect(s.detail).toContain("₹1,00,000");
      expect(s.detail).toContain("8 orders");
      expect(s.href).toBe("/dashboard/analytics?range=7d&compare=previous");
      expect(s.askMink).toContain("down 60%");
    });

    it("survives an unknown currency code", () => {
      const [s] = rankMinkHomeSuggestions(
        quiet({
          currency: "NOPE",
          sales: {
            current: 40,
            previous: 100,
            currentOrders: 8,
            previousOrders: 20,
          },
        }),
      );
      expect(s.detail).toContain("NOPE 40");
    });
  });

  describe("orders, stock, inbox and enquiries wording", () => {
    it("points stale orders at the pending list first, then processing", () => {
      const [pending] = rankMinkHomeSuggestions(
        quiet({ staleOrders: { pending: 1, processing: 2 } }),
      );
      expect(pending.title).toBe("3 orders have waited over 48 hours");
      expect(pending.detail).toContain(
        "1 still pending and 2 still processing",
      );
      expect(pending.href).toBe("/dashboard/orders?status=pending");

      const [processing] = rankMinkHomeSuggestions(
        quiet({ staleOrders: { pending: 0, processing: 1 } }),
      );
      expect(processing.title).toBe("1 order has waited over 48 hours");
      expect(processing.href).toBe("/dashboard/orders?status=processing");
    });

    it("splits stock into out and low, each with its inventory filter", () => {
      const out = rankMinkHomeSuggestions(quiet({ stock: { out: 1, low: 2 } }));
      expect(out.map((s) => [s.id, s.title, s.href])).toEqual([
        [
          "out_of_stock",
          "1 item is out of stock",
          "/dashboard/inventory?filter=out",
        ],
        [
          "low_stock",
          "2 items are running low",
          "/dashboard/inventory?filter=low",
        ],
      ]);
    });

    it("counts chats and enquiries with the right verb", () => {
      const [chat] = rankMinkHomeSuggestions(
        quiet({ inbox: { needsReply: 1 } }),
      );
      expect(chat.title).toBe("1 WhatsApp chat needs a reply");
      const [chats] = rankMinkHomeSuggestions(
        quiet({ inbox: { needsReply: 4 } }),
      );
      expect(chats.title).toBe("4 WhatsApp chats need a reply");
      const [enquiry] = rankMinkHomeSuggestions(
        quiet({ enquiries: { unread: 1 } }),
      );
      expect(enquiry.title).toBe("1 new enquiry is waiting");
      expect(enquiry.href).toBe("/dashboard/enquiries?status=new");
    });
  });

  describe("catalogue and offers wording", () => {
    it("describes which gap a product has", () => {
      const [photos] = rankMinkHomeSuggestions(
        quiet({
          catalogue: {
            gaps: 2,
            missingDescription: 0,
            missingImage: 2,
            samples: 0,
          },
        }),
      );
      expect(photos.title).toBe(
        "2 published products are missing a photo or description",
      );
      expect(photos.detail).toContain("2 without a photo");
      expect(photos.detail).not.toContain("without a description");

      const [both] = rankMinkHomeSuggestions(
        quiet({
          catalogue: {
            gaps: 3,
            missingDescription: 1,
            missingImage: 2,
            samples: 0,
          },
        }),
      );
      expect(both.detail).toContain(
        "2 without a photo and 1 without a description",
      );
    });

    it("flags sample products on their own", () => {
      const [s] = rankMinkHomeSuggestions(
        quiet({
          catalogue: {
            gaps: 0,
            missingDescription: 0,
            missingImage: 0,
            samples: 1,
          },
        }),
      );
      expect(s.id).toBe("sample_products");
      expect(s.title).toBe("1 sample product is still in your catalogue");
      expect(s.href).toBe("/dashboard/products?q=Sample");
    });

    it("words offers by what needs deciding", () => {
      const [ending] = rankMinkHomeSuggestions(
        quiet({ offers: { endingSoon: 2, finished: 0 } }),
      );
      expect(ending.title).toBe("2 offers end within 3 days");
      const [finished] = rankMinkHomeSuggestions(
        quiet({ offers: { endingSoon: 0, finished: 1 } }),
      );
      expect(finished.title).toBe("1 offer has run out but is still on");
      const [mixed] = rankMinkHomeSuggestions(
        quiet({ offers: { endingSoon: 1, finished: 2 } }),
      );
      expect(mixed.title).toBe("3 offers need a decision");
      expect(mixed.href).toBe("/dashboard/offers");
    });
  });

  describe("credits threshold", () => {
    it("flags under ten percent, not at it, and never an unmetered plan", () => {
      const cap = 100;
      const atThreshold = cap * CREDITS_LOW_FRACTION;
      expect(
        rankMinkHomeSuggestions(
          quiet({ credits: { remaining: atThreshold, cap } }),
        ),
      ).toEqual([]);
      const [s] = rankMinkHomeSuggestions(
        quiet({ credits: { remaining: atThreshold - 1, cap } }),
      );
      expect(s.id).toBe("credits_low");
      expect(s.detail).toContain("9 of 100 credits left");
      expect(s.href).toBe("/dashboard/plans");
      expect(
        rankMinkHomeSuggestions(quiet({ credits: { remaining: 0, cap: 0 } })),
      ).toEqual([]);
    });
  });

  describe("wording contract", () => {
    it("never uses an em dash and stays inside the length bounds", () => {
      const out = rankMinkHomeSuggestions(everything());
      const more = rankMinkHomeSuggestions({
        ...everything(),
        sales: null,
        staleOrders: null,
        stock: null,
        inbox: null,
        enquiries: null,
      });
      for (const s of [...out, ...more]) {
        for (const text of [s.id, s.title, s.detail, s.href, s.askMink]) {
          expect(text).not.toContain(EM_DASH);
          expect(text.length).toBeGreaterThan(0);
        }
        expect(s.title.length).toBeLessThanOrEqual(SUGGESTION_TITLE_MAX);
        expect(s.detail.length).toBeLessThanOrEqual(SUGGESTION_DETAIL_MAX);
        expect(s.href.length).toBeLessThanOrEqual(SUGGESTION_HREF_MAX);
        expect(s.askMink.length).toBeLessThanOrEqual(SUGGESTION_ASK_MAX);
        expect(s.href.startsWith("/dashboard/")).toBe(true);
      }
    });

    it("clips a runaway number rather than overflowing the card", () => {
      const [s] = rankMinkHomeSuggestions(
        quiet({ staleOrders: { pending: 10 ** 15, processing: 10 ** 15 } }),
      );
      expect(s.title.length).toBeLessThanOrEqual(SUGGESTION_TITLE_MAX);
    });
  });
});

describe("minkHomeSuggestionLinkLabel", () => {
  it("names the destination with a short verb", () => {
    expect(minkHomeSuggestionLinkLabel("/dashboard/inventory?filter=out")).toBe(
      "Open inventory",
    );
    expect(
      minkHomeSuggestionLinkLabel("/dashboard/orders?status=pending"),
    ).toBe("Open orders");
    expect(
      minkHomeSuggestionLinkLabel(
        "/dashboard/analytics?range=7d&compare=previous",
      ),
    ).toBe("Open analytics");
    expect(minkHomeSuggestionLinkLabel("/dashboard/inbox")).toBe("Open inbox");
    expect(minkHomeSuggestionLinkLabel("/dashboard/enquiries?status=new")).toBe(
      "Open enquiries",
    );
    expect(minkHomeSuggestionLinkLabel("/dashboard/products?q=Sample")).toBe(
      "Open products",
    );
    expect(minkHomeSuggestionLinkLabel("/dashboard/offers")).toBe(
      "Open offers",
    );
    expect(minkHomeSuggestionLinkLabel("/dashboard/plans")).toBe("Open plan");
    expect(minkHomeSuggestionLinkLabel("/dashboard/somewhere-else")).toBe(
      "Open",
    );
  });

  it("does not confuse a prefix with a sibling route", () => {
    expect(minkHomeSuggestionLinkLabel("/dashboard/ordersx")).toBe("Open");
  });
});
