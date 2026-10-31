import "server-only";

import { and, eq } from "drizzle-orm";
import {
  composeEmail,
  emailButton,
  emailDetails,
  emailLinkFallback,
  emailPanel,
  emailParagraph,
  escapeHtml,
  safeEmailUrl,
} from "./shell";
import { platformEmailBrand } from "./platform-brand";
import { PLATFORM_EMAIL_DOMAIN } from "./sender";
import { sendEmail, type SendEmailResult } from "./send";
import { withService } from "@/lib/db/client";
import { admins, storeBillingSettings, stores } from "@/drizzle/schema";
import { logError, logInfo } from "@/lib/observability/logger";
import {
  acknowledgementEmail,
  blockLiftedEmail,
  blockNoticeEmail,
  outcomeEmail,
  storeMinkRepliedEmail,
  storeSuspendedEmail,
  type BlockNoticeFacts,
  type ComplainantEmailText,
  type LiftFacts,
  type NoticeEmailText,
  type ReplyFacts,
  type SuspensionFacts,
} from "@/lib/moderation/copy";
import type { ComplaintKind, ComplaintOutcome } from "@/lib/moderation/kinds";

// ---------------------------------------------------------------------------
// The takedown emails (takedown design 7.6).
//
// Every word is lib/moderation/copy.ts's: this module only escapes those
// words, links the button and sends. Two rules decide where a message is
// logged, and they are the reason this module exists rather than a few
// inline sendEmail calls (design F9):
//
//  1. A STORE NOTICE goes to EVERY owner of the store (admins with role
//     superadmin), or to its invoice contact when no owner has an email, and
//     is logged under that store: it is the store's own notice.
//  2. AN EMAIL TO A COMPLAINANT is platform mail, sent with storeId null and
//     the sensitive `complaint_reply` mailer, never under the store it is
//     about: store staff read their store's email log, and a complaint about
//     a store must never appear there.
//
// From "StoreMink <support@...>", so a reply reaches the support mailbox.
// Sending is best-effort: sendEmail never throws, and neither does anything
// here.
// ---------------------------------------------------------------------------

/** The sender of every takedown email. */
export const TAKEDOWN_FROM = `StoreMink <support@${PLATFORM_EMAIL_DOMAIN}>`;

const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "storemink.com")
  .trim()
  .toLowerCase();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A notice's page on the store's dashboard
 * (`https://{slug}.{root}/dashboard/settings/notices/{id}`), or null when the
 * slug or the block id is not one: a link built from anything else is a link
 * we would rather not send.
 */
export function noticeUrl(slug: string, blockId: string): string | null {
  const s = slug.trim().toLowerCase();
  const id = blockId.trim().toLowerCase();
  if (!SLUG_RE.test(s) || !UUID_RE.test(id)) return null;
  return safeEmailUrl(
    `https://${s}.${ROOT_DOMAIN}/dashboard/settings/notices/${id}`,
  );
}

/** A built email: what sendEmail needs besides the addresses. */
export interface TakedownEmail {
  subject: string;
  html: string;
}

/** Where a store notice's button goes: the store's slug and the block. */
export interface NoticeLink {
  slug: string;
  blockId: string;
}

function textParagraphs(texts: readonly string[]): string[] {
  return texts
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => emailParagraph(escapeHtml(text)));
}

/** A store notice (copy.ts's words) as HTML, with its button when it has one. */
function storeNoticeHtml(
  text: NoticeEmailText,
  link: NoticeLink | null,
): string {
  const url =
    text.buttonLabel && link ? noticeUrl(link.slug, link.blockId) : null;
  return composeEmail({
    brand: platformEmailBrand(),
    heading: text.heading,
    preheader: text.preheader,
    blocks: [
      emailDetails(
        text.details.map((row) => ({
          label: row.label,
          valueHtml: escapeHtml(row.value),
        })),
      ),
      ...textParagraphs(text.paragraphs),
      url && text.buttonLabel ? emailButton(url, text.buttonLabel) : "",
      url ? emailLinkFallback(url) : "",
      ...textParagraphs(text.afterButton),
    ],
    footerReasonHtml: escapeHtml(text.footer),
  });
}

