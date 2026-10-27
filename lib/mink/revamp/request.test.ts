import { describe, expect, it } from "vitest";
import { REVAMP_LIMITS } from "./contract";
import {
  REVAMP_REQUEST_LIMITS as L,
  keyRefinementProducts,
  readRevampRequest,
  revampChainCarry,
  revampRefinementStale,
  revampRequestToWire,
} from "./request";

const PHOTO = "https://storage.googleapis.com/bucket/stores/s/media/jar.webp";

const brief = () => ({
  business: "  Handmade soy candles for gifting  ",
  look: "warm and minimal",
  audience: "young professionals",
  facts: ["Poured in Pune", "  ", "Cotton wicks"],
  avoid: "neon colours",
  language: "",
});

const product = (overrides: Record<string, unknown> = {}) => ({
  name: "Lavender jar",
  description: "Calming lavender in a glass jar.",
  sizes: [{ label: "", price: 499, mrp: 599 }],
  photo_url: PHOTO,
  category_slug: "Candles",
  ...overrides,
});

const full = (overrides: Record<string, unknown> = {}) => ({
  brief: brief(),
  products: [product()],
  ...overrides,
});

const refine = (overrides: Record<string, unknown> = {}) => ({
  ...full(),
  instruction: "Make it warmer",
  refine_scope: { design: true },
  ...overrides,
});

function issuesOf(
  input: Record<string, unknown>,
  kind: "full" | "refine" = "full",
): string[] {
  const read = readRevampRequest(input, kind);
  return read.ok ? [] : read.issues;
}

function valueOf(input: Record<string, unknown>, kind: "full" | "refine") {
  const read = readRevampRequest(input, kind);
  if (!read.ok) throw new Error(read.issues.join("\n"));
  return read.value;
}

describe("readRevampRequest: a full redesign", () => {
  it("reads a valid request into exactly what the job stores", () => {
    const value = valueOf(full(), "full");
    expect(value).toEqual({
      kind: "full",
      brief: {
        business: "Handmade soy candles for gifting",
        look: "warm and minimal",
        audience: "young professionals",
        facts: ["Poured in Pune", "Cotton wicks"],
        avoid: "neon colours",
        language: "English",
      },
      products: [
        {
          key: "p1",
          name: "Lavender jar",
          description: "Calming lavender in a glass jar.",
          sizes: [{ label: "", price: 499, mrp: 599 }],
          photoUrl: PHOTO,
          categorySlug: "candles",
        },
      ],
      categories: [],
      pages: null,
      instruction: null,
      refineScope: null,
    });
  });

  it("normalises text with NFKC and keeps the merchant's language", () => {
    const value = valueOf(
      full({
        brief: { business: "ＣＡＮＤＬＥＳ for gifting", language: " Hindi " },
      }),
      "full",
    );
    expect(value.brief.business).toBe("CANDLES for gifting");
    expect(value.brief.language).toBe("Hindi");
  });

  it("numbers products by position and ignores a refinement's fields", () => {
    const value = valueOf(
      full({
        products: [product(), product({ name: "Rose jar" })],
        instruction: "x",
        refine_scope: {},
      }),
      "full",
    );
    expect(value.products.map((entry) => entry.key)).toEqual(["p1", "p2"]);
    expect(value.instruction).toBeNull();
    expect(value.refineScope).toBeNull();
  });

  it("asks for the brief and for what the store sells", () => {
    expect(issuesOf({})).toEqual([
      "brief is required: give brief.business, what the store sells and who buys it, in the merchant's words.",
    ]);
    expect(issuesOf({ brief: { look: "warm" } })).toEqual([
      "brief.business (what the store sells and who buys it) is required: ask the merchant if you do not know.",
    ]);
    expect(issuesOf({ brief: { business: "ab" } })).toEqual([
      "brief.business (what the store sells and who buys it) must be at least 3 characters.",
    ]);
  });

  it("bounds every brief field", () => {
    const issues = issuesOf({
      brief: {
        business: "b".repeat(L.business + 1),
        look: "l".repeat(L.look + 1),
        audience: "a".repeat(L.audience + 1),
        avoid: "v".repeat(L.avoid + 1),
        language: "g".repeat(L.language + 1),
      },
    });
    expect(issues).toEqual([
      `brief.business (what the store sells and who buys it) must be ${L.business} characters or fewer.`,
      `brief.look must be ${L.look} characters or fewer.`,
      `brief.audience must be ${L.audience} characters or fewer.`,
      `brief.avoid must be ${L.avoid} characters or fewer.`,
      `brief.language must be ${L.language} characters or fewer.`,
    ]);
    expect(
      valueOf(
        {
          brief: { business: "b".repeat(L.business), look: "l".repeat(L.look) },
        },
        "full",
      ).brief.look,
    ).toHaveLength(L.look);
    expect(issuesOf({ brief: { business: "Candles", look: 5 } })).toEqual([
      "brief.look must be text.",
    ]);
  });

  it("bounds the facts", () => {
    expect(issuesOf({ brief: { business: "Candles", facts: "Pune" } })).toEqual(
      ["brief.facts must be a list of short true statements."],
    );
    expect(
      issuesOf({
        brief: {
          business: "Candles",
          facts: Array.from({ length: L.facts + 1 }, (_, i) => `fact ${i}`),
        },
      }),
    ).toEqual([`brief.facts holds at most ${L.facts} statements.`]);
    expect(
      issuesOf({
        brief: {
          business: "Candles",
          facts: ["ok", "f".repeat(L.fact + 1), 3],
        },
      }),
    ).toEqual([
      `brief.facts[1] must be ${L.fact} characters or fewer.`,
      "brief.facts[2] must be text.",
    ]);
  });
});

