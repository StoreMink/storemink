import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEECH_LANG,
  SPEAKABLE_MAX_CHARS,
  speakableMinkText,
  speechLangFor,
  normalizeSpeechLanguage,
  splitSpeechChunks,
} from "./speech-text";

describe("speakableMinkText", () => {
  it("keeps the words of headings, emphasis and links and ends each as a sentence", () => {
    const spoken = speakableMinkText(
      "## Sales this week\n\nYou made **₹12,400** from _18 orders_, see [the report](/dashboard/analytics).",
    );
    expect(spoken).toBe(
      "Sales this week. You made ₹12,400 from 18 orders, see the report.",
    );
  });

  it("turns list items into sentences and drops horizontal rules", () => {
    const spoken = speakableMinkText(
      "Three things to do:\n- Restock Almond shake\n* Reply to 2 enquiries\n---\n1. Publish the blog\n",
    );
    expect(spoken).toBe(
      "Three things to do: Restock Almond shake. Reply to 2 enquiries. Publish the blog.",
    );
  });

  it("reads a table as label: value lines", () => {
    const spoken = speakableMinkText(
      "| Product | Units | Sales |\n|---|---:|---|\n| Milk | 12 | ₹240 |\n| Bread | 3 | ₹90 |",
    );
    expect(spoken).toBe(
      "Product: Milk, Units: 12, Sales: ₹240. Product: Bread, Units: 3, Sales: ₹90.",
    );
  });

  it("uses the first cell as the label when a table has no header", () => {
    expect(speakableMinkText("| Milk | 12 |\n| Bread | 3 |")).toBe(
      "Milk: 12. Bread: 3.",
    );
  });

  it("drops code blocks, dashboard paths and URLs", () => {
    const spoken = speakableMinkText(
      "Open /dashboard/orders/ORD1001 to see it.\n\n```csv\nHandle,Title\nmilk,Milk\n```\nMore at https://help.storemink.com/orders and `SKU100100015`.",
    );
    expect(spoken).toBe("Open to see it. More at and SKU100100015.");
    expect(spoken).not.toContain("Handle");
    expect(spoken).not.toContain("/dashboard");
  });

  it("drops a fence left open at the end and html tags", () => {
    expect(speakableMinkText("Done.<br>\n```\nconst x = 1;\nmore code")).toBe(
      "Done.",
    );
  });

  it("collapses whitespace and blockquotes", () => {
    expect(speakableMinkText("> Hello   there\n\n\n>   friend!  ")).toBe(
      "Hello there. friend!",
    );
  });

  it("returns an empty string for blank or non-string input", () => {
    expect(speakableMinkText("   \n\n")).toBe("");
    expect(speakableMinkText("```\nonly code\n```")).toBe("");
    expect(speakableMinkText(undefined as unknown as string)).toBe("");
  });

  it("caps at a sentence boundary within the limit", () => {
    const sentence = "This is one sentence about stock levels at the shop.";
    const long = Array.from({ length: 60 }, () => sentence).join(" ");
    const spoken = speakableMinkText(long);
    expect(spoken.length).toBeLessThanOrEqual(SPEAKABLE_MAX_CHARS);
    expect(spoken.endsWith(".")).toBe(true);
    expect(spoken.endsWith(sentence)).toBe(true);
    expect(spoken.length).toBeGreaterThan(
      SPEAKABLE_MAX_CHARS - sentence.length - 2,
    );
  });

  it("falls back to a word boundary when no sentence ends inside the limit", () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const spoken = speakableMinkText(words);
    expect(spoken.length).toBeLessThanOrEqual(SPEAKABLE_MAX_CHARS);
    expect(spoken.endsWith("word")).toBe(false);
    expect(/word\d+$/.test(spoken)).toBe(true);
  });
});

