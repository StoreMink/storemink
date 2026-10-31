"use server";

import { refresh } from "next/cache";
import { getPlatformViewer } from "@/app/actions/platform";
import { loggableError } from "@/lib/db/errors";
import { logError, logWarn } from "@/lib/observability/logger";
import { IS_PRODUCTION_PLATFORM } from "@/lib/store/host";
import {
  ARCHIVE_ERRORS,
  extendArchive,
  recordArchiveView,
  releaseArchiveHold,
  type ArchiveKeepChange,
} from "@/lib/moderation/archive";
import {
  BLOCK_ERRORS,
  addStoreEmailedReply,
  blockItem,
  liftBlock,
  markRemovedByHand,
  replyToStore,
  retryStorage,
  tellStoreNow,
  type BlockInput,
} from "@/lib/moderation/block";
import {
  COMPLAINT_ERRORS,
  acknowledgeComplaint,
  logComplaint,
  markActioned,
  reopenComplaint,
  resolveComplaint,
  updateComplaint,
  type ComplaintInput,
  type ComplaintPatch,
  type ComplaintRow,
  type ModerationOperator,
} from "@/lib/moderation/complaints";
import {
  TARGET_ERRORS,
  getArchiveForViewing,
  resolveTarget,
  type TargetInput,
} from "@/lib/moderation/console-read";
import { deadlineLabel, type DeadlineStage } from "@/lib/moderation/deadlines";
import { runModerationFollowUps } from "@/lib/moderation/follow-ups";
import {
  HOLD_ERRORS,
  releaseStoreHold,
  setStoreHold,
  type SetHoldInput,
} from "@/lib/moderation/holds";
import {
  complaintRef,
  type BlockKind,
  type BlockReason,
  type ComplaintKind,
  type ComplaintOutcome,
} from "@/lib/moderation/kinds";
import {
  acknowledgeComplainant,
  notifyComplaintUrgent,
  tellComplainantOutcome,
  type ComplaintFacts,
} from "@/lib/moderation/notify";
import { istShortDate } from "@/lib/billing/tax-copy";

// ---------------------------------------------------------------------------
// The operator console's takedown actions (takedown design 3.10, 5.5, 6.2 to
// 6.7; plan stage T15).
//
// ★ EVERY EXPORT HERE IS A PUBLIC POST ENDPOINT, and these hide a merchant's
// products, suspend whole stores and open archived evidence. So each export
// re-derives the operator from the session (`getPlatformViewer()`) and checks
// the role of design 3.10 ITSELF, before any lib call; the console page's
// gate and a hidden button are not the boundary. The browser only names what
// to act on (ids, the operator's words); never who is asking, nor their role.
//
//   member and superadmin: log, change, acknowledge, act on, resolve and
//     reopen a complaint; find and block an item (a store's own request
//     included); reply to a store; add a store's emailed reply; Retry now;
//     mark a file removed by hand.
//   superadmin only: keep a block from the store (D5), tell the store later,
//     suspend a whole store, lift a block (D19, D22), open an archived copy
//     (D2), keep a copy longer or release its hold, put a store on hold or
//     release it.
//
// The lib functions re-check the same rules, so a mistake here still fails
// closed; the tests mock them to prove the action's own gate.
//
// ★ ONLY ASYNC FUNCTIONS ARE EXPORTED. A `type` export from a "use server"
// file fails `next build` while tsc passes (CODEBASE.md, invoice-types.ts),
// so the console reads the shapes as `Parameters<typeof x>` and
// `Awaited<ReturnType<typeof x>>`, and the input types from lib/moderation
// with `import type`.
//
// Every answer is `{ ok: true, message, ... }` (`message` is the toast of
// design 6) or `{ ok: false, error }` with the sentence to show; a complaint
// form error may name its `field`. No export throws.
//
// ★ OUTSIDE PRODUCTION (dev, staging and local run no scheduler) each action
// that changed something runs the every-minute follow-up inline once its own
// work has committed (design 8.1), so a test there sees the archive copied,
// the notice sent and, 35 seconds after a block, the file replaced, at the
// next action. It opens its own scopes and has its own 40-second budget; a
// failure in it never fails the action.
// ---------------------------------------------------------------------------

