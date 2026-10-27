import { describe, expect, it } from "vitest";
import {
  MAX_LEXEMES_PER_WORD,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_WORDS,
  normaliseSearchQuery,
  prefixTsQuery,
  searchWords,
  splitSnippet,
  splitTitleMatches,
} from "./prefix-search";
import { splitSnippet as inboxSplitSnippet } from "@/lib/whatsapp/inbox-workspace";

const ZWJ = String.fromCharCode(0x200d);
const ZWNJ = String.fromCharCode(0x200c);

describe("searchWords", () => {
  it("★ keeps a Devanagari virama and a Gurmukhi adhak inside their words", () => {
    expect(searchWords("ऑर्डर स्टेटस")).toEqual(["ऑर्डर", "स्टेटस"]);
    expect(searchWords("ਕਿੰਨੇ ਆਰਡਰ")).toEqual(["ਕਿੰਨੇ", "ਆਰਡਰ"]);
    expect(searchWords("ਅੱਜ")).toEqual(["ਅੱਜ"]);
  });

  it("★ F6: keeps a zero-width joiner inside its word, as the message index does", () => {
    expect(searchWords(`क्${ZWJ}ष`)).toEqual([`क्${ZWJ}ष`]);
    expect(searchWords(`ऑर्${ZWNJ}डर`)).toEqual([`ऑर्${ZWNJ}डर`]);
  });

  it("★ F6: cuts at spaces only, so an email, a phone number, a code or a price stays one word", () => {
    expect(
      searchWords(
        "priya.sharma@gmail.com +919876543210 98765-43210 DIWALI-20 1299.50 t-shirt",
      ),
    ).toEqual([
      "priya.sharma@gmail.com",
      "+919876543210",
      "98765-43210",
      "diwali-20",
      "1299.50",
      "t-shirt",
    ]);
    expect(searchWords("Mera ORDER kab aayega")).toEqual([
      "mera",
      "order",
      "kab",
      "aayega",
    ]);
    expect(searchWords("₹499 offer?")).toEqual(["₹499", "offer?"]);
  });

  it("finds nothing searchable in one-letter words, punctuation or an emoji", () => {
    expect(searchWords("a b")).toEqual([]);
    expect(searchWords("??")).toEqual([]);
    expect(searchWords("🙂")).toEqual([]);
    expect(searchWords("₹5 -a")).toEqual([]);
    expect(searchWords("")).toEqual([]);
  });

  it("drops control characters, which Postgres text cannot hold", () => {
    expect(searchWords(`or${String.fromCharCode(0)}der`)).toEqual(["order"]);
  });

  it("keeps each word once and at most six", () => {
    expect(searchWords("order Order ORDER")).toEqual(["order"]);
    expect(searchWords("one two three four five six seven eight")).toHaveLength(
      MAX_SEARCH_WORDS,
    );
    expect(searchWords("one two three four five six seven")).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
    ]);
  });
});

