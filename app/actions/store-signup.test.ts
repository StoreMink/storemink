/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock("next/cache", () => ({ updateTag: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/db/errors", () => ({ isUniqueViolation: vi.fn() }));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({ STORE_TAG: "stores" }));
// The real host helpers, so storeAuthHosts runs for real against the root.
// ★ NOT the module default ("storemink.com"): with the default, a hard-coded
// root in createStore passes every test, and on dev/staging it would list
// {slug}.storemink.com instead of the host the store is actually served on.
vi.mock("@/lib/store/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store/host")>()),
  ROOT_DOMAIN: "staging.storemink.com",
}));
// after() is captured, not run: the test decides when "after the response" is.
const afterQueue = vi.hoisted(() => ({ tasks: [] as Array<() => unknown> }));
vi.mock("next/server", () => ({
  after: vi.fn((task: () => unknown) => {
    afterQueue.tasks.push(task);
  }),
}));
vi.mock("@/lib/auth/authorized-domains", () => ({
  ensureAuthorizedHosts: vi.fn(async () => ({ added: [] })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(() => {}),
  logInfo: vi.fn(() => {}),
  logWarn: vi.fn(() => {}),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/legal/store", () => ({
  recordSignupConsent: vi.fn(async () => {}),
}));
const firebaseAuth = vi.hoisted(() => ({
  getUserByEmail: null as any,
  // The account record behind a session; null means unreadable.
  getUser: null as any,
}));
vi.mock("@/lib/auth/firebase-admin", () => ({
  getFirebaseAdminAuth: vi.fn(() => firebaseAuth),
}));
vi.mock("@/lib/auth/firebase-users", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/firebase-users")>()),
  deleteAuthUser: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/identity-usage", () => ({
  authIdsInUse: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
  clientIp: vi.fn(() => "203.0.113.7"),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));

import { updateTag } from "next/cache";
import { after } from "next/server";
import { ensureAuthorizedHosts } from "@/lib/auth/authorized-domains";
import { logWarn } from "@/lib/observability/logger";
import { isUniqueViolation } from "@/lib/db/errors";
import { getServerUser } from "@/lib/auth/server-user";
import { emitEvent } from "@/lib/notifications/record";
import { recordSignupConsent } from "@/lib/legal/store";
import { admins, storeBillingSettings, stores } from "@/drizzle/schema";
import { getFirebaseAdminAuth } from "@/lib/auth/firebase-admin";
import { deleteAuthUser } from "@/lib/auth/firebase-users";
import { authIdsInUse } from "@/lib/auth/identity-usage";
import { rateLimit } from "@/lib/rate-limit";
import {
  checkStoreSlugAvailability,
  createStore,
  getSignupResumeInfo,
  reclaimUnusedSignupEmail,
} from "./store-signup";

const USER = {
  id: "user-1",
  email: "owner@example.com",
  emailConfirmed: true,
  phoneConfirmed: true,
  phone: "+919876543210",
  metadata: {},
} as any;

const INPUT = {
  name: "Acme Foods",
  firstName: " Asha ",
  lastName: " Shah ",
  country: " in ",
  addressLine1: " 12 Radial Road ",
  addressLine2: " Floor 2 ",
  city: " New Delhi ",
  state: " Delhi ",
  postalCode: " 110001 ",
  lat: 28.6139,
  lng: 77.209,
};

/** Run what createStore deferred, as Next does once the response is sent. */
async function runAfterTasks() {
  for (const task of afterQueue.tasks.splice(0)) await task();
}

beforeEach(() => {
  vi.clearAllMocks();
  afterQueue.tasks = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  dbHolder.current = makeDbMock({
    selectQueue: [[], []],
    returning: [{ id: "store-1", slug: "acme-foods" }],
  });
  vi.mocked(getServerUser).mockResolvedValue(USER);
  vi.mocked(isUniqueViolation).mockReturnValue(false);
  vi.mocked(recordSignupConsent).mockResolvedValue(undefined);
});

