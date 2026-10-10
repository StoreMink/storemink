import type { ConfirmationResult } from "firebase/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EARLIER_SEND_WAIT_MS,
  forgetPendingCode,
  pendingCodeKey,
  rememberPendingCode,
  resetPendingCustomerCodes,
  resumablePendingCode,
  trackSend,
  waitForEarlierSend,
} from "./pending-customer-codes";

const confirmation = (label: string) =>
  ({ verificationId: label }) as unknown as ConfirmationResult;

describe("pending customer codes", () => {
  beforeEach(() => resetPendingCustomerCodes());
  afterEach(() => vi.useRealTimers());

  it("resumes only the same order, purpose and number", () => {
    const key = pendingCodeKey("order-1", "pickup");
    const sent = confirmation("a");
    rememberPendingCode(key, {
      phone: "+919876543210",
      maskedPhone: "••••••3210",
      confirmation: sent,
      sentAt: 1_000,
    });

    expect(
      resumablePendingCode(key, "+919876543210", 1_000)?.confirmation,
    ).toBe(sent);
    expect(resumablePendingCode(key, "+919811112222", 1_000)).toBeUndefined();
    expect(
      resumablePendingCode(
        pendingCodeKey("order-1", "return"),
        "+919876543210",
        1_000,
      ),
    ).toBeUndefined();
  });

  it("★ does not resume a code older than the send the cooldown counts from", () => {
    const key = pendingCodeKey("order-1", "pickup");
    rememberPendingCode(key, {
      phone: "+919876543210",
      maskedPhone: "••••••3210",
      confirmation: confirmation("old"),
      sentAt: 1_000,
    });
    // The number was texted again later (for another order): that newer SMS
    // is the one on the phone, so this order's older code is not resumable.
    expect(resumablePendingCode(key, "+919876543210", 2_000)).toBeUndefined();
  });

  it("forgets a used code, but never a newer one", () => {
    const key = pendingCodeKey("order-1", "pickup");
    const used = confirmation("used");
    const newer = confirmation("newer");
    rememberPendingCode(key, {
      phone: "+919876543210",
      maskedPhone: "••••••3210",
      confirmation: newer,
      sentAt: 1_000,
    });
    forgetPendingCode(key, used);
    expect(resumablePendingCode(key, "+919876543210", 0)).toBeDefined();
    forgetPendingCode(key, newer);
    expect(resumablePendingCode(key, "+919876543210", 0)).toBeUndefined();
  });

  it("waits for a send in the air until it is released", async () => {
    const key = pendingCodeKey("order-1", "pickup");
    const release = trackSend(key);
    let waited = false;
    const waiting = waitForEarlierSend(key).then(() => (waited = true));
    await Promise.resolve();
    expect(waited).toBe(false);

    release();
    await waiting;
    expect(waited).toBe(true);
    // Released sends are no longer waited for.
    await expect(waitForEarlierSend(key)).resolves.toBeUndefined();
  });

  it("returns at once when nothing is in the air", async () => {
    vi.useFakeTimers();
    await expect(
      waitForEarlierSend(pendingCodeKey("order-1", "pickup")),
    ).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("★ gives up on a send that never settles, and stops waiting for it", async () => {
    vi.useFakeTimers();
    const key = pendingCodeKey("order-1", "pickup");
    trackSend(key); // never released: its reCAPTCHA left the page
    let waited = false;
    const waiting = waitForEarlierSend(key).then(() => (waited = true));

    await vi.advanceTimersByTimeAsync(EARLIER_SEND_WAIT_MS - 1);
    expect(waited).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(waited).toBe(true);

    // The next attempt does not wait the whole bound again.
    let again = false;
    const second = waitForEarlierSend(key).then(() => (again = true));
    await Promise.resolve();
    await second;
    expect(again).toBe(true);
  });

  it("an older send's release never clears a newer send", async () => {
    const key = pendingCodeKey("order-1", "pickup");
    const releaseOld = trackSend(key);
    const releaseNew = trackSend(key);
    releaseOld();

    let waited = false;
    const waiting = waitForEarlierSend(key).then(() => (waited = true));
    await Promise.resolve();
    expect(waited).toBe(false);
    releaseNew();
    await waiting;
    expect(waited).toBe(true);
  });
});