describe("speechLangFor", () => {
  it("keeps detected languages that share a script and recognises omitted scripts", () => {
    expect(speechLangFor("तुमची ऑर्डर तयार आहे", "en-US", "mr-IN")).toBe(
      "mr-IN",
    );
    expect(speechLangFor("Aapka order taiyar hai", "en-US", "hi-IN")).toBe(
      "hi-IN",
    );
    expect(speechLangFor("உங்கள் ஆர்டர் தயார்", "en-IN", "hi-IN")).toBe(
      "ta-IN",
    );
    expect(speechLangFor("ଆପଣଙ୍କ ଅର୍ଡର ପ୍ରସ୍ତୁତ", "en-IN")).toBe("or-IN");
    expect(speechLangFor("آپ کا آرڈر تیار ہے", "en-IN")).toBe("ur-IN");
  });

  it("★ a hint for a language the model has no voice for leaves the script's own voice to read it", () => {
    // Bulbul reads Devanagari as Hindi and Bengali script as Bengali; a
    // Maithili, Nepali or Assamese tag would be refused and handed to the
    // browser, which has no such voice either (speech-text.ts).
    expect(speechLangFor("अहाँक ऑर्डर तैयार अछि", "en-IN", "mai-IN")).toBe(
      "hi-IN",
    );
    expect(speechLangFor("तपाईंको अर्डर तयार छ", "en-IN", "ne-IN")).toBe(
      "hi-IN",
    );
    expect(speechLangFor("আপোনাৰ অৰ্ডাৰ সাজু", "en-IN", "as-IN")).toBe("bn-IN");
    // Latin text keeps the browser's language unless the hint has a voice.
    expect(speechLangFor("Your order is ready.", "en-GB", "ml-IN")).toBe(
      "en-GB",
    );
    expect(speechLangFor("Ungal order thayar.", "en-IN", "ta-IN")).toBe(
      "ta-IN",
    );
  });

  it("normalises known language tags without accepting provider prose", () => {
    expect(normalizeSpeechLanguage(" MR-in ")).toBe("mr-IN");
    expect(normalizeSpeechLanguage("od-IN")).toBe("or-IN");
    expect(normalizeSpeechLanguage("ta")).toBe("ta-IN");
    for (const bad of [
      null,
      "unknown",
      "auto",
      "<script>",
      "en-IN instructions",
      "xx-IN",
    ])
      expect(normalizeSpeechLanguage(bad)).toBeNull();
  });

  it("picks Indic languages by script", () => {
    expect(speechLangFor("आपके पास 12 ऑर्डर हैं।", "en-IN")).toBe("hi-IN");
    expect(speechLangFor("உங்களிடம் 12 ஆர்டர்கள் உள்ளன", "en-IN")).toBe(
      "ta-IN",
    );
    expect(speechLangFor("మీకు 12 ఆర్డర్లు ఉన్నాయి", "en-IN")).toBe("te-IN");
    expect(speechLangFor("ನಿಮಗೆ 12 ಆರ್ಡರ್‌ಗಳಿವೆ", "en-IN")).toBe("kn-IN");
    expect(speechLangFor("আপনার ১২টি অর্ডার আছে", "en-IN")).toBe("bn-IN");
    expect(speechLangFor("તમારી પાસે 12 ઓર્ડર છે", "en-IN")).toBe("gu-IN");
    expect(speechLangFor("നിങ്ങൾക്ക് 12 ഓർഡറുകൾ ഉണ്ട്", "en-IN")).toBe("ml-IN");
    expect(speechLangFor("ਤੁਹਾਡੇ ਕੋਲ 12 ਆਰਡਰ ਹਨ", "en-IN")).toBe("pa-IN");
  });

  it("uses the fallback for Latin text and en-IN for a blank fallback", () => {
    expect(speechLangFor("You have 12 orders.", "en-GB")).toBe("en-GB");
    expect(speechLangFor("You have 12 orders.", "")).toBe(DEFAULT_SPEECH_LANG);
    expect(speechLangFor("1234 !!", "fr-FR")).toBe("fr-FR");
  });

  it("follows the majority script in mixed text", () => {
    expect(
      speechLangFor(
        "Your order (ऑर्डर) is ready for collection today.",
        "en-IN",
      ),
    ).toBe("en-IN");
    expect(speechLangFor("Order आपका ऑर्डर तैयार है।", "en-IN")).toBe("hi-IN");
  });
});

describe("splitSpeechChunks", () => {
  it("keeps a short answer whole", () => {
    expect(splitSpeechChunks("You have 12 orders today.")).toEqual([
      "You have 12 orders today.",
    ]);
    expect(splitSpeechChunks("   ")).toEqual([]);
  });

  it("starts with a short piece, then packs sentences, losing nothing", () => {
    const sentences = Array.from(
      { length: 12 },
      (_, i) => `Sentence number ${i + 1} tells you something useful today.`,
    );
    const text = sentences.join(" ");
    const pieces = splitSpeechChunks(text, 120, 300);
    expect(pieces[0].length).toBeLessThanOrEqual(120);
    for (const piece of pieces.slice(1))
      expect(piece.length).toBeLessThanOrEqual(300);
    expect(pieces.join(" ")).toBe(text);
    expect(pieces.length).toBeGreaterThan(2);
  });

  it("★ keeps decimals, abbreviations and version numbers in one piece", () => {
    expect(
      splitSpeechChunks(
        "Sales were ₹4.5 lakh this week. Returns fell.",
        40,
        40,
      ),
    ).toEqual(["Sales were ₹4.5 lakh this week.", "Returns fell."]);
    expect(
      splitSpeechChunks("Rs. 500 is the price. Pay with v2.1 now.", 25, 25),
    ).toEqual(["Rs. 500 is the price.", "Pay with v2.1 now."]);
    // A terminator followed by a lowercase word continues the sentence, and
    // a leading ellipsis is not dropped on the floor.
    expect(splitSpeechChunks("...wait. e.g. this one. Done.", 24, 24)).toEqual([
      "...wait. e.g. this one.",
      "Done.",
    ]);
    expect(splitSpeechChunks('She said "Yes." Then left.', 16, 16)).toEqual([
      'She said "Yes."',
      "Then left.",
    ]);
  });

  it("splits at the danda and cuts an overlong sentence at a space", () => {
    expect(splitSpeechChunks("आज पाँच ऑर्डर आए। कल तीन आए।", 20, 40)).toEqual([
      "आज पाँच ऑर्डर आए।",
      "कल तीन आए।",
    ]);
    const long = "word ".repeat(80).trim();
    const pieces = splitSpeechChunks(long, 50, 100);
    expect(pieces.every((piece) => piece.length <= 100)).toBe(true);
    expect(pieces.every((piece) => !piece.startsWith(" "))).toBe(true);
    expect(pieces.join(" ")).toBe(long);
  });
});