describe("readRevampRequest: products", () => {
  it("refuses a list that is not one, or too long", () => {
    expect(issuesOf(full({ products: "jar" }))).toEqual([
      "products must be a list of the merchant's own products, or left out.",
    ]);
    const many = Array.from({ length: REVAMP_LIMITS.maxProducts + 1 }, (_, i) =>
      product({ name: `Jar ${i}` }),
    );
    expect(issuesOf(full({ products: many }))).toEqual([
      `products holds at most ${REVAMP_LIMITS.maxProducts} products in one redesign: add the rest later.`,
    ]);
    expect(valueOf(full({ products: null }), "full").products).toEqual([]);
  });

  it("needs a name, bounds the words and refuses a repeated name", () => {
    expect(issuesOf(full({ products: ["jar"] }))).toEqual([
      "products[0] must be a product with a name and its sizes.",
    ]);
    expect(
      issuesOf(
        full({
          products: [
            product({ name: "  " }),
            product({ name: "n".repeat(L.productName + 1) }),
            product({ description: "d".repeat(L.productDescription + 1) }),
            product({ name: "LAVENDER JAR" }),
          ],
        }),
      ),
    ).toEqual([
      "products[0].name is required: ask the merchant if you do not know.",
      `products[1].name must be ${L.productName} characters or fewer.`,
      `products[2].description must be ${L.productDescription} characters or fewer.`,
      "products[3].name repeats products[2]: each product needs its own name.",
    ]);
  });

  it("needs one to eight sizes, named when there is more than one", () => {
    expect(issuesOf(full({ products: [product({ sizes: [] })] }))).toEqual([
      "products[0].sizes needs at least one size with its price: ask the merchant for the price.",
    ]);
    expect(
      issuesOf(full({ products: [product({ sizes: undefined })] })),
    ).toEqual([
      "products[0].sizes needs at least one size with its price: ask the merchant for the price.",
    ]);
    const sizes = Array.from(
      { length: REVAMP_LIMITS.maxSizes + 1 },
      (_, i) => ({
        label: `S${i}`,
        price: 100,
      }),
    );
    expect(issuesOf(full({ products: [product({ sizes })] }))).toEqual([
      `products[0].sizes holds at most ${REVAMP_LIMITS.maxSizes} sizes.`,
    ]);
    expect(
      issuesOf(
        full({
          products: [
            product({
              sizes: [
                { label: "", price: 100 },
                { label: "Large", price: 200 },
                { label: "large", price: 250 },
                "x",
              ],
            }),
          ],
        }),
      ),
    ).toEqual([
      "products[0].sizes[3] must be a size with a label and a price.",
      "products[0].sizes[0].label is required when a product has more than one size.",
      "products[0].sizes[2].label repeats another size: each size needs its own label.",
      "products[0].sizes[3].label is required when a product has more than one size.",
    ]);
    expect(
      issuesOf(
        full({
          products: [
            product({
              sizes: [{ label: "l".repeat(L.sizeLabel + 1), price: 9 }],
            }),
          ],
        }),
      ),
    ).toEqual([
      `products[0].sizes[0].label must be ${L.sizeLabel} characters or fewer.`,
    ]);
  });

  it("holds prices to real rupee amounts", () => {
    const priced = (price: unknown, mrp?: unknown) =>
      issuesOf(
        full({ products: [product({ sizes: [{ label: "", price, mrp }] })] }),
      );
    expect(priced("499")).toEqual([
      "products[0].sizes[0].price must be a number of rupees, such as 499.",
    ]);
    expect(priced(0)).toEqual([
      "products[0].sizes[0].price must be more than 0.",
    ]);
    expect(priced(-5)).toEqual([
      "products[0].sizes[0].price must be more than 0.",
    ]);
    expect(priced(L.maxPrice + 1)).toEqual([
      "products[0].sizes[0].price must be ₹1,00,00,000 or less.",
    ]);
    expect(priced(19.999)).toEqual([
      "products[0].sizes[0].price can have at most two decimal places.",
    ]);
    expect(priced(19.99)).toEqual([]);
    expect(priced(L.maxPrice)).toEqual([]);
    expect(priced(500, 400)).toEqual([
      "products[0].sizes[0].mrp must be at least the price, or left out.",
    ]);
    expect(priced(500, 500)).toEqual([]);
    expect(priced(500, null)).toEqual([]);
    expect(priced(500, "600")).toEqual([
      "products[0].sizes[0].mrp must be a number of rupees, such as 499.",
    ]);
  });

  it("takes only an https photo address, or none", () => {
    const photo = (photo_url: unknown) =>
      issuesOf(full({ products: [product({ photo_url })] }));
    const message =
      "products[0].photo_url must be the https address of a photo the merchant attached in this chat, or null.";
    expect(photo("http://example.com/a.jpg")).toEqual([message]);
    expect(photo("https://user:pw@example.com/a.jpg")).toEqual([message]);
    expect(photo("not a url")).toEqual([message]);
    expect(photo(42)).toEqual([message]);
    expect(photo(`https://example.com/${"a".repeat(L.photoUrl)}`)).toEqual([
      message,
    ]);
    expect(photo(null)).toEqual([]);
    expect(
      valueOf(full({ products: [product({ photo_url: "  " })] }), "full")
        .products[0].photoUrl,
    ).toBeNull();
  });

  it("takes a category slug or none", () => {
    const slug = (category_slug: unknown) =>
      issuesOf(full({ products: [product({ category_slug })] }));
    const message =
      'products[0].category_slug must be a category slug such as "mens-shoes", or null.';
    expect(slug("Mens Shoes")).toEqual([message]);
    expect(slug("a".repeat(L.categorySlug + 1))).toEqual([message]);
    expect(slug(7)).toEqual([message]);
    expect(slug(null)).toEqual([]);
  });
});

