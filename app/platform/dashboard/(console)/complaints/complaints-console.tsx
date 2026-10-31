import Link from "next/link";
import { Check } from "lucide-react";
import { ResponsiveTable } from "@/app/dashboard/components/responsive-table";
import { InfoTip } from "@/components/ui/info-tip";
import {
  complaintKindLabel,
  kindWord,
  type BlockKind,
  type ComplaintKind,
} from "@/lib/moderation/kinds";
import { deadlineLabel, type DeadlineStage } from "@/lib/moderation/deadlines";
// Types only: console-read.ts is server-only, and a type import is erased.
import type {
  BlockListRow,
  BlockStatus,
  ComplaintDetail,
  ComplaintListRow,
  ComplaintStatus,
  ConsoleCounts,
  FileStage,
  HoldListRow,
  ModerationEventRow,
} from "@/lib/moderation/console-read";

// ---------------------------------------------------------------------------
// The words and tables of the operator console's Complaints screens (takedown
// design 6.1 to 6.4), shared by the server pages and their client forms.
//
// ★ NO "use client" AND NO SERVER IMPORT: the list and the complaint page
// render these tables on the server, and the form and the actions read the
// same words in the browser. The reads themselves stay in
// lib/moderation/console-read.ts (server-only), imported here as types only.
//
// ★ INDIA TIME, ALWAYS. These render on the server, where Cloud Run is UTC,
// and every deadline is an India-time promise (design 6). India has no daylight
// saving, so a fixed +5:30 is exact and needs no time-zone library.
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Fixed short months: "Sep", never the "Sept" some runtimes print. */
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isFinite(at.getTime()) ? at : null;
}

