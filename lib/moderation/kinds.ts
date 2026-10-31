/**
 * The words and lists of operator takedown (takedown design 5.1): what can be
 * blocked, why, where a blocked file lives, what happens to it, and how a
 * complaint is filed and closed.
 *
 * PURE and client-safe: no server import, no clock, no database. Every list
 * mirrors a CHECK of migration 0269 (`20261030_0269_content_takedown.sql`),
 * in the CHECK's own order, and kinds.test.ts reads the migration as text and
 * compares, so code and schema cannot drift.
 *
 * Merchant, shopper and email sentences live in copy.ts; the console's own
 * sentences live in its components (design 6). The labels here are the ones
 * both sides share: the kind word ("product", "an image"), the reason, the
 * complaint kind and its reference.
 */

/** Whether `value` is one of `list` (narrows a string read from a form). */
export function isOneOf<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

// ── Blocks ──────────────────────────────────────────────────────────────────

/** What one block names (`content_blocks_kind_check`). */
export const BLOCK_KINDS = [
  "product",
  "page",
  "blog_post",
  "collection",
  "review",
  "blog_comment",
  "file",
  "store",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** Why a block was made (`content_blocks_reason_check`). */
export const BLOCK_REASONS = [
  "court_order",
  "government_order",
  "intimate_or_impersonation",
  "listed_content",
  "other_removal",
  "terms_breach",
  "store_request",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/**
 * Where a blocked file lives (`content_blocks_target_check` and
 * `content_blocks_storage_kind_check`): an object in this environment's
 * public bucket, an address on any other host, or an image built into the
 * app under /themes/. There is no source for StoreMink's old storage: such an
 * address is an outside one like any other (amendment A1).
 */
export const FILE_SOURCES = ["bucket", "external", "bundled"] as const;
export type FileSource = (typeof FILE_SOURCES)[number];

/** What has happened to a blocked file (`content_blocks_storage_values_check`). */
export const STORAGE_STATES = [
  "none",
  "pending",
  "failed",
  "replaced",
  "restoring",
  "restored",
  "not_restored",
  "cancelled",
  "not_ours",
  "manual",
  "removed_by_hand",
] as const;
export type StorageState = (typeof STORAGE_STATES)[number];

/** How far an archive's file copies are (`content_block_archives_files_state_check`). */
export const ARCHIVE_FILE_STATES = [
  "none",
  "pending",
  "copied",
  "failed",
] as const;
export type ArchiveFileState = (typeof ARCHIVE_FILE_STATES)[number];

/** Who wrote a message about a block (`content_block_messages_side_check`). */
export const MESSAGE_SIDES = ["store", "storemink"] as const;
export type MessageSide = (typeof MESSAGE_SIDES)[number];

/**
 * The reasons a block of this kind may give: a store asks StoreMink to remove
 * only what it cannot remove itself, a review or a comment
 * (`content_blocks_store_request_check`).
 */
export function reasonsForKind(kind: BlockKind): BlockReason[] {
  return BLOCK_REASONS.filter(
    (reason) =>
      reason !== "store_request" ||
      kind === "review" ||
      kind === "blog_comment",
  );
}

/** A court or a government order: the block follows the order (design 3.4). */
export function isOrderReason(reason: BlockReason): boolean {
  return reason === "court_order" || reason === "government_order";
}

/**
 * The word for what was blocked, as a sentence reads it: "product",
 * "blog post", "comment", and for a file "image" when its content type is an
 * image, else "file".
 */
export function kindWord(kind: BlockKind, contentType?: string | null): string {
  switch (kind) {
    case "product":
      return "product";
    case "page":
      return "page";
    case "blog_post":
      return "blog post";
    case "collection":
      return "collection";
    case "review":
      return "review";
    case "blog_comment":
      return "comment";
    case "store":
      return "store";
    case "file":
      return /^image\//i.test((contentType ?? "").trim()) ? "image" : "file";
  }
}

/** "a product", "an image": the article each kind word takes. */
export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

/**
 * The reason as the console and the store's notice name it (design 6.5 step 3
 * and 7.2). The notice and its emails say "You asked us to remove it" for a
 * store's own request (copy.ts `noticeReasonLabel`).
 */
export function reasonLabel(reason: BlockReason): string {
  switch (reason) {
    case "court_order":
      return "Court order";
    case "government_order":
      return "Government or police order";
    case "intimate_or_impersonation":
      return "Intimate image or impersonation";
    case "listed_content":
      return "Content listed in Acceptable Use section 2";
    case "other_removal":
      return "Other removal request";
    case "terms_breach":
      return "Breaks our Acceptable Use Policy";
    case "store_request":
      return "The store asked us to remove it";
  }
}

/**
 * Where a merchant who disagrees can turn (design 3.4, 7.1): the order itself
 * for a block on a court or government order; the Grievance Appellate
 * Committee for a block made on a complaint; StoreMink's Grievance Officer
 * first for a block StoreMink made on its own, because an appeal lies against
 * the Grievance Officer's decision; nobody for a store's own request.
 */
export type AppealRoute = "order" | "committee" | "grievance_officer" | "none";

export function appealRoute(block: {
  reasonKind: BlockReason;
  complaintId: string | null | undefined;
}): AppealRoute {
  if (block.reasonKind === "store_request") return "none";
  if (isOrderReason(block.reasonKind)) return "order";
  return block.complaintId ? "committee" : "grievance_officer";
}

// ── Complaints ──────────────────────────────────────────────────────────────

/** What a complaint is (`grievance_complaints_kind_check`); deadlines.ts times each. */
export const COMPLAINT_KINDS = [
  "court_order",
  "government_order",
  "information_order",
  "intimate_or_impersonation",
  "listed_content",
  "other_removal",
  "grievance",
  "data_request",
] as const;
export type ComplaintKind = (typeof COMPLAINT_KINDS)[number];

/** How a complaint reached StoreMink (`grievance_complaints_channel_check`). */
export const COMPLAINT_CHANNELS = [
  "email",
  "post",
  "web_form",
  "gac",
  "court",
  "government",
  "other",
] as const;
export type ComplaintChannel = (typeof COMPLAINT_CHANNELS)[number];

/** How a complaint was resolved (`grievance_complaints_outcome_check`). */
export const COMPLAINT_OUTCOMES = [
  "removed",
  "partly_removed",
  "not_removed",
  "not_ours",
  "withdrawn",
  "answered",
] as const;
export type ComplaintOutcome = (typeof COMPLAINT_OUTCOMES)[number];

/**
 * The kinds every operator hears about the moment they are logged (design
 * 3.9 and the `platform.complaint_urgent` event of 7.5).
 */
export const URGENT_COMPLAINT_KINDS = [
  "court_order",
  "government_order",
  "information_order",
  "intimate_or_impersonation",
] as const satisfies readonly ComplaintKind[];

export function isUrgentComplaintKind(kind: ComplaintKind): boolean {
  return isOneOf(URGENT_COMPLAINT_KINDS, kind);
}

/** The complaint kind by its name in the console and the operators' alerts (design 6.3). */
export function complaintKindLabel(kind: ComplaintKind): string {
  switch (kind) {
    case "court_order":
      return "Court order";
    case "government_order":
      return "Government or police order";
    case "information_order":
      return "Order to give information or help";
    case "intimate_or_impersonation":
      return "Intimate image or impersonation";
    case "listed_content":
      return "Content listed in Acceptable Use section 2";
    case "other_removal":
      return "Other removal request";
    case "grievance":
      return "Other complaint";
    case "data_request":
      return "Personal data request";
  }
}

const REF_PREFIX = "SM-";

/** The largest `ref_no` an integer column holds. */
const MAX_REF_NO = 2_147_483_647;

/** A complaint's reference: "SM-" and at least six digits ("SM-000123"). */
export function complaintRef(refNo: number): string {
  const n = Number.isFinite(refNo) ? Math.max(0, Math.trunc(refNo)) : 0;
  return `${REF_PREFIX}${String(n).padStart(6, "0")}`;
}

/**
 * The `ref_no` a reference names ("SM-000123", any case, gives 123), or null
 * when it is not one.
 */
export function parseComplaintRef(ref: string): number | null {
  const match = /^SM-(\d{6,10})$/i.exec(ref.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 1 && n <= MAX_REF_NO ? n : null;
}

// ── The record ──────────────────────────────────────────────────────────────

/** Every action `moderation_events` records (`moderation_events_action_check`). */
export const MODERATION_ACTIONS = [
  "complaint_logged",
  "complaint_updated",
  "complaint_acknowledged",
  "complaint_actioned",
  "complaint_resolved",
  "complaint_reopened",
  "complaint_alerted",
  "complaint_erased",
  "block_created",
  "block_lifted",
  "block_erased",
  "store_told",
  "archive_written",
  "archive_files_copied",
  "archive_files_failed",
  "archive_viewed",
  "archive_downloaded",
  "archive_kept_longer",
  "archive_hold_set",
  "archive_hold_released",
  "archive_purged",
  "archive_purge_skipped",
  "storage_replaced",
  "storage_failed",
  "storage_cancelled",
  "storage_restored",
  "storage_not_restored",
  "storage_removed_by_hand",
  "merchant_notified",
  "merchant_notify_failed",
  "store_replied",
  "storemink_replied",
  "reupload_refused",
  "store_hold_set",
  "store_hold_released",
  "store_delete_refused",
  "store_deleted",
  "store_suspended",
  "store_reactivated",
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];
