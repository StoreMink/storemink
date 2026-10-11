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
  /** Who replied, for a dashboard message. */
  sentBy: string | null;
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

export interface InboxThread {
  conversation: InboxConversationRow;
  messages: InboxMessageRow[];
  window: { open: boolean; closesAt: string | null };
  customer: InboxCustomerPanel;
}

export interface InboxTemplateOption {
  id: string;
  name: string;
  language: string;
  body: string;
  /** Named placeholders, in `{{n}}` order; staff fill each one. */
  variables: string[];
}

/** The longest free-form reply the dashboard sends — WhatsApp's own cap. */
export const INBOX_REPLY_MAX_CHARS = 4096;
