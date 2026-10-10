import { beforeEach, describe, expect, it } from "vitest";
import {
  PHONE_SEND_COOLDOWN_MS,
  PHONE_SEND_LIMIT,
  PHONE_SEND_LOCKOUT_MS,
  PHONE_SEND_WINDOW_MS,
  checkPhoneSend,
  isTooManyRequests,
  phoneSendErrorMessage,
  recordPhoneSend,
  recordPhoneSendFailure,
  resetPhoneSendGuard,
} from "./phone-send-guard";

const PHONE = "+919876543210";
const T0 = Date.UTC(2026, 9, 10, 14, 0, 0);
const err = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => resetPhoneSendGuard());

describe("checkPhoneSend", () => {
  it("allows the first send", () => {
    expect(checkPhoneSend(PHONE, T0)).toEqual({ ok: true });
  });

  it("refuses a second send inside the cooldown, and allows it after", () => {
    recordPhoneSend(PHONE, T0);
    const soon = checkPhoneSend(PHONE, T0 + 5_000);
    expect(soon.ok).toBe(false);
    if (!soon.ok) {
      expect(soon.reason).toBe("cooldown");
      expect(soon.retryAt).toBe(T0 + PHONE_SEND_COOLDOWN_MS);
      expect(soon.message).toMatch(/just sent/i);
    }
    expect(checkPhoneSend(PHONE, T0 + PHONE_SEND_COOLDOWN_MS)).toEqual({
      ok: true,
    });
  });

  // The resend button every flow shows appears after 30 seconds; the rule must
  // never refuse a button that has only just appeared.
  it("never refuses a resend offered after the 30-second timer", () => {
    expect(PHONE_SEND_COOLDOWN_MS).toBeLessThanOrEqual(30_000);
  });

  it("treats the same number typed differently as one number", () => {
    recordPhoneSend("+91 98765 43210", T0);
    expect(checkPhoneSend(PHONE, T0 + 1_000).ok).toBe(false);
  });

  it("keeps numbers apart", () => {
    recordPhoneSend(PHONE, T0);
    expect(checkPhoneSend("+919876543211", T0 + 1_000)).toEqual({ ok: true });
  });

  it("caps sends per number per window, and frees the oldest slot when it ages out", () => {
    for (let i = 0; i < PHONE_SEND_LIMIT; i++) {
      recordPhoneSend(PHONE, T0 + i * PHONE_SEND_COOLDOWN_MS);
    }
    const after = T0 + PHONE_SEND_LIMIT * PHONE_SEND_COOLDOWN_MS;
    const blocked = checkPhoneSend(PHONE, after);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.reason).toBe("limit");
      expect(blocked.retryAt).toBe(T0 + PHONE_SEND_WINDOW_MS);
    }
    expect(checkPhoneSend(PHONE, T0 + PHONE_SEND_WINDOW_MS).ok).toBe(true);
  });

  // The person who has just received their 5th code of the hour must still be
  // able to go Back and return to it: the cooldown is reported first.
  it("reports the cooldown first after the last allowed send, with the limit's message", () => {
    for (let i = 0; i < PHONE_SEND_LIMIT; i++) {
      recordPhoneSend(PHONE, T0 + i * PHONE_SEND_COOLDOWN_MS);
    }
    const lastSend = T0 + (PHONE_SEND_LIMIT - 1) * PHONE_SEND_COOLDOWN_MS;
    const check = checkPhoneSend(PHONE, lastSend + 5_000);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe("cooldown");
      expect(check.retryAt).toBe(lastSend + PHONE_SEND_COOLDOWN_MS);
      expect(check.message).toMatch(/try again after/i);
      expect(check.message).not.toMatch(/just sent/i);
    }
    const later = checkPhoneSend(PHONE, lastSend + PHONE_SEND_COOLDOWN_MS);
    expect(!later.ok && later.reason).toBe("limit");
  });

  it("reports the cooldown first under a lockout too", () => {
    recordPhoneSend(PHONE, T0);
    recordPhoneSendFailure(PHONE, err("auth/too-many-requests"), T0 + 1_000);
    const check = checkPhoneSend(PHONE, T0 + 2_000);
    expect(!check.ok && check.reason).toBe("cooldown");
    expect(!check.ok && check.message).toMatch(/for your security/i);
    const later = checkPhoneSend(PHONE, T0 + PHONE_SEND_COOLDOWN_MS);
    expect(!later.ok && later.reason).toBe("locked");
  });

  it("stays below Firebase's documented 10 per number per hour", () => {
    expect(PHONE_SEND_LIMIT).toBeLessThan(10);
    expect(PHONE_SEND_WINDOW_MS).toBeGreaterThanOrEqual(60 * 60_000);
  });
});

describe("recordPhoneSendFailure", () => {
  it("locks the number after Firebase says too many requests", () => {
    recordPhoneSendFailure(PHONE, err("auth/too-many-requests"), T0);
    const locked = checkPhoneSend(PHONE, T0 + 60_000);
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.reason).toBe("locked");
      expect(locked.retryAt).toBe(T0 + PHONE_SEND_LOCKOUT_MS);
    }
    expect(checkPhoneSend(PHONE, T0 + PHONE_SEND_LOCKOUT_MS).ok).toBe(true);
  });

  // A failed send texted nobody, so it must not spend the person's budget —
  // otherwise a flaky network locks someone out without a single SMS.
  it("spends nothing for any other failure", () => {
    for (let i = 0; i < PHONE_SEND_LIMIT + 2; i++) {
      recordPhoneSendFailure(PHONE, err("auth/network-request-failed"), T0);
    }
    expect(checkPhoneSend(PHONE, T0)).toEqual({ ok: true });
  });

  it("never shortens an existing lockout", () => {
    recordPhoneSendFailure(PHONE, err("auth/too-many-requests"), T0);
    recordPhoneSendFailure(PHONE, err("auth/too-many-requests"), T0 - 60_000);
    const locked = checkPhoneSend(PHONE, T0 + 1_000);
    expect(!locked.ok && locked.retryAt).toBe(T0 + PHONE_SEND_LOCKOUT_MS);
  });
});

describe("phoneSendErrorMessage", () => {
  it("names when to try again instead of 'wait a moment'", () => {
    recordPhoneSendFailure(PHONE, err("auth/too-many-requests"), T0);
    const message = phoneSendErrorMessage(
      PHONE,
      err("auth/too-many-requests"),
      T0,
    );
    expect(message).toMatch(/try again after/i);
    expect(message).not.toMatch(/a moment/i);
  });

  it("still says something useful when the lockout was not recorded", () => {
    expect(
      phoneSendErrorMessage(PHONE, err("auth/too-many-requests"), T0),
    ).toMatch(/too many codes/i);
  });

  it("defers to the shared mapper for every other code", () => {
    expect(
      phoneSendErrorMessage(PHONE, err("auth/invalid-phone-number"), T0),
    ).toMatch(/valid mobile number/i);
  });
});

describe("isTooManyRequests", () => {
  it("recognises only Firebase's too-many-requests code", () => {
    expect(isTooManyRequests(err("auth/too-many-requests"))).toBe(true);
    expect(isTooManyRequests(err("auth/quota-exceeded"))).toBe(false);
    expect(isTooManyRequests(null)).toBe(false);
    expect(isTooManyRequests("auth/too-many-requests")).toBe(false);
  });
});
