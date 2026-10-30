/**
 * Every sentence a merchant, a shopper or a complainant reads about a
 * takedown (takedown design 7.1 to 7.6, with amendments A4, A9 and A16):
 * the Notices from StoreMink pages, the banners and labels on blocked items,
 * the prefilled message to the store, Mink AI's sentence, the shopper's
 * refusals, the upload refusals, the store's bell and the emails' words.
 * Defined once here and imported everywhere; the operator console's own
 * sentences live in its components (design 6).
 *
 * PURE and client-safe: imports only `./kinds`. Dates, names and links come
 * in already formatted (India time) and are placed as given; emails are
 * returned as plain parts that `lib/email/takedown-emails.ts` composes,
 * escapes and links.
 */

import {
  appealRoute,
  kindWord,
  reasonLabel,
  withArticle,
  type AppealRoute,
  type BlockKind,
  type BlockReason,
  type ComplaintKind,
  type ComplaintOutcome,
} from "./kinds";

/** A block that names one item rather than a whole store. */
export type ItemKind = Exclude<BlockKind, "store">;

/** The kinds the dashboard shows a "Blocked by StoreMink" banner on. */
export type BannerKind = "product" | "page" | "blog_post" | "collection";

/** What the appeal sentence is chosen by. */
export type RouteFacts = {
  reasonKind: BlockReason;
  complaintId: string | null | undefined;
};

/** StoreMink's support mailbox, the one address these texts name. */
export const SUPPORT_EMAIL = "support@storemink.com";

