// ---------------------------------------------------------------------------
// The facts sheet and the answer contract: which products a question names,
// what one product line says, the sheet's shape, and what the parser refuses.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  MINK_REPLY_MAX_CHARS,
  allowedUrlsIn,
  factsSummary,
  htmlToText,
  matchProducts,
  parseMinkWhatsAppAnswer,
  pinCodeIn,
  renderHours,
  renderMinkFacts,
  renderProductFact,
  renderRecentMessages,
  type MinkFacts,
  type MinkProductLike,
} from "./mink-facts";
import { DEFAULT_BUSINESS_HOURS } from "./business-hours";

const product = (over: Partial<MinkProductLike> = {}): MinkProductLike => ({
  id: "p1",
  name: "Almond Shake",
  slug: "almond-shake",
  description: "<p>A creamy almond shake, no added sugar.</p>",
  category: "Shakes",
  base_price: 150,
  selling_price: 120,
  track_inventory: true,
  stock: 4,
  low_stock_threshold: null,
  allow_backorder: false,
  returnable: false,
  variants: [],
  ...over,
});

const facts = (over: Partial<MinkFacts> = {}): MinkFacts => ({
  store: {
    name: "Echoss",
    url: "https://echoss.storemink.com",
    email: null,
  },
  hours: null,
  orders: ["Order ORD10011027, placed 12 Oct: On the way with Delhivery."],
  products: [renderProductFact(product(), "https://echoss.storemink.com")],
  delivery: null,
  offers: [],
  policies: [{ title: "Refund & Cancellation Policy", text: "7 days." }],
  recent: [],
  ...over,
});

describe("matchProducts", () => {
  const catalogue = [
    product(),
    product({
      id: "p2",
      name: "Oat Cookies",
      slug: "oat-cookies",
      category: "Snacks",
      description: "Crunchy oats.",
    }),
    product({
      id: "p3",
      name: "Blue Running Shoes",
      slug: "blue-shoes",
      category: "Shoes",
      description: null,
    }),
  ];

  it("finds products by the words a question shares with their name, plural or not", () => {
    expect(
      matchProducts("do you have almond shakes?", catalogue).map((p) => p.id),
    ).toEqual(["p1"]);
    expect(
      matchProducts("price of the cookies", catalogue).map((p) => p.id),
    ).toEqual(["p2"]);
  });

  it("a category word matches too, below a name match", () => {
    expect(
      matchProducts("any shoes in 42?", catalogue).map((p) => p.id),
    ).toEqual(["p3"]);
    // Two name matches tie; the sort is by name.
    expect(
      matchProducts("shakes and cookies", catalogue).map((p) => p.id),
    ).toEqual(["p1", "p2"]);
    // A description match alone counts least.
    expect(
      matchProducts("something crunchy", catalogue).map((p) => p.id),
    ).toEqual(["p2"]);
  });

  it("stopwords alone match nothing, and the list is bounded", () => {
    expect(matchProducts("what is the price", catalogue)).toEqual([]);
    expect(matchProducts("", catalogue)).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) =>
      product({ id: `s${i}`, name: `Shake ${i}`, slug: `s${i}` }),
    );
    expect(matchProducts("shake", many)).toHaveLength(5);
  });
});

describe("renderProductFact", () => {
  it("says the price, the sale, the stock, the return rule and the link", () => {
    const line = renderProductFact(product(), "https://echoss.storemink.com");
    expect(line).toContain("Almond Shake: ₹120 (was ₹150)");
    expect(line).toContain("in stock");
    expect(line).toContain("final sale, not returnable");
    expect(line).toContain("about: A creamy almond shake, no added sugar.");
    expect(line).toContain(
      "link https://echoss.storemink.com/shop/almond-shake",
    );
  });

  it("lists options with their own price and stock, sold-out ones included", () => {
    const line = renderProductFact(
      product({
        variants: [
          {
            id: "v1",
            base_price: 150,
            selling_price: 120,
            special_price: null,
            track_inventory: true,
            stock: 2,
            low_stock_threshold: null,
            allow_backorder: false,
            option_values: ["500 ml"],
          },
          {
            id: "v2",
            base_price: 250,
            selling_price: 220,
            special_price: 200,
            track_inventory: true,
            stock: 0,
            low_stock_threshold: null,
            allow_backorder: false,
            option_values: ["1 L"],
          },
        ],
      }),
      null,
    );
    expect(line).toContain("options: 500 ml ₹120 in stock; 1 L ₹200 sold out");
    expect(line).not.toContain("link ");
  });
});