describe("checkStoreSlugAvailability", () => {
  it.each([
    ["", "", "Enter a store name."],
    ["AB", "ab", "At least 3 characters."],
    ["x".repeat(41), "x".repeat(41), "Too long (40 characters max)."],
    ["Dashboard", "dashboard", "This name is reserved."],
    ["POS", "pos", "This name is reserved."],
    ["Demo", "demo", "This name is reserved."],
    ["demo-fashion", "demo-fashion", "This name is reserved."],
  ])("rejects invalid or reserved input %s", async (raw, slug, reason) => {
    expect(await checkStoreSlugAvailability(raw)).toEqual({
      slug,
      available: false,
      reason,
    });
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("normalizes a store name and checks every existing store, including inactive ones", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await checkStoreSlugAvailability("  Asha's Fresh Foods  ")).toEqual({
      slug: "ashas-fresh-foods",
      available: true,
    });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
      "ashas-fresh-foods",
    );
  });

  it("does not reveal whether an existing store is pending or suspended", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "store-existing" }]],
    });
    expect(await checkStoreSlugAvailability("Acme")).toEqual({
      slug: "acme",
      available: false,
      reason: "This name is not available.",
    });
  });

  it("fails closed when availability cannot be established", async () => {
    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("database offline");
    });
    expect(await checkStoreSlugAvailability("Acme")).toEqual({
      slug: "acme",
      available: false,
      reason: "Couldn't check right now.",
    });
  });
});

describe("getSignupResumeInfo", () => {
  it("returns a minimal anonymous state", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    expect(await getSignupResumeInfo()).toEqual({
      authenticated: false,
      hasStore: false,
      emailConfirmed: false,
    });
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("★ resumes at the store step when the account was verified after the session was minted", async () => {
    vi.mocked(getServerUser).mockResolvedValue({
      ...USER,
      emailConfirmed: false,
    });
    firebaseAuth.getUser = vi.fn(async () => ({ emailVerified: true }));
    try {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });
      expect(await getSignupResumeInfo()).toMatchObject({
        authenticated: true,
        emailConfirmed: true,
      });
      expect(firebaseAuth.getUser).toHaveBeenCalledWith(USER.id);
    } finally {
      firebaseAuth.getUser = null;
    }
  });

  it("resumes a verified account without a store", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getSignupResumeInfo()).toMatchObject({
      authenticated: true,
      hasStore: false,
      emailConfirmed: true,
      email: "owner@example.com",
    });
  });

  it("returns the owned slug and splits an OAuth full name", async () => {
    vi.mocked(getServerUser).mockResolvedValue({
      ...USER,
      metadata: { full_name: "Asha Devi Shah" },
    });
    dbHolder.current = makeDbMock({
      selectQueue: [[{ store_id: "store-1" }], [{ slug: "acme" }]],
    });
    expect(await getSignupResumeInfo()).toMatchObject({
      hasStore: true,
      slug: "acme",
      firstName: "Asha",
      lastName: "Devi Shah",
    });
  });

  it("says whether an existing store's owner has a verified mobile", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ store_id: "store-1", phone_verified_at: "2026-10-10T08:00:00Z" }],
        [{ slug: "acme" }],
      ],
    });
    expect(await getSignupResumeInfo()).toMatchObject({
      hasStore: true,
      phoneVerified: true,
    });
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ store_id: "store-1", phone_verified_at: null }],
        [{ slug: "acme" }],
      ],
    });
    expect((await getSignupResumeInfo()).phoneVerified).toBe(false);
    // No store, no claim either way.
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getSignupResumeInfo()).not.toHaveProperty("phoneVerified");
  });

  it("prefers provider given and family names", async () => {
    vi.mocked(getServerUser).mockResolvedValue({
      ...USER,
      metadata: {
        full_name: "Ignored Name",
        given_name: "Priya",
        family_name: "Singh",
      },
    });
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getSignupResumeInfo()).toMatchObject({
      firstName: "Priya",
      lastName: "Singh",
    });
  });

  it("keeps the authenticated resume usable during a database outage", async () => {
    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("offline");
    });
    expect(await getSignupResumeInfo()).toMatchObject({
      authenticated: true,
      hasStore: false,
      emailConfirmed: true,
    });
  });
});

