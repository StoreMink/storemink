// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// Firebase: a code sign-in on the SECONDARY app. Every object the form touches
// is created here so each test can read what happened to it.
const fb = vi.hoisted(() => {
  const state = { verifiers: [] as any[] };
  const user = {
    getIdToken: vi.fn(async () => "proof-token"),
    delete: vi.fn(async () => {}),
  };
  const confirmation = { confirm: vi.fn(async () => ({ user })) };
  const secondaryAuth = { signOut: vi.fn(async () => {}) };
  return { state, user, confirmation, secondaryAuth };
});

vi.mock("firebase/auth", () => ({
  RecaptchaVerifier: vi.fn(function (this: any) {
    this.clear = vi.fn();
    fb.state.verifiers.push(this);
  }),
  signInWithPhoneNumber: vi.fn(async () => fb.confirmation),
  getAdditionalUserInfo: vi.fn(() => ({ isNewUser: true })),
}));
vi.mock("@/lib/auth/firebase-client", () => ({
  getSecondaryFirebaseAuth: vi.fn(() => fb.secondaryAuth),
  firebaseAuthErrorCode: vi.fn((err: any) => String(err?.code ?? "")),
  firebaseAuthErrorMessage: vi.fn((err: any) =>
    err?.code === "auth/network-request-failed"
      ? "Network error. Check your connection and try again."
      : "That code isn't right. Please check and try again.",
  ),
}));
vi.mock("@/app/actions/account-settings", () => ({
  confirmVerifiedPhone: vi.fn(async () => ({ phone: "+919876543210" })),
}));
// A plain input in place of the phone library keeps these tests about the
// verification flow rather than about number formatting.
vi.mock("react-phone-number-input", () => ({
  default: ({ value, onChange, numberInputProps }: any) => (
    <input
      {...numberInputProps}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
  isValidPhoneNumber: (v: string) => /^\+\d{10,15}$/.test(v),
  formatPhoneNumberIntl: (v: string) => v,
}));
vi.mock("@/lib/phone-labels", () => ({ customPhoneLabels: {} }));
vi.mock("@/components/ui/phone-country-select", () => ({
  CountrySelect: () => null,
}));

import { VerifyPhoneForm } from "./verify-phone-form";
import { getAdditionalUserInfo, signInWithPhoneNumber } from "firebase/auth";
import { confirmVerifiedPhone } from "@/app/actions/account-settings";
import {
  PHONE_SEND_COOLDOWN_MS,
  resetPhoneSendGuard,
} from "@/lib/auth/phone-send-guard";

const authError = (code: string) => Object.assign(new Error(code), { code });

function sendCodeFor(number: string) {
  fireEvent.change(screen.getByLabelText("Mobile number"), {
    target: { value: number },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
}

async function typeCode(code: string) {
  const input = await screen.findByPlaceholderText("6-digit code");
  fireEvent.change(input, { target: { value: code } });
}

describe("VerifyPhoneForm", () => {
  beforeEach(() => {
    // The send guard is module-scoped: without this, one test's send puts the
    // next test's number in its cooldown.
    resetPhoneSendGuard();
    fb.state.verifiers.length = 0;
  });

  it("refuses an invalid number without sending anything", () => {
    render(<VerifyPhoneForm onVerified={vi.fn()} />);
    sendCodeFor("+91123");
    expect(screen.getByRole("alert").textContent).toMatch(
      /valid mobile number/i,
    );
    expect(signInWithPhoneNumber).not.toHaveBeenCalled();
  });

  it("★ sends on the isolated app, verifies at six digits and reports the SERVER's number", async () => {
    const onVerified = vi.fn();
    render(<VerifyPhoneForm onVerified={onVerified} />);
    sendCodeFor("+919876543210");

    await screen.findByPlaceholderText("6-digit code");
    expect(signInWithPhoneNumber).toHaveBeenCalledWith(
      fb.secondaryAuth,
      "+919876543210",
      fb.state.verifiers[0],
    );

    await typeCode("12-34 56");
    await waitFor(() =>
      expect(onVerified).toHaveBeenCalledWith("+919876543210"),
    );
    expect(fb.confirmation.confirm).toHaveBeenCalledWith("123456");
    // The new phone-only identity is flagged so the server can remove it.
    expect(confirmVerifiedPhone).toHaveBeenCalledWith({
      idToken: "proof-token",
      cleanupCreatedAuthUser: true,
    });
  });

  it("does not ask the server to clean up an identity that already existed", async () => {
    vi.mocked(getAdditionalUserInfo).mockReturnValueOnce({
      isNewUser: false,
    } as any);
    render(<VerifyPhoneForm onVerified={vi.fn()} />);
    sendCodeFor("+919876543210");
    await typeCode("123456");
    await waitFor(() =>
      expect(confirmVerifiedPhone).toHaveBeenCalledWith({
        idToken: "proof-token",
        cleanupCreatedAuthUser: false,
      }),
    );
  });

  it("★ a failed save keeps the proof: Try again never re-confirms the code", async () => {
    vi.mocked(confirmVerifiedPhone).mockResolvedValueOnce({
      error: "Couldn't save your phone number. Please try again.",
    });
    const onVerified = vi.fn();
    render(<VerifyPhoneForm onVerified={onVerified} />);
    sendCodeFor("+919876543210");
    await typeCode("123456");

    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByRole("alert").textContent).toMatch(/couldn.?t save/i);
    expect(onVerified).not.toHaveBeenCalled();

    fireEvent.click(retry);
    await waitFor(() =>
      expect(onVerified).toHaveBeenCalledWith("+919876543210"),
    );
    // A code can be confirmed with Firebase only once.
    expect(fb.confirmation.confirm).toHaveBeenCalledTimes(1);
    expect(confirmVerifiedPhone).toHaveBeenCalledTimes(2);
  });

  it("a wrong code is reported and never reaches the server", async () => {
    fb.confirmation.confirm.mockRejectedValueOnce(
      Object.assign(new Error("bad"), {
        code: "auth/invalid-verification-code",
      }),
    );
    render(<VerifyPhoneForm onVerified={vi.fn()} />);
    sendCodeFor("+919876543210");
    await typeCode("000000");

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /code isn.?t right/i,
      ),
    );
    expect(confirmVerifiedPhone).not.toHaveBeenCalled();
    expect(
      (screen.getByPlaceholderText("6-digit code") as HTMLInputElement).value,
    ).toBe("");
  });

  it("uses a fresh reCAPTCHA verifier for every send", async () => {
    render(<VerifyPhoneForm onVerified={vi.fn()} />);
    sendCodeFor("+919876543210");
    await screen.findByPlaceholderText("6-digit code");

    fireEvent.click(screen.getByRole("button", { name: "Change number" }));
    sendCodeFor("+919812345678");
    await screen.findByPlaceholderText("6-digit code");

    expect(fb.state.verifiers).toHaveLength(2);
    expect(fb.state.verifiers[0].clear).toHaveBeenCalled();
    expect(signInWithPhoneNumber).toHaveBeenLastCalledWith(
      fb.secondaryAuth,
      "+919812345678",
      fb.state.verifiers[1],
    );
  });

  describe("send guard", () => {
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("★ a second send while the first is in flight does not reach Firebase", async () => {
      let answer: (value: unknown) => void = () => {};
      vi.mocked(signInWithPhoneNumber).mockImplementationOnce(
        () => new Promise((resolve) => (answer = resolve)) as any,
      );
      render(<VerifyPhoneForm onVerified={vi.fn()} />);
      fireEvent.change(screen.getByLabelText("Mobile number"), {
        target: { value: "+919876543210" },
      });
      const form = screen.getByLabelText("Mobile number").closest("form")!;
      // Enter twice: a keyboard submit is not stopped by a disabled button.
      fireEvent.submit(form);
      fireEvent.submit(form);

      await waitFor(() => expect(signInWithPhoneNumber).toHaveBeenCalled());
      await act(async () => answer(fb.confirmation));
      await screen.findByPlaceholderText("6-digit code");
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);
      expect(fb.state.verifiers).toHaveLength(1);
    });

    it("★ after Firebase says too many requests, a further tap stays off Firebase and names a time", async () => {
      vi.mocked(signInWithPhoneNumber).mockRejectedValueOnce(
        authError("auth/too-many-requests"),
      );
      render(<VerifyPhoneForm onVerified={vi.fn()} />);
      sendCodeFor("+919876543210");
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toMatch(
          /try again after/i,
        ),
      );

      fireEvent.click(screen.getByRole("button", { name: "Send code" }));
      expect(screen.getByRole("alert").textContent).toMatch(/try again after/i);
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);
      // Refused before a reCAPTCHA verifier was even created for the tap.
      expect(fb.state.verifiers).toHaveLength(1);
    });

    it("★ Change number back to the same number inside the cooldown resumes the live code", async () => {
      const onVerified = vi.fn();
      render(<VerifyPhoneForm onVerified={onVerified} />);
      sendCodeFor("+919876543210");
      await screen.findByPlaceholderText("6-digit code");

      fireEvent.click(screen.getByRole("button", { name: "Change number" }));
      sendCodeFor("+919876543210");

      await screen.findByPlaceholderText("6-digit code");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);
      // Resend waits for the guard's cooldown, not a fresh 30 seconds.
      const resend = screen.getByRole("button", { name: /resend in \d+s/i });
      expect(resend).toBeDisabled();
      const seconds = Number(resend.textContent!.match(/(\d+)s/)![1]);
      expect(seconds).toBeLessThanOrEqual(PHONE_SEND_COOLDOWN_MS / 1000);

      // The code already on the phone still verifies.
      await typeCode("123456");
      await waitFor(() =>
        expect(onVerified).toHaveBeenCalledWith("+919876543210"),
      );
      expect(fb.confirmation.confirm).toHaveBeenCalledWith("123456");
    });

    it("★ a code is resumed only for the number it was sent to", async () => {
      render(<VerifyPhoneForm onVerified={vi.fn()} />);
      sendCodeFor("+919876543210");
      await screen.findByPlaceholderText("6-digit code");

      fireEvent.click(screen.getByRole("button", { name: "Change number" }));
      sendCodeFor("+919812345678");
      await screen.findByPlaceholderText("6-digit code");

      // The second number's code replaced the first: going back to the first
      // number inside its cooldown must not show a code step that would
      // confirm against the other number's code.
      fireEvent.click(screen.getByRole("button", { name: "Change number" }));
      sendCodeFor("+919876543210");
      expect(screen.getByRole("alert").textContent).toMatch(/just sent/i);
      expect(screen.queryByPlaceholderText("6-digit code")).toBeNull();
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(2);
    });

    it("a remount inside the cooldown does not text the same number again", async () => {
      const first = render(<VerifyPhoneForm onVerified={vi.fn()} />);
      sendCodeFor("+919876543210");
      await screen.findByPlaceholderText("6-digit code");
      first.unmount();

      render(<VerifyPhoneForm onVerified={vi.fn()} />);
      sendCodeFor("+919876543210");
      expect(screen.getByRole("alert").textContent).toMatch(/just sent/i);
      expect(screen.queryByPlaceholderText("6-digit code")).toBeNull();
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);
    });

    it("a confirmed code is spent: Change number does not resume it", async () => {
      vi.mocked(confirmVerifiedPhone).mockResolvedValueOnce({
        error: "Couldn't save your phone number. Please try again.",
      });
      render(<VerifyPhoneForm onVerified={vi.fn()} />);
      sendCodeFor("+919876543210");
      await typeCode("123456");
      await screen.findByRole("button", { name: "Try again" });

      fireEvent.click(screen.getByRole("button", { name: "Change number" }));
      sendCodeFor("+919876543210");
      expect(screen.getByRole("alert").textContent).toMatch(/just sent/i);
      expect(screen.queryByPlaceholderText("6-digit code")).toBeNull();
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);
    });

    it("a failure that is not a rate limit does not lock the number", async () => {
      vi.mocked(signInWithPhoneNumber).mockRejectedValueOnce(
        authError("auth/network-request-failed"),
      );
      render(<VerifyPhoneForm onVerified={vi.fn()} />);
      sendCodeFor("+919876543210");
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toMatch(/network error/i),
      );

      fireEvent.click(screen.getByRole("button", { name: "Send code" }));
      await screen.findByPlaceholderText("6-digit code");
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(2);
    });
  });
});
