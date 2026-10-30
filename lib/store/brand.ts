import "server-only";
import { getCurrentStore, lookupStoreById } from "@/lib/store/resolve";
import { PLATFORM_EMAIL_DOMAIN, senderDomainFor } from "@/lib/email/sender";
import { maskBlockedMedia } from "@/lib/moderation/blocked-objects";

// A store's public brand + footer identity. Stored under stores.settings.brand
// (jsonb) and edited from the dashboard (/dashboard/branding). Everything falls
// back to sensible defaults so a brand-new store still renders correctly.
export interface StoreSocial {
  instagram: string | null;
  youtube: string | null;
  whatsapp: string | null;
}

export interface StoreBadge {
  icon: string;
  label: string;
}

export interface StoreBrand {
  name: string;
  logoUrl: string | null;
  primaryColor: string;
  tagline: string | null; // short — used as the <title> suffix
  blurb: string | null; // footer paragraph
  legalName: string | null; // copyright entity (defaults to name)
  creditLine: string | null; // footer credit line
  email: string | null;
  phone: string | null;
  hours: string | null;
  social: StoreSocial;
  badges: StoreBadge[];
  domain: string; // Resend-verified domain to send this store's email FROM
  /**
   * A square brand mark shown beside the serif wordmark in email headers when
   * there is no full logo. Set only on StoreMink's own platform brand
   * (lib/email/platform-brand.ts); a merchant's identity is their logo or name.
   */
  mark?: string | null;
}

// Default storefront accent (the existing near-black) — a store keeps the clean
// default look until it picks its own primary colour in the dashboard.
export const DEFAULT_PRIMARY = "#17130f";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function socialFromSettings(v: unknown): StoreSocial {
  const s = (v ?? {}) as Record<string, unknown>;
  return {
    instagram: str(s.instagram),
    youtube: str(s.youtube),
    whatsapp: str(s.whatsapp),
  };
}

function badgesFromSettings(v: unknown): StoreBadge[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((b) => {
      const o = (b ?? {}) as Record<string, unknown>;
      return { icon: str(o.icon) ?? "•", label: str(o.label) ?? "" };
    })
    .filter((b) => b.label);
}

// Resolve a brand object from a store's settings, applying defaults.
export function brandFromSettings(
  settings: Record<string, unknown> | null | undefined,
  fallbackName: string,
  domain: string,
): StoreBrand {
  const b = ((settings?.brand as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  return {
    name: str(b.name) ?? fallbackName,
    logoUrl: str(b.logoUrl),
    primaryColor: str(b.primaryColor) ?? DEFAULT_PRIMARY,
    tagline: str(b.tagline),
    blurb: str(b.blurb),
    legalName: str(b.legalName),
    creditLine: str(b.creditLine),
    email: str(b.email),
    phone: str(b.phone),
    hours: str(b.hours),
    social: socialFromSettings(b.social),
    badges: badgesFromSettings(b.badges),
    domain,
  };
}

/**
 * ★ A BLOCKED LOGO LEAVES THE LOGO SLOT EMPTY (takedown, design 5.6). The two
 * readers below mask the brand like every storefront read, and a logo the
 * mask changed becomes null rather than the placeholder's address: every logo
 * slot already has a designed no-logo state (the header, footer, password and
 * in-progress pages print the store's name, an email prints the name in
 * serif), while the placeholder is a relative address an email client cannot
 * load and a favicon or a JSON-LD logo should not carry.
 */
function withoutBlockedLogo(brand: StoreBrand, masked: StoreBrand): StoreBrand {
  return masked.logoUrl === brand.logoUrl
    ? masked
    : { ...masked, logoUrl: null };
}

// The brand for the CURRENT request's store (resolved from host), with a
// blocked logo removed (above). Never inside a database scope's callback:
// the mask may reload the blocked set through its own scope.
export async function getStoreBrand(): Promise<StoreBrand> {
  const brand = await getStoreBrandForEditing();
  return withoutBlockedLogo(brand, await maskBlockedMedia(brand));
}

// The brand for a specific store by ID, masked like getStoreBrand: its
// callers are emails and receipts.
export async function getStoreBrandById(id: string): Promise<StoreBrand> {
  const store = await lookupStoreById(id);
  const domain = store ? senderDomainFor(store) : PLATFORM_EMAIL_DOMAIN;
  const brand = brandFromSettings(
    store?.settings,
    store?.name || "Store",
    domain,
  );
  return withoutBlockedLogo(brand, await maskBlockedMedia(brand));
}

/**
 * The CURRENT request's brand exactly as saved, for an EDITOR that writes it
 * back. Not masked, on purpose: the Website Builder saves `logoUrl` with every
 * brand change, so reading the masked brand there would quietly erase a
 * blocked logo from the store's settings, and lifting the block could not
 * bring it back. Never render this to a shopper or put it in an email.
 */
export async function getStoreBrandForEditing(): Promise<StoreBrand> {
  const store = await getCurrentStore();
  // `domain` feeds the email From address, so it MUST be a Resend-verified
  // sending domain. A plain {slug}.storemink.com subdomain is never verified in
  // Resend, so senderDomainFor() falls back to the shared platform domain until
  // the store verifies its own custom domain — otherwise every send is rejected.
  return brandFromSettings(store.settings, store.name, senderDomainFor(store));
}
