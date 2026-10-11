// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  begin: vi.fn(),
  confirm: vi.fn(),
}));
const firebase = vi.hoisted(() => ({
  signIn: vi.fn(),
  confirmCode: vi.fn(),
  signOut: vi.fn(),
  deleteUser: vi.fn(),
  verifierClears: vi.fn(),
}));

vi.mock("@/app/actions/pos-customer-verification-actions", () => ({
  beginCustomerPhoneVerification: actions.begin,
  confirmCustomerPhoneVerification: actions.confirm,
}));
vi.mock("firebase/auth", () => ({
  RecaptchaVerifier: class {
    clear() {
      firebase.verifierClears();
    }
  },
  signInWithPhoneNumber: firebase.signIn,
  getAdditionalUserInfo: vi.fn(() => ({ isNewUser: false })),
}));
vi.mock("@/lib/auth/firebase-client", () => ({
  getSecondaryFirebaseAuth: vi.fn(() => ({ signOut: firebase.signOut })),
  firebaseAuthErrorMessage: vi.fn(() => "Phone verification failed."),
  firebaseAuthErrorCode: vi.fn(() => "auth/mocked"),
}));

import {
  recordPhoneSend,
  resetPhoneSendGuard,
} from "@/lib/auth/phone-send-guard";
import { CustomerPhoneVerification } from "./customer-phone-verification";
import { resetPendingCustomerCodes } from "./pending-customer-codes";

function renderVerification(
  overrides: Partial<Parameters<typeof CustomerPhoneVerification>[0]> = {},
) {
  return render(
    <CustomerPhoneVerification
      orderId="order-1"
      purpose="pickup"
      onVerified={vi.fn()}
      onOverride={vi.fn()}
      onCancel={vi.fn()}
      {...overrides}
    />,
  );
}

function firebaseError(code: string) {
  return Object.assign(new Error(code), { code });
}