/** The answer to an operator who is not one (design 6.5, for every action). */
const NOT_OPERATOR = BLOCK_ERRORS.notOperator;

/** The toasts of design 6, and the few lines the design left unwritten. */
const TOAST = {
  logged: (ref: string) => `Complaint ${ref} logged.`,
  acknowledgementSent: "Acknowledgement sent.",
  markedAcknowledged: "Marked as acknowledged.",
  kindChanged: "Kind changed. Deadlines updated.",
  kindChangedPassed: (what: string) =>
    `Kind changed. The deadline to ${what} has already passed: act now.`,
  /** Added: a change other than the kind (design 6.4 has only Change kind). */
  updated: "Complaint updated.",
  /** Added: a patch that changed nothing. */
  unchanged: "Nothing was changed.",
  recorded: "Recorded.",
  resolved: "Complaint resolved.",
  reopened: "Complaint reopened.",
  blocked: "Blocked. It is hidden from the store now.",
  storeSuspended: "Store suspended. StoreMink is copying its files.",
  lifted: "Block lifted.",
  told: "The store has been told.",
  markedRemoved: "Marked as removed.",
  replySent: "Reply sent.",
  replyAdded: "Reply added.",
  /** Added: Retry now (design 6.6 gives the button, not its toast). */
  retrying: "StoreMink is trying again now.",
  keptUntil: (date: string) => `Kept until ${date}.`,
  keptUntilReleased: "Kept until released.",
  copyHoldReleased: (date: string) =>
    `Hold released. The copy will be deleted after ${date}.`,
  storeOnHold: "Store on hold.",
  storeHoldReleased: "Hold released.",
} as const;

/** Added: a resolution whose outcome email did not go (design 6.4 is silent). */
const OUTCOME_EMAIL_FAILED = "The outcome email could not be sent.";

type Refusal = { ok: false; error: string; field?: string };

function refuse(error: string, field?: string): Refusal {
  return field ? { ok: false, error, field } : { ok: false, error };
}

