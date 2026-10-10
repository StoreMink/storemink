// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  firebaseAuthErrorMessage: vi.fn(
    () => "That code isn't right. Please check and try again.",
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
});