describe("CustomerPhoneVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actions.begin.mockResolvedValue({
      phone: "+919876543210",
      maskedPhone: "••••••3210",
    });
    actions.confirm.mockResolvedValue({ verified: true });
    firebase.confirmCode.mockResolvedValue({
      user: {
        getIdToken: vi.fn(async () => "firebase-id-token"),
        delete: firebase.deleteUser,
      },
    });
    firebase.signIn.mockResolvedValue({ confirm: firebase.confirmCode });
    firebase.signOut.mockResolvedValue(undefined);
    // The send guard and the pending codes are module state, so one test's
    // sends would otherwise cool down, lock or resume the next test's number.
    resetPhoneSendGuard();
    resetPendingCustomerCodes();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("sends to the server-owned phone and verifies automatically at six digits", async () => {
    const verified = vi.fn();
    render(
      <CustomerPhoneVerification
        orderId="order-1"
        purpose="pickup"
        onVerified={verified}
        onOverride={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/code sent to \+91 ••••••3210/i),
    ).toBeVisible();
    expect(actions.begin).toHaveBeenCalledWith("order-1", "pickup");
    expect(firebase.signIn).toHaveBeenCalledWith(
      expect.anything(),
      "+919876543210",
      expect.anything(),
    );

    fireEvent.change(screen.getByLabelText("6-digit code"), {
      target: { value: "12a34567" },
    });

    await waitFor(() => expect(verified).toHaveBeenCalledTimes(1));
    expect(firebase.confirmCode).toHaveBeenCalledWith("123456");
    expect(actions.confirm).toHaveBeenCalledWith({
      orderId: "order-1",
      purpose: "pickup",
      idToken: "firebase-id-token",
      cleanupCreatedAuthUser: false,
    });
    expect(firebase.signOut).toHaveBeenCalled();
  });

  it("shows a retry when the initial send cannot start", async () => {
    actions.begin.mockResolvedValue({
      error: "This order has no valid mobile.",
    });
    render(
      <CustomerPhoneVerification
        orderId="order-2"
        purpose="return"
        onVerified={vi.fn()}
        onOverride={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This order has no valid mobile.",
    );
    expect(
      screen.getByRole("button", { name: /try sending again/i }),
    ).toBeVisible();
    expect(firebase.signIn).not.toHaveBeenCalled();
  });

  // ★★ The dialog NEVER decides this for itself — it renders what the server
  // reported. `onOverride` is separate from `onVerified` so a caller cannot
  // confuse "the customer answered a code" with "a manager went ahead anyway".
  describe("★ an order the OTP cannot reach", () => {
    it("offers the override to an operator the server says may use it", async () => {
      actions.begin.mockResolvedValue({
        unverifiable: true,
        canOverride: true,
        error: "This order has no mobile number that can be texted.",
      });
      const onVerified = vi.fn();
      const onOverride = vi.fn();
      render(
        <CustomerPhoneVerification
          orderId="order-9"
          purpose="pickup"
          onVerified={onVerified}
          onOverride={onOverride}
          onCancel={vi.fn()}
        />,
      );

      const proceed = await screen.findByRole("button", {
        name: /hand over without a code/i,
      });
      expect(screen.queryByLabelText("6-digit code")).toBeNull();
      expect(firebase.signIn).not.toHaveBeenCalled();

      fireEvent.click(proceed);
      expect(onOverride).toHaveBeenCalledTimes(1);
      expect(onVerified).not.toHaveBeenCalled();
    });

    it("★ shows a cashier the reason and NO button", async () => {
      actions.begin.mockResolvedValue({
        unverifiable: true,
        canOverride: false,
        error: "This order has no mobile number that can be texted.",
      });
      render(
        <CustomerPhoneVerification
          orderId="order-9"
          purpose="return"
          onVerified={vi.fn()}
          onOverride={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      expect(
        await screen.findByText(/manager has to complete this one/i),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /without a code/i }),
      ).toBeNull();
    });
  });

  // ★★ Firebase's per-number block is long and undisclosed, and every refused
  // request extends it (lib/auth/phone-send-guard.ts). The till must never be
  // what drives a customer's number into it.
  describe("★ phone send guard", () => {
    it("★ a second tap while a send is in flight does not ask Firebase twice", async () => {
      actions.begin.mockResolvedValueOnce({ error: "Temporary problem." });
      renderVerification();
      const retry = await screen.findByRole("button", {
        name: /try sending again/i,
      });

      let finishSend!: (value: unknown) => void;
      firebase.signIn.mockImplementationOnce(
        () => new Promise((resolve) => (finishSend = resolve)),
      );
      // Both taps land before React re-renders, so the button is still enabled
      // for the second one, exactly as a double tap or key-repeat would be.
      act(() => {
        fireEvent.click(retry);
        fireEvent.click(retry);
      });
      await waitFor(() => expect(firebase.signIn).toHaveBeenCalledTimes(1));

      await act(async () => finishSend({ confirm: firebase.confirmCode }));
      expect(
        await screen.findByText(/code sent to \+91 ••••••3210/i),
      ).toBeVisible();
      expect(actions.begin).toHaveBeenCalledTimes(2);
      expect(firebase.signIn).toHaveBeenCalledTimes(1);
    });

    it("★ stops asking Firebase once it says too many requests, and names a time", async () => {
      firebase.signIn.mockRejectedValueOnce(
        firebaseError("auth/too-many-requests"),
      );
      const first = renderVerification();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        /try again after/i,
      );
      // Held until the lockout ends: a tap reaches neither the server's
      // per-order budget nor Firebase.
      const held = screen.getByRole("button", { name: /try again in 30 min/i });
      expect(held).toBeDisabled();
      fireEvent.click(held);
      expect(actions.begin).toHaveBeenCalledTimes(1);

      // Nor does closing and reopening the dialog reach Firebase.
      first.unmount();
      renderVerification();
      await waitFor(() => expect(actions.begin).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        /try again after/i,
      );
      expect(
        screen.getByRole("button", { name: /try again in 30 min/i }),
      ).toBeDisabled();
      expect(firebase.signIn).toHaveBeenCalledTimes(1);
    });

    it("★ a blocked number does not stop the till serving the next customer", async () => {
      firebase.signIn.mockRejectedValueOnce(
        firebaseError("auth/too-many-requests"),
      );
      const first = renderVerification();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        /try again after/i,
      );
      first.unmount();

      actions.begin.mockResolvedValue({
        phone: "+919811112222",
        maskedPhone: "••••••2222",
      });
      renderVerification({ orderId: "order-2" });
      expect(
        await screen.findByText(/code sent to \+91 ••••••2222/i),
      ).toBeVisible();
      expect(firebase.signIn).toHaveBeenLastCalledWith(
        expect.anything(),
        "+919811112222",
        expect.anything(),
      );
    });

    it("★ reopening the dialog inside the cooldown resumes the code already sent", async () => {
      const first = renderVerification();
      expect(
        await screen.findByText(/code sent to \+91 ••••••3210/i),
      ).toBeVisible();
      first.unmount();

      const verified = vi.fn();
      renderVerification({ onVerified: verified });
      expect(
        await screen.findByText(/code sent to \+91 ••••••3210/i),
      ).toBeVisible();
      expect(actions.begin).toHaveBeenCalledTimes(2);
      expect(firebase.signIn).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByRole("button", { name: /resend in \d+s/i }),
      ).toBeDisabled();

      // The code on the customer's phone confirms in the reopened dialog.
      fireEvent.change(screen.getByLabelText("6-digit code"), {
        target: { value: "123456" },
      });
      await waitFor(() => expect(verified).toHaveBeenCalledTimes(1));
      expect(firebase.confirmCode).toHaveBeenCalledWith("123456");
    });

    it("★ closing and reopening during a slow send texts the customer once", async () => {
      let finishSend!: (value: unknown) => void;
      firebase.signIn.mockImplementationOnce(
        () => new Promise((resolve) => (finishSend = resolve)),
      );
      const first = renderVerification();
      await waitFor(() => expect(firebase.signIn).toHaveBeenCalledTimes(1));
      first.unmount();

      // The reopened dialog waits for the send still in the air, given every
      // chance to run first: it neither asks the server nor texts again.
      renderVerification();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(screen.getByText(/sending code/i)).toBeVisible();
      expect(actions.begin).toHaveBeenCalledTimes(1);
      expect(firebase.signIn).toHaveBeenCalledTimes(1);

      await act(async () => finishSend({ confirm: firebase.confirmCode }));
      expect(
        await screen.findByText(/code sent to \+91 ••••••3210/i),
      ).toBeVisible();
      expect(actions.begin).toHaveBeenCalledTimes(2);
      expect(firebase.signIn).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("★ a resend inside the cooldown keeps the live code instead of texting again", async () => {
      vi.useFakeTimers();
      try {
        const start = Date.parse("2026-10-10T10:00:00Z");
        vi.setSystemTime(start);
        const verified = vi.fn();
        renderVerification({ onVerified: verified });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText(/code sent to \+91 ••••••3210/i)).toBeVisible();

        // The resend countdown runs out on a till whose clock still says the
        // code went out five seconds ago.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        vi.setSystemTime(start + 5_000);
        fireEvent.click(screen.getByRole("button", { name: /resend code/i }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        expect(actions.begin).toHaveBeenCalledTimes(2);
        expect(firebase.signIn).toHaveBeenCalledTimes(1);
        expect(firebase.signOut).not.toHaveBeenCalled();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(
          screen.getByRole("button", { name: /resend in 20s/i }),
        ).toBeDisabled();

        // The code already on the customer's phone still confirms.
        fireEvent.change(screen.getByLabelText("6-digit code"), {
          target: { value: "123456" },
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(firebase.confirmCode).toHaveBeenCalledWith("123456");
        expect(verified).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("★ a cooldown on a different number never resumes this order's code", async () => {
      vi.useFakeTimers();
      try {
        const start = Date.parse("2026-10-10T10:00:00Z");
        vi.setSystemTime(start);
        // The number the order is about to be corrected to was texted at the
        // same moment as this order's code went out.
        recordPhoneSend("+919811112222");
        renderVerification();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText(/code sent to \+91 ••••••3210/i)).toBeVisible();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        vi.setSystemTime(start + 5_000);
        actions.begin.mockResolvedValue({
          phone: "+919811112222",
          maskedPhone: "••••••2222",
        });
        fireEvent.click(screen.getByRole("button", { name: /resend code/i }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        // The live code belongs to the OLD number, so it is not resumed as if
        // it had gone to the new one, and nothing is texted.
        expect(actions.begin).toHaveBeenCalledTimes(2);
        expect(firebase.signIn).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("alert")).toHaveTextContent(
          /a code was just sent to this number/i,
        );
        expect(screen.queryByText(/••••••2222/)).toBeNull();
        expect(
          screen.getByRole("button", { name: /resend in 20s/i }),
        ).toBeDisabled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a refused send holds the button until the guard allows it, without asking the server", async () => {
      vi.useFakeTimers();
      try {
        const start = Date.parse("2026-10-10T10:00:00Z");
        vi.setSystemTime(start);
        // Another check at this counter texted the number moments ago.
        recordPhoneSend("+919876543210");
        renderVerification({ purpose: "return" });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByRole("alert")).toHaveTextContent(
          /a code was just sent to this number/i,
        );
        const held = screen.getByRole("button", { name: /try again in 25s/i });
        expect(held).toBeDisabled();
        fireEvent.click(held);
        expect(actions.begin).toHaveBeenCalledTimes(1);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(25_000);
        });
        fireEvent.click(
          screen.getByRole("button", { name: /try sending again/i }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText(/code sent to \+91 ••••••3210/i)).toBeVisible();
        expect(actions.begin).toHaveBeenCalledTimes(2);
        expect(firebase.signIn).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a failed send that is not a rate limit leaves the number free to retry at once", async () => {
      firebase.signIn.mockRejectedValueOnce(
        firebaseError("auth/invalid-app-credential"),
      );
      renderVerification();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Phone verification failed.",
      );

      fireEvent.click(
        screen.getByRole("button", { name: /try sending again/i }),
      );
      expect(
        await screen.findByText(/code sent to \+91 ••••••3210/i),
      ).toBeVisible();
      expect(firebase.signIn).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