describe("readRevampRequest: categories and pages", () => {
  it("takes only changes the merchant confirmed, through the v1 rules", () => {
    expect(issuesOf(full({ categories: "all" }))).toEqual([
      "categories must be a list of the changes the merchant agreed to, or left out.",
    ]);
    const many = Array.from(
      { length: REVAMP_LIMITS.maxCategoryChanges + 1 },
      () => ({ action: "hide", slug: "old", merchant_confirmed: true }),
    );
    expect(issuesOf(full({ categories: many }))).toEqual([
      `categories holds at most ${REVAMP_LIMITS.maxCategoryChanges} changes.`,
    ]);
    expect(
      issuesOf(full({ categories: [{ action: "create", name: "Gifts" }] })),
    ).toEqual([
      "categories[0]: ask the merchant before changing a category and set merchant_confirmed only once they have agreed.",
    ]);
    const value = valueOf(
      full({
        categories: [
          { action: "create", name: "Gift sets", merchant_confirmed: true },
          {
            action: "update",
            slug: "candles",
            description: "Hand poured.",
            merchant_confirmed: true,
          },
          { action: "hide", slug: "sample-tees", merchant_confirmed: true },
        ],
      }),
      "full",
    );
    expect(value.categories).toEqual([
      {
        action: "create",
        name: "Gift sets",
        slug: null,
        description: null,
        newPhoto: false,
      },
      {
        action: "update",
        slug: "candles",
        name: null,
        description: "Hand poured.",
        newPhoto: false,
      },
      { action: "hide", slug: "sample-tees" },
    ]);
  });

  it("reads pages as slugs, with the homepage as an empty slug", () => {
    expect(valueOf(full({ pages: null }), "full").pages).toBeNull();
    expect(
      valueOf(full({ pages: ["/", "About", "about", " /faq/ "] }), "full")
        .pages,
    ).toEqual(["", "about", "faq"]);
    expect(issuesOf(full({ pages: "about" }))).toEqual([
      "pages must be a list of page slugs, or null for the default set.",
    ]);
    expect(issuesOf(full({ pages: [] }))).toEqual([
      "pages must name at least one page, or be null for the default set.",
    ]);
    expect(issuesOf(full({ pages: ["about us", 3, "terms"] }))).toEqual([
      'pages[0] is not a page slug: use one from the store context, such as "about".',
      "pages[1] must be a page slug.",
      "pages[2] is the merchant's legal text, which a redesign never changes: leave it out.",
    ]);
    const many = Array.from(
      { length: REVAMP_LIMITS.maxPages + 1 },
      (_, i) => `p${i}`,
    );
    expect(issuesOf(full({ pages: many }))).toEqual([
      `pages lists at most ${REVAMP_LIMITS.maxPages} pages.`,
    ]);
  });
});