/** A value the browser sent, as a string (anything else is empty). */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** An optional string: absent, null and non-strings are null. */
function optional(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Strings only, from an array; a single string is kept as the form's text. */
function strings(value: unknown): string[] | string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

const ZONELESS_LOCAL_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;

/**
 * The time a complaint reached StoreMink. The form asks for it in India time
 * (design 6.3), and a `datetime-local` value carries no zone, so a zoneless
 * "YYYY-MM-DDTHH:mm" is read as India time; anything with a zone, or a
 * Date, is taken as it is.
 */
function receivedAtFrom(value: unknown): Date | string | null {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return ZONELESS_LOCAL_TIME.test(text) ? `${text}+05:30` : text;
}

/**
 * Who is asking, from the session; null for anyone who is not a StoreMink
 * operator. Every export calls this for itself.
 */
async function currentOperator(): Promise<ModerationOperator | null> {
  const viewer = await getPlatformViewer();
  const email = viewer?.email?.trim() ?? "";
  if (!viewer || !email) return null;
  return {
    email,
    role: viewer.role === "superadmin" ? "superadmin" : "member",
  };
}

/**
 * After an action's own work has committed, when it changed something:
 * outside production the every-minute follow-up inline (design 8.1), then the
 * console page re-rendered in the same response. A refused action changed
 * nothing, so its operator is answered at once rather than after a run.
 */
async function afterWork(changed: boolean): Promise<void> {
  if (!changed) return;
  if (!IS_PRODUCTION_PLATFORM) {
    await runModerationFollowUps().catch(() => null);
  }
  refresh();
}

function failed(action: string, err: unknown, error: string): Refusal {
  logError(`moderation: ${action} action failed`, loggableError(err));
  return refuse(error);
}

/** What the operator alerts and emails need of a complaint row. */
function complaintFacts(row: ComplaintRow): ComplaintFacts {
  return {
    id: row.id,
    refNo: row.refNo,
    kind: row.kind as ComplaintKind,
    storeId: row.storeId,
    storeName: row.storeLabel || null,
  };
}

/** "remove or block", "provide", "answer", "acknowledge", "resolve". */
function deadlineVerb(kind: ComplaintKind, stage: DeadlineStage): string {
  const label = deadlineLabel(kind, stage).replace(/ by$/, "");
  return label.charAt(0).toLowerCase() + label.slice(1);
}

// ── Complaints (design 6.3, 6.4; every operator) ─────────────────────────────

/**
 * Log a complaint (design 6.3). `receivedAt` is an ISO time, or the form's
 * zoneless India time. An urgent kind (an order, or an intimate image or
 * impersonation) alerts every operator once it is stored (design 3.9).
 */
export async function logComplaintAction(input: ComplaintInput) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    const result = await logComplaint(
      {
        receivedAt: receivedAtFrom(input?.receivedAt),
        channel: str(input?.channel),
        kind: str(input?.kind),
        complainantName: optional(input?.complainantName),
        complainantContact: optional(input?.complainantContact),
        actingFor: optional(input?.actingFor),
        authorityRef: optional(input?.authorityRef),
        storeId: optional(input?.storeId) || null,
        urls: strings(input?.urls),
        summary: str(input?.summary),
      },
      operator,
    );
    if (result.ok && result.urgent) {
      await notifyComplaintUrgent(
        complaintFacts(result.complaint),
        result.complaint.actionDueAt,
      ).catch(() => null);
      // ★ The structured line design 3.9 promises the moment an urgent
      //   complaint is logged: the alert "Takedown: a complaint needs action"
      //   pages on any WARNING starting "moderation: complaint ", so it no
      //   longer waits for the "soon" stage. No store id, like the deadline
      //   line (lib/moderation/follow-ups.ts), and it is written even when
      //   the bell above failed.
      const due = new Date(result.complaint.actionDueAt);
      logWarn("moderation: complaint urgent", {
        ref: complaintRef(result.complaint.refNo),
        kind: result.complaint.kind,
        stage: "act",
        phase: "logged",
        dueAt: Number.isNaN(due.getTime()) ? null : due.toISOString(),
      });
    }
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error, result.field);
    const ref = complaintRef(result.complaint.refNo);
    return {
      ok: true as const,
      complaintId: result.complaint.id,
      ref,
      urgent: result.urgent,
      message: TOAST.logged(ref),
    };
  } catch (err) {
    return failed("log complaint", err, COMPLAINT_ERRORS.logFailed);
  }
}

/**
 * Change a logged complaint (design 6.4 "Change kind"; 5.4): the kind at any
 * time (deadlines only tighten), the received time before acknowledgement,
 * the other details while not erased. Only the keys present change.
 */
