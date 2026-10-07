"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { isStorefrontGated } from "@/lib/store/launch-state";
import { getOrCreateStorefrontPassword } from "@/lib/store/storefront-access";
import {
  STOREFRONT_GRANT_COOKIE,
  STOREFRONT_GRANT_TTL_SECONDS,
  signStorefrontGrant,
  storefrontGrantsConfigured,
  storefrontPasswordMatches,
} from "@/lib/store/storefront-grant";
import { logError } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// The storefront password page's one action.
//
// ★ THE HOST DECIDES WHICH STORE. A caller cannot name one; the password is
// compared against the store this request is on, so a password leaked from
// one shop opens nothing on another.
//
// ★ RATE-LIMITED PER VISITOR AND PER STORE, because an 8-character password
// is a sharing code, not a credential: it keeps a shop private, it does not
// protect money or data (every public write is refused on a closed store
// regardless, lib/store/storefront-access.ts). The limiter makes guessing it
// impractical without making a typo expensive.
//
// ★ THE GRANT IS A HOST-ONLY COOKIE. Unlike `sm_session`, which spans every
// store subdomain by design, a grant for one store must not be presented to
// another's host — the cookie name is shared and the claims are what tell the
// stores apart, but there is no reason to send it at all.
// ---------------------------------------------------------------------------

export interface UnlockState {
  error?: string;
}

function safeNext(raw: FormDataEntryValue | null): string {
  const value = typeof raw === "string" ? raw : "";
  // Same-origin paths only: a `next` of `//evil.example` or `https://…` would
  // turn the password page into an open redirect.
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.startsWith("/password")) return "/";
  return value.slice(0, 512);
}

export async function unlockStorefront(
  _prev: UnlockState,
  formData: FormData,
): Promise<UnlockState> {
  const store = await getCurrentStoreOrNull();
  if (!store) return { error: "This store could not be found." };
  const next = safeNext(formData.get("next"));
  if (!isStorefrontGated(store)) redirect(next);

  if (!storefrontGrantsConfigured()) {
    logError(
      "unlockStorefront: no signing key (set CRON_SECRET or STOREFRONT_PASSWORD_SECRET)",
      null,
      { storeId: store.id },
    );
    return {
      error: "The password page isn't available right now. Please try later.",
    };
  }

  const h = await headers();
  const ip = clientIp(h);
  const [perVisitor, perStore] = await Promise.all([
    rateLimit(`storefront-pass:${store.id}:${ip}`, {
      max: 10,
      windowSeconds: 15 * 60,
    }),
    rateLimit(`storefront-pass:${store.id}`, {
      max: 200,
      windowSeconds: 60 * 60,
    }),
  ]);
  if (!perVisitor.allowed || !perStore.allowed) {
    return { error: "Too many attempts. Please wait a few minutes." };
  }

  const entered = formData.get("password");
  let current;
  try {
    current = await getOrCreateStorefrontPassword(store.id);
  } catch (err) {
    logError("unlockStorefront: password unreadable", err, {
      storeId: store.id,
    });
    return {
      error: "Couldn't check the password right now. Please try again.",
    };
  }
  if (
    !storefrontPasswordMatches(
      typeof entered === "string" ? entered : null,
      current.password,
    )
  ) {
    return { error: "That password isn't right." };
  }

  const secure =
    (h.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() === "https";
  (await cookies()).set({
    name: STOREFRONT_GRANT_COOKIE,
    value: signStorefrontGrant({
      storeId: store.id,
      version: current.version,
    }),
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: STOREFRONT_GRANT_TTL_SECONDS,
  });
  redirect(next);
}
