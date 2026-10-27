// ---------------------------------------------------------------------------
// Account and staff access mail: the four messages that hand somebody a way
// into a store.
//
//   staff_invite          a dashboard admin invited with a temporary password
//   password_reset        a dashboard password reset link
//   pos_staff_invite      a register (POS) staff invitation link
//   pos_credential_reset  a register PIN or password reset link
//
// All four are SENSITIVE mailers (lib/email/mailers.ts): each body carries a
// working credential, so the email log records that it went out without
// storing the body. That is decided by the mailer key at send time, not here.
//
// These builders are PURE: no database, no network, no request scope. The
// actions fetch the brand and build the link, then pass both in. That is what
// lets a preview gallery and the no-long-dash guard render them directly.
//
// Every value that came from a person or the database (names, roles, emails,
// the temporary password) is escaped, either here or by the shell component
// it is passed to. Links go through `safeEmailUrl`, so a malformed one is
// dropped rather than rendered as a `javascript:` button.
// ---------------------------------------------------------------------------

import type { StoreBrand } from "@/lib/store/brand";
import {
  composeEmail,
  emailButton,
  emailCode,
  emailDetails,
  emailLinkFallback,
  emailNote,
  emailParagraph,
  emailSignoff,
  escapeHtml,
  safeEmailUrl,
} from "@/lib/email/shell";

export interface BuiltEmail {
  subject: string;
  html: string;
}

/** "Superadmin" from "superadmin", "Store manager" from "store_manager". */
function roleLabel(role: string): string {
  const words = role.trim().replace(/[_-]+/g, " ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/** "a member", "an admin": the role as it reads inside a sentence. */
function withArticle(role: string): string {
  const words = role.trim().replace(/[_-]+/g, " ").toLowerCase();
  return `${/^[aeiou]/.test(words) ? "an" : "a"} ${words}`;
}

/** "Hello Ada," or, with no usable name, "Hello,". */
function greeting(name: string): string {
  const trimmed = name.trim();
  return trimmed ? `Hello ${escapeHtml(trimmed)},` : "Hello,";
}

/** The call to action and its plain-link fallback, or nothing when the link
 *  is not a safe absolute http(s) URL. */
function actionBlocks(
  link: string,
  label: string,
  opts: { fallback: boolean },
): string[] {
  const href = safeEmailUrl(link);
  if (!href) return [];
  return [
    emailButton(href, label),
    opts.fallback ? emailLinkFallback(href) : "",
  ];
}

/**
 * A dashboard admin invited by a superadmin. The account already exists with a
 * temporary password; the first sign-in forces them to choose a new one.
 */
export function buildStaffInviteEmail(opts: {
  brand: StoreBrand;
  firstName: string;
  lastName?: string | null;
  email: string;
  role: string;
  tempPassword: string;
  signInUrl: string;
}): BuiltEmail {
  const { brand } = opts;
  const store = escapeHtml(brand.name);
  const fullName = [opts.firstName, opts.lastName ?? ""]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");

  const html = composeEmail({
    brand,
    eyebrow: "Invitation",
    heading: `You're invited to the ${brand.name} dashboard`,
    preheader: `Your temporary sign-in details for the ${brand.name} dashboard.`,
    blocks: [
      emailParagraph(greeting(fullName), { lead: true }),
      emailParagraph(
        `You've been invited to help run <strong>${store}</strong> as ${escapeHtml(withArticle(opts.role))}. Use the details below to sign in for the first time.`,
      ),
      emailDetails([
        { label: "Sign-in email", valueHtml: escapeHtml(opts.email.trim()) },
        { label: "Role", valueHtml: escapeHtml(roleLabel(opts.role)) },
      ]),
      emailCode(opts.tempPassword, {
        label: "Temporary password",
        compact: true,
      }),
      ...actionBlocks(opts.signInUrl, "Sign in to the dashboard", {
        fallback: false,
      }),
      emailNote(
        "You'll be asked to set a new password the first time you sign in. The temporary password stops working after that.",
      ),
      emailSignoff(brand.name),
    ],
    footerReasonHtml: `You're receiving this because an admin at ${store} invited ${escapeHtml(opts.email.trim())} to the dashboard.`,
  });

  return {
    // A mail header, not HTML: the brand name goes in unescaped.
    subject: `You're invited to the ${brand.name} dashboard`,
    html,
  };
}

/** A dashboard password reset link. The link itself is the credential. */
export function buildPasswordResetEmail(opts: {
  brand: StoreBrand;
  link: string;
}): BuiltEmail {
  const { brand } = opts;
  const store = escapeHtml(brand.name);

  const html = composeEmail({
    brand,
    heading: "Reset your password",
    preheader: `Choose a new password for your ${brand.name} account.`,
    blocks: [
      emailParagraph(
        `We received a request to reset the password for your <strong>${store}</strong> account. Use the button below to choose a new one.`,
        { lead: true },
      ),
      ...actionBlocks(opts.link, "Reset password", { fallback: true }),
      emailNote(
        "If you didn't ask for this, you can safely ignore this email. Your password won't change.",
      ),
      emailSignoff(brand.name),
    ],
    footerReasonHtml: `You're receiving this because a password reset was requested for this email address at ${store}.`,
  });

  return { subject: `Reset your ${brand.name} password`, html };
}

/**
 * A register (POS) staff invitation. Registration verifies their phone, then
 * they choose their own password and 8-digit PIN; nobody else ever sets one.
 */
export function buildPosStaffInviteEmail(opts: {
  brand: StoreBrand;
  name: string;
  role: string;
  link: string;
}): BuiltEmail {
  const { brand } = opts;
  const store = escapeHtml(brand.name);

  const html = composeEmail({
    brand,
    eyebrow: "Invitation",
    heading: "Set up your POS access",
    preheader: `Finish setting up your account for ${brand.name} POS.`,
    blocks: [
      emailParagraph(greeting(opts.name), { lead: true }),
      emailParagraph(
        `You've been added to <strong>${store}</strong> as ${escapeHtml(withArticle(opts.role))}. Finish setting up your account: verify your phone, then choose a password and an 8-digit PIN.`,
      ),
      ...actionBlocks(opts.link, "Complete registration", { fallback: true }),
      emailNote(
        "This link expires in 7 days. If you didn't expect this, you can safely ignore this email.",
      ),
      emailSignoff(brand.name),
    ],
    footerReasonHtml: `You're receiving this because ${store} added you to its POS team.`,
  });

  return { subject: `You've been added to ${brand.name} POS`, html };
}

/** A register (POS) PIN or password reset link. Single use, one hour. */
export function buildPosCredentialResetEmail(opts: {
  brand: StoreBrand;
  name: string;
  link: string;
}): BuiltEmail {
  const { brand } = opts;
  const store = escapeHtml(brand.name);

  const html = composeEmail({
    brand,
    heading: "Reset your POS access",
    preheader: `Choose a new PIN or password for ${brand.name} POS.`,
    blocks: [
      emailParagraph(greeting(opts.name), { lead: true }),
      emailParagraph(
        `We received a request to reset the PIN or password you use for <strong>${store}</strong> POS.`,
      ),
      ...actionBlocks(opts.link, "Reset PIN or password", { fallback: true }),
      emailNote(
        "This link expires in 1 hour and can be used once. If you didn't request it, you can safely ignore this email. Nothing has changed.",
      ),
      emailSignoff(brand.name),
    ],
    footerReasonHtml: `You're receiving this because a reset was requested for your ${store} POS account.`,
  });

  return { subject: `Reset your ${brand.name} POS access`, html };
}