export async function updateComplaintAction(
  complaintId: string,
  patch: ComplaintPatch,
) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    const clean: ComplaintPatch = {};
    const has = (key: keyof ComplaintPatch) =>
      patch !== null && typeof patch === "object" && key in patch;
    if (has("receivedAt")) clean.receivedAt = receivedAtFrom(patch.receivedAt);
    if (has("channel")) clean.channel = str(patch.channel);
    if (has("kind")) clean.kind = str(patch.kind);
    if (has("complainantName"))
      clean.complainantName = optional(patch.complainantName);
    if (has("complainantContact"))
      clean.complainantContact = optional(patch.complainantContact);
    if (has("actingFor")) clean.actingFor = optional(patch.actingFor);
    if (has("authorityRef")) clean.authorityRef = optional(patch.authorityRef);
    if (has("storeId")) clean.storeId = optional(patch.storeId) || null;
    if (has("urls")) clean.urls = strings(patch.urls);
    if (has("summary")) clean.summary = str(patch.summary);
    const result = await updateComplaint(str(complaintId), clean, operator);
    await afterWork(result.ok && result.changed.length > 0);
    if (!result.ok) return refuse(result.error, result.field);
    const kind = result.complaint.kind as ComplaintKind;
    let message: string = TOAST.unchanged;
    if (result.changed.includes("kind")) {
      const passed = (["act", "acknowledge", "resolve"] as const).find((s) =>
        result.passed.includes(s),
      );
      message = passed
        ? TOAST.kindChangedPassed(deadlineVerb(kind, passed))
        : TOAST.kindChanged;
    } else if (result.changed.length > 0) {
      message = TOAST.updated;
    }
    return {
      ok: true as const,
      changed: result.changed,
      passed: result.passed,
      message,
    };
  } catch (err) {
    return failed("update complaint", err, COMPLAINT_ERRORS.saveFailed);
  }
}

/**
 * "Send acknowledgement" (`sendEmail: true`: the email to the complainant
 * goes first, and the complaint is marked only when it went) or "Mark as
 * acknowledged" (answered from the support mailbox).
 */
export async function acknowledgeComplaintAction(
  complaintId: string,
  options: { sendEmail?: boolean } = {},
) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    const sendEmail = options?.sendEmail === true;
    const result = await acknowledgeComplaint(
      str(complaintId),
      operator,
      sendEmail
        ? {
            deliver: async ({ complaint, to }) => {
              const sent = await acknowledgeComplainant({
                to,
                name: complaint.complainantName,
                complaint: {
                  ...complaintFacts(complaint),
                  receivedAt: complaint.receivedAt,
                },
                recorded: {
                  summary: complaint.summary,
                  addresses: complaint.urls ?? [],
                },
              });
              return { sent: sent.sent === true, error: sent.error };
            },
          }
        : {},
    );
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error, result.field);
    return {
      ok: true as const,
      emailed: result.emailed,
      message: result.emailed
        ? TOAST.acknowledgementSent
        : TOAST.markedAcknowledged,
    };
  } catch (err) {
    return failed("acknowledge complaint", err, COMPLAINT_ERRORS.saveFailed);
  }
}

/** "No removal needed" or "Information provided", with the operator's note (design 6.4). */
export async function markComplaintActionedAction(
  complaintId: string,
  note: string,
) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    const result = await markActioned(str(complaintId), str(note), operator);
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error, result.field);
    return { ok: true as const, message: TOAST.recorded };
  } catch (err) {
    return failed("mark complaint actioned", err, COMPLAINT_ERRORS.saveFailed);
  }
}

/**
 * Resolve a complaint (design 6.4): an outcome, a note (required for "Not
 * removed" and "Partly removed"), and, when `emailComplainant`, the outcome
 * emailed first. A failed email never stops the resolution; it comes back as
 * a warning.
 */
export async function resolveComplaintAction(
  complaintId: string,
  input: { outcome: string; note?: string | null; emailComplainant?: boolean },
) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    const result = await resolveComplaint(
      str(complaintId),
      {
        outcome: str(input?.outcome),
        note: optional(input?.note),
        ...(input?.emailComplainant === true
          ? {
              deliver: async ({ complaint, to, outcome, note }) => {
                const sent = await tellComplainantOutcome({
                  to,
                  name: complaint.complainantName,
                  complaint: complaintFacts(complaint),
                  outcome: outcome as ComplaintOutcome,
                  note,
                });
                return { sent: sent.sent === true, error: sent.error };
              },
            }
          : {}),
      },
      operator,
    );
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error, result.field);
    return {
      ok: true as const,
      emailed: result.emailed,
      warnings: result.emailed === false ? [OUTCOME_EMAIL_FAILED] : [],
      message: TOAST.resolved,
    };
  } catch (err) {
    return failed("resolve complaint", err, COMPLAINT_ERRORS.saveFailed);
  }
}

