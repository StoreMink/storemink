"use server";

import { updateTag } from "next/cache";
import { headers } from "next/headers";
import { after } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getFirebaseAdminAuth } from "@/lib/auth/firebase-admin";
import { authErrorCode, deleteAuthUser } from "@/lib/auth/firebase-users";
import { authIdsInUse } from "@/lib/auth/identity-usage";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { ensureAuthorizedHosts } from "@/lib/auth/authorized-domains";
import {
  storeAuthHosts,
  type StoreAuthHostInput,
} from "@/lib/auth/store-auth-hosts";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { withService } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { admins, storeBillingSettings, stores } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { emailVerifiedNow } from "@/lib/auth/email-verified";
import { STORE_TAG } from "@/lib/store/resolve";
import { ROOT_DOMAIN } from "@/lib/store/host";
import { slugify } from "@/lib/slug";
import { emitEvent } from "@/lib/notifications/record";
import { recordSignupConsent } from "@/lib/legal/store";
import { COUNTRIES, DEFAULT_COUNTRY } from "@/lib/countries";

// Subdomains we can never hand out (platform-reserved or operational).
const RESERVED = new Set([
  "www",
  "app",
  "help",
  "pos",
  "themes",
  "api",
  "admin",
  "dashboard",
  "auth",
  "mail",
  "email",
  "smtp",
  "ftp",
  "blog",
  "status",
  "support",
  "billing",
  "account",
  "accounts",
  "login",
  "signup",
  "store",
  "stores",
  "storiq",
  "storemink",
  "assets",
  "cdn",
  "static",
  "media",
  "img",
  "images",
]);

export interface SlugCheck {
  slug: string;
  available: boolean;
  reason?: string;
}

/**
 * Live store-name → subdomain availability check for signup. Derives the slug
 * from what the user typed, validates its shape, rejects reserved names, then
 * checks (via the service role, so pending/suspended stores count too) whether
 * any store already owns it.
 */
export async function checkStoreSlugAvailability(
  raw: string,
): Promise<SlugCheck> {
  const slug = slugify(raw || "");

  if (!slug) {
    return { slug, available: false, reason: "Enter a store name." };
  }
  if (slug.length < 3) {
    return { slug, available: false, reason: "At least 3 characters." };
  }
  if (slug.length > 40) {
    return { slug, available: false, reason: "Too long (40 characters max)." };
  }
  if (RESERVED.has(slug)) {
    return { slug, available: false, reason: "This name is reserved." };
  }
  // The demo- namespace belongs to theme demo stores (seedDemoStore), and
  // studio-preview- to Theme Studio's private preview stores.
  if (/^demo(-|$)/.test(slug) || /^studio-preview(-|$)/.test(slug)) {
    return { slug, available: false, reason: "This name is reserved." };
  }

  try {
    const rows = await withService((db) =>
      db
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.slug, slug))
        .limit(1),
    );
    if (rows[0]) {
      return { slug, available: false, reason: "This name is not available." };
    }
    return { slug, available: true };
  } catch (err) {
    console.error(
      "checkStoreSlugAvailability:",
      err instanceof Error ? err.message : err,
    );
    return { slug, available: false, reason: "Couldn't check right now." };
  }
}

export interface SignupResume {
  /** Whether there's an authenticated session (email/password or Google). */
  authenticated: boolean;
  /** Whether this account already owns a store (→ send them to the dashboard). */
  hasStore: boolean;
  /** The owned store's slug, when hasStore. */
  slug?: string;
  /** The owner's mobile is verified (admins.phone_verified_at), when
   *  hasStore — a paid plan needs it before payment. */
  phoneVerified?: boolean;
  /** Google verifies this itself; password signup verifies it with our OTP. */
  emailConfirmed: boolean;
  email?: string;
  /** Name prefill (from Google profile metadata when signing in with Google). */
  firstName?: string;
  lastName?: string;
}

/**
 * What the signup wizard needs on load to resume: after a Google redirect (or a
 * refreshed tab), an account may already have a session — and possibly a store.
 * Lets the client jump straight to the store step (prefilling the Google
 * name), or bounce a finished account to its dashboard.
 */
