// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

// Firebase: a phone challenge for the signed-in invited admin.
const fb = vi.hoisted(() => {
  const verifyPhoneNumber = vi.fn<
    (phone: string, verifier: unknown) => Promise<string>
  >(async () => "vid-1");
  const auth = { currentUser: { uid: "admin-1" } };
  return { verifyPhoneNumber, auth };
});

vi.mock("firebase/auth", () => {
  const PhoneAuthProvider = vi.fn(function (this: any) {
    this.verifyPhoneNumber = fb.verifyPhoneNumber;
  });
  (PhoneAuthProvider as any).credential = vi.fn((id: string, code: string) => ({
    id,
    code,
  }));
  return {
    PhoneAuthProvider,
    RecaptchaVerifier: vi.fn(function (this: any) {
      this.clear = vi.fn();
    }),
    updatePhoneNumber: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/auth/firebase-client", () => ({
  getFirebaseAuth: vi.fn(() => fb.auth),
  establishSession: vi.fn(async () => null),
  phoneLinkErrorMessage: vi.fn((err: any) => `link:${err?.code ?? "unknown"}`),
  firebaseAuthErrorMessage: vi.fn(
    (err: any) => `mapped:${err?.code ?? "unknown"}`,
  ),
}));
vi.mock("@/app/actions/set-password", () => ({
  setPassword: vi.fn(async () => ({})),
  getSetPasswordProfile: vi.fn(async () => null),
}));
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
}));
// A plain input in place of the phone library keeps these tests about sending.
vi.mock("react-phone-number-input", () => ({
  default: ({ value, onChange, placeholder, disabled }: any) => (
    <input
      placeholder={placeholder}
      disabled={disabled}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock("@/lib/phone-labels", () => ({ customPhoneLabels: {} }));
vi.mock("@/components/ui/phone-country-select", () => ({
  CountrySelect: () => null,
}));

import SetPasswordPage from "./page";
import { PhoneAuthProvider, updatePhoneNumber } from "firebase/auth";
import { resetPhoneSendGuard } from "@/lib/auth/phone-send-guard";

const A = "+919876543210";
const B = "+919812345678";

function enterPhone(number: string) {
  fireEvent.change(screen.getByPlaceholderText("Mobile number"), {
    target: { value: number },
  });
}

function sendTo(number: string) {
  enterPhone(number);
  fireEvent.click(screen.getByRole("button", { name: "Send OTP" }));
}

describe("SetPasswordPage phone code sends", () => {
  beforeEach(() => {
    resetPhoneSendGuard();
  });

  it("★ a second tap while the first send is in flight does not call Firebase twice", async () => {
    let resolveSend!: (id: string) => void;
    fb.verifyPhoneNumber.mockImplementationOnce(
      () => new Promise<string>((r) => (resolveSend = r)),
    );
    render(<SetPasswordPage />);
    enterPhone(A);

    // Both taps land before React re-renders the button as disabled.
    const send = screen.getByRole("button", { name: "Send OTP" });
    act(() => {
      send.click();
      send.click();
    });
    await act(async () => resolveSend("vid-1"));

    await screen.findByPlaceholderText("Enter 6-digit OTP");
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(1);
  });

  it("★ after Firebase says too many requests, a further tap stays off Firebase and names a time", async () => {
    fb.verifyPhoneNumber.mockRejectedValueOnce({
      code: "auth/too-many-requests",
    });
    render(<SetPasswordPage />);
    sendTo(A);

    expect(await screen.findByText(/try again after/i)).toBeTruthy();
    expect(screen.queryByText("link:auth/too-many-requests")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Send OTP" }));
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/try again after/i)).toBeTruthy();
  });

  it("★ Edit, then the same number inside the cooldown, resumes the live code", async () => {
    render(<SetPasswordPage />);
    sendTo(A);
    await screen.findByPlaceholderText("Enter 6-digit OTP");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Send OTP" }));

    const otp = await screen.findByPlaceholderText("Enter 6-digit OTP");
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/code was just sent/i)).toBeNull();

    // The code already on the phone still links.
    fireEvent.change(otp, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByText("Phone Number Verified");
    expect((PhoneAuthProvider as any).credential).toHaveBeenCalledWith(
      "vid-1",
      "123456",
    );
    expect(updatePhoneNumber).toHaveBeenCalledTimes(1);
  });

  it("a successful send to a different number replaces the live code", async () => {
    fb.verifyPhoneNumber
      .mockResolvedValueOnce("vid-A")
      .mockResolvedValueOnce("vid-B");
    render(<SetPasswordPage />);
    sendTo(A);
    await screen.findByPlaceholderText("Enter 6-digit OTP");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    sendTo(B);
    await screen.findByPlaceholderText("Enter 6-digit OTP");
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(2);
    expect(fb.verifyPhoneNumber.mock.calls[1][0]).toBe(B);

    // A's code is no longer the live one, so A inside its cooldown is refused
    // rather than resumed against B's verificationId.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    sendTo(A);
    expect(await screen.findByText(/code was just sent/i)).toBeTruthy();
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(2);
    expect(screen.queryByPlaceholderText("Enter 6-digit OTP")).toBeNull();
  });

  it("a non-rate-limit failure keeps the link mapper and does not lock the number", async () => {
    fb.verifyPhoneNumber.mockRejectedValueOnce({
      code: "auth/invalid-phone-number",
    });
    render(<SetPasswordPage />);
    sendTo(A);
    expect(
      await screen.findByText("link:auth/invalid-phone-number"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send OTP" }));
    await screen.findByPlaceholderText("Enter 6-digit OTP");
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(2);
  });
});
