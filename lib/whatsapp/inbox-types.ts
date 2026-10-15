// ---------------------------------------------------------------------------
// The inbox's wire shapes — client-safe (no imports), shared by the server
// reads, the actions, the poll route and the dashboard screen so the three
// cannot disagree about a field.
// ---------------------------------------------------------------------------

export type InboxConversationStatus = "needs_reply" | "open" | "closed";

export const INBOX_STATUSES: readonly InboxConversationStatus[] = [
  "needs_reply",
  "open",
  "closed",
];

export type InboxFilter = InboxConversationStatus | "all";

export interface InboxContact {
  id: string;
  /** E.164. */
  phone: string;
  /** "+91 98765 43210", for reading. */
  phoneLabel: string;
  /** The WhatsApp profile name, which the customer chose and may be anything. */
  name: string | null;
  /** The shopper's account on this store, when the number matched one. */
  userId: string | null;
}

export interface InboxConversationRow {
  id: string;
  status: InboxConversationStatus;
  unreadCount: number;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastPreview: string | null;
  contact: InboxContact;
  /** Can staff write freely right now (24 hours since the customer wrote)? */
  windowOpen: boolean;
  /** Who is on it (an admin id), or nobody. */
  assignedAdminId: string | null;
  /** The store's label ids this conversation carries. */
  labelIds: string[];
  /** When the list was searched and the hit was INSIDE the conversation: the
   *  message and the line it was found in, matched words in « ». */
  match?: { messageId: string; snippet: string } | null;
}

/** The list's filters beside the status tabs. */
export interface InboxListQuery {
  filter: InboxFilter;
  q: string;
  page: number;
  /** "" anyone · "me" · "unassigned" · an admin id. */
  assignee?: string;
  /** A label id, or "". */
  label?: string;
}

export interface InboxLabel {
  id: string;
  name: string;
  color: string;
}

export interface InboxAssignee {
  id: string;
  name: string;
}

export interface InboxCannedReply {
  id: string;
  shortcut: string;
  title: string;
  body: string;
}

/** What the inbox screen needs beside the list: the people, labels and
 *  saved replies of this store, and who is looking. */
export interface InboxWorkspace {
  me: InboxAssignee;
  assignees: InboxAssignee[];
  labels: InboxLabel[];
  cannedReplies: InboxCannedReply[];
}

export interface InboxCounts {
  needs_reply: number;
  open: number;
  closed: number;
  all: number;
}

export interface InboxListResult {
  rows: InboxConversationRow[];
  total: number;
  counts: InboxCounts;
}

export interface InboxMessageRow {
  id: string;
  direction: "in" | "out";
  source: string;
  kind: string;
  body: string | null;
  /** A public URL into our bucket when a file was kept; never Meta's URL. */
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaName: string | null;
  payload: Record<string, unknown> | null;
  status: string;
  error: string | null;
  sentAt: string;
  /** Who replied, for a dashboard message; who wrote it, for a note. */
  sentBy: string | null;
  /** Meta's id, by which a reply quotes this message. */
  providerMessageId: string | null;
  /** The message this one replied to, by Meta's id (quoted replies). */
  quotedProviderId: string | null;
}

export interface InboxCustomerOrder {
  id: string;
  orderRef: string;
  status: string;
  paymentStatus: string;
  total: number;
  createdAt: string;
  channel: string;
}

export interface InboxCustomerPanel {
  consent: { updates: boolean; marketing: boolean };
  orders: InboxCustomerOrder[];
  /** Store credit balance, when the number matched an account. */
  credit: number | null;
}

/** A reply customer-facing Mink wrote for a person to send (or not). */
export interface InboxMinkDraft {
  id: string;
  text: string;
  /** Mink's own few words on why it stopped short of sending. */
  reason: string;
  /** What it drew on: "Order ORD10011027", "Refund & Cancellation Policy". */
  facts: string[];
  /** `helps`: Mink would have sent it but handed over; `drafts`: every reply
   *  waits for a person. */
  mode: "helps" | "drafts";
  /** The credit was already taken (a send Meta refused); sending is free. */
  charged: boolean;
  createdAt: string;
}

export interface InboxThread {
  conversation: InboxConversationRow;
  messages: InboxMessageRow[];
  window: { open: boolean; closesAt: string | null };
  customer: InboxCustomerPanel;
  /** The newest draft waiting on this conversation, if any. */
  minkDraft: InboxMinkDraft | null;
}

export interface InboxTemplateOption {
  id: string;
  name: string;
  language: string;
  body: string;
  /** Named placeholders, in `{{n}}` order; staff fill each one. */
  variables: string[];
  /** A merchant's template may carry a text header, a footer and buttons;
   *  shown so staff know what the customer will see. Empty for the
   *  catalogue's. */
  headerText?: string;
  footerText?: string;
  buttons?: { type: string; text: string }[];
}

/** What a send from the inbox reports (a reply, a template, a file). */
export interface InboxSendResult {
  ok: boolean;
  messageId?: string;
  /** `window_closed` tells the composer to switch to templates. */
  code?: "window_closed" | "not_connected" | "refused";
  error?: string;
}

/** The longest free-form reply the dashboard sends — WhatsApp's own cap. */
export const INBOX_REPLY_MAX_CHARS = 4096;

/** A private note in the thread is an InboxMessageRow with this source and
 *  kind; it is never a whatsapp_messages row and never leaves the dashboard. */
export const INBOX_NOTE_SOURCE = "note";

/** What the dashboard can send as a file: a photo (converted to JPEG) or a
 *  PDF. Voice notes and videos stay a phone's job. */
export const INBOX_MEDIA_ACCEPT =
  "image/jpeg,image/png,image/webp,application/pdf";
export const INBOX_MEDIA_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const INBOX_MEDIA_DOCUMENT_MAX_BYTES = 16 * 1024 * 1024;
