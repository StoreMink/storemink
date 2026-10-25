import { describe, expect, it } from "vitest";
import {
  cleanRevampCopy,
  copyIssues,
  hasLongDash,
  isEnglish,
  latinLetterShare,
  readsAsLanguage,
  revampClaimEvidence,
  revampStoreNames,
  unsupportedClaimsIn,
  withoutStoreNames,
  withoutUnsupportedClaims,
} from "./copy-checks";
import type { RevampRequest, RevampSnapshot } from "./contract";

const request: Pick<RevampRequest, "brief" | "products" | "instruction"> = {
  brief: {
    business: "We press mustard oil in our own mill in Alwar",
    look: "warm and earthy",
    audience: "home cooks",
    facts: ["Cold pressed in a wooden kachi ghani", "Family run since 1998"],
    avoid: "Do not call it organic",
    language: "English",
  },
  products: [
    {
      key: "p1",
      name: "Pure Kachi Ghani Mustard Oil",
      description: "Pungent, cold pressed oil for everyday cooking.",
      sizes: [{ label: "1 L", price: 240, mrp: null }],
      photoUrl: null,
      categorySlug: null,
    },
  ],
  instruction: null,
};

const STORE = {
  storeName: "Alwar Oils",
  products: [],
  categories: [],
  facts: {} as RevampSnapshot["facts"],
};
const evidence = revampClaimEvidence({ ...request, categories: [] }, STORE);

describe("latinLetterShare", () => {
  it("is 1 for English and for text without letters", () => {
    expect(latinLetterShare("Cold pressed mustard oil")).toBe(1);
    expect(latinLetterShare("₹240 · 1 L")).toBe(1);
    expect(latinLetterShare("")).toBe(1);
  });

  it("drops for Devanagari and Gurmukhi", () => {
    expect(latinLetterShare("सरसों का तेल")).toBe(0);
    expect(latinLetterShare("ਸਰ੍ਹੋਂ ਦਾ ਤੇਲ")).toBe(0);
    expect(latinLetterShare("Mustard oil सरसों")).toBeLessThan(0.9);
  });
});

describe("readsAsLanguage", () => {
  it("holds English fields to the Latin share and leaves other languages alone", () => {
    expect(readsAsLanguage("Fresh from our mill", "English")).toBe(true);
    expect(readsAsLanguage("सरसों का तेल", "English")).toBe(false);
    expect(readsAsLanguage("सरसों का तेल", "Hindi")).toBe(true);
    expect(isEnglish("")).toBe(true);
    expect(isEnglish("english ")).toBe(true);
    expect(isEnglish("Punjabi")).toBe(false);
  });
});

describe("unsupportedClaimsIn", () => {
  it("keeps a claim the merchant made", () => {
    // "pure" is in the product name, "1998" in the facts.
    expect(
      unsupportedClaimsIn("Pure mustard oil since 1998.", evidence),
    ).toEqual([]);
    expect(
      unsupportedClaimsIn("Traditional kachi ghani, cold pressed.", evidence),
    ).toEqual(["traditional"]);
  });

  it("refuses food claims the merchant never made", () => {
    expect(
      unsupportedClaimsIn("100% natural and chemical-free.", evidence),
    ).toEqual(["100%", "natural", "chemical-free"]);
    expect(unsupportedClaimsIn("Good for your heart.", evidence)).toEqual([
      "heart",
    ]);
    expect(
      unsupportedClaimsIn("Organic goodness in every drop", evidence),
    ).toEqual(["organic"]);
  });

  it("does not read the merchant's own avoid list as a claim they made", () => {
    expect(evidence).not.toContain("Do not call it organic");
  });

  it("reads a claim only where the words make one", () => {
    expect(unsupportedClaimsIn("Shop our best sellers", evidence)).toEqual([]);
    expect(unsupportedClaimsIn("Made with heart in Alwar", evidence)).toEqual(
      [],
    );
    expect(unsupportedClaimsIn("The best oil in town", evidence)).toEqual([
      "best",
    ]);
  });

  it("includes Theme Studio's marketing claims", () => {
    expect(unsupportedClaimsIn("Award-winning oil", evidence)).toContain(
      "award",
    );
    expect(unsupportedClaimsIn("Trusted by 5,000 families", evidence)).toEqual([
      "a customer count",
    ]);
    expect(unsupportedClaimsIn("Since 1998", evidence)).toEqual([]);
    expect(unsupportedClaimsIn("Since 1987", evidence)).toEqual([
      "a founding year",
    ]);
  });
});

describe("copyIssues", () => {
  it("names every problem with where it is", () => {
    const issues = copyIssues("Naturally pure — 100% organic", {
      evidence,
      language: "English",
      where: "The homepage hero heading",
    });
    expect(issues.map((issue) => issue.kind)).toEqual(["dash", "claim"]);
    expect(issues[1]!.detail).toContain("The homepage hero heading");
    expect(issues[1]!.detail).toContain('"natural"');
  });

  it("flags a field written in another script", () => {
    const issues = copyIssues("सरसों का शुद्ध तेल", {
      evidence,
      language: "English",
      where: "The About page heading",
    });
    expect(issues.map((issue) => issue.kind)).toEqual(["language"]);
  });

  it("finds nothing wrong with empty text", () => {
    expect(
      copyIssues("  ", { evidence, language: "English", where: "x" }),
    ).toEqual([]);
  });
});