/** Reopen a resolved complaint, with a required note (design 6.4). */
export async function reopenComplaintAction(complaintId: string, note: string) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    const result = await reopenComplaint(str(complaintId), str(note), operator);
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error, result.field);
    return { ok: true as const, message: TOAST.reopened };
  } catch (err) {
    return failed("reopen complaint", err, COMPLAINT_ERRORS.saveFailed);
  }
}

// ── Blocking (design 6.5, 6.6) ───────────────────────────────────────────────

/**
 * "Find" on Block an item (design 6.5): an address; a store and the kind
 * "store"; a store, a kind and a search; or a store, a kind and an item id.
 * A read, so no follow-up runs.
 */
export async function resolveTargetAction(input: TargetInput) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    const raw = (input ?? {}) as Record<string, unknown>;
    let target: TargetInput;
    if (typeof raw.address === "string") {
      target = {
        address: raw.address,
        storeId: optional(raw.storeId) || null,
      };
    } else if (raw.kind === "store") {
      target = { storeId: str(raw.storeId), kind: "store" };
    } else if (typeof raw.search === "string") {
      target = {
        storeId: str(raw.storeId),
        kind: str(raw.kind) as Extract<TargetInput, { search: string }>["kind"],
        search: raw.search,
      };
    } else {
      target = {
        storeId: str(raw.storeId),
        kind: str(raw.kind) as Extract<TargetInput, { itemId: string }>["kind"],
        itemId: str(raw.itemId),
      };
    }
    return await resolveTarget(target);
  } catch (err) {
    return failed("resolve target", err, TARGET_ERRORS.readFailed);
  }
}

/**
 * Block an item, a file or a whole store (design 5.3, 6.5). Every operator
 * blocks (D1); a whole store and a block kept from the store are a
 * superadmin's (design 3.10, D5), and only on a court or government order
 * with its legal basis (checked in lib/moderation/block.ts).
 */
export async function blockItemAction(input: BlockInput) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    const kind = str(input?.kind) as BlockKind;
    // Only an explicit `false` keeps a block from the store (D5).
    const tellStore = input?.tellStore !== false;
    if (kind === "store" && operator.role !== "superadmin") {
      return refuse(BLOCK_ERRORS.storeSuperadmin);
    }
    if (!tellStore && operator.role !== "superadmin") {
      return refuse(BLOCK_ERRORS.untoldSuperadmin);
    }
    const images = strings(input?.alsoBlockImages);
    const result = await blockItem(
      {
        kind,
        storeId: optional(input?.storeId),
        itemId: optional(input?.itemId),
        fileAddress: optional(input?.fileAddress),
        reason: str(input?.reason) as BlockReason,
        legalBasis: optional(input?.legalBasis),
        complaintId: optional(input?.complaintId) || null,
        storeMessage: str(input?.storeMessage),
        tellStore,
        alsoBlockImages: Array.isArray(images) ? images : null,
      },
      operator,
    );
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error);
    return {
      ok: true as const,
      blockId: result.blockId,
      childBlockIds: result.childBlockIds,
      warnings: result.warnings,
      message: kind === "store" ? TOAST.storeSuspended : TOAST.blocked,
    };
  } catch (err) {
    return failed("block", err, BLOCK_ERRORS.failed);
  }
}

/**
 * Lift a block (design 3.5, 6.6). Superadmin only (D19), a store-requested
 * block included (D22). `notifyStore` and `alsoChildren` default to true,
 * as the dialog's ticks do.
 */