export async function getSignupResumeInfo(): Promise<SignupResume> {
  const user = await getServerUser();
  if (!user) {
    return {
      authenticated: false,
      hasStore: false,
      emailConfirmed: false,
    };
  }

  let storeIdOwned: string | undefined;
  let slug: string | undefined;
  let phoneVerified = false;
  try {
    const existing = await withService((db) =>
      db
        .select({
          store_id: admins.storeId,
          phone_verified_at: admins.phoneVerifiedAt,
        })
        .from(admins)
        .where(eq(admins.id, user.id))
        .limit(1),
    );
    storeIdOwned = existing[0]?.store_id ?? undefined;
    phoneVerified = Boolean(existing[0]?.phone_verified_at);

    if (storeIdOwned) {
      const storeRows = await withService((db) =>
        db
          .select({ slug: stores.slug })
          .from(stores)
          .where(eq(stores.id, storeIdOwned!))
          .limit(1),
      );
      slug = storeRows[0]?.slug ?? undefined;
    }
  } catch (err) {
    console.error("getSignupResumeInfo:", err);
  }

  // Best-effort name prefill from OAuth profile metadata.
  const meta = user.metadata ?? {};
  const full = String(meta.full_name || meta.name || "").trim();
  const parts = full ? full.split(/\s+/) : [];
  const firstName = (meta.given_name as string) || parts[0] || undefined;
  const lastName =
    (meta.family_name as string) ||
    (parts.length > 1 ? parts.slice(1).join(" ") : undefined);

  return {
    authenticated: true,
    hasStore: !!storeIdOwned,
    slug,
    ...(storeIdOwned ? { phoneVerified } : {}),
    // The record when the cookie still says unverified: a resumed tab whose
    // code was accepted goes on to the store step, never back to a new code.
    emailConfirmed: await emailVerifiedNow(user),
    email: user.email ?? undefined,
    firstName,
    lastName,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Free an email whose login holds no StoreMink role, so signup can create the
 * account afresh. Called by the wizard only after Firebase answered
 * `auth/email-already-in-use` AND the typed password did not sign in.
 *
 * Two things leave such a login behind: a deleted store whose owner login
 * `deleteStore` could not remove, and an abandoned signup — the password step
 * creates the Firebase account before the email is verified, so a half-finished
 * attempt (or somebody typing another person's address) holds the email with a
 * password its real owner does not know. Either way signup dead-ended on
 * "An account with this email already exists", and the platform login asks for
 * a store address this person does not have.
 *
 * ★ A login that still holds a role anywhere — store admin, storefront
 * customer, POS operator, platform operator — is never touched: that is a real
 * account, and its owner signs in with its own password. Deleting a role-less
 * login loses nothing, and the new account must still prove the address with
 * the emailed code before it can create a store.
 */
export async function reclaimUnusedSignupEmail(
  email: string,
): Promise<{ reclaimed: boolean }> {
  const address = String(email ?? "")
    .trim()
    .toLowerCase();
  if (!EMAIL_RE.test(address)) return { reclaimed: false };

  // A deletion endpoint anyone can call: bounded per IP, generous enough for
  // a shared office connection.
  const { allowed } = await rateLimit(
    `signup-reclaim:${clientIp(await headers())}`,
    { max: 10, windowSeconds: 3600 },
  );
  if (!allowed) return { reclaimed: false };

  const auth = getFirebaseAdminAuth();
  if (!auth) return { reclaimed: false };

  let uid: string;
  const emails = new Set([address]);
  try {
    const record = await auth.getUserByEmail(address);
    uid = record.uid;
    if (record.email) emails.add(record.email.trim().toLowerCase());
  } catch (err) {
    // Already gone (deleted between the client's attempt and now): the email
    // is free, so the wizard may simply try again.
    if (authErrorCode(err) === "auth/user-not-found")
      return { reclaimed: true };
    logError("reclaimUnusedSignupEmail (lookup)", err);
    return { reclaimed: false };
  }

  try {
    // Fails closed: an unanswerable check throws, and "unknown" is "in use".
    const inUse = await authIdsInUse(new Map([[uid, emails]]));
    if (inUse.has(uid)) return { reclaimed: false };
    await deleteAuthUser(uid);
  } catch (err) {
    logError("reclaimUnusedSignupEmail", err, { uid });
    return { reclaimed: false };
  }
  logInfo("signup: removed a login with no StoreMink role", { uid });
  return { reclaimed: true };
}

/**
 * Add a new store's exact host(s) to Identity Platform's authorized domains,
 * after the response is sent. ★ It must never fail or slow signup: the store is
 * already committed, a Google API round trip has no place in front of the
 * merchant, and the hourly sweep (syncStoreAuthHosts) re-adds anything missed.
 * So every failure, including `after()` itself throwing outside a request
 * scope, is a logged warning and nothing more.
 */
function registerStoreAuthHosts(
  storeId: string,
  store: StoreAuthHostInput,
): void {
  const warn = (err: unknown) =>
    logWarn("createStore: could not authorize the store's sign-in hosts", {
      storeId,
      error: err instanceof Error ? err.message : String(err),
    });
  try {
    after(async () => {
      try {
        // Empty for a demo/preview store or a local root: nothing to register.
        const hosts = storeAuthHosts(store, ROOT_DOMAIN);
        if (hosts.length === 0) return;
        const result = await ensureAuthorizedHosts(hosts);
        if (result.error) warn(result.error);
      } catch (err) {
        warn(err);
      }
    });
  } catch (err) {
    warn(err);
  }
}

export interface CreateStoreInput {
  /** Store display name (also seeds the subdomain slug). */
  name: string;
  /** Owner's first name (written to admins.first_name). */
  firstName?: string;
  /** Owner's last name (admins.last_name; optional). */
  lastName?: string;
  /** ISO country code the merchant sells from (settings.business.country).
   *  Defaults to the platform's home country when absent; the wizard offers
   *  the same default and lets the merchant change it. */
  country?: string;
  /**
   * The business address. ★ OPTIONAL AT SIGNUP since 2026-10-07: it prints on
   * invoices and decides GST place of supply, and a store has no invoice
   * until its first order. The go-live checklist (lib/store/launch-checklist-
   * rules.ts) requires it before the store can open, which is where it is
   * actually needed. Whatever IS supplied is stored exactly as before.
   */
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  /** Pin coordinates, when captured. Stored as numbers, not strings, so the
   *  eventual "stores near you" query doesn't have to parse them back. */
  lat?: number;
  lng?: number;
}

export interface CreateStoreResult {
  slug?: string;
  storeId?: string;
  /** The owner's mobile is already verified, so a paid plan chosen during
   *  signup can go straight to payment (Razorpay autopay needs a mobile). */
  phoneVerified?: boolean;
  error?: string;
}

/**
 * Provision a new store. Called AFTER the owner has verified their email (so
 * there's an authenticated session — see the signup wizard). Creates the store,
 * makes the caller its superadmin (recording their name + selling country),
 * seeds the invoice profile, and returns the slug + id. Runs the writes via the
 * service role because a brand-new owner isn't yet a superadmin of any store
 * (so RLS would block them).
 *
 * ★★ IT INSTALLS NO THEME (owner, 2026-10-11). The store is created with
 * `settings.themePending: true` and nothing seeded: no pages, menus or sample
 * products. Its owner chooses a theme on Dashboard → Storefront, which
 * installs it and clears the flag (lib/themes/switch.ts); until then the
 * storefront shows a "store in progress" page behind the password, and the
 * go-live checklist keeps the store closed.
 *
 * ★★ THE THREE ROWS ARE ONE TRANSACTION. They used to be three `withService`
 * calls with a hand-written rollback (delete the store if the admin or billing
 * insert failed). A rollback that is itself a network call can fail, and when
 * it did the slug was burned: a half-made store nobody owned, blocking every
 * retry with "that name is not available". One transaction cannot leave that
 * behind — a failed insert rolls back the store row with it, and the slug is
 * free again on the next attempt.
 */
export async function createStore(
  input: CreateStoreInput,
): Promise<CreateStoreResult> {
  const rawName = input.name;

  const user = await getServerUser();
  if (!user) {
    return { error: "Please sign in before creating a store." };
  }
  // Client steps are an affordance, never the security boundary. A verified
  // email is an authoritative server-side requirement: Google supplies the
  // claim; password signup earns it through signup-email-otp.
  //
  // ★ THE PHONE IS NOT. It moved to the go-live checklist (2026-10-10): the
  // store opens closed, and Go live refuses until the owner has proven their
  // mobile with a code (lib/store/launch-checklist-rules.ts). Asking at signup
  // put a second code in front of a store that cannot take an order yet, and
  // linking the number to the login refused every merchant who had ever
  // shopped on a StoreMink store with that mobile.
  // ★ The account record, not only the cookie: the code may have been
  // accepted in a tab that could not re-mint its session afterwards
  // (lib/auth/email-verified.ts).
  if (!(await emailVerifiedNow(user))) {
    return {
      error: "Please verify your email address before creating a store.",
    };
  }

  // Authoritative re-check (the client check is just for live feedback).
  const check = await checkStoreSlugAvailability(rawName);
  if (!check.available) {
    return { error: check.reason ?? "This name is not available." };
  }
  const slug = check.slug;

  // One store per owner for now (admins.id is the auth user id).
  const existing = await withService((db) =>
    db
      .select({ store_id: admins.storeId })
      .from(admins)
      .where(eq(admins.id, user.id))
      .limit(1),
  ).catch(() => []);
  if (existing[0]) {
    return { error: "This account already has a store." };
  }

  // Where the merchant sells from — non-secret (it prints on invoices later),
  // so it lives in the anon-readable stores.settings jsonb under `business`
  // (never a secret — convention #9). Only the country is certain at signup;
  // the address arrives later from Taxes & invoices and the go-live checklist
  // refuses to open the store without it.
  const countryInput = (input.country || "").trim().slice(0, 2).toUpperCase();
  const country = COUNTRIES.some((c) => c.code === countryInput)
    ? countryInput
    : DEFAULT_COUNTRY;
  const addressLine1 = (input.addressLine1 || "").trim().slice(0, 160);
  const addressLine2 = (input.addressLine2 || "").trim().slice(0, 160);
  const city = (input.city || "").trim().slice(0, 80);
  const state = (input.state || "").trim().slice(0, 80);
  const postalCode = (input.postalCode || "").trim().slice(0, 20);

  const countryName =
    COUNTRIES.find((candidate) => candidate.code === country)?.name ?? country;
  const hasAddress = Boolean(addressLine1 || city || state || postalCode);
  const formattedAddress = hasAddress
    ? [
        addressLine1,
        addressLine2,
        [city, [state, postalCode].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(", "),
        countryName,
      ]
        .filter(Boolean)
        .join("\n")
    : null;

  const business: Record<string, string | number> = { country };
  if (addressLine1) business.addressLine1 = addressLine1;
  if (addressLine2) business.addressLine2 = addressLine2;
  if (city) business.city = city;
  if (state) business.state = state;
  if (postalCode) business.postalCode = postalCode;
  // Keep one display-ready form for existing readers while the structured
  // fields remain the canonical, editable source.
  if (formattedAddress) business.address = formattedAddress;

  // Coordinates are optional — they come from the map pin or the browser's
  // geolocation, and a merchant who declines the permission prompt must still
  // be able to finish signing up. Bounds-checked so a bad client can't store
  // nonsense that later breaks a distance query.
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  ) {
    business.lat = lat;
    business.lng = lng;
  }

  // Make the owner the store's superadmin, recording their name (falls back to
  // the email local-part so admins.first_name is never blank).
  const firstName =
    (input.firstName || "").trim() ||
    (user.email ? user.email.split("@")[0] : "Owner");
  const lastName = (input.lastName || "").trim() || null;

  const storeSettings = {
    // The brand NAME is the merchant's and is stored here and on stores.name;
    // the brand colour, tagline and blurb arrive with their first theme, and
    // only where they are still empty (lib/themes/switch.ts).
    brand: { name: rawName.trim() },
    // CLOSED until the owner completes the go-live checklist and presses Go
    // live: visitors see a password page, nothing is indexed, and every public
    // write is refused. Written EXPLICITLY false because absence means
    // "launched" — stores created before this flag existed are already trading
    // and in Google, and treating a missing value as unlaunched would put a
    // password page in front of live shops. See lib/store/launch-state.ts.
    launched: false,
    // ★ No theme yet: see isThemePending (lib/store/launch-state.ts). Written
    // explicitly true because only an explicit true counts; every store made
    // before this flag existed has a theme and must not show the
    // store-in-progress page.
    themePending: true,
    business,
  };

  // Create the store, its owner and its invoice profile — one transaction.
  let store: { id: string; slug: string };
  try {
    store = await withService(async (db) => {
      const [created] = await db
        .insert(stores)
        .values({
          slug,
          name: rawName.trim(),
          status: "active",
          plan: "free",
          settings: storeSettings,
        })
        .returning({ id: stores.id, slug: stores.slug });

      await db.insert(admins).values({
        id: user.id,
        email: user.email ?? "",
        role: "superadmin",
        storeId: created.id,
        firstName: firstName.slice(0, 80),
        lastName: lastName ? lastName.slice(0, 80) : null,
        // ★★ A VERIFIED NUMBER MUST LAND HERE, NOT ONLY ON THE INVOICE
        // PROFILE. `admins.phone` is where every server reader looks for a
        // billing contact — `resolveBillingEmail`, and therefore
        // `startEnrolment`, which needs BOTH an email and a phone to register
        // a Razorpay mandate. Signup no longer asks for a phone, so this is
        // usually null now and the owner adds it from the go-live checklist
        // (`confirmVerifiedPhone`). A login that already carries one (an older
        // half-finished signup linked it) is Firebase-verified, so it counts.
        phone: user.phone ?? null,
        phoneVerifiedAt: user.phone ? sql`now()` : null,
        // The owner set their own password during signup — the admins column
        // defaults force_password_reset=true (that's for INVITED staff who get
        // a temporary password), so override it here or the owner is bounced to
        // /auth/set-password on their first login.
        forcePasswordReset: false,
      });

      // The invoice renderer reads store_billing_settings, not stores.settings.
      // Seed it with everything signup knows — name, verified email and phone,
      // and the address when one was given — so Taxes & invoices opens
      // pre-filled and the checklist's "business details" item is honest
      // about what is still missing.
      await db.insert(storeBillingSettings).values({
        storeId: created.id,
        businessName: rawName.trim(),
        businessAddress: formattedAddress,
        contactEmail: user.email ?? null,
        contactPhone: user.phone ?? null,
        updatedBy: user.id,
      });

      return created;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: "That name was just taken — try another." };
    }
    console.error(
      "createStore (store transaction):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not create your store. Please try again." };
  }

  // ★ Phone codes need this store's EXACT host in Identity Platform's
  // authorized domains (storemink.com alone does not cover a subdomain for
  // phone sign-in; lib/auth/authorized-domains.ts). Registered now so
  // storefront sign-in, enquiries, POS and the dashboard mobile check work from
  // the first minute instead of after the hourly sweep. Right after the commit,
  // so a later failure in this action still leaves the host registered.
  registerStoreAuthHosts(store.id, {
    slug: store.slug,
    settings: storeSettings,
  });

  // Nothing is seeded here any more: the owner's first theme choice seeds the
  // homepage, the theme's pages, its sample catalogue and its menus, without
  // overwriting anything they have made in the meantime (lib/themes/switch.ts).

  // New store row must be resolvable on the VERY NEXT request. `revalidateTag`
  // with the `max` profile is stale-while-revalidate: the first dashboard load
  // can therefore receive the cached "slug does not exist" result, fall back
  // to the legacy WholeSip store, and tell the new owner they have no access.
  // This is a Server Action and signup immediately redirects to the new host,
  // so Next 16's read-your-own-writes primitive is the correct contract here.
  updateTag(STORE_TAG);

  // NOTE: search engines are deliberately NOT notified here any more.
  //
  // A store at this instant has nothing of its own: no theme, no pages, no
  // products. Submitting that to Google and IndexNow the moment it exists
  // would show search engines an empty shop, and the reputational cost lands
  // on the whole *.storemink.com domain — including the stores that did the
  // work. `robots.txt` cannot undo it either: Disallow stops future crawling,
  // it does not deindex.
  //
  // The store is submitted when its owner completes the go-live checklist and
  // presses Go live (app/actions/launch-actions.ts), which is the one place
  // markStoreLaunched() is called from. See lib/store/launch-state.ts.
  //
  // Still needed below: the welcome email tells the merchant their address.
  const storeUrl = `https://${store.slug}.${ROOT_DOMAIN}`;

  // Belt and braces: consent is recorded right after the account is created,
  // but a wizard resumed from a refreshed tab or a Google redirect can reach
  // store creation by a path that skipped it. The unique index makes this a
  // no-op when it already landed, and an account that owns a store with NO
  // recorded agreement is the one outcome worth a second write to avoid.
  await recordSignupConsent({
    userId: user.id,
    email: user.email ?? null,
    actorType: "merchant",
    storeId: store.id,
    context: "signup",
  });

  // The MERCHANT's welcome — the only thing that greets someone who has just
  // finished signup. Without it a new store owner completed the wizard and
  // received nothing: no confirmation, no store address, no next step.
  // Scoped to the new store so it reaches the owner's own dashboard and inbox.
  emitEvent({
    type: "store.created",
    storeId: store.id,
    actor: { type: "system" },
    subject: { type: "store", id: store.id, label: rawName.trim() },
    payload: { storeUrl, plan: "free" },
  });

  // The OPERATORS' copy of the same moment (store_id NULL): same trigger,
  // different audience, different words — the two-audience rule (§23).
  emitEvent({
    type: "platform.store_created",
    storeId: null,
    actor: { type: "admin", id: user.id, label: user.email ?? null },
    subject: { type: "store", id: store.id, label: rawName.trim() },
    payload: { slug: store.slug },
  });

  return {
    slug: store.slug,
    storeId: store.id,
    phoneVerified: Boolean(user.phone),
  };
}
