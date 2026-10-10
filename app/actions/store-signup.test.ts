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
vi.mock("@/lib/store/host", () => ({ ROOT_DOMAIN: "storemink.com" }));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/legal/store", () => ({
  recordSignupConsent: vi.fn(async () => {}),
}));
vi.mock("@/lib/themes/apply", () => ({
  applyTheme: vi.fn(async () => ({ success: true, errors: [] })),
}));
vi.mock("@/lib/themes/runtime-registry", async () => {
  const { THEME_META } = await import("@/lib/themes/meta");
  return { getThemeCatalog: vi.fn(async () => [...THEME_META]) };
});
const firebaseAuth = vi.hoisted(() => ({ getUserByEmail: null as any }));
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
import { isUniqueViolation } from "@/lib/db/errors";
import { getServerUser } from "@/lib/auth/server-user";
import { emitEvent } from "@/lib/notifications/record";
import { recordSignupConsent } from "@/lib/legal/store";
import { applyTheme } from "@/lib/themes/apply";
import { DEFAULT_THEME_ID } from "@/lib/themes/meta";
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
  template: DEFAULT_THEME_ID,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  dbHolder.current = makeDbMock({
    selectQueue: [[], []],
    returning: [{ id: "store-1", slug: "acme-foods" }],
  });
  vi.mocked(getServerUser).mockResolvedValue(USER);
  vi.mocked(isUniqueViolation).mockReturnValue(false);
  vi.mocked(applyTheme).mockResolvedValue({ success: true, errors: [] } as any);
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
      phoneConfirmed: false,
      emailConfirmed: false,
    });
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("resumes a verified account without a store", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getSignupResumeInfo()).toMatchObject({
      authenticated: true,
      hasStore: false,
      phoneConfirmed: true,
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
      phoneConfirmed: true,
      emailConfirmed: true,
    });
  });
});

describe("createStore gates", () => {
  it("rejects an unavailable theme before creating a user-bound resource", async () => {
    expect(await createStore({ ...INPUT, template: "not-a-theme" })).toEqual({
      error: "That store theme is not available.",
    });
    expect(getServerUser).not.toHaveBeenCalled();
  });

  it("requires an authenticated, email-confirmed and phone-confirmed owner", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    expect((await createStore(INPUT)).error).toMatch(/sign in/i);

    vi.mocked(getServerUser).mockResolvedValue({
      ...USER,
      emailConfirmed: false,
    });
    expect((await createStore(INPUT)).error).toMatch(/verify your email/i);

    vi.mocked(getServerUser).mockResolvedValue({
      ...USER,
      phoneConfirmed: false,
    });
    expect((await createStore(INPUT)).error).toMatch(/verify your phone/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
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
      template: DEFAULT_THEME_ID,
      firstName: "Asha",
      country: "in",
    });
    expect(result).toEqual({ slug: "acme-foods", storeId: "store-1" });
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

    expect(result).toEqual({ slug: "acme-foods", storeId: "store-1" });
    expect(dbHolder.current.calls.insert[0]).toBe(stores);
    expect(dbHolder.current.calls.values[0]).toEqual({
      slug: "acme-foods",
      name: "Acme Foods",
      status: "active",
      plan: "free",
      settings: {
        template: DEFAULT_THEME_ID,
        brand: { name: "Acme Foods" },
        launched: false,
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

  it("★★ records the OTP-verified phone on the owner row, not only the invoice profile", async () => {
    // `admins.phone` is where `resolveBillingEmail` — and therefore
    // `startEnrolment` — looks for a billing contact. Writing it to
    // store_billing_settings alone left every wizard-created store unable to
    // subscribe: "We couldn't prepare autopay", before any Razorpay call.
    await createStore(INPUT);
    expect(dbHolder.current.calls.values[1]).toMatchObject({
      phone: "+919876543210",
    });
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
      error: "That name was just taken — try another.",
    });
    expect(applyTheme).not.toHaveBeenCalled();
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
    expect(applyTheme).not.toHaveBeenCalled();
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
    expect(applyTheme).not.toHaveBeenCalled();
  });

  it("keeps a working store when best-effort theme seeding is partial", async () => {
    vi.mocked(applyTheme).mockResolvedValue({
      success: false,
      errors: ["one sample product failed"],
    } as any);
    expect(await createStore(INPUT)).toEqual({
      slug: "acme-foods",
      storeId: "store-1",
    });
    expect(updateTag).toHaveBeenCalledWith("stores");
  });

  it("records consent and emits separate merchant and operator events", async () => {
    await createStore(INPUT);

    expect(applyTheme).toHaveBeenCalledWith("store-1", DEFAULT_THEME_ID, {
      publish: true,
      actorUserId: "user-1",
    });
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
          storeUrl: "https://acme-foods.storemink.com",
          plan: "free",
        },
      }),
    );
    expect(emitEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "platform.store_created",
        storeId: null,
        payload: { slug: "acme-foods", template: DEFAULT_THEME_ID },
      }),
    );
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