export async function liftBlockAction(
  blockId: string,
  input: { note: string; notifyStore?: boolean; alsoChildren?: boolean },
) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    if (operator.role !== "superadmin") {
      return refuse(BLOCK_ERRORS.liftSuperadmin);
    }
    const result = await liftBlock(
      {
        blockId: str(blockId),
        note: str(input?.note),
        notifyStore: input?.notifyStore !== false,
        alsoChildren: input?.alsoChildren !== false,
      },
      operator,
    );
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error);
    return {
      ok: true as const,
      liftedIds: result.liftedIds,
      warnings: result.warnings,
      message: TOAST.lifted,
    };
  } catch (err) {
    return failed("lift", err, BLOCK_ERRORS.liftFailed);
  }
}

/** "Tell the store now" for a block kept from it (design 3.4, 6.6). Superadmin only. */
export async function tellStoreNowAction(blockId: string) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    if (operator.role !== "superadmin") {
      return refuse(BLOCK_ERRORS.tellSuperadmin);
    }
    const result = await tellStoreNow(str(blockId), operator);
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error);
    return {
      ok: true as const,
      notified: result.notified,
      message: TOAST.told,
    };
  } catch (err) {
    return failed("tell store", err, BLOCK_ERRORS.saveFailed);
  }
}

/** StoreMink's reply to the store about a block (design 6.6). Every operator. */
export async function replyToStoreAction(blockId: string, body: string) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    const result = await replyToStore(
      { blockId: str(blockId), body: str(body) },
      operator,
    );
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error);
    return {
      ok: true as const,
      messageId: result.messageId,
      notified: result.notified,
      message: TOAST.replySent,
    };
  } catch (err) {
    return failed("reply to store", err, BLOCK_ERRORS.saveFailed);
  }
}

/** "Add the store's emailed reply" (design 3.4, 6.6). Every operator. */
export async function addStoreEmailedReplyAction(
  blockId: string,
  fromAddress: string,
  body: string,
) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    const result = await addStoreEmailedReply(
      { blockId: str(blockId), fromAddress: str(fromAddress), body: str(body) },
      operator,
    );
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error);
    return {
      ok: true as const,
      messageId: result.messageId,
      message: TOAST.replyAdded,
    };
  } catch (err) {
    return failed("add emailed reply", err, BLOCK_ERRORS.saveFailed);
  }
}

/** "Mark as removed" for a file removed by hand (design 6.6). Every operator. */
export async function markRemovedByHandAction(blockId: string, note: string) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    const result = await markRemovedByHand(str(blockId), str(note), operator);
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error);
    return { ok: true as const, message: TOAST.markedRemoved };
  } catch (err) {
    return failed("mark removed", err, BLOCK_ERRORS.saveFailed);
  }
}

/**
 * "Retry now" (design 6.6): a failed copy or replacement back to pending.
 * Every operator. Outside production the follow-up then runs inline, even
 * when nothing was waiting, so a replacement held for its 35 seconds goes
 * at this press.
 */
export async function retryStorageAction(blockId: string) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    const result = await retryStorage(str(blockId), operator);
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error);
    return {
      ok: true as const,
      storage: result.storage,
      files: result.files,
      message: TOAST.retrying,
    };
  } catch (err) {
    return failed("retry storage", err, BLOCK_ERRORS.saveFailed);
  }
}

// ── The archived copy (design 3.6, 6.6; superadmin only) ─────────────────────

/**
 * "Open the copy" (design 6.6, D2): records why first (`archive_viewed`),
 * then reads the snapshot and file list against that receipt. The answer's
 * `receipt` is what the archive routes ask for, for ten minutes:
 *   /api/platform/takedowns/<blockId>/files/<n>?receipt=<receipt>[&download=1]
 *   /api/platform/takedowns/<blockId>/record?receipt=<receipt>
 * A read, so no follow-up runs.
 */
