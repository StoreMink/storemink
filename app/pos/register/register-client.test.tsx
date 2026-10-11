// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

// Firebase: the staff member's own account, then a phone challenge on it.
const fb = vi.hoisted(() => {
  const verifyPhoneNumber = vi.fn<
    (phone: string, verifier: unknown) => Promise<string>
  >(async () => "vid-1");
  const auth = { currentUser: { phoneNumber: null as string | null } };
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
    createUserWithEmailAndPassword: vi.fn(async () => ({})),
    signInWithEmailAndPassword: vi.fn(async () => ({})),
    updatePhoneNumber: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/auth/firebase-client", () => ({
  getFirebaseAuth: vi.fn(() => fb.auth),
  establishSession: vi.fn(async () => null),
  firebaseAuthErrorMessage: vi.fn(
    (err: any) => `mapped:${err?.code ?? "unknown"}`,
  ),
}));
vi.mock("@/app/actions/pos-staff-actions", () => ({
  completeStaffRegistration: vi.fn(async () => ({})),
}));
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), refresh: vi.fn() })),
}));
// A plain input in place of the phone library keeps these tests about sending.
vi.mock("react-phone-number-input", () => ({
  default: ({ value, onChange, placeholder }: any) => (
    <input
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
  isValidPhoneNumber: (v: string) => /^\+\d{10,15}$/.test(v),
}));

import { RegisterClient } from "./register-client";
import { PhoneAuthProvider, updatePhoneNumber } from "firebase/auth";
import { resetPhoneSendGuard } from "@/lib/auth/phone-send-guard";

const A = "+919876543210";
const B = "+919812345678";

function renderClient() {
  return render(
    <RegisterClient
      token="tok"
      email="asha@shop.in"
      name="Asha"
      role="cashier"
    />,
  );
}

async function reachPhoneStep() {
  fireEvent.change(screen.getByPlaceholderText("Create a password (min 8)"), {
    target: { value: "password1" },
  });
  fireEvent.change(screen.getByPlaceholderText("Confirm password"), {
    target: { value: "password1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByPlaceholderText("Phone number");
}

function sendTo(number: string) {
  fireEvent.change(screen.getByPlaceholderText("Phone number"), {
    target: { value: number },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
}

describe("RegisterClient phone code sends", () => {
  beforeEach(() => {
    resetPhoneSendGuard();
  });

  it("★ a second tap while the first send is in flight does not call Firebase twice", async () => {
    let resolveSend!: (id: string) => void;
    fb.verifyPhoneNumber.mockImplementationOnce(
      () => new Promise<string>((r) => (resolveSend = r)),
    );
    renderClient();
    await reachPhoneStep();
    fireEvent.change(screen.getByPlaceholderText("Phone number"), {
      target: { value: A },
    });

    // Both taps land before React re-renders the button as disabled.
    const send = screen.getByRole("button", { name: "Send code" });
    act(() => {
      send.click();
      send.click();
    });
    await act(async () => resolveSend("vid-1"));

    await screen.findByPlaceholderText("6-digit code");
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(1);
  });

  it("★ after Firebase says too many requests, a further tap stays off Firebase and names a time", async () => {
    fb.verifyPhoneNumber.mockRejectedValueOnce({
      code: "auth/too-many-requests",
    });
    renderClient();
    await reachPhoneStep();
    sendTo(A);

    expect(await screen.findByText(/try again after/i)).toBeTruthy();
    expect(screen.queryByText("mapped:auth/too-many-requests")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/try again after/i)).toBeTruthy();
  });

  it("★ Use a different number, then the same number inside the cooldown, resumes the live code", async () => {
    renderClient();
    await reachPhoneStep();
    sendTo(A);
    await screen.findByPlaceholderText("6-digit code");

    fireEvent.click(
      screen.getByRole("button", { name: "Use a different number" }),
    );
    sendTo(A);

    const code = await screen.findByPlaceholderText("6-digit code");
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/code was just sent/i)).toBeNull();

    // The code already on the phone still verifies.
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify phone" }));
    await screen.findByPlaceholderText("Set an 8-digit PIN");
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
    renderClient();
    await reachPhoneStep();
    sendTo(A);
    await screen.findByPlaceholderText("6-digit code");
    fireEvent.click(
      screen.getByRole("button", { name: "Use a different number" }),
    );
    sendTo(B);
    await screen.findByPlaceholderText("6-digit code");
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(2);
    expect(fb.verifyPhoneNumber.mock.calls[1][0]).toBe(B);

    // A's code is no longer the live one, so A inside its cooldown is refused
    // rather than resumed against B's verificationId.
    fireEvent.click(
      screen.getByRole("button", { name: "Use a different number" }),
    );
    sendTo(A);
    expect(await screen.findByText(/code was just sent/i)).toBeTruthy();
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(2);
    expect(screen.queryByPlaceholderText("6-digit code")).toBeNull();
  });

  it("a remount inside the cooldown does not text the same number again", async () => {
    const first = renderClient();
    await reachPhoneStep();
    sendTo(A);
    await screen.findByPlaceholderText("6-digit code");
    first.unmount();

    renderClient();
    await reachPhoneStep();
    sendTo(A);
    expect(await screen.findByText(/code was just sent/i)).toBeTruthy();
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(1);
  });

  it("a non-rate-limit failure does not lock the number", async () => {
    fb.verifyPhoneNumber.mockRejectedValueOnce({
      code: "auth/invalid-phone-number",
    });
    renderClient();
    await reachPhoneStep();
    sendTo(A);
    expect(
      await screen.findByText("mapped:auth/invalid-phone-number"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByPlaceholderText("6-digit code");
    expect(fb.verifyPhoneNumber).toHaveBeenCalledTimes(2);
  });
});