describe("the sheet", () => {
  it("renders every section, says when a section is empty, and lists only its own links", () => {
    const sheet = renderMinkFacts(facts({ hours: "Mon 10:00 to 19:00." }));
    expect(sheet).toContain("Shop: Echoss.");
    expect(sheet).toContain("Business hours: Mon 10:00 to 19:00.");
    expect(sheet).toContain("THIS CUSTOMER'S ORDERS");
    expect(sheet).toContain("Order ORD10011027");
    expect(sheet).toContain("OFFERS RUNNING NOW: none.");
    expect(sheet).toContain("Refund & Cancellation Policy: 7 days.");
    expect([...allowedUrlsIn(facts())]).toEqual([
      "https://echoss.storemink.com",
      "https://echoss.storemink.com/shop/almond-shake",
    ]);
  });

  it("renders the hours per day, the zone and whether the shop is open", () => {
    const line = renderHours(DEFAULT_BUSINESS_HOURS, "Asia/Kolkata", true);
    expect(line).toContain("Mon 10:00 to 19:00");
    expect(line).toContain("Sun closed");
    expect(line).toContain(
      "Times in Asia/Kolkata. Right now the shop is open.",
    );
  });

  it("the recent exchange is bounded and attributed", () => {
    const recent = renderRecentMessages([
      { who: "customer", text: "  hi \n there " },
      { who: "shop", text: "x".repeat(400) },
    ]);
    expect(recent.split("\n")[0]).toBe("Customer: hi there");
    expect(recent.split("\n")[1]).toHaveLength("Shop: ".length + 300);
    expect(renderRecentMessages([])).toBe("(none)");
  });

  it("★ the staff summary names what was used, never what it said", () => {
    expect(
      factsSummary(facts({ delivery: "x", hours: "y", offers: ["z"] })),
    ).toEqual([
      "Order ORD10011027",
      "Almond Shake",
      "Delivery check",
      "Current offers",
      "Refund & Cancellation Policy",
      "Business hours",
    ]);
  });

  it("htmlToText strips tags and entities and cuts on a word", () => {
    expect(
      htmlToText(
        "<p>Returns within <strong>7</strong> days &amp; refunds.</p>",
        100,
      ),
    ).toBe("Returns within 7 days & refunds.");
    expect(htmlToText("one two three four", 9)).toBe("one two…");
  });

  it("pinCodeIn finds a six-digit PIN and nothing else", () => {
    expect(pinCodeIn("deliver to 560001?")).toBe("560001");
    expect(pinCodeIn("order ORD10011027")).toBeNull();
    expect(pinCodeIn("9876543210")).toBeNull();
  });
});

describe("parseMinkWhatsAppAnswer", () => {
  const allowed = new Set(["https://echoss.storemink.com/shop/almond-shake"]);

  it("accepts the shape and trims markdown out of the reply", () => {
    expect(
      parseMinkWhatsAppAnswer(
        {
          outcome: "answer",
          reply: "  **Yes**, the Almond Shake is ₹120 and in stock. ",
          reason: "price in facts",
        },
        allowed,
      ),
    ).toEqual({
      outcome: "answer",
      reply: "Yes, the Almond Shake is ₹120 and in stock.",
      reason: "price in facts",
    });
  });

  it("refuses anything that is not the shape", () => {
    expect(parseMinkWhatsAppAnswer(null, allowed)).toBeNull();
    expect(parseMinkWhatsAppAnswer("yes", allowed)).toBeNull();
    expect(
      parseMinkWhatsAppAnswer({ outcome: "maybe", reply: "x" }, allowed),
    ).toBeNull();
    expect(
      parseMinkWhatsAppAnswer({ outcome: "answer", reply: 1 }, allowed),
    ).toBeNull();
    expect(
      parseMinkWhatsAppAnswer({ outcome: "answer", reply: "   " }, allowed),
    ).toBeNull();
    expect(
      parseMinkWhatsAppAnswer(
        { outcome: "answer", reply: "ok\u0007" },
        allowed,
      ),
    ).toBeNull();
  });

  it("★ a link not in the facts turns the answer into a hand-over", () => {
    expect(
      parseMinkWhatsAppAnswer(
        {
          outcome: "answer",
          reply: "Pay here: https://evil.example/pay",
          reason: "",
        },
        allowed,
      ),
    ).toEqual({
      outcome: "hand_over",
      reply: "",
      reason: "reply carried a link not in the facts",
    });
    expect(
      parseMinkWhatsAppAnswer(
        {
          outcome: "answer",
          reply: "See https://echoss.storemink.com/shop/almond-shake.",
          reason: "",
        },
        allowed,
      )?.outcome,
    ).toBe("answer");
  });

  it("a template token or an over-long reply hands over", () => {
    expect(
      parseMinkWhatsAppAnswer(
        { outcome: "answer", reply: "Hi {{1}}", reason: "" },
        allowed,
      )?.outcome,
    ).toBe("hand_over");
    expect(
      parseMinkWhatsAppAnswer(
        {
          outcome: "answer",
          reply: "x".repeat(MINK_REPLY_MAX_CHARS + 1),
          reason: "",
        },
        allowed,
      )?.outcome,
    ).toBe("hand_over");
  });

  it("a hand-over may carry an empty reply, and keeps a short one for staff", () => {
    expect(
      parseMinkWhatsAppAnswer(
        { outcome: "hand_over", reply: "", reason: "refund" },
        allowed,
      ),
    ).toEqual({ outcome: "hand_over", reply: "", reason: "refund" });
    expect(
      parseMinkWhatsAppAnswer(
        {
          outcome: "hand_over",
          reply: "Sorry, someone will reply.",
          reason: "refund",
        },
        allowed,
      )?.reply,
    ).toBe("Sorry, someone will reply.");
  });
});