describe("createStore gates", () => {
  it("requires an authenticated, email-confirmed owner", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    expect((await createStore(INPUT)).error).toMatch(/sign in/i);

    vi.mocked(getServerUser).mockResolvedValue({
      ...USER,
      emailConfirmed: false,
    });
    expect((await createStore(INPUT)).error).toMatch(/verify your email/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ trusts the account record when the session still says unverified", async () => {
    vi.mocked(getServerUser).mockResolvedValue({
      ...USER,
      emailConfirmed: false,
    });
    firebaseAuth.getUser = vi.fn(async () => ({ emailVerified: true }));
    try {
      const result = await createStore(INPUT);
      expect(result.error).toBeUndefined();
      expect(result.storeId).toBeTruthy();
    } finally {
      firebaseAuth.getUser = null;
    }
  });

  it("★ creates the store without a phone; the go-live checklist asks for it", async () => {
    vi.mocked(getServerUser).mockResolvedValue({
      ...USER,
      phone: null,
      phoneConfirmed: false,
    });
    const result = await createStore(INPUT);
    expect(result.error).toBeUndefined();
    expect(dbHolder.current.calls.insert[1]).toBe(admins);
    expect(dbHolder.current.calls.values[1]).toMatchObject({
      phone: null,
      phoneVerifiedAt: null,
    });
  });

  it("re-checks slug ownership and one-store-per-owner on the server", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "taken" }]],
    });
    expect((await createStore(INPUT)).error).toMatch(/not available/i);

    dbHolder.current = makeDbMock({
      selectQueue: [[], [{ store_id: "existing-store" }]],
    });
    expect((await createStore(INPUT)).error).toMatch(/already has a store/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ accepts a store with no address yet, storing only the country", async () => {
    // The address moved to the dashboard's go-live checklist, which refuses to
    // open the store without it. Signup must not ask for what a store without
    // an order cannot yet need.
    const result = await createStore({
      name: "Acme Foods",
      firstName: "Asha",
      country: "in",
    });
    expect(result).toEqual({
      slug: "acme-foods",
      storeId: "store-1",
      phoneVerified: true,
    });
    expect(dbHolder.current.calls.values[0].settings.business).toEqual({
      country: "IN",
    });
    // The invoice profile is seeded with what IS known, and an honest null
    // for the address — which is what the checklist reads.
    expect(dbHolder.current.calls.values[2]).toMatchObject({
      businessName: "Acme Foods",
      businessAddress: null,
      contactEmail: "owner@example.com",
      contactPhone: "+919876543210",
    });
  });

  it("★★ installs no theme: the store waits on themePending for its owner's choice", async () => {
    const result = await createStore({ name: "Acme Foods", firstName: "Asha" });
    expect(result.error).toBeUndefined();
    const settings = dbHolder.current.calls.values[0].settings;
    // Only an explicit true counts (isThemePending), so it is written as one.
    expect(settings.themePending).toBe(true);
    expect(settings).not.toHaveProperty("template");
    expect(settings).not.toHaveProperty("theme");
    // ★ Nothing seeded: the store, its owner and its invoice profile, and no
    // page, menu, category or product row of any theme's.
    expect(dbHolder.current.calls.insert).toEqual([
      stores,
      admins,
      storeBillingSettings,
    ]);
    expect(dbHolder.current.calls.update).toEqual([]);
  });

  it("★ keeps the store name the seller typed where the storefront and dashboard read it", async () => {
    await createStore({ ...INPUT, name: "  Acme Foods  " });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      name: "Acme Foods",
      settings: { brand: { name: "Acme Foods" } },
    });
  });

  it("ignores a theme id posted around the wizard", async () => {
    // A server action is a public endpoint; the old optional `template` input
    // must neither install a theme nor be stored.
    await createStore({ ...INPUT, template: "vitrine" } as any);
    const settings = dbHolder.current.calls.values[0].settings;
    expect(settings.themePending).toBe(true);
    expect(settings).not.toHaveProperty("template");
  });

  it("reports whether the owner's mobile is verified, for a paid plan at signup", async () => {
    expect((await createStore(INPUT)).phoneVerified).toBe(true);
    vi.mocked(getServerUser).mockResolvedValue({ ...USER, phone: null });
    dbHolder.current = makeDbMock({
      selectQueue: [[], []],
      returning: [{ id: "store-1", slug: "acme-foods" }],
    });
    expect((await createStore(INPUT)).phoneVerified).toBe(false);
  });

  it("falls back to the platform's home country for a missing or unknown code", async () => {
    await createStore({ ...INPUT, country: "" });
    expect(dbHolder.current.calls.values[0].settings.business.country).toBe(
      "IN",
    );
    dbHolder.current = makeDbMock({
      selectQueue: [[], []],
      returning: [{ id: "store-1", slug: "acme-foods" }],
    });
    await createStore({ ...INPUT, country: "zz" });
    expect(dbHolder.current.calls.values[0].settings.business.country).toBe(
      "IN",
    );
  });
});

