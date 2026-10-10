import { describe, expect, it, vi } from "vitest";

vi.mock("./firebase-admin", () => ({ getFirebaseAdminAuth: vi.fn() }));

import { getFirebaseAdminAuth } from "./firebase-admin";
import { emailVerifiedNow } from "./email-verified";

const unverified = { id: "uid-1", emailConfirmed: false };

function adminWith(getUser: () => Promise<unknown>) {
  vi.mocked(getFirebaseAdminAuth).mockReturnValue({ getUser } as never);
}

describe("emailVerifiedNow", () => {
  it("trusts a verified session without reading the account", async () => {
    expect(await emailVerifiedNow({ id: "uid-1", emailConfirmed: true })).toBe(
      true,
    );
    expect(getFirebaseAdminAuth).not.toHaveBeenCalled();
  });

  it("★ reads the account when the session's snapshot still says unverified", async () => {
    const getUser = vi.fn(async () => ({ emailVerified: true }));
    adminWith(getUser);
    expect(await emailVerifiedNow(unverified)).toBe(true);
    expect(getUser).toHaveBeenCalledWith("uid-1");
  });

  it("an account that is not verified stays unverified", async () => {
    adminWith(async () => ({ emailVerified: false }));
    expect(await emailVerifiedNow(unverified)).toBe(false);
  });

  it("★ an unreadable account never verifies anyone", async () => {
    adminWith(async () => {
      throw new Error("network");
    });
    expect(await emailVerifiedNow(unverified)).toBe(false);
    vi.mocked(getFirebaseAdminAuth).mockReturnValue(null);
    expect(await emailVerifiedNow(unverified)).toBe(false);
  });
});