describe("prefixTsQuery", () => {
  it("makes every word a required prefix, quoted", () => {
    expect(
      prefixTsQuery([
        { word: "ऑर्डर", lexemes: ["ऑर्डर"] },
        { word: "dikha", lexemes: ["dikha"] },
      ]),
    ).toBe("'ऑर्डर':* & 'dikha':*");
  });

  it("★ F6: a word matches when every lexeme the parser made of it does, or the word whole does", () => {
    expect(
      prefixTsQuery([
        { word: "98765-43210", lexemes: ["98765", "-43210"] },
        { word: "priya.sharma@gm", lexemes: ["priya.sharma", "gm"] },
      ]),
    ).toBe(
      "('-43210':* & '98765':* | '98765-43210':*) & ('priya.sharma':* & 'gm':* | 'priya.sharma@gm':*)",
    );
    // The word itself is one of its lexemes: no second way to match.
    expect(
      prefixTsQuery([{ word: "t-shirt", lexemes: ["t-shirt", "t", "shirt"] }]),
    ).toBe("('t-shirt':* & 'shirt':*)");
    // Only one-letter lexemes: the word is searched whole.
    expect(prefixTsQuery([{ word: "a.b", lexemes: ["a", "b"] }])).toBe(
      "'a.b':*",
    );
  });

  it("★ never lets a text-search operator through: every item is quoted and escaped", () => {
    expect(
      prefixTsQuery([
        { word: "!c:*|(x)", lexemes: ["c", "x"] },
        { word: "it's", lexemes: ["it", "s"] },
        { word: "a\\b", lexemes: [] },
      ]),
    ).toBe("'!c:*|(x)':* & ('it':* | 'it''s':*) & 'a\\\\b':*");
  });

  it("keeps at most the eight longest lexemes of one word", () => {
    const lexemes = Array.from(
      { length: 12 },
      (_, index) => `w${"x".repeat(index)}`,
    );
    const query = prefixTsQuery([{ word: "long", lexemes }]) ?? "";
    expect(query.match(/:\*/g)).toHaveLength(MAX_LEXEMES_PER_WORD + 1);
    expect(query).toContain(`'w${"x".repeat(11)}':*`);
    expect(query).not.toContain("'wx':*");
  });

  it("is null without a word", () => {
    expect(prefixTsQuery([])).toBeNull();
  });
});

describe("splitSnippet", () => {
  it("separates the marked words from the rest, and the inbox re-exports it", () => {
    const parts = [
      { text: "Your ", hit: false },
      { text: "zebracode", hit: true },
      { text: " coupon saved ", hit: false },
      { text: "20", hit: true },
      { text: " orders", hit: false },
    ];
    expect(splitSnippet("Your «zebracode» coupon saved «20» orders")).toEqual(
      parts,
    );
    expect(parts.map((part) => part.text).join("")).toBe(
      "Your zebracode coupon saved 20 orders",
    );
    expect(inboxSplitSnippet).toBe(splitSnippet);
    expect(splitSnippet("plain")).toEqual([{ text: "plain", hit: false }]);
  });
});

describe("splitTitleMatches", () => {
  it("marks every case-insensitive occurrence of the searched words", () => {
    expect(splitTitleMatches("Diwali offer for Diwali", ["diwali"])).toEqual([
      { text: "Diwali", hit: true },
      { text: " offer for ", hit: false },
      { text: "Diwali", hit: true },
    ]);
    expect(
      splitTitleMatches("ਅੱਜ ਦੇ ਟੋਟਲ ਕਿੰਨੇ ਆਰਡਰ", searchWords("ਆਰਡ")),
    ).toEqual([
      { text: "ਅੱਜ ਦੇ ਟੋਟਲ ਕਿੰਨੇ ", hit: false },
      { text: "ਆਰਡ", hit: true },
      { text: "ਰ", hit: false },
    ]);
  });

  it("returns the title whole when nothing matches or no word was searched", () => {
    expect(splitTitleMatches("Stock check", ["coupon"])).toEqual([
      { text: "Stock check", hit: false },
    ]);
    expect(splitTitleMatches("Stock check", [])).toEqual([
      { text: "Stock check", hit: false },
    ]);
    expect(splitTitleMatches("", ["stock"])).toEqual([]);
  });
});

describe("normaliseSearchQuery", () => {
  it("trims, makes every run of spaces one space, and cuts to 80 characters", () => {
    expect(normaliseSearchQuery("  Priya \n\t 9876  ")).toBe("Priya 9876");
    expect(normaliseSearchQuery("x".repeat(200))).toHaveLength(
      MAX_SEARCH_QUERY_LENGTH,
    );
    expect(normaliseSearchQuery("   ")).toBe("");
  });

  it("never cuts a letter made of two UTF-16 units in half", () => {
    const text = `${"a".repeat(79)}𝒜𝒜`;
    expect(Array.from(normaliseSearchQuery(text))).toHaveLength(80);
    expect(normaliseSearchQuery(text).endsWith("𝒜")).toBe(true);
  });
});