export async function openArchiveAction(blockId: string, reason: string) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    if (operator.role !== "superadmin") {
      return refuse(ARCHIVE_ERRORS.viewSuperadminOnly);
    }
    const id = str(blockId);
    const recorded = await recordArchiveView(id, str(reason), operator, {
      what: "copy",
    });
    if (!recorded.ok) return refuse(recorded.error);
    const read = await getArchiveForViewing(
      id,
      { eventId: recorded.eventId },
      operator,
    );
    if (!read.ok) return refuse(read.error);
    return {
      ok: true as const,
      receipt: recorded.eventId,
      archive: read.archive,
    };
  } catch (err) {
    return failed("open archive", err, ARCHIVE_ERRORS.saveFailed);
  }
}

/**
 * "Keep longer" (design 6.6): `{ until: "YYYY-MM-DD" }` (the end of that day
 * in India time) or `{ hold: true }` (until released), with who asked.
 */
export async function extendArchiveAction(
  blockId: string,
  change: ArchiveKeepChange,
  whoAsked: string,
) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    if (operator.role !== "superadmin") {
      return refuse(ARCHIVE_ERRORS.keepSuperadminOnly);
    }
    const raw = (change ?? {}) as Record<string, unknown>;
    const keep: ArchiveKeepChange =
      raw.hold === true ? { hold: true } : { until: str(raw.until) };
    const result = await extendArchive(
      str(blockId),
      keep,
      str(whoAsked),
      operator,
    );
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error);
    return {
      ok: true as const,
      keepUntil: result.keepUntil,
      legalHold: result.legalHold,
      message:
        "hold" in keep
          ? TOAST.keptUntilReleased
          : TOAST.keptUntil(istShortDate(result.keepUntil)),
    };
  } catch (err) {
    return failed("keep archive longer", err, ARCHIVE_ERRORS.saveFailed);
  }
}

/** "Release hold" on an archived copy, with a required note (design 6.6). */
export async function releaseArchiveHoldAction(blockId: string, note: string) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    if (operator.role !== "superadmin") {
      return refuse(ARCHIVE_ERRORS.releaseSuperadminOnly);
    }
    const result = await releaseArchiveHold(str(blockId), str(note), operator);
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error);
    return {
      ok: true as const,
      keepUntil: result.keepUntil,
      message: TOAST.copyHoldReleased(istShortDate(result.keepUntil)),
    };
  } catch (err) {
    return failed("release archive hold", err, ARCHIVE_ERRORS.saveFailed);
  }
}

// ── Store holds (design 3.7, 6.7; superadmin only) ───────────────────────────

/**
 * "Put on hold" (design 6.7): a reason, who asked, an optional complaint (id
 * or "SM-000123") and an optional review date ("YYYY-MM-DD"). The store is
 * never told (D14).
 */
export async function setStoreHoldAction(input: SetHoldInput) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    if (operator.role !== "superadmin") {
      return refuse(HOLD_ERRORS.setSuperadminOnly);
    }
    const result = await setStoreHold(
      {
        storeId: str(input?.storeId),
        reason: str(input?.reason),
        authorityRef: optional(input?.authorityRef),
        complaint: optional(input?.complaint),
        reviewOn: optional(input?.reviewOn),
      },
      operator,
    );
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error);
    return {
      ok: true as const,
      holdId: result.hold.id,
      message: TOAST.storeOnHold,
    };
  } catch (err) {
    return failed("set store hold", err, HOLD_ERRORS.saveFailed);
  }
}

/** "Release hold" on a store, with a required note (design 6.7). */
export async function releaseStoreHoldAction(holdId: string, note: string) {
  try {
    const operator = await currentOperator();
    if (!operator) return refuse(NOT_OPERATOR);
    if (operator.role !== "superadmin") {
      return refuse(HOLD_ERRORS.releaseSuperadminOnly);
    }
    const result = await releaseStoreHold(str(holdId), str(note), operator);
    await afterWork(result.ok);
    if (!result.ok) return refuse(result.error);
    return { ok: true as const, message: TOAST.storeHoldReleased };
  } catch (err) {
    return failed("release store hold", err, HOLD_ERRORS.saveFailed);
  }
}