describe("cleanRevampCopy and withoutUnsupportedClaims", () => {
  it("rewrites long dashes and tidies spaces", () => {
    expect(cleanRevampCopy("Pressed  — then bottled ")).not.toMatch(/[–—]/);
    expect(hasLongDash(cleanRevampCopy("2–4 days"))).toBe(false);
  });

  it("★ keeps no angle bracket in plain-text copy, so no field can carry markup (f-7)", () => {
    // Defence in depth after the JSON-LD escaping fix: a tagline, a product's
    // copy or a menu label is text, never HTML.
    expect(cleanRevampCopy("Fresh > frozen, always")).toBe(
      "Fresh frozen, always",
    );
    const tag = cleanRevampCopy(
      "Mustard oil <img src=x onerror=alert(1)> from Alwar </script>",
    );
    expect(tag).not.toMatch(/[<>]/);
    expect(tag).toBe(
      "Mustard oil img src=x onerror=alert(1) from Alwar /script",
    );
    // Lines stay lines.
    expect(cleanRevampCopy("One <\nTwo")).toBe("One\nTwo");
  });

  it("drops only the sentences that make an unsupported claim", () => {
    const result = withoutUnsupportedClaims(
      "Cold pressed in our own mill. It is 100% natural. Ships in 2 days.",
      evidence,
    );
    expect(result.text).toBe("Cold pressed in our own mill. Ships in 2 days.");
    expect(result.removed).toEqual(["100%", "natural"]);
  });

  it("returns empty text when every sentence was a claim", () => {
    expect(withoutUnsupportedClaims("Organic. Natural.", evidence).text).toBe(
      "",
    );
  });
});

describe("revampClaimEvidence: one evidence for the compiler and the checks (output-3)", () => {
  const product = (name: string, sample: boolean) => ({
    id: name,
    name,
    slug: name.toLowerCase().replace(/\W+/g, "-"),
    status: "published",
    updatedAt: "t",
    sample,
    imageUrl: null,
    categoryId: null,
  });
  const category = (name: string, sample: boolean) => ({
    id: name,
    slug: name.toLowerCase().replace(/\W+/g, "-"),
    name,
    description: null,
    imageUrl: null,
    status: "active",
    updatedAt: "t",
    sample,
    productCount: 1,
  });
  const store = {
    storeName: "Alwar Oils",
    products: [
      product("Organic Mustard Oil", false),
      product("Award Honey (Sample)", false),
      product("Certified Jam", true),
    ],
    categories: [
      category("Pure Ghee", false),
      category("Healthy Snacks", true),
    ],
    facts: {
      delivery: "Fresh produce delivered every morning",
      returns: null,
      freeDeliveryAbove: 999,
      city: "Alwar",
      state: "Rajasthan",
    } as unknown as RevampSnapshot["facts"],
  };
  const full = revampClaimEvidence(
    {
      ...request,
      categories: [
        {
          action: "create",
          name: "Natural Soaps",
          slug: null,
          description: "Handmade in our workshop",
          newPhoto: false,
        },
        { action: "hide", slug: "healthy-snacks" },
      ],
    },
    store,
  );

  it("★★ takes the store's own catalogue, the confirmed category changes and the store's facts", () => {
    expect(unsupportedClaimsIn("Organic Mustard Oil", full)).toEqual([]);
    expect(unsupportedClaimsIn("Pure Ghee for every kitchen", full)).toEqual(
      [],
    );
    expect(unsupportedClaimsIn("Natural Soaps, handmade", full)).toEqual([]);
    expect(
      unsupportedClaimsIn("Fresh produce delivered every morning", full),
    ).toEqual([]);
    expect(full).toContain("Alwar Oils");
  });

  it("never takes a theme sample's words or the avoid list", () => {
    expect(unsupportedClaimsIn("Healthy snacks", full)).toContain("healthy");
    expect(unsupportedClaimsIn("Certified jam", full)).toContain("certified");
    expect(unsupportedClaimsIn("Award honey", full)).toContain("award");
    expect(full).not.toContain("Do not call it organic");
  });
});

describe("revampStoreNames: one list of names for the compiler and the checks (output-4)", () => {
  const names = revampStoreNames(
    {
      products: [{ ...request.products[0], name: " काजू कतली " }],
      categories: [
        {
          action: "create",
          name: "मिठाई",
          slug: null,
          description: null,
          newPhoto: false,
        },
        { action: "hide", slug: "old" },
      ],
    },
    {
      storeName: "मिठाई घर",
      products: [
        {
          id: "x",
          name: "Barfi (Sample)",
          slug: "barfi",
          status: "draft",
          updatedAt: "t",
          sample: true,
          imageUrl: null,
          categoryId: null,
        },
      ],
      categories: [],
    },
  );

  it("names the shop, its products and categories, longest first, trimmed", () => {
    expect(names).toEqual(["Barfi (Sample)", "काजू कतली", "मिठाई घर", "मिठाई"]);
  });

  it("★ takes the longer name out first, so a shorter one cannot split it", () => {
    expect(withoutStoreNames("Welcome to मिठाई घर", names).trim()).toBe(
      "Welcome to",
    );
    expect(
      readsAsLanguage(withoutStoreNames("Our काजू कतली", names), "English"),
    ).toBe(true);
    expect(
      readsAsLanguage(
        withoutStoreNames("मिठाई घर में स्वागत", names),
        "English",
      ),
    ).toBe(false);
  });
});
