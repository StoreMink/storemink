/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// establishSession on a page that resumed from the server session: the Auth
// instance is created at the moment it is first needed, and Firebase reads
// the saved sign-in back asynchronously. `currentUser` is null until then.

const state = vi.hoisted(() => ({ auth: null as any }));
vi.mock("firebase/app", () => ({
  initializeApp: vi.fn(() => ({ name: "[DEFAULT]" })),
  getApps: vi.fn(() => []),
  getApp: vi.fn(),
}));
vi.mock("firebase/auth", () => ({
  getAuth: vi.fn(() => state.auth),
  initializeAuth: vi.fn(),
  inMemoryPersistence: {},
}));

import { establishSession, getCurrentFirebaseUser } from "./firebase-client";

function restoringAuth(user: unknown) {
  // Signed in, but not restored yet: exactly a freshly created Auth instance.
  const auth: any = { currentUser: null };
  auth.authStateReady = vi.fn(async () => {
    auth.currentUser = user;
  });
  return auth;
}

const fetchMock = vi.fn(async () => ({ ok: true }));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("establishSession on a resumed page", () => {
  it("★ waits for the saved sign-in instead of reporting the merchant signed out", async () => {
    const user = { getIdToken: vi.fn(async () => "fresh-token") };
    state.auth = restoringAuth(user);

    expect(await establishSession(true)).toBeNull();
    expect(state.auth.authStateReady).toHaveBeenCalled();
    expect(user.getIdToken).toHaveBeenCalledWith(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idToken: "fresh-token" }),
      }),
    );
  });

  it("reports signed out only when there is genuinely no saved sign-in", async () => {
    state.auth = restoringAuth(null);
    expect(await establishSession(true)).toBe(
      "You're not signed in. Please try again.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers from what has loaded when the browser refuses to restore", async () => {
    const user = { getIdToken: vi.fn() };
    state.auth = {
      currentUser: user,
      authStateReady: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    };
    expect(await getCurrentFirebaseUser()).toBe(user);
  });
});
