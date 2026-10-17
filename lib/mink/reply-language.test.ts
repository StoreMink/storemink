// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  MINK_REPLY_LANGUAGES,
  isMinkReplyLanguage,
  minkReplyLanguageInstruction,
  readStoredMinkReplyLanguage,
  storeMinkReplyLanguage,
} from "./reply-language";

describe("reply language", () => {
  beforeEach(() => window.localStorage.clear());

  it("is a closed list with a matching default", () => {
    expect(MINK_REPLY_LANGUAGES[0].code).toBe("auto");
    expect(isMinkReplyLanguage("hi")).toBe(true);
    expect(isMinkReplyLanguage("fr")).toBe(false);
    expect(minkReplyLanguageInstruction("auto")).toBe(
      "match the language and script of the merchant's message",
    );
    expect(minkReplyLanguageInstruction("hi")).toContain("Devanagari");
    expect(minkReplyLanguageInstruction(undefined)).toContain("match");
  });

  it("remembers a choice per browser and falls back on junk", () => {
    expect(readStoredMinkReplyLanguage()).toBe("auto");
    storeMinkReplyLanguage("ta");
    expect(readStoredMinkReplyLanguage()).toBe("ta");
    window.localStorage.setItem("storemink:mink-reply-language", "xx");
    expect(readStoredMinkReplyLanguage()).toBe("auto");
    storeMinkReplyLanguage("auto");
    expect(
      window.localStorage.getItem("storemink:mink-reply-language"),
    ).toBeNull();
  });
});
