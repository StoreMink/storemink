import "server-only";

import { recordEvent, type EmitEventInput } from "@/lib/notifications/record";
import {
  buildAcknowledgementEmail,
  buildBlockLiftedEmail,
  buildBlockNoticeEmail,
  buildOutcomeEmail,
  buildStoreMinkRepliedEmail,
  buildStoreSuspendedEmail,
  sendComplainantEmail,
  sendStoreNotice,
  storeOwnerEmails,
  type RecordedComplaint,
  type StoreOwnerRecipients,
  type TakedownEmail,
} from "@/lib/email/takedown-emails";
import type { SendEmailResult } from "@/lib/email/send";
import { istShortDate, istTime } from "@/lib/billing/tax-copy";
import {
  complaintRef,
  isUrgentComplaintKind,
  type BlockKind,
  type BlockReason,
  type ComplaintKind,
  type ComplaintOutcome,
} from "./kinds";
import type { AlertPhase, DeadlineStage } from "./deadlines";

// ---------------------------------------------------------------------------
// Who is told about a takedown, and how (takedown design 7.5, 7.6).
//
// Two audiences, two rules:
//
//  • THE STORE (a block it is told about, its lift, StoreMink's reply): the
//    bell event with the store's id (in-app only), and the notice email to
//    every owner through lib/email/takedown-emails.ts, logged under the store.
//    The caller decides whether the store is told (`tell_store`) and claims
//    the notice (`notice_claimed_at`) before calling; this module only tells.
//  • THE OPERATORS (an urgent complaint, a deadline, a store's reply): the
//    three `platform.*` events, ALWAYS with storeId null, through the one
//    wrapper `notifyOperators`. The notification worker logs an event's
//    emails under its store, so an operator alert carrying the store's id
//    would put a complaint about that store into its own email log and bell
//    (design F9). The store is named in the payload, for operators only.
//
// Events are recorded with `recordEvent` (awaited), not `emitEvent`: the
// every-minute follow-up and the deadline sweep run in a cron, where there is
// no request for after() to defer onto, and every caller here also awaits an
// email. recordEvent never throws.
// ---------------------------------------------------------------------------

/** The operator events of design 7.5. */
export type ModerationOperatorEvent =
  | "platform.complaint_urgent"
  | "platform.complaint_due"
  | "platform.takedown_reply";

/** An operator event as its emitter describes it: never with a store. */
export type OperatorEventInput = Omit<
  EmitEventInput,
  | "type"
  | "storeId"
  | "customerId"
  | "locationId"
  | "restrictToAdminIds"
  | "email"
  | "deduplicate"
> & { type: ModerationOperatorEvent };

/**
 * Record a moderation event for StoreMink's operators. The one way the three
 * `platform.*` events are emitted, and it sets storeId null whatever the
 * input carries, so no complaint or reply can reach a store's log or bell.
 */
export function notifyOperators(
  input: OperatorEventInput,
): Promise<string | null> {
  return recordEvent({ ...input, storeId: null });
}

/** What the operator alerts need of a complaint. */
export interface ComplaintFacts {
  id: string;
  refNo: number;
  kind: ComplaintKind;
  /** The store it is about, if any: named for operators, never the event's store. */
  storeId?: string | null;
  storeName?: string | null;
}

function complaintSubject(complaint: ComplaintFacts) {
  return {
    type: "complaint",
    id: complaint.id,
    label: complaintRef(complaint.refNo),
  };
}