describe("createStore provisioning", () => {
  it("writes a non-indexable free store with normalized business location", async () => {
    const result = await createStore(INPUT);

    expect(result).toEqual({
      slug: "acme-foods",
      storeId: "store-1",
      phoneVerified: true,
    });
    expect(dbHolder.current.calls.insert[0]).toBe(stores);
    expect(dbHolder.current.calls.values[0]).toEqual({
      slug: "acme-foods",
      name: "Acme Foods",
      status: "active",
      plan: "free",
      settings: {
        brand: { name: "Acme Foods" },
        launched: false,
        themePending: true,
        business: {
          country: "IN",
          addressLine1: "12 Radial Road",
          addressLine2: "Floor 2",
          city: "New Delhi",
          state: "Delhi",
          postalCode: "110001",
          address: "12 Radial Road\nFloor 2\nNew Delhi, Delhi 110001\nIndia",
          lat: 28.6139,
          lng: 77.209,
        },
      },
    });
  });

  it("drops invalid coordinates without blocking signup", async () => {
    await createStore({ ...INPUT, lat: 91, lng: 181 });
    expect(dbHolder.current.calls.values[0].settings.business).toEqual({
      country: "IN",
      addressLine1: "12 Radial Road",
      addressLine2: "Floor 2",
      city: "New Delhi",
      state: "Delhi",
      postalCode: "110001",
      address: "12 Radial Road\nFloor 2\nNew Delhi, Delhi 110001\nIndia",
    });
  });

  it("seeds the invoice profile from the same validated business address", async () => {
    await createStore(INPUT);
    expect(dbHolder.current.calls.insert[2]).toBe(storeBillingSettings);
    expect(dbHolder.current.calls.values[2]).toEqual({
      storeId: "store-1",
      businessName: "Acme Foods",
      businessAddress:
        "12 Radial Road\nFloor 2\nNew Delhi, Delhi 110001\nIndia",
      contactEmail: "owner@example.com",
      contactPhone: "+919876543210",
      updatedBy: "user-1",
    });
  });

  it("creates the owner with no forced password reset and bounded names", async () => {
    await createStore({
      ...INPUT,
      firstName: "A".repeat(100),
      lastName: "B".repeat(100),
    });
    expect(dbHolder.current.calls.insert[1]).toBe(admins);
    expect(dbHolder.current.calls.values[1]).toMatchObject({
      id: "user-1",
      email: "owner@example.com",
      role: "superadmin",
      storeId: "store-1",
      firstName: "A".repeat(80),
      lastName: "B".repeat(80),
      forcePasswordReset: false,
    });
  });

  it("★★ records a login's verified phone on the owner row, not only the invoice profile", async () => {
    // `admins.phone` is where `resolveBillingEmail` — and therefore
    // `startEnrolment` — looks for a billing contact. Writing it to
    // store_billing_settings alone left every wizard-created store unable to
    // subscribe: "We couldn't prepare autopay", before any Razorpay call.
    await createStore(INPUT);
    expect(dbHolder.current.calls.values[1]).toMatchObject({
      phone: "+919876543210",
    });
    // A number already on the login is Firebase-verified, so it is recorded
    // as verified and the checklist does not ask for it again.
    expect(dbHolder.current.calls.values[1].phoneVerifiedAt).toBeTruthy();
  });

  it("falls back to the email local-part when the owner name is blank", async () => {
    await createStore({ ...INPUT, firstName: "", lastName: "" });
    expect(dbHolder.current.calls.values[1]).toMatchObject({
      firstName: "owner",
      lastName: null,
    });
  });

  it("maps a concurrent slug race to a useful retry message", async () => {
    vi.mocked(isUniqueViolation).mockReturnValue(true);
    const originalInsert = dbHolder.current.db.insert;
    dbHolder.current.db.insert = vi.fn((table: any) => {
      if (table === stores) throw new Error("duplicate");
      return originalInsert(table);
    });
    expect(await createStore(INPUT)).toEqual({
      error: "That name was just taken - try another.",
    });
  });

  it("★★ a failed owner insert fails the ONE transaction — no store, no burned slug, no hand-rolled delete", async () => {
    // The three rows used to be three withService calls with a manual
    // rollback; a rollback that is itself a network call can fail and leave a
    // store nobody owns, blocking every retry on "that name is not available".
    dbHolder.current = makeDbMock({
      selectQueue: [[], []],
      returning: [{ id: "store-1", slug: "acme-foods" }],
      failInsertFor: [admins],
    });

    expect(await createStore(INPUT)).toEqual({
      error: "Could not create your store. Please try again.",
    });
    expect(dbHolder.current.calls.delete).toHaveLength(0);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("a failed invoice-profile insert fails the same transaction", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[], []],
      returning: [{ id: "store-1", slug: "acme-foods" }],
      failInsertFor: [storeBillingSettings],
    });

    expect((await createStore(INPUT)).error).toMatch(/could not create/i);
    expect(dbHolder.current.calls.delete).toHaveLength(0);
  });

  it("makes the new store resolvable on the very next request", async () => {
    await createStore(INPUT);
    expect(updateTag).toHaveBeenCalledWith("stores");
  });

  it("records consent and emits separate merchant and operator events", async () => {
    await createStore(INPUT);

    expect(recordSignupConsent).toHaveBeenCalledWith({
      userId: "user-1",
      email: "owner@example.com",
      actorType: "merchant",
      storeId: "store-1",
      context: "signup",
    });
    expect(emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "store.created",
        storeId: "store-1",
        payload: {
          storeUrl: "https://acme-foods.staging.storemink.com",
          plan: "free",
        },
      }),
    );
    expect(emitEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "platform.store_created",
        storeId: null,
        payload: { slug: "acme-foods" },
      }),
    );
  });
});