describe("readRevampRequest: a refinement", () => {
  it("reads the merchant's words and what may change", () => {
    const value = valueOf(
      refine({
        refine_scope: {
          design: true,
          photos: ["hero-1", "hero-1", " shot-2 "],
          pages: ["", "about"],
        },
      }),
      "refine",
    );
    expect(value.kind).toBe("refine");
    expect(value.instruction).toBe("Make it warmer");
    expect(value.refineScope).toEqual({
      design: true,
      copy: false,
      layout: false,
      photos: ["hero-1", "shot-2"],
      pages: ["", "about"],
      products: false,
    });
  });

  it("bounds the instruction", () => {
    expect(issuesOf(refine({ instruction: undefined }), "refine")).toEqual([
      "instruction (the merchant's own words) is required: ask the merchant if you do not know.",
    ]);
    expect(issuesOf(refine({ instruction: "ok" }), "refine")).toEqual([
      "instruction (the merchant's own words) must be at least 3 characters.",
    ]);
    expect(
      issuesOf(
        refine({ instruction: "w".repeat(L.instructionMax + 1) }),
        "refine",
      ),
    ).toEqual([
      `instruction (the merchant's own words) must be ${L.instructionMax} characters or fewer.`,
    ]);
  });

  it("needs a scope that changes something", () => {
    expect(issuesOf(refine({ refine_scope: undefined }), "refine")).toEqual([
      "refine_scope is required: say what may change (design, copy, layout, photos or products).",
    ]);
    expect(issuesOf(refine({ refine_scope: {} }), "refine")).toEqual([
      "refine_scope must change something: set design, copy, layout or products to true, or name the photos to redraw.",
    ]);
    expect(
      issuesOf(
        refine({ refine_scope: { copy: "yes", layout: true } }),
        "refine",
      ),
    ).toEqual(["refine_scope.copy must be true or false."]);
  });

  it('reads photos as "all", a list of ids, or none', () => {
    const photos = (value: unknown) =>
      readRevampRequest(refine({ refine_scope: { photos: value } }), "refine");
    const scope = (value: unknown) => {
      const read = photos(value);
      return read.ok ? read.value.refineScope?.photos : read.issues;
    };
    expect(scope("all")).toBe("all");
    expect(scope(["ALL"])).toBe("all");
    expect(scope(["  "])).toEqual([
      "refine_scope must change something: set design, copy, layout or products to true, or name the photos to redraw.",
    ]);
    const message =
      'refine_scope.photos must be "all", a list of photo ids from the redesign card, or null.';
    expect(scope("hero")).toEqual(expect.arrayContaining([message]));
    expect(scope([3])).toEqual(expect.arrayContaining([message]));
    expect(scope(["x".repeat(L.shotId + 1)])).toEqual(
      expect.arrayContaining([message]),
    );
    expect(
      scope(
        Array.from({ length: REVAMP_LIMITS.maxShots + 1 }, (_, i) => `s${i}`),
      ),
    ).toEqual(
      expect.arrayContaining([
        `refine_scope.photos names at most ${REVAMP_LIMITS.maxShots} photos.`,
      ]),
    );
    expect(
      issuesOf(
        refine({ refine_scope: { design: true, pages: ["terms"] } }),
        "refine",
      ),
    ).toEqual([
      "refine_scope.pages[0] is the merchant's legal text, which a redesign never changes: leave it out.",
    ]);
  });
});

