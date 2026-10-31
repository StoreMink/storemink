// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

// The shopper sign-in modal from the 2026-10-10 incident (echoss): every send
// path must ask lib/auth/phone-send-guard before Firebase. Firebase's send and
// the reCAPTCHA are mocked; the guard and the error mapper are real, so the
// messages asserted here are the ones a shopper actually reads.
const fb = vi.hoisted(() => ({
  signInWithPhoneNumber: vi.fn(),
  closeAuthModal: vi.fn(),
  refreshCustomer: vi.fn(async () => {}),
}));

vi.mock("firebase/auth", () => ({
  signInWithPhoneNumber: fb.signInWithPhoneNumber,
}));
vi.mock("@/lib/auth/firebase-client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/firebase-client")
  >("@/lib/auth/firebase-client");
  return {
    firebaseAuthErrorMessage: actual.firebaseAuthErrorMessage,
    firebaseAuthErrorCode: actual.firebaseAuthErrorCode,
    getFirebaseAuth: vi.fn(() => ({})),
    establishSession: vi.fn(async () => null),
  };
});
vi.mock("@/lib/auth/recaptcha", () => ({
  freshInvisibleVerifier: vi.fn(() => ({ clear: vi.fn() })),
}));
vi.mock("./AuthProvider", () => ({
  useAuth: () => ({
    isAuthModalOpen: true,
    closeAuthModal: fb.closeAuthModal,
    refreshCustomer: fb.refreshCustomer,
  }),
}));
vi.mock("@/app/(storefront)/components/brand-provider", () => ({
  useBrand: () => ({ name: "Echoss", logoUrl: null }),
}));
vi.mock("@/app/(storefront)/components/policy-consent", () => ({
  usePolicyLinks: () => ({ links: [], required: false, loading: false }),
  PolicyConsent: () => null,
}));
vi.mock("@/app/actions/customer-profile", () => ({
  getMyCustomer: vi.fn(async () => null),
  updateCustomerProfile: vi.fn(async () => ({})),
}));
// A plain input in place of the phone library; the real one hands onChange an
// E.164 string, which is what the guard keys on.
vi.mock("react-phone-number-input", () => ({
  default: ({ value, onChange, onKeyDown, numberInputProps }: any) => (
    <input
      {...numberInputProps}
      aria-label="Mobile number"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  ),
}));
vi.mock("@/lib/phone-labels", () => ({ customPhoneLabels: {} }));
vi.mock("@/components/ui/phone-country-select", () => ({
  CountrySelect: () => null,
}));

import AuthModal from "./AuthModal";
import {
  checkPhoneSend,
  recordPhoneSend,
  resetPhoneSendGuard,
} from "@/lib/auth/phone-send-guard";

const tooMany = () =>
  Object.assign(new Error("TOO_MANY_ATTEMPTS_TRY_LATER"), {
    code: "auth/too-many-requests",
  });

function typeNumber(number: string) {
  fireEvent.change(screen.getByLabelText("Mobile number"), {
    target: { value: number },
  });
}

function pressContinue() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

/** Settle the awaited send and the state updates behind it. */
async function flush() {
  await act(async () => {});
}

async function enterCode(code: string) {
  code.split("").forEach((digit, i) => {
    fireEvent.change(document.getElementById(`auth-otp-input-${i}`)!, {
      target: { value: digit },
    });
  });
  await flush();
}

