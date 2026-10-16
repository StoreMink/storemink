// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSignupMessage, runEmbeddedSignup } from "./embedded-signup";

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

  it("★★ reads the Coexistence finish, which names the WABA alone", () => {
    expect(
      parseSignupMessage("https://www.facebook.com", {
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
        data: { waba_id: "2323545385144849" },
      }),
    ).toEqual({
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      wabaId: "2323545385144849",
      phoneNumberId: null,
    });
    // A number id, when Meta sends one, is carried.
    expect(
      parseSignupMessage("https://www.facebook.com", {
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
        data: { waba_id: "2", phone_number_id: "3" },
      }),
    ).toEqual({
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      wabaId: "2",
      phoneNumberId: "3",
    });
    // Still nothing without the WABA, and still nothing off facebook.com.
    expect(
      parseSignupMessage("https://www.facebook.com", {
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
        data: {},
      }),
    ).toBeNull();
    expect(
      parseSignupMessage("https://evil.example", {
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
        data: { waba_id: "2" },
      }),
    ).toBeNull();
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

describe("runEmbeddedSignup", () => {
  type LoginCallback = (response: {
    authResponse?: { code?: string } | null;
  }) => void;

  afterEach(() => {
    delete window.FB;
    vi.useRealTimers();
  });

  /** A Facebook SDK whose login answers with a code and, as Meta's popup
   *  does, posts the signup event to the page. */
  function fakeSdk(event?: unknown) {
    const login = vi.fn((cb: LoginCallback, opts: Record<string, unknown>) => {
      void opts;
      cb({ authResponse: { code: "CODE" } });
      if (event !== undefined) {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: "https://www.facebook.com",
            data: JSON.stringify(event),
          }),
        );
      }
    });
    window.FB = { init: vi.fn(), login };
    return login;
  }

  const input = {
    appId: "APP",
    configId: "CFG",
    graphVersion: "v26.0",
    coexistence: true,
  };

  it("★★ completes the Coexistence finish that names only the WABA", async () => {
    const login = fakeSdk({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      data: { waba_id: "2323545385144849" },
    });
    await expect(runEmbeddedSignup(input)).resolves.toEqual({
      ok: true,
      code: "CODE",
      wabaId: "2323545385144849",
      phoneNumberId: null,
    });
    expect(login.mock.calls[0]![1]).toMatchObject({
      extras: { featureType: "whatsapp_business_app_onboarding" },
    });
  });

  it("a plain FINISH still carries both ids", async () => {
    fakeSdk(JSON.parse(finish));
    await expect(
      runEmbeddedSignup({ ...input, coexistence: false }),
    ).resolves.toEqual({
      ok: true,
      code: "CODE",
      wabaId: "2323545385144849",
      phoneNumberId: "1280649011808874",
    });
  });

  it("a finish with no number outside Coexistence is still an error", async () => {
    fakeSdk({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH_ONLY_WABA",
      data: { waba_id: "1" },
    });
    const r = await runEmbeddedSignup({ ...input, coexistence: false });
    expect(r).toMatchObject({ ok: false, cancelled: false });
  });

  it("with no account at all it gives up after 15 seconds", async () => {
    vi.useFakeTimers();
    fakeSdk();
    const pending = runEmbeddedSignup(input);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      cancelled: false,
      error:
        "Meta signed you in but didn't return the WhatsApp account. Try again.",
    });
  });
});
