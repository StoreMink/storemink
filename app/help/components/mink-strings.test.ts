import { describe, expect, it } from "vitest";
import { HELP_LANGUAGES, type HelpLanguageCode } from "@/lib/help/languages";
import {
  MINK_STRINGS,
  minkIntro,
  minkStrings,
  type MinkStrings,
} from "./mink-strings";

// Built from code points so this file never holds the characters themselves.
const LONG_DASHES = [
  String.fromCodePoint(0x2014),
  String.fromCodePoint(0x2013),
];

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

/** Sample arguments a string-producing function in the strings is called with. */
const SAMPLE_ARGS = ["Sample", 3, "/help/sample/guide"];

type Leaf = { path: string; value: string };

/**
 * Every string the chat can show for one language, found by walking objects,
 * arrays and functions generically, so a key added later is covered with no
 * edit here.
 */
function leaves(value: unknown, path = ""): Leaf[] {
  if (typeof value === "string") return [{ path, value }];
  if (typeof value === "function") {
    return leaves(
      (value as (...args: unknown[]) => unknown)(...SAMPLE_ARGS),
      `${path}()`,
    );
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leaves(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      leaves(item, path ? `${path}.${key}` : key),
    );
  }
  return [{ path, value: String(value) }];
}

/** The shape of a value: keys, array lengths and leaf kinds, not the words. */
function shape(value: unknown): unknown {
  if (typeof value === "function") return "function";
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shape((value as Record<string, unknown>)[key])]),
    );
  }
  return typeof value;
}

const CODES = HELP_LANGUAGES.map((language) => language.code);

describe("MINK_STRINGS", () => {
  it("has a set of words for every language in the menu, and no other", () => {
    expect(Object.keys(MINK_STRINGS).sort()).toEqual([...CODES].sort());
  });

  it.each(CODES)("gives %s exactly the keys English has", (code) => {
    expect(shape(MINK_STRINGS[code])).toEqual(shape(MINK_STRINGS.en));
  });

  it.each(CODES)("gives %s a non-empty value everywhere", (code) => {
    const found = leaves(MINK_STRINGS[code]);
    expect(found.length).toBe(leaves(MINK_STRINGS.en).length);
    for (const { path, value } of found) {
      expect(value.trim(), `${code}.${path}`).not.toBe("");
    }
  });

  it.each(CODES)("has no em dash or en dash in %s", (code) => {
    for (const { path, value } of leaves(MINK_STRINGS[code])) {
      for (const dash of LONG_DASHES) {
        expect(value.includes(dash), `${code}.${path}`).toBe(false);
      }
    }
  });

  it.each(CODES)("gives %s four different example questions", (code) => {
    const starters = MINK_STRINGS[code].starters;
    expect(starters).toHaveLength(4);
    expect(new Set(starters).size).toBe(4);
  });

  it("translates every other language: no value is left in English", () => {
    const english = new Map(
      leaves(MINK_STRINGS.en).map((leaf) => [leaf.path, leaf.value]),
    );
    for (const code of CODES) {
      if (code === "en") continue;
      for (const { path, value } of leaves(MINK_STRINGS[code])) {
        expect(value, `${code}.${path}`).not.toBe(english.get(path));
      }
    }
  });

  it("writes the visible words of each other language in its own script", () => {
    const keys: (keyof MinkStrings)[] = [
      "inputLabel",
      "placeholder",
      "send",
      "welcomeText",
      "newChat",
      "helpful",
      "notHelpful",
      "deleteChat",
    ];
    for (const code of CODES) {
      if (code === "en") continue;
      for (const key of keys) {
        expect(MINK_STRINGS[code][key], `${code}.${key}`).toMatch(SCRIPT[code]);
      }
      for (const status of Object.values(MINK_STRINGS[code].talkStatus)) {
        expect(status, `${code}.talkStatus`).toMatch(SCRIPT[code]);
      }
    }
  });

  it("keeps the name Mink AI in Latin letters in every language", () => {
    for (const code of CODES) {
      const words = MINK_STRINGS[code];
      for (const key of [
        "dialogLabel",
        "inputLabel",
        "talk",
        "voiceGroup",
        "stillAnswering",
      ] as const) {
        expect(words[key], `${code}.${key}`).toContain("Mink AI");
      }
    }
  });

  it("keeps the English accessible names the Help tests rely on", () => {
    const en = MINK_STRINGS.en;
    expect(en.dialogLabel).toBe("Mink AI Help Assistant");
    expect(en.inputLabel).toBe("Ask Mink AI a StoreMink question");
    expect(en.send).toBe("Send question");
    expect(en.newChatLabel).toBe("Start a new conversation");
    expect(en.maximize).toBe("Maximize Mink AI");
    expect(en.restore).toBe("Restore Mink AI drawer");
    expect(en.helpful).toBe("Helpful");
    expect(en.notHelpful).toBe("Not helpful");
    expect(en.deleteChat).toBe("Delete chat");
    expect(en.language).toBe("Language");
  });
});

describe("minkStrings", () => {
  it("gives English when no language is picked", () => {
    expect(minkStrings(null)).toBe(MINK_STRINGS.en);
  });

  it.each(CODES)("gives the words of %s when it is picked", (code) => {
    expect(minkStrings(code)).toBe(MINK_STRINGS[code]);
  });

  it("gives English for a code it does not know, never undefined", () => {
    expect(minkStrings("xx" as unknown as HelpLanguageCode)).toBe(
      MINK_STRINGS.en,
    );
  });
});

describe("minkIntro", () => {
  it.each(CODES)(
    "opens the %s conversation with the lead and the welcome",
    (code) => {
      const words = MINK_STRINGS[code];
      const intro = minkIntro(words);
      expect(intro.trim()).not.toBe("");
      expect(intro).toBe(`${words.introLead} ${words.welcomeText}`);
      expect(intro.startsWith(words.introLead)).toBe(true);
      for (const dash of LONG_DASHES) expect(intro.includes(dash)).toBe(false);
    },
  );
});