describe("AuthModal phone sends", () => {
  beforeEach(() => {
    resetPhoneSendGuard();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("★ a second Enter while the first send is in flight does not call Firebase twice", async () => {
    let resolveSend: (value: any) => void = () => {};
    fb.signInWithPhoneNumber.mockImplementation(
      () => new Promise((resolve) => (resolveSend = resolve)),
    );
    render(<AuthModal />);
    typeNumber("+919876500001");

    const input = screen.getByLabelText("Mobile number");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(1);

    await act(async () => resolveSend({ confirm: vi.fn() }));
    expect(screen.getByText("Verify your number")).toBeTruthy();
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(1);
  });

  it("★ after too-many-requests, a further tap stays off Firebase and names a time", async () => {
    fb.signInWithPhoneNumber.mockRejectedValue(tooMany());
    render(<AuthModal />);
    typeNumber("+919876500002");

    pressContinue();
    await flush();
    expect(screen.getByText(/try again after/i)).toBeTruthy();
    expect(screen.queryByText(/wait a few minutes/i)).toBeNull();

    pressContinue();
    await flush();
    fireEvent.keyDown(screen.getByLabelText("Mobile number"), { key: "Enter" });
    await flush();
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/try again after/i)).toBeTruthy();
  });

  it("★ Edit and Back resume the live code for the same number instead of texting again", async () => {
    fb.signInWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });
    render(<AuthModal />);
    typeNumber("+919876500003");
    pressContinue();
    await flush();
    expect(screen.getByText("Verify your number")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    pressContinue();
    await flush();
    expect(screen.getByText("Verify your number")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    pressContinue();
    await flush();
    expect(screen.getByText("Verify your number")).toBeTruthy();

    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/just sent/i)).toBeNull();
    expect(screen.getByText(/Resend OTP in \d+s/)).toBeTruthy();
  });

  it("★ closing and reopening the modal resumes the code rather than sending another", async () => {
    fb.signInWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });
    const first = render(<AuthModal />);
    typeNumber("+919876500004");
    pressContinue();
    await flush();
    // AuthModalLoader unmounts the modal on close.
    first.unmount();

    render(<AuthModal />);
    typeNumber("+919876500004");
    pressContinue();
    await flush();
    expect(screen.getByText("Verify your number")).toBeTruthy();
    expect(screen.getByText(/Resend OTP in \d+s/)).toBeTruthy();
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(1);
  });

  it("a resumed code verifies against the confirmation that was texted", async () => {
    const confirm = vi.fn(async () => ({}));
    fb.signInWithPhoneNumber.mockResolvedValue({ confirm });
    const first = render(<AuthModal />);
    typeNumber("+919876500009");
    pressContinue();
    await flush();
    first.unmount();

    render(<AuthModal />);
    typeNumber("+919876500009");
    pressContinue();
    await flush();
    await enterCode("123456");
    expect(confirm).toHaveBeenCalledWith("123456");
    expect(screen.getByText("Almost there")).toBeTruthy();
  });

  it("does not resume a code whose wrong-attempt cap is spent", async () => {
    const confirm = vi.fn(async () => {
      throw Object.assign(new Error("bad code"), {
        code: "auth/invalid-verification-code",
      });
    });
    fb.signInWithPhoneNumber.mockResolvedValue({ confirm });
    render(<AuthModal />);
    typeNumber("+919876500010");
    pressContinue();
    await flush();

    await enterCode("111111");
    for (const digit of ["2", "3", "4", "5"]) {
      fireEvent.change(document.getElementById("auth-otp-input-5")!, {
        target: { value: digit },
      });
      await flush();
    }
    expect(confirm).toHaveBeenCalledTimes(5);

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    pressContinue();
    await flush();
    expect(screen.getByText(/just sent/i)).toBeTruthy();
    expect(screen.queryByText("Verify your number")).toBeNull();
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(1);
  });

  it("a code resumed after Back keeps its earlier wrong attempts", async () => {
    const confirm = vi.fn(async () => {
      throw Object.assign(new Error("bad code"), {
        code: "auth/invalid-verification-code",
      });
    });
    fb.signInWithPhoneNumber.mockResolvedValue({ confirm });
    render(<AuthModal />);
    typeNumber("+919876500011");
    pressContinue();
    await flush();

    await enterCode("111111");
    for (const digit of ["2", "3"]) {
      fireEvent.change(document.getElementById("auth-otp-input-5")!, {
        target: { value: digit },
      });
      await flush();
    }

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    pressContinue();
    await flush();
    expect(screen.getByText("Verify your number")).toBeTruthy();

    await enterCode("444444");
    fireEvent.change(document.getElementById("auth-otp-input-5")!, {
      target: { value: "5" },
    });
    await flush();
    // 3 before Back + 2 after: the cap of 5, not a fresh 5 for the same code.
    expect(confirm).toHaveBeenCalledTimes(5);
    expect(
      (document.getElementById("auth-otp-input-0") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/too many incorrect attempts/i)).toBeTruthy();
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(1);
  });

  it("does not resume a code another flow has superseded since", async () => {
    vi.useFakeTimers();
    fb.signInWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });
    const number = "+919876500012";
    render(<AuthModal />);
    typeNumber(number);
    pressContinue();
    await flush();

    // Past the cooldown, another flow (the enquiries form, say) texts the
    // same number through the guard. Its code is now the newest one.
    await act(async () => {
      vi.advanceTimersByTime(26_000);
    });
    expect(checkPhoneSend(number).ok).toBe(true);
    recordPhoneSend(number);

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    pressContinue();
    await flush();
    expect(screen.getByText(/just sent/i)).toBeTruthy();
    expect(screen.queryByText("Verify your number")).toBeNull();
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(1);
  });

  it("A, then B, then back to A inside the cooldown does not resume B's code under A", async () => {
    fb.signInWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });
    render(<AuthModal />);
    typeNumber("+919876500013");
    pressContinue();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    typeNumber("+919876500014");
    pressContinue();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    typeNumber("+919876500013");
    pressContinue();
    await flush();
    expect(screen.getByText(/just sent/i)).toBeTruthy();
    expect(screen.queryByText("Verify your number")).toBeNull();
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(2);
  });

  it("★ a send left hanging in a closed modal cannot replace the reopened modal's code", async () => {
    let landStale: (value: any) => void = () => {};
    const staleConfirm = vi.fn(async () => ({}));
    const freshConfirm = vi.fn(async () => ({}));
    fb.signInWithPhoneNumber.mockImplementationOnce(
      () => new Promise((resolve) => (landStale = resolve)),
    );
    const first = render(<AuthModal />);
    typeNumber("+919876500015");
    pressContinue();
    first.unmount();

    // Reopened with the number corrected.
    fb.signInWithPhoneNumber.mockResolvedValueOnce({ confirm: freshConfirm });
    render(<AuthModal />);
    typeNumber("+919876500016");
    pressContinue();
    await flush();
    await act(async () => landStale({ confirm: staleConfirm }));

    // The corrected number's code is still the one Back + Continue resumes...
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    pressContinue();
    await flush();
    expect(screen.getByText("Verify your number")).toBeTruthy();
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(2);

    // ...and the one a typed code is checked against.
    await enterCode("123456");
    expect(freshConfirm).toHaveBeenCalledWith("123456");
    expect(staleConfirm).not.toHaveBeenCalled();
  });

  it("a resumed code is still the one verified when a closed modal's send lands meanwhile", async () => {
    let landStale: (value: any) => void = () => {};
    const resumedConfirm = vi.fn(async () => ({}));
    const staleConfirm = vi.fn(async () => ({}));
    fb.signInWithPhoneNumber.mockResolvedValueOnce({
      confirm: resumedConfirm,
    });
    const first = render(<AuthModal />);
    typeNumber("+919876500017");
    pressContinue();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fb.signInWithPhoneNumber.mockImplementationOnce(
      () => new Promise((resolve) => (landStale = resolve)),
    );
    typeNumber("+919876500018");
    pressContinue();
    first.unmount();

    render(<AuthModal />);
    typeNumber("+919876500017");
    pressContinue();
    await flush();
    expect(screen.getByText("Verify your number")).toBeTruthy();
    await act(async () => landStale({ confirm: staleConfirm }));

    await enterCode("123456");
    expect(resumedConfirm).toHaveBeenCalledWith("123456");
    expect(staleConfirm).not.toHaveBeenCalled();
  });

  it("sends to a different number normally, and does not resume the old code for it", async () => {
    fb.signInWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });
    render(<AuthModal />);
    typeNumber("+919876500005");
    pressContinue();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    typeNumber("+919876500006");
    pressContinue();
    await flush();
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(2);
    expect(fb.signInWithPhoneNumber.mock.calls[1][1]).toBe("+919876500006");
  });

  it("★ a failure that is not a rate limit does not lock the number", async () => {
    fb.signInWithPhoneNumber.mockRejectedValue(
      Object.assign(new Error("bad token"), {
        code: "auth/invalid-app-credential",
      }),
    );
    render(<AuthModal />);
    typeNumber("+919876500007");

    pressContinue();
    await flush();
    expect(
      screen.getByText("The security check didn't complete. Please try again."),
    ).toBeTruthy();

    pressContinue();
    await flush();
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/try again after/i)).toBeNull();
  });

  it("★ Resend is guarded too: a rate-limited resend locks the number", async () => {
    vi.useFakeTimers();
    fb.signInWithPhoneNumber.mockResolvedValueOnce({ confirm: vi.fn() });
    render(<AuthModal />);
    typeNumber("+919876500008");
    pressContinue();
    await flush();
    expect(screen.getByText("Resend OTP in 30s")).toBeTruthy();

    for (let i = 0; i < 30; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
    }
    fb.signInWithPhoneNumber.mockRejectedValueOnce(tooMany());
    fireEvent.click(screen.getByRole("button", { name: "Resend OTP" }));
    await flush();
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/try again after/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resend OTP" }));
    await flush();
    expect(fb.signInWithPhoneNumber).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/try again after/i)).toBeTruthy();
  });
});