describe("readRevampRequest: every issue at once", () => {
  it("reports all the problems in one call", () => {
    const issues = issuesOf(
      {
        brief: { business: "", facts: "x" },
        products: [product({ sizes: [] }), product({ photo_url: "ftp://a" })],
        categories: [{ action: "hide", slug: "old" }],
        pages: [],
        instruction: "",
        refine_scope: {},
      },
      "refine",
    );
    expect(issues).toHaveLength(9);
  });
});

describe("revampRequestToWire", () => {
  it("round trips a stored request, keeping keys and confirmed categories", () => {
    const original = valueOf(
      refine({
        products: [product(), product({ name: "Rose jar", photo_url: null })],
        categories: [
          {
            action: "update",
            slug: "candles",
            name: "Candles",
            new_photo: true,
            merchant_confirmed: true,
          },
          {
            action: "create",
            name: "Gift sets",
            slug: "gifts",
            merchant_confirmed: true,
          },
          { action: "hide", slug: "old", merchant_confirmed: true },
        ],
        pages: ["about"],
      }),
      "refine",
    );
    const again = valueOf(
      {
        ...revampRequestToWire(original),
        instruction: original.instruction,
        refine_scope: original.refineScope,
      },
      "refine",
    );
    expect(again).toEqual(original);
    expect(again.products.map((entry) => entry.key)).toEqual(["p1", "p2"]);
  });
});

describe("keyRefinementProducts", () => {
  const read = (names: string[]) =>
    valueOf(
      {
        ...full({ products: names.map((name) => product({ name })) }),
        instruction: "Make it warmer",
        refine_scope: { design: true },
      },
      "refine",
    );

  it("keeps the parent's keys for the products it carries, and gives new ones keys after them", () => {
    const parent = [{ key: "p1" }, { key: "p2" }];
    const keyed = keyRefinementProducts(
      read(["Lavender jar", "Amber jar", "Rose jar"]),
      parent,
      2,
    );
    expect(keyed.products.map((entry) => [entry.key, entry.name])).toEqual([
      ["p1", "Lavender jar"],
      ["p2", "Amber jar"],
      ["p3", "Rose jar"],
    ]);
  });

  it("★ never reuses a parent's key for a product added on top of an applied parent", () => {
    // Nothing carried: the parent's products are on the store already, and its
    // plan's product copy is keyed p1 and p2.
    const keyed = keyRefinementProducts(
      read(["Rose jar"]),
      [{ key: "p1" }, { key: "p2" }],
      0,
    );
    expect(keyed.products.map((entry) => entry.key)).toEqual(["p3"]);
  });

  it("follows a parent whose own keys did not start at p1", () => {
    // A refinement of an applied redesign keyed its one new product p3.
    const keyed = keyRefinementProducts(
      read(["Rose jar", "Fig jar"]),
      [{ key: "p3" }],
      1,
    );
    expect(keyed.products.map((entry) => entry.key)).toEqual(["p3", "p4"]);
  });

  it("changes nothing else in the request", () => {
    const original = read(["Lavender jar"]);
    const keyed = keyRefinementProducts(original, [], 0);
    expect({ ...keyed, products: [] }).toEqual({ ...original, products: [] });
    expect(keyed.products[0]).toEqual({ ...original.products[0], key: "p1" });
  });
});