describe("createStore sign-in host registration", () => {
  it("★ authorizes the new store's exact host after the response, not before", async () => {
    const result = await createStore(INPUT);

    expect(result).toEqual({
      slug: "acme-foods",
      storeId: "store-1",
      phoneVerified: true,
    });
    // Deferred: nothing has gone to Google while the merchant waits.
    expect(after).toHaveBeenCalledTimes(1);
    expect(ensureAuthorizedHosts).not.toHaveBeenCalled();

    await runAfterTasks();
    expect(ensureAuthorizedHosts).toHaveBeenCalledWith([
      "acme-foods.staging.storemink.com",
    ]);
    expect(logWarn).not.toHaveBeenCalled();
  });

  // ★ Pins the call's position: right after the commit, before any later step
  // that can throw. Moved below one of these, a committed store would never
  // get its host and phone codes would fail there until the hourly sweep.
  it.each([
    [
      "recording consent rejects",
      () =>
        vi
          .mocked(recordSignupConsent)
          .mockRejectedValueOnce(new Error("consent failed")),
    ],
  ])(
    "★ still registers the committed store's host when %s afterwards",
    async (_label, fail) => {
      fail();
      await expect(createStore(INPUT)).rejects.toThrow(/failed/);

      expect(after).toHaveBeenCalledTimes(1);
      await runAfterTasks();
      expect(ensureAuthorizedHosts).toHaveBeenCalledTimes(1);
      expect(ensureAuthorizedHosts).toHaveBeenCalledWith([
        "acme-foods.staging.storemink.com",
      ]);
    },
  );

  it("registers nothing when the store was not created", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[], []],
      returning: [{ id: "store-1", slug: "acme-foods" }],
      failInsertFor: [admins],
    });
    expect((await createStore(INPUT)).error).toMatch(/could not create/i);

    vi.mocked(isUniqueViolation).mockReturnValue(true);
    dbHolder.current = makeDbMock({
      selectQueue: [[], []],
      returning: [{ id: "store-1", slug: "acme-foods" }],
      failInsertFor: [stores],
    });
    expect((await createStore(INPUT)).error).toMatch(/just taken/i);

    vi.mocked(getServerUser).mockResolvedValue(null);
    expect((await createStore(INPUT)).error).toMatch(/sign in/i);

    await runAfterTasks();
    expect(after).not.toHaveBeenCalled();
    expect(ensureAuthorizedHosts).not.toHaveBeenCalled();
  });

  it("★ a failed authorization never changes the signup result, only logs a warning", async () => {
    const created = {
      slug: "acme-foods",
      storeId: "store-1",
      phoneVerified: true,
    };

    // Identity Platform answers with an error.
    vi.mocked(ensureAuthorizedHosts).mockResolvedValueOnce({
      added: [],
      error: "Identity Platform update failed (403)",
    });
    expect(await createStore(INPUT)).toEqual(created);
    await runAfterTasks();
    expect(logWarn).toHaveBeenLastCalledWith(
      expect.stringMatching(/authorize/i),
      expect.objectContaining({
        storeId: "store-1",
        error: "Identity Platform update failed (403)",
      }),
    );

    // The call throws outright: the deferred task still settles quietly.
    vi.mocked(ensureAuthorizedHosts).mockRejectedValueOnce(
      new Error("socket hang up"),
    );
    dbHolder.current = makeDbMock({
      selectQueue: [[], []],
      returning: [{ id: "store-1", slug: "acme-foods" }],
    });
    expect(await createStore(INPUT)).toEqual(created);
    await expect(runAfterTasks()).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ storeId: "store-1", error: "socket hang up" }),
    );

    // after() itself refusing (outside a request scope) cannot fail a store
    // that is already committed.
    vi.mocked(after).mockImplementationOnce(() => {
      throw new Error("`after` was called outside a request scope");
    });
    dbHolder.current = makeDbMock({
      selectQueue: [[], []],
      returning: [{ id: "store-1", slug: "acme-foods" }],
    });
    expect(await createStore(INPUT)).toEqual(created);
    expect(logWarn).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ storeId: "store-1" }),
    );
    expect(logWarn).toHaveBeenCalledTimes(3);
  });
});

