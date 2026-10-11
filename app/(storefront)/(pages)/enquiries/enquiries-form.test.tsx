// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

// Auth context: mock useAuth itself so AuthProvider's Supabase internals never
// run. The source imports via "../../components/auth/AuthProvider"; the "@/..."
// specifier resolves to the same file (alias "@" -> project root).
vi.mock("@/app/(storefront)/components/auth/AuthProvider", () => ({
  useAuth: vi.fn(),
}));

// Server action that performs the actual enquiry write.
vi.mock("@/app/actions/enquiry-actions", () => ({
  submitEnquiry: vi.fn(),
}));

// Isolated secondary-app phone verify. Shared spies via vi.hoisted so the
// factory and tests reference the same fns.
const { signInWithPhoneNumber, confirm, secondarySignOut } = vi.hoisted(() => ({
  signInWithPhoneNumber: vi.fn(),
  confirm: vi.fn(),
  secondarySignOut: vi.fn(),
}));
vi.mock("firebase/auth", () => ({
  RecaptchaVerifier: class {
    clear() {}
  },
  signInWithPhoneNumber,
}));
vi.mock("@/lib/auth/firebase-client", () => ({
  getSecondaryFirebaseAuth: vi.fn(() => ({ signOut: secondarySignOut })),
  firebaseAuthErrorMessage: vi.fn(() => "Something went wrong."),
  firebaseAuthErrorCode: vi.fn((err: any) => err?.code ?? "unknown"),
}));

import EnquiriesForm from "./enquiries-form";
import { useAuth } from "@/app/(storefront)/components/auth/AuthProvider";
import { submitEnquiry } from "@/app/actions/enquiry-actions";
import { resetPhoneSendGuard } from "@/lib/auth/phone-send-guard";
import { MAX_VERIFY_ATTEMPTS } from "@/lib/use-otp-throttle";

const mockedUseAuth = vi.mocked(useAuth);
const mockedSubmit = vi.mocked(submitEnquiry);

function setAuth(value: any) {
  mockedUseAuth.mockReturnValue(value);
}

const LOGGED_OUT = { user: null, customer: null } as any;
const SIGNED_IN = {
  user: { phone: "919999999999" },
  customer: { first_name: "Ada", last_name: "L", email: "ada@x.com" },
} as any;