describe("the versions of one redesign (chat-1)", () => {
  const item = (key: string, name: string) => ({ key, name });
  const gift = { action: "create", name: "Gift boxes", slug: null };
  const rename = (name: string) => ({
    action: "update",
    slug: "oils",
    name,
    description: null,
    newPhoto: false,
  });
  /** A: the full redesign. */
  const full = (live: boolean) => ({
    products: [item("p1", "Lavender jar"), item("p2", "Amber jar")],
    categories: [gift],
    live,
  });

  it("★★ carries what an unapplied version asked for and nothing a live one put on the store", () => {
    // B was asked for while A was not applied, so it carries A's products.
    const b = {
      products: [...full(false).products, item("p3", "Rose jar")],
      categories: [gift],
      live: false,
    };
    const notLive = revampChainCarry([b, full(false)]);
    expect(notLive.products.map((p) => p.name)).toEqual([
      "Lavender jar",
      "Amber jar",
      "Rose jar",
    ]);
    expect(notLive.categories).toEqual([gift]);
    // A applied since: its products and its category are on the store.
    const applied = revampChainCarry([b, full(true)]);
    expect(applied.products).toEqual([item("p3", "Rose jar")]);
    expect(applied.categories).toEqual([]);
    expect(applied.usedKeys).toEqual(["p1", "p2", "p1", "p2", "p3"]);
  });

  it("★★ carries a live version's work again once it is undone", () => {
    // B was asked for while A was on the store, so it carries only its own.
    const b = {
      products: [item("p3", "Rose jar")],
      categories: [],
      live: false,
    };
    expect(revampChainCarry([b, full(true)]).products).toEqual([
      item("p3", "Rose jar"),
    ]);
    const undone = revampChainCarry([b, full(false)]);
    expect(undone.products.map((p) => p.key)).toEqual(["p1", "p2", "p3"]);
    expect(undone.categories).toEqual([gift]);
  });

  it("knows a product by its name and a category change by what it does and says", () => {
    const carry = revampChainCarry([
      {
        products: [item("p5", "  lavender  JAR ")],
        categories: [rename("Cold-pressed oils")],
        live: false,
      },
      {
        products: [item("p1", "Lavender jar")],
        categories: [rename("Oils and ghee")],
        live: true,
      },
    ]);
    // The same product by name is on the store already; a new name for the
    // category the live version renamed is a change of its own.
    expect(carry.products).toEqual([]);
    expect(carry.categories).toEqual([rename("Cold-pressed oils")]);
  });

  it("never carries two products under one key", () => {
    const carry = revampChainCarry([
      { products: [item("p1", "Fig jar")], categories: [], live: false },
      { products: [item("p1", "Lavender jar")], categories: [], live: false },
    ]);
    expect(carry.products).toEqual([
      item("p1", "Lavender jar"),
      item("p2", "Fig jar"),
    ]);
    expect(carry.usedKeys).toContain("p2");
  });

  describe("revampRefinementStale", () => {
    const own = (
      products: Array<{ key: string; name: string }>,
      categories: Array<Record<string, unknown>> = [],
    ) => ({ products, categories: categories as Array<{ action: string }> });

    it("is fine while the refinement carries exactly what is not on the store", () => {
      expect(
        revampRefinementStale(
          own([...full(false).products, item("p3", "Rose jar")], [gift]),
          [full(false)],
        ),
      ).toBeNull();
      expect(
        revampRefinementStale(own([item("p3", "Rose jar")]), [full(true)]),
      ).toBeNull();
    });

    it("★★ says applied when an earlier version put what it carries on the store since", () => {
      expect(
        revampRefinementStale(
          own([...full(false).products, item("p3", "Rose jar")], [gift]),
          [full(true)],
        ),
      ).toBe("applied");
      // The category alone is enough: Apply would find it created already.
      expect(revampRefinementStale(own([], [gift]), [full(true)])).toBe(
        "applied",
      );
    });

    it("★★ says undone when an earlier version took back what it leaves out", () => {
      expect(
        revampRefinementStale(own([item("p3", "Rose jar")]), [full(false)]),
      ).toBe("undone");
    });

    it("does not count a product the merchant added again under a new key", () => {
      expect(
        revampRefinementStale(own([item("p7", "Lavender jar")]), [full(true)]),
      ).toBeNull();
    });
  });
});