describe("reclaimUnusedSignupEmail", () => {
  const notFound = Object.assign(new Error("no user"), {
    code: "auth/user-not-found",
  });

  beforeEach(() => {
    firebaseAuth.getUserByEmail = vi.fn(async () => ({
      uid: "orphan-uid",
      email: "Iamvansh@Gmail.com",
    }));
    vi.mocked(getFirebaseAdminAuth).mockReturnValue(firebaseAuth as any);
    vi.mocked(authIdsInUse).mockResolvedValue(new Set());
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true });
  });

  it("removes a login that holds no StoreMink role so the email signs up as new", async () => {
    const res = await reclaimUnusedSignupEmail("  iamvansh@gmail.com ");

    expect(res).toEqual({ reclaimed: true });
    expect(firebaseAuth.getUserByEmail).toHaveBeenCalledWith(
      "iamvansh@gmail.com",
    );
    // The role check sees the login's own email as well as the typed one, so
    // a platform operator is recognised whichever spelling they signed up with.
    expect(vi.mocked(authIdsInUse).mock.calls[0][0]).toEqual(
      new Map([["orphan-uid", new Set(["iamvansh@gmail.com"])]]),
    );
    expect(deleteAuthUser).toHaveBeenCalledWith("orphan-uid");
  });

  it("never deletes a login that another store, a customer account or the console still uses", async () => {
    vi.mocked(authIdsInUse).mockResolvedValue(new Set(["orphan-uid"]));

    expect(await reclaimUnusedSignupEmail("iamvansh@gmail.com")).toEqual({
      reclaimed: false,
    });
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });

  it("fails closed when the role check cannot answer", async () => {
    vi.mocked(authIdsInUse).mockRejectedValue(new Error("db down"));

    expect(await reclaimUnusedSignupEmail("iamvansh@gmail.com")).toEqual({
      reclaimed: false,
    });
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });

  it("reports the email free when the login is already gone", async () => {
    firebaseAuth.getUserByEmail = vi.fn(async () => {
      throw notFound;
    });

    expect(await reclaimUnusedSignupEmail("iamvansh@gmail.com")).toEqual({
      reclaimed: true,
    });
    expect(authIdsInUse).not.toHaveBeenCalled();
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });

  it("refuses a malformed email, a rate-limited caller and an unconfigured auth backend", async () => {
    expect(await reclaimUnusedSignupEmail("not-an-email")).toEqual({
      reclaimed: false,
    });
    expect(rateLimit).not.toHaveBeenCalled();

    vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false });
    expect(await reclaimUnusedSignupEmail("iamvansh@gmail.com")).toEqual({
      reclaimed: false,
    });

    vi.mocked(getFirebaseAdminAuth).mockReturnValueOnce(null);
    expect(await reclaimUnusedSignupEmail("iamvansh@gmail.com")).toEqual({
      reclaimed: false,
    });

    expect(firebaseAuth.getUserByEmail).not.toHaveBeenCalled();
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });
});
