// The Branding page's pure half: the editable draft, how it becomes the form
// `saveStoreBranding` reads, the colour helpers, validation, and the words the
// Credit line field shows. Client-safe and import-light (types and the
// import-free footer-credit rule only), so the editor and its tests share it.

import type { StoreBrand } from "@/lib/store/brand";
import type { BrandVoiceStructured } from "@/lib/ai/brand-voice";
import { isDefaultCreditWords } from "@/lib/store/footer-credit";

/** lib/store/brand.ts DEFAULT_PRIMARY. That module is server-only, so the
 *  value is repeated here rather than imported into a client bundle. */
export const FALLBACK_PRIMARY = "#17130f";

/** Everything the branding form edits, as plain strings ("" for empty). */
export interface BrandDraft {
  name: string;
  logoUrl: string;
  primaryColor: string;
  tagline: string;
  blurb: string;
  legalName: string;
  creditLine: string;
  email: string;
  phone: string;
  hours: string;
  instagram: string;
  youtube: string;
  whatsapp: string;
}

export const BRAND_DRAFT_KEYS = [
  "name",
  "logoUrl",
  "primaryColor",
  "tagline",
  "blurb",
  "legalName",
  "creditLine",
  "email",
  "phone",
  "hours",
  "instagram",
  "youtube",
  "whatsapp",
] as const satisfies readonly (keyof BrandDraft)[];

/** The brand voice part of the page: the guide and the five answers. */
export interface VoiceDraft {
  content: string;
  answers: BrandVoiceStructured;
}

export const VOICE_ANSWER_KEYS = [
  "sell",
  "audience",
  "personality",
  "why",
  "avoid",
] as const satisfies readonly (keyof BrandVoiceStructured)[];

export function brandDraftFrom(brand: StoreBrand): BrandDraft {
  return {
    name: brand.name ?? "",
    logoUrl: brand.logoUrl ?? "",
    primaryColor: normalizeHex(brand.primaryColor ?? "") ?? FALLBACK_PRIMARY,
    tagline: brand.tagline ?? "",
    blurb: brand.blurb ?? "",
    legalName: brand.legalName ?? "",
    creditLine: brand.creditLine ?? "",
    email: brand.email ?? "",
    phone: brand.phone ?? "",
    hours: brand.hours ?? "",
    instagram: brand.social?.instagram ?? "",
    youtube: brand.social?.youtube ?? "",
    whatsapp: brand.social?.whatsapp ?? "",
  };
}

export function voiceDraftFrom(voice: {
  content: string;
  structured: BrandVoiceStructured;
}): VoiceDraft {
  const answers = {} as BrandVoiceStructured;
  for (const key of VOICE_ANSWER_KEYS) {
    answers[key] = voice.structured?.[key] ?? "";
  }
  return { content: voice.content ?? "", answers };
}

export function sameBrandDraft(a: BrandDraft, b: BrandDraft): boolean {
  return BRAND_DRAFT_KEYS.every((key) => a[key] === b[key]);
}

export function sameVoiceDraft(a: VoiceDraft, b: VoiceDraft): boolean {
  return (
    a.content === b.content &&
    VOICE_ANSWER_KEYS.every(
      (key) => (a.answers[key] ?? "") === (b.answers[key] ?? ""),
    )
  );
}

/** A link a merchant typed without a scheme ("instagram.com/acme") would
 *  render as a path on their own store, so it gets https:// in front. A value
 *  that already names a scheme is left exactly as typed. */
export function withScheme(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
}

/** The draft as it is sent: trimmed, social links given a scheme. The server
 *  trims too, so what is kept as "saved" matches what a reload shows. */
export function brandDraftForSave(draft: BrandDraft): BrandDraft {
  const out = { ...draft };
  for (const key of BRAND_DRAFT_KEYS) out[key] = draft[key].trim();
  out.instagram = withScheme(draft.instagram);
  out.youtube = withScheme(draft.youtube);
  out.whatsapp = withScheme(draft.whatsapp);
  return out;
}

export function voiceDraftForSave(voice: VoiceDraft): VoiceDraft {
  const answers = {} as BrandVoiceStructured;
  for (const key of VOICE_ANSWER_KEYS) {
    answers[key] = (voice.answers[key] ?? "").trim();
  }
  return { content: voice.content.trim(), answers };
}

/** The FormData `saveStoreBranding` reads, field for field. */
export function brandingFormData(draft: BrandDraft): FormData {
  const form = new FormData();
  for (const key of BRAND_DRAFT_KEYS) form.set(key, draft[key]);
  return form;
}

export type BrandFieldErrors = Partial<Record<"name" | "email", string>>;

/** What must be fixed before branding can be saved. The server checks the
 *  name again; the email check exists because a typo there is silent. */
export function validateBrandDraft(draft: BrandDraft): BrandFieldErrors {
  const errors: BrandFieldErrors = {};
  if (!draft.name.trim()) errors.name = "Add your store name.";
  const email = draft.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "Enter an email address like hello@yourstore.com.";
  }
  return errors;
}

/** "#abc", "abc", "#AABBCC" or "aabbcc" as lowercase "#aabbcc"; anything
 *  else null. The server keeps only a six-digit hex. */
export function normalizeHex(raw: string): string | null {
  const value = raw.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(value)) {
    return `#${value
      .split("")
      .map((c) => c + c)
      .join("")
      .toLowerCase()}`;
  }
  if (/^[0-9a-f]{6}$/i.test(value)) return `#${value.toLowerCase()}`;
  return null;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The text colour that reads better on `hex`: white or near-black. */
export function readableTextOn(hex: string): "#ffffff" | "#111827" {
  const valid = normalizeHex(hex) ?? FALLBACK_PRIMARY;
  const bg = luminance(valid);
  return contrast(bg, 1) >= contrast(bg, luminance("#111827"))
    ? "#ffffff"
    : "#111827";
}

/**
 * What the Credit line field says, by whether the store's plan removes
 * StoreMink's "Powered by" badge (PLAN_LIMITS.removeBadge for its effective
 * plan, read by the page) and by what the field holds. The storefront follows
 * the same rule (lib/store/footer-credit.ts): Free always shows the badge,
 * Basic and Pro show the store's own line or nothing. ★ On Basic and Pro the
 * field has no placeholder: the badge's words there would suggest the badge
 * still shows when the field is empty, and an example line reads as store
 * data (owner's rule, 31 Oct 2026: no example placeholders). ★ And a
 * line that is only the badge's words shows NOTHING there (isDefaultCreditWords,
 * the storefront's own test), so the hint says so rather than promising it
 * shows: the Free placeholder suggests exactly those words, so a store that
 * typed them on Free carries them into Basic or Pro. `null` is a plan that
 * could not be read, so the hint states both rules.
 */
export function creditLineCopy(
  removeBadge: boolean | null,
  creditLine: string,
): {
  hint: string;
  placeholder?: string;
} {
  if (removeBadge === false) {
    return {
      hint: "The Free plan shows Powered by StoreMink here. On Basic or Pro, show your own line or nothing.",
      placeholder: "Powered by StoreMink",
    };
  }
  if (removeBadge === true) {
    if (isDefaultCreditWords(creditLine)) {
      return {
        hint: "These are StoreMink's badge words, so nothing shows here. Type your own line, or leave it empty.",
      };
    }
    return {
      hint: "Shown at the very bottom of your store. Leave it empty to show nothing.",
    };
  }
  return {
    hint: "Shown on Basic and Pro only. The Free plan shows Powered by StoreMink here.",
  };
}