function capitalise(text: string): string {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

/** A name to place in a sentence, or the kind's own words when it has none. */
function itemName(label: string | null | undefined, fallback: string): string {
  const trimmed = (label ?? "").trim();
  return trimmed ? trimmed : fallback;
}

// ── 7.1 Notices from StoreMink ──────────────────────────────────────────────

/** The list page and the Settings link (design 7.1). */
export const NOTICES = {
  navLabel: "Notices from StoreMink",
  title: "Notices from StoreMink",
  intro:
    "When StoreMink blocks something on your store, after a complaint, a legal order, a breach of our policies or your own request, you find it here.",
  columns: {
    item: "Item",
    blockedOn: "Blocked on",
    why: "Why",
    state: "State",
  },
  states: { blocked: "Blocked", lifted: "Lifted" },
  empty:
    "There are no notices. StoreMink has not blocked anything on your store.",
} as const;

/** One notice's page (design 7.1). */
export const NOTICE = {
  facts: {
    item: "Item",
    blockedOn: "Blocked on",
    reason: "Reason",
    reference: "Reference",
  },
  messageHeading: "Message from StoreMink",
  meaningHeading: "What this means",
  canDoHeading: "What you can do",
  storeMinkAuthor: "StoreMink",
  notFound: "We could not find this notice.",
} as const;

/**
 * A notice's title: "Product blocked by StoreMink", "Image blocked by
 * StoreMink", "Review removed at your request", "Store suspended by
 * StoreMink"; once lifted, "Product unblocked by StoreMink" or "Suspension
 * lifted by StoreMink".
 */
export function noticeTitle(notice: {
  kind: BlockKind;
  reasonKind: BlockReason;
  contentType?: string | null;
  lifted: boolean;
}): string {
  if (notice.kind === "store") {
    return notice.lifted
      ? "Suspension lifted by StoreMink"
      : "Store suspended by StoreMink";
  }
  const word = capitalise(kindWord(notice.kind, notice.contentType));
  if (notice.lifted) return `${word} unblocked by StoreMink`;
  if (notice.reasonKind === "store_request") {
    return `${word} removed at your request`;
  }
  return `${word} blocked by StoreMink`;
}

/** The reason as the store reads it: its own request in its own words. */
export function noticeReasonLabel(reason: BlockReason): string {
  return reason === "store_request"
    ? "You asked us to remove it"
    : reasonLabel(reason);
}

const ITEM_HIDDEN = [
  "Shoppers can't see it on your store, in search or in your sitemap.",
  "You can still edit it, but it stays hidden until StoreMink lifts the block.",
  "Publishing it does not show it.",
];
const PAGE_FIX = [
  "If you fix the page, publish it, so that the fixed version is what shows if the block is lifted.",
];
const POST_HIDDEN = [
  "Shoppers can't see it on your store, and its author can't post another one on the same product or post while it is blocked.",
];
const IMAGE_HIDDEN = [
  "Wherever your store uses it, it now shows a grey 'Image not available' picture.",
  "You can't put the same image back while it is blocked.",
];
const FILE_HIDDEN = ["It can no longer be opened from your store."];
const STORE_CLOSED = [
  "Your store was closed to shoppers, and its dashboard and POS could not be opened, while it was suspended.",
];
const ARCHIVE_KEPT = [
  "StoreMink keeps a copy for at least 180 days, as the law requires.",
  "You can't see or change that copy.",
];

/** The paragraphs of "What this means", each as its sentences. */
function meaningSentences(
  kind: BlockKind,
  contentType?: string | null,
): string[][] {
  switch (kind) {
    case "product":
    case "blog_post":
    case "collection":
      return [ITEM_HIDDEN, ARCHIVE_KEPT];
    case "page":
      return [ITEM_HIDDEN, PAGE_FIX, ARCHIVE_KEPT];
    case "review":
    case "blog_comment":
      return [POST_HIDDEN, ARCHIVE_KEPT];
    case "file":
      return kindWord(kind, contentType) === "image"
        ? [IMAGE_HIDDEN, ARCHIVE_KEPT]
        : [FILE_HIDDEN, ARCHIVE_KEPT];
    case "store":
      return [STORE_CLOSED, ARCHIVE_KEPT];
  }
}

/** "What this means" (design 7.1, with A9 and A16), one string per paragraph. */
export function whatThisMeans(
  kind: BlockKind,
  contentType?: string | null,
): string[] {
  return meaningSentences(kind, contentType).map((p) => p.join(" "));
}

/** The first sentence of "What this means", which the notice email repeats. */
export function meaningFirstSentence(
  kind: BlockKind,
  contentType?: string | null,
): string {
  return meaningSentences(kind, contentType)[0][0];
}

const ROUTE_SENTENCES: Record<AppealRoute, string> = {
  order:
    "This block follows a legal order. We can lift it only when the order allows it.",
  committee:
    "If you are not satisfied with our decision, you can appeal to the Grievance Appellate Committee at gac.gov.in within 30 days.",
  grievance_officer: `If you disagree, reply below, or write to our Grievance Officer at ${SUPPORT_EMAIL}. If you are not satisfied with the Grievance Officer's decision, you can then appeal to the Grievance Appellate Committee at gac.gov.in within 30 days of it.`,
  none: "If you want it shown again, reply below and tick Please show it again.",
};

/** The sentence that says where the store can turn (design 7.1). */
export function routeSentence(route: AppealRoute): string {
  return ROUTE_SENTENCES[route];
}

/**
 * The same sentence as an email says it. "Reply below" means the reply box
 * on the notice page, which an email does not have, so the two routes that
 * say it name where to reply instead: the notice in the dashboard (an item
 * notice, whose email has a button to it) or this email (a suspension, whose
 * dashboard is shut). What the store can do is unchanged.
 */
function emailRouteSentence(route: AppealRoute, hasDashboard: boolean): string {
  if (route === "grievance_officer") {
    const where = hasDashboard
      ? "reply on the notice in your dashboard or to this email"
      : "reply to this email";
    return `If you disagree, ${where}, or write to our Grievance Officer at ${SUPPORT_EMAIL}. If you are not satisfied with the Grievance Officer's decision, you can then appeal to the Grievance Appellate Committee at gac.gov.in within 30 days of it.`;
  }
  if (route === "none") {
    return hasDashboard
      ? "If you want it shown again, reply on the notice in your dashboard and tick Please show it again."
      : "If you want it shown again, reply to this email and ask us to show it again.";
  }
  return routeSentence(route);
}

/** "What you can do" (design 7.1), one string per paragraph. */
export function whatYouCanDo(block: RouteFacts): string[] {
  const route = appealRoute(block);
  const reply =
    route === "none"
      ? "Reply below to tell us your side."
      : "Reply below to tell us your side. If you have fixed the problem, tick Please review it again.";
  return [reply, routeSentence(route)];
}

/** The banner on a lifted notice. */
export function liftBanner(liftedOn: string, note?: string | null): string {
  const extra = (note ?? "").trim();
  const base = `StoreMink lifted this block on ${liftedOn.trim()}.`;
  return extra ? `${base} ${extra}` : base;
}

/**
 * The heading of a message the store sent: its sender's email, or for a reply
 * an operator copied in from an email, the address followed by "by email".
 */
export function storeReplyAuthor(
  email: string | null | undefined,
  viaEmail: boolean,
): string {
  const address = (email ?? "").trim();
  if (!viaEmail) return address || "Your store";
  return address ? `${address}, by email` : "By email";
}

/** The longest reply a store may send. */
export const NOTICE_REPLY_MAX = 4000;

/** The reply form (design 7.1). */
export const NOTICE_REPLY = {
  label: "Your reply",
  placeholder: "Tell us what happened, or what you changed.",
  reviewTick: "I have fixed this. Please review it again.",
  showTick: "Please show it again.",
  button: "Send reply",
  sent: "Reply sent. We will answer here and by email.",
  /** The reply could not be saved (a database failure, not a refusal). */
  failed: "Your reply was not sent. Please try again.",
  errors: {
    empty: "Write a reply first.",
    tooLong: "Keep your reply under 4,000 characters.",
    noPermission: "You need permission to manage Settings to reply.",
    lifted: "This block was lifted, so there is nothing to reply to.",
  },
} as const;

/** The tick under the reply box: a review, or for a store's request, showing it again. */
export function replyTick(route: AppealRoute): string {
  return route === "none" ? NOTICE_REPLY.showTick : NOTICE_REPLY.reviewTick;
}

// ── 7.2 The message to the store, prefilled by reason ──────────────────────

/**
 * The message an operator starts from (design 7.2), for an item or a whole
 * store. Null where the reason is not offered: a store's own request for a
 * whole store or for anything but a review or a comment.
 */
export function defaultStoreMessage(
  reason: BlockReason,
  kind: BlockKind,
  contentType?: string | null,
): string | null {
  if (kind === "store") {
    switch (reason) {
      case "court_order":
        return "We suspended your store because a court ordered us to. We can't open it again while the order applies.";
      case "government_order":
        return "We suspended your store because a government authority ordered us to under the Information Technology Act, 2000. We can't open it again while the order applies.";
      case "intimate_or_impersonation":
        return "We suspended your store after a complaint that it shows a person without their consent, or pretends to be someone.";
      case "listed_content":
        return "We suspended your store after a complaint that it breaks section 2 of our Acceptable Use Policy (content you may not publish).";
      case "other_removal":
        return "We suspended your store after a complaint that it uses someone else's work, brand or rights without permission, or breaks another law.";
      case "terms_breach":
        return "We suspended your store because it breaks our Acceptable Use Policy.";
      case "store_request":
        return null;
    }
  }
  const word = kindWord(kind, contentType);
  switch (reason) {
    case "court_order":
      return `We blocked this ${word} because a court ordered us to remove it. We can't show it on your store while the order applies.`;
    case "government_order":
      return `We blocked this ${word} because a government authority ordered us to remove it under the Information Technology Act, 2000. We can't show it on your store while the order applies.`;
    case "intimate_or_impersonation":
      return `We blocked this ${word} after a complaint that it shows a person without their consent, or pretends to be someone. The law requires us to act on such complaints within 2 hours.`;
    case "listed_content":
      return `We blocked this ${word} after a complaint that it breaks section 2 of our Acceptable Use Policy (content you may not publish).`;
    case "other_removal":
      return `We blocked this ${word} after a complaint that it uses someone else's work, brand or rights without permission, or breaks another law.`;
    case "terms_breach":
      return `We blocked this ${word} because it breaks our Acceptable Use Policy.`;
    case "store_request":
      return kind === "review" || kind === "blog_comment"
        ? `We removed this ${word} because you asked us to.`
        : null;
  }
}

// ── 7.3 On the item, in the dashboard ───────────────────────────────────────

/** The labels on a blocked item (design 7.3). */
export const ITEM = {
  blocked: "Blocked by StoreMink",
  removed: "Removed by StoreMink",
  seeWhyItIsBlocked: "See why it is blocked",
  seeWhy: "See why",
} as const;

/**
 * The status an item shows in the dashboard: a review reads "Removed by
 * StoreMink" (the customer's page), everything else "Blocked by StoreMink".
 */
export function itemStatusLabel(kind: BlockKind): string {
  return kind === "review" || kind === "blog_comment"
    ? ITEM.removed
    : ITEM.blocked;
}

/** The banner in a blocked item's editor (design 7.3). */
export function itemBlockedBanner(kind: BannerKind): string {
  if (kind === "page") {
    return "StoreMink has blocked this page, so it isn't shown on your store. You can still edit and publish it, and the version you publish is what shows if StoreMink lifts the block.";
  }
  return `StoreMink has blocked this ${kindWord(kind)}, so it isn't shown on your store. You can still edit it. It stays hidden until StoreMink lifts the block.`;
}

/** The dashboard home banner while a notice is unopened (design 7.3). */
export function homeBanner(count: number): string {
  const n = Math.max(1, Math.trunc(Number.isFinite(count) ? count : 1));
  return n === 1
    ? "StoreMink has blocked 1 item on your store."
    : `StoreMink has blocked ${n} items on your store.`;
}

// ── 7.4 Mink AI, shoppers, uploads ──────────────────────────────────────────

/** What Mink AI says about a blocked item it was asked to use (design 7.4). */
export function minkBlockedSentence(name: string | null | undefined): string {
  return `StoreMink has blocked ${itemName(name, "this item")}. It stays hidden from your store until StoreMink lifts the block. You can read why in Settings, Notices from StoreMink.`;
}

/** What a shopper reads (design 7.4). */
export const SHOPPER = {
  reviewRemoved:
    "StoreMink has removed your review of this product, so it can't be changed or posted again.",
  commentRemoved:
    "StoreMink has removed your comment on this post, so you can't post another one on it.",
  postRemoved: "StoreMink has removed this post from the store.",
  submissionRemoved: "Removed by StoreMink",
} as const;

/**
 * The refusal when a blocked file is put back through a StoreMink tool
 * (design 7.4, decision D21): named when the store was told of the block,
 * nameless when the block is kept from it.
 */
export function uploadRefusal(refusal: {
  told: boolean;
  kindWord: string;
}): string {
  if (!refusal.told) {
    return `This file can't be uploaded. If you need help, write to ${SUPPORT_EMAIL}.`;
  }
  const word = refusal.kindWord === "image" ? "image" : "file";
  return `StoreMink has blocked this ${word}, so it can't be uploaded again. See Settings, Notices from StoreMink.`;
}

/** The refusal when a chat picture is blocked (amendment A4). */
export function attachmentRefusal(told: boolean): string {
  return told
    ? "StoreMink has blocked this image, so it can't be used in your store. See Settings, Notices from StoreMink."
    : `This image can't be used. If you need help, write to ${SUPPORT_EMAIL}.`;
}

// ── 7.5 The store's bell ────────────────────────────────────────────────────

/** The three store events' labels and descriptions (design 7.5). */
export const STORE_EVENTS = {
  contentBlocked: {
    label: "Content blocked by StoreMink",
    description:
      "StoreMink blocked something on your store after a complaint, a legal order, a breach of its policies or your request.",
  },
  blockLifted: {
    label: "Block lifted by StoreMink",
    description: "StoreMink lifted a block on your store.",
  },
  reply: {
    label: "Reply from StoreMink",
    description: "StoreMink replied about something it blocked on your store.",
  },
} as const;

export type BellText = { title: string; body: string };

/** What an item is called when the bell has no name for it. */
function bellLabel(
  label: string | null | undefined,
  kind: BlockKind,
  contentType: string | null | undefined,
  sentenceStart: boolean,
): string {
  const fallback = `${sentenceStart ? "The" : "the"} ${kindWord(kind, contentType)}`;
  return itemName(label, fallback);
}

/** The bell for a new block (design 7.5; a whole store has its own words). */
export function blockedBell(event: {
  kind: BlockKind;
  contentType?: string | null;
  itemLabel?: string | null;
}): BellText {
  const label = bellLabel(event.itemLabel, event.kind, event.contentType, true);
  if (event.kind === "store") {
    return {
      title: "StoreMink suspended your store",
      body: `${label} was closed to shoppers. See why.`,
    };
  }
  return {
    title: `StoreMink blocked ${withArticle(kindWord(event.kind, event.contentType))}`,
    body: `${label} is hidden from your store. See why.`,
  };
}

/** The bell for a lifted block (design 7.5; a whole store has its own words). */
export function liftedBell(event: {
  kind: BlockKind;
  contentType?: string | null;
  itemLabel?: string | null;
}): BellText {
  const label = bellLabel(event.itemLabel, event.kind, event.contentType, true);
  if (event.kind === "store") {
    return {
      title: "StoreMink lifted the suspension",
      body: `${label} is open to shoppers again.`,
    };
  }
  return {
    title: "StoreMink lifted a block",
    body: `${label} is no longer blocked.`,
  };
}

/** The bell for StoreMink's reply (design 7.5). */
export function replyBell(event: {
  kind: BlockKind;
  contentType?: string | null;
  itemLabel?: string | null;
}): BellText {
  const label = bellLabel(
    event.itemLabel,
    event.kind,
    event.contentType,
    false,
  );
  return {
    title: "StoreMink replied",
    body: `About ${label}. Open the notice to read it.`,
  };
}

// ── 7.6 Emails ──────────────────────────────────────────────────────────────

/** One fact row of an email. */
export type EmailDetail = { label: string; value: string };

/**
 * An email's words, in order: the preheader, the heading, the facts, the
 * paragraphs before the button, the button's label (null for none), the
 * paragraphs after it and the footer. The sender adds the link and escapes.
 */
export type NoticeEmailText = {
  subject: string;
  preheader: string;
  heading: string;
  details: EmailDetail[];
  paragraphs: string[];
  buttonLabel: string | null;
  afterButton: string[];
  footer: string;
};

/** The facts an item notice is built from. */
export type BlockNoticeFacts = {
  storeName: string;
  kind: ItemKind;
  contentType?: string | null;
  itemLabel: string;
  /** The date, already in India time. */
  blockedOn: string;
  reasonKind: BlockReason;
  /** "SM-000123", or null when the block names no complaint. */
  reference: string | null;
  storeMessage: string;
  complaintId: string | null;
};

function noticeFooter(storeName: string): string {
  return `This is a notice from StoreMink about content on ${storeName}. Questions? Reply to this email.`;
}

function referenceRow(reference: string | null): EmailDetail[] {
  const value = (reference ?? "").trim();
  return value ? [{ label: "Reference", value }] : [];
}

function messageParagraph(message: string): string[] {
  const text = message.trim();
  return text ? [text] : [];
}

/** The block notice (design 7.6, mailer `takedown_notice`). */
export function blockNoticeEmail(facts: BlockNoticeFacts): NoticeEmailText {
  const word = kindWord(facts.kind, facts.contentType);
  const store = facts.storeName.trim();
  return {
    subject: `StoreMink has blocked ${withArticle(word)} on ${store}`,
    preheader:
      "It is hidden from your store. Read why and reply in your dashboard.",
    heading: `We have blocked ${withArticle(word)} on your store`,
    details: [
      { label: "Store", value: store },
      {
        label: capitalise(word),
        value: itemName(facts.itemLabel, `This ${word}`),
      },
      { label: "Blocked on", value: facts.blockedOn.trim() },
      { label: "Reason", value: noticeReasonLabel(facts.reasonKind) },
      ...referenceRow(facts.reference),
    ],
    paragraphs: [
      ...messageParagraph(facts.storeMessage),
      meaningFirstSentence(facts.kind, facts.contentType),
      emailRouteSentence(appealRoute(facts), true),
    ],
    buttonLabel: "Read the notice",
    afterButton: [
      "You can reply there with your side, or reply to this email.",
    ],
    footer: noticeFooter(store),
  };
}

/** The facts a whole-store suspension notice is built from. */
export type SuspensionFacts = {
  storeName: string;
  /** The date, already in India time. */
  suspendedOn: string;
  reasonKind: BlockReason;
  reference: string | null;
  storeMessage: string;
  complaintId: string | null;
};

/** The suspension notice (design 7.6, with A9): no button, the dashboard is shut. */
export function storeSuspendedEmail(facts: SuspensionFacts): NoticeEmailText {
  const store = facts.storeName.trim();
  return {
    subject: `StoreMink has suspended ${store}`,
    preheader:
      "Your store is closed to shoppers. Read why, and reply to this email.",
    heading: "We have suspended your store",
    details: [
      { label: "Store", value: store },
      { label: "Suspended on", value: facts.suspendedOn.trim() },
      { label: "Reason", value: noticeReasonLabel(facts.reasonKind) },
      ...referenceRow(facts.reference),
    ],
    paragraphs: [
      ...messageParagraph(facts.storeMessage),
      "While it is suspended, shoppers can't open your store, and you and your staff can't open its dashboard or POS.",
      "StoreMink keeps a copy of your store's content for at least 180 days, as the law requires.",
      emailRouteSentence(appealRoute(facts), false),
      "Reply to this email to tell us your side.",
    ],
    buttonLabel: null,
    afterButton: [],
    footer: noticeFooter(store),
  };
}

/** The facts a lifted-block email is built from. */
export type LiftFacts = {
  storeName: string;
  kind: BlockKind;
  contentType?: string | null;
  itemLabel: string;
  liftNote?: string | null;
};

/** The block-lifted email (design 7.6), for an item or a whole store. */
export function blockLiftedEmail(facts: LiftFacts): NoticeEmailText {
  const store = facts.storeName.trim();
  const note = messageParagraph(facts.liftNote ?? "");
  if (facts.kind === "store") {
    const opened = `Shoppers can open ${store} again, and you can sign in to its dashboard.`;
    return {
      subject: `StoreMink has lifted the suspension of ${store}`,
      preheader: opened,
      heading: "Your store is open again",
      details: [],
      paragraphs: [opened, ...note],
      buttonLabel: "Read the notice",
      afterButton: [],
      footer: noticeFooter(store),
    };
  }
  const word = kindWord(facts.kind, facts.contentType);
  const label = itemName(facts.itemLabel, `Your ${word}`);
  const unblocked = `${label} on ${store} is no longer blocked. If it is published, shoppers can see it again.`;
  return {
    subject: `StoreMink has lifted the block on your ${word}`,
    preheader: unblocked,
    heading: "The block is lifted",
    details: [],
    paragraphs: [unblocked, ...note],
    buttonLabel: "Read the notice",
    afterButton: [],
    footer: noticeFooter(store),
  };
}

/** The facts a StoreMink-replied email is built from. */
export type ReplyFacts = {
  storeName: string;
  kind: BlockKind;
  contentType?: string | null;
  itemLabel: string;
  reply: string;
  /** True while a whole-store block is in force: its dashboard is shut. */
  storeSuspended: boolean;
};

/** The StoreMink-replied email (design 7.6). */
export function storeMinkRepliedEmail(facts: ReplyFacts): NoticeEmailText {
  const store = facts.storeName.trim();
  const word = kindWord(facts.kind, facts.contentType);
  const subject =
    facts.kind === "store"
      ? "StoreMink replied about your suspended store"
      : `StoreMink replied about your blocked ${word}`;
  const label =
    facts.kind === "store"
      ? itemName(facts.itemLabel, store || "your store")
      : itemName(facts.itemLabel, `your ${word}`);
  const shut = facts.kind === "store" && facts.storeSuspended;
  return {
    subject,
    preheader: `We replied about ${label}.`,
    heading: `We replied about ${label}`,
    details: [],
    paragraphs: messageParagraph(facts.reply),
    buttonLabel: shut ? null : "Read and reply",
    afterButton: shut ? ["Reply to this email to tell us your side."] : [],
    footer: noticeFooter(store),
  };
}

// ── 7.6 Emails to a complainant ─────────────────────────────────────────────

/** The sign-off of every email to a complainant. */
export const COMPLAINANT_SIGNOFF = [
  "Grievance Officer, STOREMINK LLP",
  SUPPORT_EMAIL,
] as const;

/** "Hello {name}," or "Hello," when there is no name. */
export function complainantGreeting(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed ? `Hello ${trimmed},` : "Hello,";
}

/** How fast StoreMink acts on a complaint of this kind (design 7.6). */
export function complaintTimingSentence(kind: ComplaintKind): string {
  switch (kind) {
    case "intimate_or_impersonation":
      return "If the content shows you, or the person you act for, naked, partly naked or in a sexual act, or pretends to be you or them, we remove it or block access to it within 2 hours of receiving your complaint, and we resolve your complaint within 36 hours.";
    case "court_order":
    case "government_order":
      return "We act on the order within 3 hours of receiving it.";
    case "information_order":
      return "We provide what the order asks for within 72 hours of receiving it.";
    case "listed_content":
      return "We will resolve your complaint within 36 hours of receiving it.";
    case "data_request":
      return "We will answer your request within 10 working days.";
    case "other_removal":
    case "grievance":
      return "We will resolve your complaint within 7 days of receiving it.";
  }
}

/** The acknowledgement's closing sentence (design 7.6). */
export const ACKNOWLEDGEMENT_APPEAL =
  "We will write to you when we have decided. If you are not satisfied with our decision, or we do not resolve your complaint within these times, you can appeal to the Grievance Appellate Committee at gac.gov.in within 30 days.";

/** The words of a complainant email, in order; the recorded complaint is data. */
export type ComplainantEmailText = {
  subject: string;
  greeting: string;
  paragraphs: string[];
  /** The line before the complaint as recorded, or null for none. */
  recordedLead: string | null;
  afterRecorded: string[];
  signoff: readonly string[];
};

/** The acknowledgement to a complainant (design 7.6, mailer `complaint_reply`). */
export function acknowledgementEmail(facts: {
  name: string | null | undefined;
  /** The time it reached StoreMink, already in India time. */
  receivedAt: string;
  reference: string;
  kind: ComplaintKind;
}): ComplainantEmailText {
  const reference = facts.reference.trim();
  return {
    subject: `We received your complaint (reference ${reference})`,
    greeting: complainantGreeting(facts.name),
    paragraphs: [
      `We received your complaint on ${facts.receivedAt.trim()} and recorded it under the reference ${reference}. Please quote it if you write to us again.`,
    ],
    recordedLead: "Your complaint, as we recorded it:",
    afterRecorded: [
      complaintTimingSentence(facts.kind),
      ACKNOWLEDGEMENT_APPEAL,
    ],
    signoff: COMPLAINANT_SIGNOFF,
  };
}

/** What a complainant is told the decision was (design 7.6). */
export function outcomeSentence(outcome: ComplaintOutcome): string {
  switch (outcome) {
    case "removed":
      return "We removed the content you reported, or blocked access to it.";
    case "partly_removed":
      return "We removed some of the content you reported. The rest stays, for the reasons below.";
    case "not_removed":
      return "We have decided not to remove the content, for the reasons below.";
    case "not_ours":
      return "The content you reported is not hosted by StoreMink, so we can't remove it.";
    case "withdrawn":
      return "We closed your complaint, as you asked.";
    case "answered":
      return "We have answered your complaint below.";
  }
}

/** The decision to a complainant (design 7.6, mailer `complaint_reply`). */
export function outcomeEmail(facts: {
  name: string | null | undefined;
  reference: string;
  outcome: ComplaintOutcome;
  note: string | null | undefined;
}): ComplainantEmailText {
  return {
    subject: `Your complaint ${facts.reference.trim()}: our decision`,
    greeting: complainantGreeting(facts.name),
    paragraphs: [
      outcomeSentence(facts.outcome),
      ...messageParagraph(facts.note ?? ""),
      routeSentence("committee"),
    ],
    recordedLead: null,
    afterRecorded: [],
    signoff: COMPLAINANT_SIGNOFF,
  };
}