function storeNotice(
  text: NoticeEmailText,
  link: NoticeLink | null,
): TakedownEmail {
  return { subject: text.subject, html: storeNoticeHtml(text, link) };
}

/** The block notice (mailer `takedown_notice`). */
export function buildBlockNoticeEmail(
  facts: BlockNoticeFacts,
  link: NoticeLink,
): TakedownEmail {
  return storeNotice(blockNoticeEmail(facts), link);
}

/** The suspension notice: no button, the store's dashboard is shut (A9). */
export function buildStoreSuspendedEmail(
  facts: SuspensionFacts,
): TakedownEmail {
  return storeNotice(storeSuspendedEmail(facts), null);
}

/** The block-lifted email, for an item or a whole store. */
export function buildBlockLiftedEmail(
  facts: LiftFacts,
  link: NoticeLink,
): TakedownEmail {
  return storeNotice(blockLiftedEmail(facts), link);
}

/** StoreMink's reply; a suspended store gets no button (it replies by email). */
export function buildStoreMinkRepliedEmail(
  facts: ReplyFacts,
  link: NoticeLink,
): TakedownEmail {
  return storeNotice(storeMinkRepliedEmail(facts), link);
}

/** The complaint as recorded, quoted back to the person who made it. */
export interface RecordedComplaint {
  summary: string;
  /** The addresses they reported, as recorded. Shown as text, never linked. */
  addresses: readonly string[];
}

function recordedHtml(recorded: RecordedComplaint): string {
  const lines = [
    recorded.summary.trim(),
    ...recorded.addresses.map((a) => a.trim()).filter(Boolean),
  ].filter(Boolean);
  if (lines.length === 0) return "";
  return emailPanel(
    lines
      .map((line) => escapeHtml(line).replace(/\n/g, "<br />"))
      .join("<br /><br />"),
  );
}

function complainantHtml(
  text: ComplainantEmailText,
  recorded: RecordedComplaint | null,
): string {
  const recordedBlock = recorded ? recordedHtml(recorded) : "";
  return composeEmail({
    brand: platformEmailBrand(),
    heading: text.subject,
    preheader: text.paragraphs[0],
    blocks: [
      ...textParagraphs([text.greeting]),
      ...textParagraphs(text.paragraphs),
      recordedBlock && text.recordedLead
        ? emailParagraph(escapeHtml(text.recordedLead))
        : "",
      recordedBlock,
      ...textParagraphs(text.afterRecorded),
      emailParagraph(
        text.signoff.map((line) => escapeHtml(line)).join("<br />"),
      ),
    ],
  });
}

/** The acknowledgement to a complainant (mailer `complaint_reply`). */
export function buildAcknowledgementEmail(facts: {
  name: string | null | undefined;
  /** The time it reached StoreMink, already in India time. */
  receivedAt: string;
  reference: string;
  kind: ComplaintKind;
  recorded: RecordedComplaint;
}): TakedownEmail {
  const text = acknowledgementEmail(facts);
  return { subject: text.subject, html: complainantHtml(text, facts.recorded) };
}

/** The decision to a complainant (mailer `complaint_reply`). */
export function buildOutcomeEmail(facts: {
  name: string | null | undefined;
  reference: string;
  outcome: ComplaintOutcome;
  note: string | null | undefined;
}): TakedownEmail {
  const text = outcomeEmail(facts);
  return { subject: text.subject, html: complainantHtml(text, null) };
}

// ── Recipients ───────────────────────────────────────────────────────────────

