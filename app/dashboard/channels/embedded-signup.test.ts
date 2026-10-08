import { describe, expect, it } from "vitest";
import { parseSignupMessage } from "./embedded-signup";

const finish = JSON.stringify({
  type: "WA_EMBEDDED_SIGNUP",
  event: "FINISH",
  data: { phone_number_id: "1280649011808874", waba_id: "2323545385144849" },
});

describe("parseSignupMessage", () => {
  it("reads a FINISH event from facebook.com", () => {
    expect(parseSignupMessage("https://www.facebook.com", finish)).toEqual({
      event: "FINISH",
      wabaId: "2323545385144849",
      phoneNumberId: "1280649011808874",
    });
    expect(
      parseSignupMessage("https://business.facebook.com", finish),
    ).not.toBeNull();
  });

  it("★ ignores the identical payload from any other origin", () => {
    expect(parseSignupMessage("https://evil.example", finish)).toBeNull();
    expect(
      parseSignupMessage("https://facebook.com.evil.example", finish),
    ).toBeNull();
    expect(parseSignupMessage("https://notfacebook.com", finish)).toBeNull();
    expect(parseSignupMessage("null", finish)).toBeNull();
  });

  it("accepts an already-parsed object and reports CANCEL / ERROR / WABA-only", () => {
    expect(
      parseSignupMessage("https://www.facebook.com", {
        type: "WA_EMBEDDED_SIGNUP",
        event: "CANCEL",
        data: { current_step: "BUSINESS_ACCOUNT_SELECTION" },
      }),
    ).toEqual({ event: "CANCEL" });
    expect(
      parseSignupMessage("https://www.facebook.com", {
        type: "WA_EMBEDDED_SIGNUP",
        event: "ERROR",
        data: { error_message: "boom" },
      }),
    ).toEqual({ event: "ERROR", message: "boom" });
    expect(
      parseSignupMessage("https://www.facebook.com", {
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH_ONLY_WABA",
        data: { waba_id: "1" },
      }),
    ).toEqual({ event: "FINISH_ONLY_WABA", wabaId: "1" });
  });

  it("ignores non-signup messages and junk", () => {
    expect(
      parseSignupMessage("https://www.facebook.com", "not json"),
    ).toBeNull();
    expect(
      parseSignupMessage("https://www.facebook.com", { type: "other" }),
    ).toBeNull();
    expect(
      parseSignupMessage("https://www.facebook.com", {
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH",
        data: {},
      }),
    ).toBeNull();
  });
});