function istParts(at: Date) {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * "26 Oct, 14:05" in India time (design 6.2), with the year when it is not
 * this year's ("26 Oct 2025, 14:05"). "-" for no time.
 */
export function istDateTime(
  value: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  const at = toDate(value);
  if (!at) return "-";
  const p = istParts(at);
  const year = p.year === istParts(now).year ? "" : ` ${p.year}`;
  return `${p.day} ${MONTHS[p.month]}${year}, ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** "26 Oct 2026" in India time. "-" for no time. */
export function istDate(value: string | Date | null | undefined): string {
  const at = toDate(value);
  if (!at) return "-";
  const p = istParts(at);
  return `${p.day} ${MONTHS[p.month]} ${p.year}`;
}

/** A "YYYY-MM-DD" India date (a hold's review date) as "26 Oct 2026". */
export function calendarDate(value: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  if (!match) return "-";
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/** "YYYY-MM-DDTHH:mm" of India time now: the latest a datetime-local may pick. */
export function istNowForInput(now: Date = new Date()): string {
  const p = istParts(now);
  return `${p.year}-${pad2(p.month + 1)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Today's India date as "YYYY-MM-DD". */
export function istToday(now: Date = new Date()): string {
  const p = istParts(now);
  return `${p.year}-${pad2(p.month + 1)}-${pad2(p.day)}`;
}

/**
 * A stretch of time as the design writes it: "25 min", "1 h 52 min" (under
 * 6 hours), "23 h" (under 2 days), "3 days".
 */
export function durationWords(ms: number): string {
  const minutes = Math.max(1, Math.floor(Math.abs(ms) / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 6) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** "Remove or block by" with a lower-case first letter, for "Overdue by ...: remove or block by". */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * The Next deadline cell (design 6.2): "Remove or block by 26 Oct, 14:05
 * (in 1 h 52 min)" within a day, "Provide by 29 Oct, 12:14" further out, and
 * once passed "Overdue by 25 min: remove or block by 26 Oct, 14:05".
 */
export function deadlineText(
  kind: ComplaintKind,
  due: { stage: DeadlineStage; dueAt: string; overdue: boolean },
  now: Date = new Date(),
): { text: string; overdue: boolean } {
  const label = deadlineLabel(kind, due.stage);
  const dueAt = toDate(due.dueAt);
  const when = istDateTime(dueAt, now);
  const left = dueAt ? dueAt.getTime() - now.getTime() : 0;
  if (due.overdue || left <= 0) {
    return {
      text: `Overdue by ${durationWords(left)}: ${lowerFirst(label)} ${when}`,
      overdue: true,
    };
  }
  if (left < 24 * HOUR_MS) {
    return {
      text: `${label} ${when} (in ${durationWords(left)})`,
      overdue: false,
    };
  }
  return { text: `${label} ${when}`, overdue: false };
}

export function stageDue(c: ComplaintDetail, stage: DeadlineStage): string {
  if (stage === "acknowledge") return c.acknowledgeDueAt;
  if (stage === "act") return c.actionDueAt;
  return c.resolveDueAt;
}

function stageMet(
  c: ComplaintDetail,
  stage: DeadlineStage,
): { at: string; by: string | null } | null {
  if (stage === "acknowledge") {
    return c.acknowledgedAt
      ? { at: c.acknowledgedAt, by: c.acknowledgedBy }
      : null;
  }
  if (stage === "act") {
    return c.actionedAt ? { at: c.actionedAt, by: c.actionedBy } : null;
  }
  return c.resolvedAt ? { at: c.resolvedAt, by: c.resolvedBy } : null;
}

/**
 * Where one deadline stands (design 6.4): "Done 26 Oct, 12:20 by
 * a@storemink.com", "In 1 h 52 min" or "Overdue by 25 min". A deadline a
 * resolved complaint never met reads "Not done".
 */
export function stageStatus(
  c: ComplaintDetail,
  stage: DeadlineStage,
  now: Date,
): { text: string; overdue: boolean } {
  const met = stageMet(c, stage);
  if (met) {
    const by = met.by ? ` by ${met.by}` : "";
    return { text: `Done ${istDateTime(met.at, now)}${by}`, overdue: false };
  }
  if (c.resolvedAt) return { text: "Not done", overdue: false };
  const left = new Date(stageDue(c, stage)).getTime() - now.getTime();
  return left <= 0
    ? { text: `Overdue by ${durationWords(left)}`, overdue: true }
    : { text: `In ${durationWords(left)}`, overdue: false };
}

// ── Labels ─────────────────────────────────────────────────────────────────

/** How a complaint reached StoreMink (design 6.3). */
export const CHANNEL_LABEL: Record<string, string> = {
  email: "Email to support@storemink.com",
  post: "Letter",
  web_form: "Our complaint form",
  gac: "Grievance Appellate Committee",
  court: "Court",
  government: "Government or police",
  other: "Other",
};

/**
 * The channels the form offers, in the design's order. "Our complaint form"
 * waits for decision D11 (no public complaint form this release).
 */
export const FORM_CHANNELS = [
  "email",
  "post",
  "gac",
  "court",
  "government",
  "other",
] as const;

/** How a complaint was resolved, as the Resolve dialog names it (design 6.4). */
export const OUTCOME_LABEL: Record<string, string> = {
  removed: "Removed",
  partly_removed: "Partly removed",
  not_removed: "Not removed",
  not_ours: "Not on StoreMink",
  withdrawn: "Withdrawn by them",
  answered: "Answered",
};

/**
 * Each kind's line in the form and the Change kind dialog (design 6.3): its
 * name and its deadlines. What a kind covers, where that needs saying, is in
 * `KIND_INFO`, behind the "i" beside the line.
 */
export const KIND_HELP: Record<ComplaintKind, string> = {
  court_order: "Court order: remove or block within 3 hours.",
  government_order:
    "Government or police order: remove or block within 3 hours.",
  information_order:
    "Order to give information or help: provide it within 72 hours.",
  intimate_or_impersonation:
    "Intimate image or impersonation: remove or block within 2 hours, at any hour. Resolve within 36 hours.",
  listed_content:
    "Content listed in Acceptable Use section 2: resolve within 36 hours.",
  other_removal: "Other removal request: resolve within 7 days.",
  grievance: "Other complaint: resolve within 7 days.",
  data_request: "Personal data request: answer within 10 working days.",
};

/** What a kind covers, shown behind the "i" beside its line. */
export const KIND_INFO: Partial<Record<ComplaintKind, string>> = {
  government_order:
    "It must be in writing from an authorised officer and name the law and the exact address.",
  information_order: "It must be in writing and say what is wanted and why.",
  intimate_or_impersonation:
    "Shows someone naked, partly naked or in a sexual act, or pretends to be them, including faked or morphed images.",
  other_removal: "Someone else's rights, intellectual property or another law.",
};

/** A kind's line split at its first colon: the bold part and the rest. */
export function kindHelpParts(kind: ComplaintKind): {
  head: string;
  rest: string;
} {
  const line = KIND_HELP[kind];
  const at = line.indexOf(": ");
  return at < 0
    ? { head: line, rest: "" }
    : { head: line.slice(0, at), rest: line.slice(at + 2) };
}

/**
 * One kind as a radio row, for the form and the Change kind dialog. The "i"
 * sits beside the label, never inside it, so the radio's name stays the
 * kind's own line.
 */
export function KindRadioRow({
  kind,
  name,
  checked,
  disabled,
  onSelect,
}: {
  kind: ComplaintKind;
  name: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const { head, rest } = kindHelpParts(kind);
  const info = KIND_INFO[kind];
  return (
    <div
      className={`flex items-start gap-2 rounded-[var(--dash-radius-sm)] border px-3 py-2 text-sm pointer-coarse:min-h-11 ${
        checked
          ? "border-[var(--dash-accent)] bg-[var(--dash-accent-soft)]"
          : "border-[var(--dash-border-strong)]"
      }`}
    >
      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
        <input
          type="radio"
          name={name}
          value={kind}
          checked={checked}
          onChange={onSelect}
          disabled={disabled}
          className="mt-1"
        />
        <span className="text-[var(--dash-text)]">
          <span className="font-medium">{head}:</span> {rest}
        </span>
      </label>
      {info ? (
        <InfoTip
          label={`About ${complaintKindLabel(kind).toLowerCase()}`}
          className="mt-0.5"
        >
          {info}
        </InfoTip>
      ) : null}
    </div>
  );
}

/**
 * How an actioned complaint was met with no block, by kind (design 6.4):
 * "No removal needed", "Information provided", and for a personal data
 * request "Request answered".
 */
export function actionedWords(kind: ComplaintKind): string {
  if (kind === "information_order") return "Information provided";
  if (kind === "data_request") return "Request answered";
  return "No removal needed";
}

/**
 * A complaint's Status (design 6.2): "Not acknowledged", "Acknowledged",
 * "Content blocked" (or how it was met without a block), "Resolved: Removed".
 */
export function complaintStatusText(row: {
  status: ComplaintStatus;
  kind: ComplaintKind;
  outcome: string | null;
  blockCount: number;
}): string {
  switch (row.status) {
    case "not_acknowledged":
      return "Not acknowledged";
    case "acknowledged":
      return "Acknowledged";
    case "actioned":
      return row.blockCount > 0 ? "Content blocked" : actionedWords(row.kind);
    case "resolved":
      return `Resolved: ${OUTCOME_LABEL[row.outcome ?? ""] ?? "Resolved"}`;
  }
}

export const STATUS_TONE: Record<ComplaintStatus, string> = {
  not_acknowledged: "dash-badge-amber",
  acknowledged: "dash-badge-blue",
  actioned: "dash-badge-violet",
  resolved: "dash-badge-green",
};

/** A block's State (design 6.2). */
export const BLOCK_STATE_LABEL: Record<BlockStatus, string> = {
  blocked: "Blocked",
  blocked_untold: "Blocked, not told (order)",
  store_suspended: "Store suspended",
  lifted: "Lifted",
};

/**
 * A block's State badge. A live block wears the takedown mark's own class,
 * dash-badge-storemink (dashboard.css: the red tint with darker words, at
 * least 4.5:1), never the shared dash-badge-red; a lifted one is grey.
 */
const BLOCK_STATE_TONE: Record<BlockStatus, string> = {
  blocked: "dash-badge-storemink",
  blocked_untold: "dash-badge-storemink",
  store_suspended: "dash-badge-storemink",
  lifted: "dash-badge-grey",
};

/** "Product", "Blog post", "File", "Store". */
export function blockKindLabel(kind: BlockKind): string {
  const word = kindWord(kind);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * A file's State on the Files tab (design 6.2): "Copying", "Still in
 * storage, retrying", "Copy failed, retry needed", "Remove by hand",
 * "Store copy: 412 of 1,200 files". A failed replacement reads "Still in
 * storage, retry needed". An item block whose archive copy is still running
 * or failed reads like a file's copy.
 */
export function fileStateText(row: {
  fileStage: FileStage | null;
  archive: BlockListRow["archive"];
}): string {
  switch (row.fileStage) {
    case "copying":
      return "Copying";
    case "archived":
      return "Still in storage, retrying";
    case "copy_failed":
      return "Copy failed, retry needed";
    case "replace_failed":
      return "Still in storage, retry needed";
    case "remove_by_hand":
      return "Remove by hand";
    case "store_copy": {
      const total = row.archive?.total ?? 0;
      const copied = row.archive?.copied ?? 0;
      return `Store copy: ${copied.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")} files`;
    }
    default:
      if (row.archive?.filesState === "pending") return "Copying";
      if (row.archive?.filesState === "failed") {
        return "Copy failed, retry needed";
      }
      return "-";
  }
}

/** A block's console page (design 6.6, stage T16b). */
export function blockHref(blockId: string): string {
  return `/dashboard/complaints/blocks/${blockId}`;
}

/** A complaint's console page (design 6.4). */
export function complaintHref(ref: string): string {
  return `/dashboard/complaints/${ref}`;
}

/** "Block an item" with this complaint chosen (design 6.4, 6.5). */
export function blockItemHref(ref?: string | null): string {
  return ref
    ? `/dashboard/complaints/block?complaint=${encodeURIComponent(ref)}`
    : "/dashboard/complaints/block";
}

// ── The history ────────────────────────────────────────────────────────────

function detailString(detail: Record<string, unknown>, key: string): string {
  const value = detail[key];
  return typeof value === "string" ? value.trim() : "";
}

function kindName(value: unknown): string {
  return typeof value === "string" && value in KIND_HELP
    ? complaintKindLabel(value as ComplaintKind)
    : "another kind";
}

/** "Product blocked: Blue mug", "Store suspended: Crumb & Co". */
function blockSubject(event: ModerationEventRow): string {
  const kind = event.block?.kind;
  const label = event.block?.label || "an item";
  if (kind === "store") return `Store suspended: ${label}`;
  return `${kind ? blockKindLabel(kind) : "Item"} blocked: ${label}`;
}

function deadlineVerb(stage: unknown): string {
  if (stage === "acknowledge") return "acknowledge";
  if (stage === "resolve") return "resolve";
  return "act";
}

/**
 * One History line after its time (design 6.4): "Logged by
 * a@storemink.com", "Product blocked: Blue mug", "Kind changed from Other
 * complaint to Intimate image or impersonation", "Acknowledgement emailed".
 * Events the design gives no example for read the same way.
 */
export function eventLine(event: ModerationEventRow): string {
  const d = event.detail;
  const by =
    event.actor && event.actor !== "system" ? ` by ${event.actor}` : "";
  const label = event.block?.label || "an item";
  switch (event.action) {
    case "complaint_logged":
      return `Logged${by}`;
    case "complaint_updated": {
      const kind = d.kind as { from?: unknown; to?: unknown } | undefined;
      if (kind && typeof kind === "object") {
        return `Kind changed from ${kindName(kind.from)} to ${kindName(kind.to)}`;
      }
      if (d.receivedAt) return `Time it reached us corrected${by}`;
      return `Details changed${by}`;
    }
    case "complaint_acknowledged":
      return d.emailed === true
        ? "Acknowledgement emailed"
        : `Marked as acknowledged${by}`;
    case "complaint_actioned": {
      const via = detailString(d, "via");
      if (via === "block") return "Acted on with a block";
      const words =
        via === "information_provided"
          ? "Information provided"
          : via === "answered"
            ? "Request answered"
            : "No removal needed";
      const note = detailString(d, "note");
      return note ? `${words}${by}: ${note}` : `${words}${by}`;
    }
    case "complaint_resolved": {
      const outcome = OUTCOME_LABEL[detailString(d, "outcome")] ?? "Resolved";
      const mail =
        d.emailed === true
          ? ", outcome emailed"
          : d.emailed === false
            ? ", the outcome email could not be sent"
            : "";
      return `Resolved${by}: ${outcome}${mail}`;
    }
    case "complaint_reopened": {
      const note = detailString(d, "note");
      return note ? `Reopened${by}: ${note}` : `Reopened${by}`;
    }
    case "complaint_alerted":
      return d.phase === "overdue"
        ? `Operators alerted: the deadline to ${deadlineVerb(d.stage)} has passed`
        : `Operators alerted: the deadline to ${deadlineVerb(d.stage)} is near`;
    case "complaint_erased":
      return "The complainant's details were erased";
    case "block_created":
      return blockSubject(event);
    case "block_lifted":
      return event.block?.kind === "store"
        ? `Suspension lifted${by}: ${label}`
        : `Block lifted${by}: ${label}`;
    case "store_told":
      return `Store told about the block on ${label}`;
    case "merchant_notified":
      return `Store emailed about the block on ${label}`;
    case "merchant_notify_failed":
      return `The email to the store about ${label} failed`;
    case "store_replied":
      return `The store replied about ${label}`;
    case "storemink_replied":
      return `Replied to the store about ${label}${by}`;
    case "archive_written":
      return `A copy of ${label} was kept`;
    case "storage_replaced":
      return `${label} was replaced with the placeholder`;
    case "storage_removed_by_hand":
      return `${label} was marked as removed${by}`;
    case "storage_restored":
      return `${label} was restored`;
    default: {
      const words = event.action.replace(/_/g, " ");
      return `${words.charAt(0).toUpperCase()}${words.slice(1)}${by}`;
    }
  }
}

// ── Tabs ───────────────────────────────────────────────────────────────────

export const COMPLAINTS_TABS = [
  { key: "open", label: "Open", count: "open" },
  { key: "due", label: "Due soon", count: "due" },
  { key: "overdue", label: "Overdue", count: "overdue" },
  { key: "replies", label: "Store replies", count: "replies" },
  { key: "blocks", label: "Blocks", count: "blocks" },
  { key: "files", label: "Files", count: "files" },
  { key: "holds", label: "Holds", count: "holds" },
  { key: "resolved", label: "Resolved", count: "resolved" },
] as const satisfies readonly {
  key: string;
  label: string;
  count: keyof ConsoleCounts;
}[];

export type ComplaintsTab = (typeof COMPLAINTS_TABS)[number]["key"];

/** The tabs that are work waiting: their count turns amber when not zero. */
const ALERT_TABS: readonly ComplaintsTab[] = [
  "due",
  "overdue",
  "replies",
  "files",
];

export function isComplaintsTab(value: unknown): value is ComplaintsTab {
  return COMPLAINTS_TABS.some((tab) => tab.key === value);
}

/** The Complaints list address, keeping the store filter. */
export function complaintsHref(input: {
  view?: ComplaintsTab;
  store?: string | null;
  page?: number;
}): string {
  const params = new URLSearchParams();
  if (input.view && input.view !== "open") params.set("view", input.view);
  if (input.store) params.set("store", input.store);
  if (input.page && input.page > 1) params.set("page", String(input.page));
  const query = params.toString();
  return query ? `/dashboard/complaints?${query}` : "/dashboard/complaints";
}

/**
 * The tab bar (design 6.2), each tab with its count. Counts are left off
 * when they could not be read, and when the list is narrowed to one store
 * (the counts are every store's).
 */
export function ComplaintsTabs({
  tab,
  counts,
  store,
}: {
  tab: ComplaintsTab;
  counts: ConsoleCounts | null;
  store: string | null;
}) {
  return (
    <nav
      aria-label="Complaints"
      className="dash-filter-tabs mb-5 w-fit max-w-full flex-wrap"
    >
      {COMPLAINTS_TABS.map(({ key, label, count }) => {
        const on = key === tab;
        const n = counts && !store ? counts[count] : null;
        const alert = n !== null && n > 0 && ALERT_TABS.includes(key);
        return (
          <Link
            key={key}
            href={complaintsHref({ view: key, store })}
            aria-current={on ? "page" : undefined}
            className={`dash-filter-tab pointer-coarse:min-h-11 ${on ? "active" : ""} ${alert ? "has-alert" : ""}`}
          >
            {label}
            {n !== null ? <span className="dash-tab-count">{n}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

// ── Tables ─────────────────────────────────────────────────────────────────

/** Every empty state of design 6.2, by tab. */
export const EMPTY_TEXT: Record<ComplaintsTab, string> = {
  open: "No open complaints.",
  due: "Nothing is due in the next 6 hours.",
  overdue: "Nothing is overdue.",
  resolved: "No resolved complaints yet.",
  blocks: "No blocks yet.",
  files: "Every blocked file is finished.",
  holds: "No store is on hold.",
  replies: "No store is waiting for an answer.",
};

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="dash-empty">
      <span className="dash-empty-icon">
        <Check aria-hidden className="h-5 w-5" strokeWidth={1.5} />
      </span>
      <p className="dash-empty-title">{text}</p>
    </div>
  );
}

const LINK =
  "hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center";

function StoreLink({
  storeId,
  label,
}: {
  storeId: string | null;
  label: string;
}) {
  if (!label) return <span className="text-[var(--dash-text-2)]">-</span>;
  if (!storeId) return <span>{label}</span>;
  return (
    <Link href={`/dashboard/stores/${storeId}`} className={LINK}>
      {label}
    </Link>
  );
}

/** The complaints table (design 6.2). */
export function ComplaintsTable({
  rows,
  now = new Date(),
}: {
  rows: ComplaintListRow[];
  now?: Date;
}) {
  return (
    <ResponsiveTable className="dash-table dash-table-wide">
      <thead>
        <tr>
          <th>Reference</th>
          <th>Received</th>
          <th>Kind</th>
          <th>Store</th>
          <th>Next deadline</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const due = row.nextDue
            ? deadlineText(row.kind, row.nextDue, now)
            : null;
          return (
            <tr key={row.id}>
              <td>
                <Link
                  href={complaintHref(row.ref)}
                  className={`dash-cell-title tabular-nums ${LINK}`}
                >
                  {row.ref}
                </Link>
              </td>
              <td>{istDateTime(row.receivedAt, now)}</td>
              <td>{complaintKindLabel(row.kind)}</td>
              <td>
                <StoreLink storeId={row.storeId} label={row.storeLabel} />
              </td>
              <td>
                {due ? (
                  <span
                    className={
                      due.overdue
                        ? "font-medium text-[var(--dash-red)]"
                        : undefined
                    }
                  >
                    {due.text}
                  </span>
                ) : (
                  <span className="text-[var(--dash-text-2)]">-</span>
                )}
              </td>
              <td>
                <span className={`dash-badge ${STATUS_TONE[row.status]}`}>
                  {complaintStatusText(row)}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </ResponsiveTable>
  );
}

function ItemCell({ row }: { row: BlockListRow }) {
  return (
    <Link href={blockHref(row.id)} className={`block ${LINK}`}>
      <span className="dash-cell-title block">{row.label || "-"}</span>
    </Link>
  );
}

/**
 * The blocks table (design 6.2): "Item", "Store", "Kind", "Blocked", "By",
 * "Complaint", "State". A complaint's own page leaves the Complaint column
 * off (design 6.4 "Blocks for this complaint").
 */
export function BlocksTable({
  rows,
  now = new Date(),
  showComplaint = true,
}: {
  rows: BlockListRow[];
  now?: Date;
  showComplaint?: boolean;
}) {
  return (
    <ResponsiveTable className="dash-table dash-table-wide">
      <thead>
        <tr>
          <th>Item</th>
          <th>Store</th>
          <th>Kind</th>
          <th>Blocked</th>
          <th>By</th>
          {showComplaint ? <th>Complaint</th> : null}
          <th>State</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <ItemCell row={row} />
            </td>
            <td>
              <StoreLink storeId={row.storeId} label={row.storeLabel} />
            </td>
            <td>{blockKindLabel(row.kind)}</td>
            <td>{istDateTime(row.blockedAt, now)}</td>
            <td className="break-all">{row.blockedBy}</td>
            {showComplaint ? (
              <td>
                {row.complaintRef ? (
                  <Link
                    href={complaintHref(row.complaintRef)}
                    className={`tabular-nums ${LINK}`}
                  >
                    {row.complaintRef}
                  </Link>
                ) : (
                  <span className="text-[var(--dash-text-2)]">-</span>
                )}
              </td>
            ) : null}
            <td>
              <span className={`dash-badge ${BLOCK_STATE_TONE[row.status]}`}>
                {BLOCK_STATE_LABEL[row.status]}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </ResponsiveTable>
  );
}

/** The files table (design 6.2): "File", "Store", "Blocked", "State". */
export function FilesTable({
  rows,
  now = new Date(),
}: {
  rows: BlockListRow[];
  now?: Date;
}) {
  return (
    <ResponsiveTable className="dash-table dash-table-wide">
      <thead>
        <tr>
          <th>File</th>
          <th>Store</th>
          <th>Blocked</th>
          <th>State</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <ItemCell row={row} />
            </td>
            <td>
              <StoreLink storeId={row.storeId} label={row.storeLabel} />
            </td>
            <td>{istDateTime(row.blockedAt, now)}</td>
            <td>
              <span className="dash-badge dash-badge-amber">
                {fileStateText(row)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </ResponsiveTable>
  );
}

/**
 * The holds table (design 6.2): "Store", "On hold since", "Reason",
 * "Review on", "Set by". A review date that has come is shown in amber: the
 * Overview's "Holds to review" counts those.
 */
export function HoldsTable({
  rows,
  now = new Date(),
}: {
  rows: HoldListRow[];
  now?: Date;
}) {
  const today = istToday(now);
  return (
    <ResponsiveTable className="dash-table dash-table-wide">
      <thead>
        <tr>
          <th>Store</th>
          <th>On hold since</th>
          <th>Reason</th>
          <th>Review on</th>
          <th>Set by</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const reached = row.reviewOn !== null && row.reviewOn <= today;
          return (
            <tr key={row.id}>
              <td>
                <StoreLink storeId={row.storeId} label={row.storeLabel} />
              </td>
              <td>{istDate(row.setAt)}</td>
              <td className="whitespace-pre-wrap">{row.reason || "-"}</td>
              <td>
                <span
                  className={
                    reached
                      ? "rounded-[var(--dash-radius-sm)] bg-[var(--dash-amber-soft)] px-1.5 py-0.5 font-semibold text-[var(--dash-text)]"
                      : undefined
                  }
                >
                  {calendarDate(row.reviewOn)}
                </span>
              </td>
              <td className="break-all">{row.setBy}</td>
            </tr>
          );
        })}
      </tbody>
    </ResponsiveTable>
  );
}

/**
 * The store replies table (design 6.2): "Item", "Store", "Last reply",
 * "Asked for a review". The store waiting longest comes first.
 */
export function RepliesTable({
  rows,
  now = new Date(),
}: {
  rows: BlockListRow[];
  now?: Date;
}) {
  return (
    <ResponsiveTable className="dash-table dash-table-wide">
      <thead>
        <tr>
          <th>Item</th>
          <th>Store</th>
          <th>Last reply</th>
          <th>Asked for a review</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <ItemCell row={row} />
            </td>
            <td>
              <StoreLink storeId={row.storeId} label={row.storeLabel} />
            </td>
            <td>{istDateTime(row.lastMessage?.at ?? null, now)}</td>
            <td>{row.lastMessage?.asksReview ? "Yes" : "No"}</td>
          </tr>
        ))}
      </tbody>
    </ResponsiveTable>
  );
}
