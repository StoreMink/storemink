import { describe, expect, it } from "vitest";
import {
  DEFAULT_HELP_LANGUAGE,
  HELP_LANGUAGES,
  helpFallbackCopy,
  helpLanguage,
  isHelpLanguageCode,
  type HelpFallbackCopy,
  type HelpLanguageCode,
} from "./languages";

const CODES: HelpLanguageCode[] = [
  "en",
  "hi",
  "bn",
  "ta",
  "te",
  "mr",
  "gu",
  "kn",
  "pa",
];

const COPY_KEYS: (keyof HelpFallbackCopy)[] = [
  "unavailable",
  "foundUnverified",
  "foundFailed",
  "clarifyPage",
  "clarifyGoal",
  "securityNote",
];

// The script each language is written in (its `model` line names it).
const SCRIPT: Record<Exclude<HelpLanguageCode, "en">, RegExp> = {
  hi: /\p{Script=Devanagari}/u,
  mr: /\p{Script=Devanagari}/u,
  bn: /\p{Script=Bengali}/u,
  ta: /\p{Script=Tamil}/u,
  te: /\p{Script=Telugu}/u,
  gu: /\p{Script=Gujarati}/u,
  kn: /\p{Script=Kannada}/u,
  pa: /\p{Script=Gurmukhi}/u,
};

// Built from code points so this file never holds the characters themselves.
const LONG_DASHES = [
  String.fromCodePoint(0x2014),
  String.fromCodePoint(0x2013),
];

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

describe("HELP_LANGUAGES", () => {
  it("offers exactly the nine languages, English first", () => {
    expect(HELP_LANGUAGES.map((language) => language.code)).toEqual(CODES);
    expect(DEFAULT_HELP_LANGUAGE).toBe("en");
    // helpLanguage falls back to index 0, so English must stay there.
    expect(HELP_LANGUAGES[0].code).toBe(DEFAULT_HELP_LANGUAGE);
  });

  it("gives every language a name, a native name, an Indian speech tag and a model instruction", () => {
    for (const language of HELP_LANGUAGES) {
      expect(language.name.trim()).not.toBe("");
      expect(language.native.trim()).not.toBe("");
      expect(language.speech).toBe(`${language.code}-IN`);
      expect(language.model.startsWith(language.name)).toBe(true);
    }
  });

  it("writes each native name in its own script", () => {
    for (const language of HELP_LANGUAGES) {
      if (language.code === "en") {
        expect(language.native).toBe("English");
        continue;
      }
      expect(language.native).toMatch(SCRIPT[language.code]);
    }
  });

  it("names the script in the model instruction of every Indic language", () => {
    for (const language of HELP_LANGUAGES) {
      if (language.code === "en") continue;
      expect(language.model).toMatch(/written in .+ script$/);
    }
  });
});

describe("isHelpLanguageCode", () => {
  it("accepts every offered code", () => {
    for (const code of CODES) expect(isHelpLanguageCode(code)).toBe(true);
  });

  it.each([
    "",
    "EN",
    "fr",
    "en-IN",
    " en",
    "hi ",
    "toString",
    "constructor",
    "__proto__",
  ])("rejects the unknown string %j", (value) => {
    expect(isHelpLanguageCode(value)).toBe(false);
  });

  it.each([null, undefined, 1, 0, true, {}, ["en"], { code: "en" }])(
    "rejects the non-string %j",
    (value) => {
      expect(isHelpLanguageCode(value)).toBe(false);
    },
  );

  it("rejects a boxed string, which is not a string value", () => {
    expect(isHelpLanguageCode(Object("en"))).toBe(false);
  });
});

describe("helpLanguage", () => {
  it("returns the entry for a known code", () => {
    for (const language of HELP_LANGUAGES) {
      expect(helpLanguage(language.code)).toBe(language);
    }
  });

  it.each(["fr", "", "EN", null, undefined, 42, {}, ["hi"]])(
    "falls back to English for %j",
    (value) => {
      expect(helpLanguage(value)).toBe(HELP_LANGUAGES[0]);
      expect(helpLanguage(value).code).toBe("en");
    },
  );
});

describe("helpFallbackCopy", () => {
  it("has every key, non-empty, in every language", () => {
    for (const code of CODES) {
      const copy = helpFallbackCopy(code);
      expect(Object.keys(copy).sort()).toEqual([...COPY_KEYS].sort());
      for (const key of COPY_KEYS) {
        expect(typeof copy[key]).toBe("string");
        expect(copy[key].trim()).not.toBe("");
      }
    }
  });

  it("keeps the English text the assistant has always shown", () => {
    expect(helpFallbackCopy("en")).toEqual({
      unavailable:
        "I couldn’t find a published StoreMink guide that confirms the answer. Try describing the screen you are on and what you want to complete, or contact support@storemink.com for help.",
      foundUnverified:
        "I found possible StoreMink guides, but I couldn’t verify an answer from them. Open the guides below, describe the screen you are on, or contact support@storemink.com.",
      foundFailed:
        "I found relevant StoreMink guides, but I couldn’t prepare a reliable step-by-step answer right now. Open the guides below for the verified instructions, or try again in a moment.",
      clarifyPage: "The StoreMink page or menu you are using",
      clarifyGoal:
        "What you want to complete and what happened after your last step",
      securityNote:
        "For your security, do not share passwords, one-time codes, card details, or private customer data in chat.",
    });
  });

  it("translates every key of every other language, in that language's script", () => {
    const english = helpFallbackCopy("en");
    for (const code of CODES) {
      if (code === "en") continue;
      const copy = helpFallbackCopy(code);
      for (const key of COPY_KEYS) {
        expect(copy[key], `${code}.${key}`).not.toBe(english[key]);
        expect(copy[key], `${code}.${key}`).toMatch(SCRIPT[code]);
      }
    }
  });

  it("keeps StoreMink in Latin letters and the support address in every language", () => {
    for (const code of CODES) {
      const copy = helpFallbackCopy(code);
      expect(copy.unavailable).toContain("StoreMink");
      expect(copy.unavailable).toContain("support@storemink.com");
      expect(copy.foundUnverified).toContain("support@storemink.com");
      expect(copy.foundFailed).toContain("StoreMink");
      expect(copy.clarifyPage).toContain("StoreMink");
    }
  });

  it("falls back to the English copy for anything unknown", () => {
    const english = helpFallbackCopy("en");
    for (const value of ["fr", "", null, undefined, 3, {}]) {
      expect(helpFallbackCopy(value)).toBe(english);
    }
  });
});

describe("no long dash in the module's data", () => {
  it("has no em dash or en dash in any language entry or fallback copy", () => {
    const all = [
      ...strings(HELP_LANGUAGES),
      ...CODES.flatMap((code) => strings(helpFallbackCopy(code))),
    ];
    expect(all.length).toBeGreaterThan(CODES.length * COPY_KEYS.length);
    for (const value of all) {
      for (const dash of LONG_DASHES) {
        expect(value.includes(dash), value).toBe(false);
      }
    }
  });
});