function iso(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * An urgent complaint was logged (a court, government or information order,
 * or an intimate-image or impersonation complaint): bell and email to every
 * operator, with its first deadline. Nothing for a complaint that is not
 * urgent.
 */
export async function notifyComplaintUrgent(
  complaint: ComplaintFacts,
  actionDueAt: Date | string,
): Promise<string | null> {
  if (!isUrgentComplaintKind(complaint.kind)) return null;
  return notifyOperators({
    type: "platform.complaint_urgent",
    actor: { type: "system", label: "StoreMink" },
    subject: complaintSubject(complaint),
    payload: {
      kind: complaint.kind,
      stage: "act",
      dueAt: iso(actionDueAt),
      storeName: complaint.storeName ?? null,
    },
  });
}

/** A deadline alert, as `dueAlert` (deadlines.ts) returns it. */
export interface DueAlertFacts {
  stage: DeadlineStage;
  phase: AlertPhase;
  dueAt: Date;
}

/**
 * A complaint deadline is close or has passed: bell and email to every
 * operator. The caller (the deadline sweep) records the alert's key on the
 * complaint so it rings once.
 */
export async function notifyComplaintDue(
  complaint: ComplaintFacts,
  alert: DueAlertFacts,
  now: Date,
): Promise<string | null> {
  const gapMs =
    alert.phase === "overdue"
      ? now.getTime() - alert.dueAt.getTime()
      : alert.dueAt.getTime() - now.getTime();
  return notifyOperators({
    type: "platform.complaint_due",
    actor: { type: "system", label: "StoreMink" },
    subject: complaintSubject(complaint),
    payload: {
      kind: complaint.kind,
      stage: alert.stage,
      phase: alert.phase,
      minutes: Math.max(0, Math.round(gapMs / 60_000)),
      dueAt: alert.dueAt.toISOString(),
      storeName: complaint.storeName ?? null,
    },
  });
}

/** A store replied about something StoreMink blocked: bell and email to operators. */
export async function notifyTakedownReply(reply: {
  blockId: string;
  itemLabel: string;
  /** The store the block is on, by name: the event itself carries no store. */
  storeName: string;
  /** True when the store ticked "Please review it again" (or "show it again"). */
  askedForReview: boolean;
}): Promise<string | null> {
  return notifyOperators({
    type: "platform.takedown_reply",
    actor: { type: "admin", label: reply.storeName },
    subject: {
      type: "content_block",
      id: reply.blockId,
      label: reply.itemLabel,
    },
    payload: {
      storeName: reply.storeName,
      askedForReview: reply.askedForReview,
    },
  });
}

// ── The store ────────────────────────────────────────────────────────────────

/** What telling a store did; the caller records it on the block. */
export interface StoreTellResult {
  /** The bell event's id; null when not asked for or not recorded. */
  bellEventId: string | null;
  /** False when the store could not be read (nothing was emailed). */
  storeFound: boolean;
  /** Owner addresses the notice went to. */
  recipients: number;
  sent: number;
  failed: number;
}

/** Which halves to send: a retry of a failed email must not ring the bell twice. */
export interface TellOptions {
  bell?: boolean;
  email?: boolean;
}

/** What every store notice names. */
export interface StoreBlockRef {
  blockId: string;
  storeId: string;
  kind: BlockKind;
  contentType?: string | null;
  /** The item's name; for a whole store, empty (the store's name is used). */
  itemLabel: string;
}

type StoreEvent =
  | "store.content_blocked"
  | "store.content_block_lifted"
  | "store.content_block_reply";

function storeBell(
  type: StoreEvent,
  block: StoreBlockRef,
  itemLabel: string,
): Promise<string | null> {
  return recordEvent({
    type,
    storeId: block.storeId,
    actor: { type: "operator", label: "StoreMink" },
    subject: { type: "content_block", id: block.blockId, label: itemLabel },
    payload: { kind: block.kind, contentType: block.contentType ?? null },
  });
}

async function tellStore(
  type: StoreEvent,
  block: StoreBlockRef,
  build: (owners: StoreOwnerRecipients, itemLabel: string) => TakedownEmail,
  options: TellOptions,
): Promise<StoreTellResult> {
  const owners = await storeOwnerEmails(block.storeId);
  const itemLabel =
    block.kind === "store"
      ? block.itemLabel.trim() || owners?.storeName || ""
      : block.itemLabel;
  const bellEventId =
    options.bell === false ? null : await storeBell(type, block, itemLabel);
  if (!owners || options.email === false) {
    return {
      bellEventId,
      storeFound: owners !== null,
      recipients: 0,
      sent: 0,
      failed: 0,
    };
  }
  const result = await sendStoreNotice({
    storeId: block.storeId,
    to: owners.emails,
    email: build(owners, itemLabel),
  });
  return { bellEventId, storeFound: true, ...result };
}

/**
 * Tell the store about a block it is told about: the bell, and the block
 * notice (or, for a whole store, the suspension notice) to every owner.
 */
export function tellStoreOfBlock(
  block: StoreBlockRef & {
    reasonKind: BlockReason;
    complaintId: string | null;
    /** The complaint's `ref_no`, or null when the block names none. */
    complaintRefNo: number | null;
    storeMessage: string;
    blockedAt: Date | string;
  },
  options: TellOptions = {},
): Promise<StoreTellResult> {
  const reference =
    block.complaintRefNo === null ? null : complaintRef(block.complaintRefNo);
  const on = istShortDate(block.blockedAt);
  return tellStore(
    "store.content_blocked",
    block,
    (owners, itemLabel) =>
      block.kind === "store"
        ? buildStoreSuspendedEmail({
            storeName: owners.storeName,
            suspendedOn: on,
            reasonKind: block.reasonKind,
            reference,
            storeMessage: block.storeMessage,
            complaintId: block.complaintId,
          })
        : buildBlockNoticeEmail(
            {
              storeName: owners.storeName,
              kind: block.kind,
              contentType: block.contentType,
              itemLabel,
              blockedOn: on,
              reasonKind: block.reasonKind,
              reference,
              storeMessage: block.storeMessage,
              complaintId: block.complaintId,
            },
            { slug: owners.slug, blockId: block.blockId },
          ),
    options,
  );
}

/** Tell the store a block it was told about was lifted. */
export function tellStoreOfLift(
  block: StoreBlockRef & { liftNote?: string | null },
  options: TellOptions = {},
): Promise<StoreTellResult> {
  return tellStore(
    "store.content_block_lifted",
    block,
    (owners, itemLabel) =>
      buildBlockLiftedEmail(
        {
          storeName: owners.storeName,
          kind: block.kind,
          contentType: block.contentType,
          itemLabel,
          liftNote: block.liftNote,
        },
        { slug: owners.slug, blockId: block.blockId },
      ),
    options,
  );
}

/**
 * Tell the store StoreMink replied about a block. A suspended store's email
 * has no button: its dashboard is shut, so it replies by email.
 */
export function tellStoreOfReply(
  block: StoreBlockRef & { reply: string },
  options: TellOptions = {},
): Promise<StoreTellResult> {
  return tellStore(
    "store.content_block_reply",
    block,
    (owners, itemLabel) =>
      buildStoreMinkRepliedEmail(
        {
          storeName: owners.storeName,
          kind: block.kind,
          contentType: block.contentType,
          itemLabel,
          reply: block.reply,
          storeSuspended:
            owners.storeStatus !== null && owners.storeStatus !== "active",
        },
        { slug: owners.slug, blockId: block.blockId },
      ),
    options,
  );
}

// ── The complainant ──────────────────────────────────────────────────────────

/** "30 Oct 2026, 14:05 IST": when a complaint reached StoreMink. */
export function indiaDateTime(value: Date | string): string {
  return `${istShortDate(value)}, ${istTime(value)} IST`;
}

/**
 * Acknowledge a complaint to the person who made it (platform mail,
 * storeId null; lib/email/takedown-emails.ts).
 */
export function acknowledgeComplainant(input: {
  to: string;
  name: string | null | undefined;
  complaint: ComplaintFacts & { receivedAt: Date | string };
  recorded: RecordedComplaint;
}): Promise<SendEmailResult> {
  return sendComplainantEmail({
    to: input.to,
    complaint: input.complaint,
    email: buildAcknowledgementEmail({
      name: input.name,
      receivedAt: indiaDateTime(input.complaint.receivedAt),
      reference: complaintRef(input.complaint.refNo),
      kind: input.complaint.kind,
      recorded: input.recorded,
    }),
  });
}

/** Tell a complainant what was decided (platform mail, storeId null). */
export function tellComplainantOutcome(input: {
  to: string;
  name: string | null | undefined;
  complaint: ComplaintFacts;
  outcome: ComplaintOutcome;
  note: string | null | undefined;
}): Promise<SendEmailResult> {
  return sendComplainantEmail({
    to: input.to,
    complaint: input.complaint,
    email: buildOutcomeEmail({
      name: input.name,
      reference: complaintRef(input.complaint.refNo),
      outcome: input.outcome,
      note: input.note,
    }),
  });
}