describe("EnquiriesForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The send ledger is module-scoped, so it would leak between tests.
    resetPhoneSendGuard();
    setAuth(LOGGED_OUT);
    confirm.mockResolvedValue({});
    signInWithPhoneNumber.mockResolvedValue({ confirm });
    secondarySignOut.mockResolvedValue(undefined);
    mockedSubmit.mockResolvedValue({ success: true } as any);
  });

  // ------------------------------------------------------------- validation
  describe("validation gates", () => {
    // These gate tests sign in (phone pre-verified) so handleSubmit is
    // reachable, and submit via the form's submit event (the canonical way to
    // exercise onSubmit in jsdom — a bare submit-button click does not reliably
    // dispatch the form's submit until a field has been interacted with).
    const submitForm = () => fireEvent.submit(document.querySelector("form")!);

    it("empty name", async () => {
      setAuth({ user: { phone: "919999999999" }, customer: null });
      render(<EnquiriesForm />);
      submitForm();
      expect(await screen.findByText("Please enter your name.")).toBeTruthy();
      expect(mockedSubmit).not.toHaveBeenCalled();
    });

    it("invalid email", async () => {
      const user = userEvent.setup();
      setAuth({ user: { phone: "919999999999" }, customer: null });
      render(<EnquiriesForm />);
      await user.type(screen.getByLabelText(/name/i), "Bob");
      await user.type(screen.getByLabelText(/email/i), "not-an-email");
      submitForm();
      expect(
        await screen.findByText("Please enter a valid email address."),
      ).toBeTruthy();
      expect(mockedSubmit).not.toHaveBeenCalled();
    });

    it("no subject selected", async () => {
      const user = userEvent.setup();
      setAuth({ user: { phone: "919999999999" }, customer: null });
      render(<EnquiriesForm />);
      await user.type(screen.getByLabelText(/name/i), "Bob");
      await user.type(screen.getByLabelText(/email/i), "bob@x.com");
      submitForm();
      expect(await screen.findByText("Please select a subject.")).toBeTruthy();
      expect(mockedSubmit).not.toHaveBeenCalled();
    });

    it('subject "Other" with empty custom subject', async () => {
      const user = userEvent.setup();
      setAuth({ user: { phone: "919999999999" }, customer: null });
      render(<EnquiriesForm />);
      await user.type(screen.getByLabelText(/name/i), "Bob");
      await user.type(screen.getByLabelText(/email/i), "bob@x.com");
      await user.selectOptions(screen.getByLabelText(/subject/i), "Other");
      submitForm();
      expect(
        await screen.findByText("Please enter your subject."),
      ).toBeTruthy();
      expect(mockedSubmit).not.toHaveBeenCalled();
    });

    it("empty message", async () => {
      const user = userEvent.setup();
      setAuth({ user: { phone: "919999999999" }, customer: null });
      render(<EnquiriesForm />);
      await user.type(screen.getByLabelText(/name/i), "Bob");
      await user.type(screen.getByLabelText(/email/i), "bob@x.com");
      await user.selectOptions(
        screen.getByLabelText(/subject/i),
        "General enquiry",
      );
      submitForm();
      expect(await screen.findByText("Please enter a message.")).toBeTruthy();
      expect(mockedSubmit).not.toHaveBeenCalled();
    });

    it("logged-out user cannot submit until phone verified (button disabled)", () => {
      setAuth(LOGGED_OUT);
      render(<EnquiriesForm />);
      const btn = screen.getByRole("button", {
        name: /send enquiry/i,
      }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(
        screen.getByText("Verify your phone number above to send."),
      ).toBeTruthy();
    });
  });

  // ------------------------------------------------------- signed-in shortcut
  it("prefills + verifies a signed-in user and submits a trimmed payload", async () => {
    const user = userEvent.setup();
    setAuth(SIGNED_IN);
    render(<EnquiriesForm />);

    // Phone shows as verified, name/email prefilled.
    expect(screen.getByText(/· verified/)).toBeTruthy();
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe(
      "Ada L",
    );
    expect((screen.getByLabelText(/email/i) as HTMLInputElement).value).toBe(
      "ada@x.com",
    );

    const btn = screen.getByRole("button", {
      name: /send enquiry/i,
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    await user.selectOptions(
      screen.getByLabelText(/subject/i),
      "General enquiry",
    );
    await user.type(screen.getByLabelText(/message/i), "  Hello there  ");
    await user.click(btn);

    expect(await screen.findByText("Enquiry sent!")).toBeTruthy();
    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    expect(mockedSubmit).toHaveBeenCalledWith({
      name: "Ada L",
      email: "ada@x.com",
      phone: "+919999999999",
      subject: "General enquiry",
      subjectDetail: undefined,
      message: "Hello there",
    });
  });

  // -------------------------------------------------------------- OTP flow
  it("runs the OTP flow for a logged-out user and enables submit", async () => {
    const user = userEvent.setup();
    setAuth(LOGGED_OUT);
    render(<EnquiriesForm />);

    // Type a 10+ digit national number (defaultCountry IN).
    const phoneField = screen.getByPlaceholderText(/mobile number/i);
    await user.type(phoneField, "9876543210");

    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    // OTP grid appears once signInWithPhoneNumber resolves.
    expect(await screen.findByText(/Enter the 6-digit code/)).toBeTruthy();
    expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);

    // Fill the 6 digits; the 6th auto-triggers verify. Use synchronous
    // fireEvent.change (re-querying each input by label) rather than
    // user.type — the component auto-advances focus on each keystroke, and on
    // slow CI runners the async per-key typing can land on a re-rendered input
    // and drop a digit, so auto-verify never fires.
    for (let i = 1; i <= 6; i++) {
      fireEvent.change(screen.getByLabelText(`Digit ${i}`), {
        target: { value: String(i) },
      });
    }

    // Verified (async verifyOtp resolves) -> phone shows verified.
    expect(
      await screen.findByText(/· verified/, undefined, { timeout: 3000 }),
    ).toBeTruthy();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("123456");
    // The throwaway secondary session is discarded after verifying.
    expect(secondarySignOut).toHaveBeenCalled();

    // Submit enabled.
    const btn = screen.getByRole("button", {
      name: /send enquiry/i,
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  // ----------------------------------------------------------- submit error
  it("keeps the form visible and shows the action error", async () => {
    const user = userEvent.setup();
    setAuth(SIGNED_IN);
    mockedSubmit.mockResolvedValue({ error: "boom" } as any);
    render(<EnquiriesForm />);

    await user.selectOptions(
      screen.getByLabelText(/subject/i),
      "General enquiry",
    );
    await user.type(screen.getByLabelText(/message/i), "Hello");
    await user.click(screen.getByRole("button", { name: /send enquiry/i }));

    expect(await screen.findByText("boom")).toBeTruthy();
    // Still on the form, not the success screen.
    expect(screen.queryByText("Enquiry sent!")).toBeNull();
  });

  // --------------------------------------------------------- success reset
  it('"Send another enquiry" resets back to the form', async () => {
    const user = userEvent.setup();
    setAuth(SIGNED_IN);
    render(<EnquiriesForm />);

    await user.selectOptions(
      screen.getByLabelText(/subject/i),
      "General enquiry",
    );
    await user.type(screen.getByLabelText(/message/i), "Hello");
    await user.click(screen.getByRole("button", { name: /send enquiry/i }));

    expect(await screen.findByText("Enquiry sent!")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: /send another enquiry/i }),
    );

    // Back on the form.
    expect(await screen.findByText("Get in touch")).toBeTruthy();
    expect(screen.getByLabelText(/message/i)).toBeTruthy();
  });
  // ------------------------------------------------------- phone send guard
  describe("phone send guard", () => {
    const CODE_STEP = /Enter the 6-digit code/;
    const verifyButton = () =>
      screen.getByRole("button", { name: /^verify$/i }) as HTMLButtonElement;
    const changeButton = () =>
      screen.getByRole("button", { name: /^change$/i });
    const phoneField = () => screen.getByPlaceholderText(/mobile number/i);

    async function enterPhone(
      user: ReturnType<typeof userEvent.setup>,
      digits = "9876543210",
    ) {
      await user.clear(phoneField());
      await user.type(phoneField(), digits);
    }

    beforeEach(() => {
      setAuth(LOGGED_OUT);
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("a second tap while the first send is in flight does not call Firebase twice", async () => {
      const user = userEvent.setup();
      let resolveSend!: (value: unknown) => void;
      signInWithPhoneNumber.mockImplementation(
        () => new Promise((resolve) => (resolveSend = resolve)),
      );
      render(<EnquiriesForm />);
      await enterPhone(user);

      // Both taps land before React re-renders the button as disabled, so only
      // the synchronous in-flight ref can stop the second one.
      const btn = verifyButton();
      act(() => {
        btn.click();
        btn.click();
      });
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);

      await act(async () => resolveSend({ confirm }));
      expect(await screen.findByText(CODE_STEP)).toBeTruthy();
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);
    });

    it("after too-many-requests, a further tap stays off Firebase and names a time", async () => {
      const user = userEvent.setup();
      signInWithPhoneNumber.mockRejectedValueOnce({
        code: "auth/too-many-requests",
      });
      render(<EnquiriesForm />);
      await enterPhone(user);

      await user.click(verifyButton());
      expect(await screen.findByText(/try again after/i)).toBeTruthy();
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);

      await user.click(verifyButton());
      expect(screen.getByText(/try again after/i)).toBeTruthy();
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);
    });

    it("Change, then the same number inside the cooldown, resumes the live code", async () => {
      const user = userEvent.setup();
      render(<EnquiriesForm />);
      await enterPhone(user);
      await user.click(verifyButton());
      expect(await screen.findByText(CODE_STEP)).toBeTruthy();

      await user.click(changeButton());
      expect(screen.queryByText(CODE_STEP)).toBeNull();

      await user.click(verifyButton());
      expect(await screen.findByText(CODE_STEP)).toBeTruthy();
      expect(screen.queryByText(/a code was just sent/i)).toBeNull();
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);

      // The resumed code is the one on their phone, and it still verifies.
      for (let i = 1; i <= 6; i++) {
        fireEvent.change(screen.getByLabelText(`Digit ${i}`), {
          target: { value: String(i) },
        });
      }
      expect(
        await screen.findByText(/· verified/, undefined, { timeout: 3000 }),
      ).toBeTruthy();
      expect(confirm).toHaveBeenCalledWith("123456");
    });

    it("a remounted form does not re-send to the same number inside the cooldown", async () => {
      const user = userEvent.setup();
      const { unmount } = render(<EnquiriesForm />);
      await enterPhone(user);
      await user.click(verifyButton());
      await screen.findByText(CODE_STEP);
      unmount();

      render(<EnquiriesForm />);
      await enterPhone(user);
      await user.click(verifyButton());
      expect(
        await screen.findByText(/a code was just sent to this number/i),
      ).toBeTruthy();
      expect(screen.queryByText(CODE_STEP)).toBeNull();
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);
    });

    it("a send to a different number replaces the live code", async () => {
      const user = userEvent.setup();
      render(<EnquiriesForm />);
      await enterPhone(user, "9876543210");
      await user.click(verifyButton());
      await screen.findByText(CODE_STEP);

      await user.click(changeButton());
      await enterPhone(user, "9123456789");
      await user.click(verifyButton());
      await screen.findByText(CODE_STEP);
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(2);
      expect(signInWithPhoneNumber.mock.calls[0][1]).toBe("+919876543210");
      expect(signInWithPhoneNumber.mock.calls[1][1]).toBe("+919123456789");

      // Back to the first number: still in its cooldown, but its code is gone.
      await user.click(changeButton());
      await enterPhone(user, "9876543210");
      await user.click(verifyButton());
      expect(
        await screen.findByText(/a code was just sent to this number/i),
      ).toBeTruthy();
      expect(screen.queryByText(CODE_STEP)).toBeNull();
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(2);
    });

    it("Change cannot reset the wrong-code cap by resuming the same code", async () => {
      const user = userEvent.setup();
      confirm.mockRejectedValue({ code: "auth/invalid-verification-code" });
      render(<EnquiriesForm />);
      await enterPhone(user);
      await user.click(verifyButton());
      await screen.findByText(CODE_STEP);

      for (let i = 1; i <= 5; i++) {
        fireEvent.change(screen.getByLabelText(`Digit ${i}`), {
          target: { value: "1" },
        });
      }
      for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
        fireEvent.change(screen.getByLabelText("Digit 6"), {
          target: { value: String(attempt) },
        });
        await waitFor(() => expect(confirm).toHaveBeenCalledTimes(attempt));
        await waitFor(() =>
          expect(screen.queryByText("Verifying…")).toBeNull(),
        );
      }

      await user.click(changeButton());
      await user.click(verifyButton());
      expect(
        await screen.findByText(/a code was just sent to this number/i),
      ).toBeTruthy();
      expect(screen.queryByText(CODE_STEP)).toBeNull();
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(1);
    });

    it("a non-rate-limit failure does not lock the number", async () => {
      const user = userEvent.setup();
      signInWithPhoneNumber.mockRejectedValueOnce({
        code: "auth/invalid-app-credential",
      });
      render(<EnquiriesForm />);
      await enterPhone(user);

      await user.click(verifyButton());
      expect(await screen.findByText("Something went wrong.")).toBeTruthy();

      await user.click(verifyButton());
      expect(await screen.findByText(CODE_STEP)).toBeTruthy();
      expect(signInWithPhoneNumber).toHaveBeenCalledTimes(2);
    });
  });
});