/** Who a store notice goes to, and the store it names. */
export interface StoreOwnerRecipients {
  /** Every owner's email, once each; the invoice contact when none. */
  emails: string[];
  storeName: string;
  slug: string;
  /** `stores.status`: a suspended store's dashboard is shut. */
  storeStatus: string | null;
}

/** Each address once, ignoring case and spaces, in the order first seen. */
export function uniqueEmails(
  values: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const email = (value ?? "").trim();
    if (!email || !email.includes("@")) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/**
 * Every owner of a store (admins with role superadmin and an email), once
 * each, else the store's invoice contact email, the fallback
 * `resolveBillingEmail` uses. Unlike that function it reads EVERY owner: a
 * takedown notice must reach whoever runs the store, not whichever owner
 * a LIMIT 1 happened to return. Null when the store cannot be read or does
 * not exist; an empty `emails` when nobody can be written to.
 */
export async function storeOwnerEmails(
  storeId: string,
): Promise<StoreOwnerRecipients | null> {
  try {
    return await withService(async (db) => {
      // One after another: the reads share this scope's one client.
      const storeRows = await db
        .select({ name: stores.name, slug: stores.slug, status: stores.status })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      const store = storeRows[0];
      if (!store) return null;
      const ownerRows = await db
        .select({ email: admins.email })
        .from(admins)
        .where(and(eq(admins.storeId, storeId), eq(admins.role, "superadmin")))
        .orderBy(admins.createdAt);
      let emails = uniqueEmails(ownerRows.map((row) => row.email));
      if (emails.length === 0) {
        const billingRows = await db
          .select({ email: storeBillingSettings.contactEmail })
          .from(storeBillingSettings)
          .where(eq(storeBillingSettings.storeId, storeId))
          .limit(1);
        emails = uniqueEmails([billingRows[0]?.email]);
      }
      return {
        emails,
        storeName: store.name || "Your store",
        slug: store.slug || "",
        storeStatus: store.status ?? null,
      };
    });
  } catch (error) {
    logError("takedown.store_owner_emails", error, { storeId });
    return null;
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** What sending one store notice to every owner did. */
export interface StoreNoticeSendResult {
  /** Addresses it was sent to (every owner, or the invoice contact). */
  recipients: number;
  /** Sends the provider accepted. */
  sent: number;
  /** Sends that failed or were skipped (no API key, suppressed address). */
  failed: number;
}

/**
 * Send one store notice to every address in `to`, logged under the store
 * (mailer `takedown_notice`). Never throws.
 */
export async function sendStoreNotice(input: {
  storeId: string;
  to: readonly string[];
  email: TakedownEmail;
}): Promise<StoreNoticeSendResult> {
  const recipients = uniqueEmails(input.to);
  let sent = 0;
  let failed = 0;
  for (const to of recipients) {
    const result = await sendEmail({
      storeId: input.storeId,
      to,
      from: TAKEDOWN_FROM,
      subject: input.email.subject,
      html: input.email.html,
      mailer: "takedown_notice",
    });
    if (result.sent) sent += 1;
    else failed += 1;
  }
  return { recipients: recipients.length, sent, failed };
}

/**
 * Send an email to a complainant. ALWAYS platform mail: storeId null and the
 * sensitive `complaint_reply` mailer, whatever store the complaint is about
 * (design F9). The complaint's store is taken only to name it in the
 * operators' log line. Never throws.
 */
export async function sendComplainantEmail(input: {
  to: string;
  email: TakedownEmail;
  complaint: { id: string; storeId?: string | null };
}): Promise<SendEmailResult> {
  const result = await sendEmail({
    storeId: null,
    to: input.to,
    from: TAKEDOWN_FROM,
    subject: input.email.subject,
    html: input.email.html,
    mailer: "complaint_reply",
  });
  logInfo("takedown.complainant_email", {
    complaintId: input.complaint.id,
    aboutStoreId: input.complaint.storeId ?? null,
    sent: result.sent,
    skipped: result.skipped === true,
  });
  return result;
}
