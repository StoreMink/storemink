// ---------------------------------------------------------------------------
// Notification copy — turns a recorded event into the line a recipient reads.
//
// Pure and audience-aware: the same event says different things to the store
// ("New order ORD10010004 · ₹1,240") and to the shopper ("Your order is on its
// way"). Kept out of events.ts so the registry stays scannable data, and out of
// the recorder so every string is unit-testable without a database.
//
// Anything missing falls back to the registry's label, so a half-populated
// payload degrades to a dull-but-correct notification instead of "undefined".
// ---------------------------------------------------------------------------

import { getEventDef, type Audience } from "./events";
import { refundCopy } from "./refund-copy";
import {
  blockedBell,
  liftedBell,
  replyBell,
  STORE_EVENTS,
} from "@/lib/moderation/copy";
import {
  BLOCK_KINDS,
  COMPLAINT_KINDS,
  complaintKindLabel,
  isOneOf,
  parseComplaintRef,
} from "@/lib/moderation/kinds";
import { deadlineLabel, type DeadlineStage } from "@/lib/moderation/deadlines";

export interface RenderableEvent {
  type: string;
  actorLabel?: string | null;
  subjectId?: string | null;
  subjectLabel?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface RenderedNotification {
  title: string;
  body: string | null;
  url: string | null;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** ₹1,240 — display only; the invoice remains the authority on money. */
function money(value: unknown, currency = "INR"): string | null {
  const n = num(value);
  if (n === null) return null;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n}`;
  }
}

/** Deep link to an order in the dashboard list (the detail is a drawer, so the
 *  list's `q` search over order_ref is the addressable form). */
function adminOrderUrl(e: RenderableEvent): string {
  const ref = str(e.subjectLabel) ?? str(e.payload?.orderRef);
  return ref
    ? `/dashboard/orders?q=${encodeURIComponent(ref)}`
    : "/dashboard/orders";
}

/** The shopper's own order page (app/(storefront)/(pages)/orders/[id]). */
function customerOrderUrl(e: RenderableEvent): string {
  const id = str(e.subjectId);
  return id ? `/orders/${id}` : "/orders";
}

/** A Theme Studio theme's page in the operator console: the subject is the
 *  project, and anything that is not a project id falls back to the list. */
function themeStudioUrl(e: RenderableEvent): string {
  const id = str(e.subjectId);
  return id &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? `/dashboard/themes/studio/${id.toLowerCase()}`
    : "/dashboard/themes/studio";
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A takedown notice on the store's own dashboard: the subject is the
 *  block, and anything that is not a block id falls back to the list. */
function storeNoticeUrl(e: RenderableEvent): string {
  const id = str(e.subjectId);
  return id && UUID_RE.test(id)
    ? `/dashboard/settings/notices/${id.toLowerCase()}`
    : "/dashboard/settings/notices";
}

/** A complaint in the operator console, by its reference ("SM-000123"). */
function complaintUrl(ref: string | null): string {
  return ref ? `/dashboard/complaints/${ref}` : "/dashboard/complaints";
}

/** A block in the operator console. */
function consoleBlockUrl(e: RenderableEvent): string {
  const id = str(e.subjectId);
  return id && UUID_RE.test(id)
    ? `/dashboard/complaints/blocks/${id.toLowerCase()}`
    : "/dashboard/complaints";
}

/** A complaint reference as the console prints it, or null. */
function complaintRefOf(value: unknown): string | null {
  const ref = str(value);
  return ref && parseComplaintRef(ref) !== null ? ref.toUpperCase() : null;
}

const DEADLINE_STAGES: readonly DeadlineStage[] = [
  "acknowledge",
  "act",
  "resolve",
];

/** "30 Oct, 14:05 IST": operators read deadlines in India time, whatever
 *  zone the server renders in (Cloud Run is UTC). */
function istTime(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Kolkata",
  });
  return `${day}, ${time} IST`;
}

/** "30 min", "2 h", "1 h 10 min": a whole number of minutes, read aloud. */
function minutesWords(value: unknown): string | null {
  const n = num(value);
  if (n === null || n < 0) return null;
  const total = Math.max(1, Math.round(n));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

function safeDashboardUrl(value: unknown): string {
  const path = str(value);
  return path && /^\/dashboard(?:[/?#]|$)/.test(path) ? path : "/dashboard";
}

/**
 * Render one event for one audience. Returns null when this audience has no
 * copy for the event — the router treats that as "don't deliver", so an event
 * can never reach an inbox as a blank row.
 */
export function renderNotification(
  event: RenderableEvent,
  audience: Audience,
): RenderedNotification | null {
  const def = getEventDef(event.type);
  if (!def) return null;
  if (!def.audiences[audience]) return null;

  const subject = str(event.subjectLabel);
  const actor = str(event.actorLabel);
  const p = event.payload ?? {};
  const currency = str(p.currency) ?? "INR";
  const total = money(p.total, currency);
  const fallback: RenderedNotification = {
    title: def.label,
    body: subject,
    url: null,
  };

  switch (event.type) {
    // ── Orders ────────────────────────────────────────────────────────────
    case "order.placed":
      return audience === "customer"
        ? {
            title: "Order confirmed",
            body: subject
              ? `We've received your order ${subject}${total ? ` · ${total}` : ""}.`
              : "We've received your order.",
            url: customerOrderUrl(event),
          }
        : {
            title: `New order${subject ? ` ${subject}` : ""}`,
            body:
              [total, actor && `from ${actor}`].filter(Boolean).join(" · ") ||
              null,
            url: adminOrderUrl(event),
          };

    case "order.status_changed": {
      const to = str(p.status);
      return audience === "customer"
        ? {
            title: `Your order is ${to ?? "updated"}`,
            body: subject ? `Order ${subject}` : null,
            url: customerOrderUrl(event),
          }
        : {
            title: `Order ${subject ?? ""} → ${to ?? "updated"}`.trim(),
            body: actor ? `Updated by ${actor}` : null,
            url: adminOrderUrl(event),
          };
    }

    case "order.cancellation_requested":
      return {
        title: `Cancellation requested${subject ? ` · ${subject}` : ""}`,
        body:
          [str(p.reason), actor && `by ${actor}`].filter(Boolean).join(" · ") ||
          "Awaiting your review.",
        url: adminOrderUrl(event),
      };

    case "order.cancelled":
      return audience === "customer"
        ? {
            title: "Order cancelled",
            body: subject
              ? `Order ${subject} has been cancelled${total ? ` · ${total}` : ""}.`
              : "Your order has been cancelled.",
            url: customerOrderUrl(event),
          }
        : {
            title: `Order cancelled${subject ? ` · ${subject}` : ""}`,
            body:
              [str(p.reason), actor && `by ${actor}`]
                .filter(Boolean)
                .join(" · ") || null,
            url: adminOrderUrl(event),
          };

    case "order.payment_received": {
      // A payment that arrived after its order was cancelled for want of one
      // (markOrderPaid's late path). The order stays cancelled, so the one
      // thing the merchant needs to know is that money is owed back.
      if (p.late === true) {
        const due = money(p.refund_due, currency);
        return {
          title: `Payment received for a cancelled order${subject ? ` · ${subject}` : ""}`,
          body: due
            ? `The order expired before the payment arrived. ${due} is owed back to the customer: refund it from the order.`
            : "The order expired before the payment arrived. Check the order and refund the customer.",
          url: adminOrderUrl(event),
        };
      }
      return {
        title: `Payment received${total ? ` · ${total}` : ""}`,
        body: subject ? `Order ${subject}` : null,
        url: adminOrderUrl(event),
      };
    }

    case "order.payment_failed":
      return {
        title: `Payment failed${subject ? ` · ${subject}` : ""}`,
        body: str(p.reason) ?? "The shopper's online payment did not complete.",
        url: adminOrderUrl(event),
      };

    case "order.refund_issued": {
      const amount = money(p.amount, currency);
      // Both emitters send `amount`; `total` here silently rendered nothing.
      const copy = refundCopy(p.paymentMethod);
      return audience === "customer"
        ? {
            title: "Refund on its way",
            body: `${amount ?? "Your refund"} has been ${copy.destination}.${
              copy.bankDelay ? " Banks usually take 5 to 7 working days." : ""
            }`,
            url: customerOrderUrl(event),
          }
        : {
            title: `Refund issued${amount ? ` · ${amount}` : ""}`,
            body: subject ? `Order ${subject}` : null,
            url: adminOrderUrl(event),
          };
    }

    // ── Inventory ─────────────────────────────────────────────────────────
    case "inventory.low_stock": {
      const left = num(p.stock);
      return {
        title: `Low stock${subject ? ` · ${subject}` : ""}`,
        body: left === null ? "Running low." : `Only ${left} left in stock.`,
        url: "/dashboard/inventory",
      };
    }

    case "inventory.out_of_stock":
      return {
        title: `Out of stock${subject ? ` · ${subject}` : ""}`,
        body: "This item is sold out and can no longer be bought.",
        url: "/dashboard/inventory",
      };

    // ── Catalog ───────────────────────────────────────────────────────────
    case "product.deleted":
      return {
        title: `Product deleted${subject ? ` · ${subject}` : ""}`,
        body: actor ? `Deleted by ${actor}` : null,
        url: "/dashboard/products",
      };

    // ── Customers ─────────────────────────────────────────────────────────
    case "customer.signed_up":
      return {
        title: "New customer",
        body: subject ?? actor,
        url: "/dashboard/users",
      };

    case "customer.review_submitted": {
      const rating = num(p.rating);
      return {
        title: `New review${rating !== null ? ` · ${rating}★` : ""}`,
        body: subject ? `On ${subject}` : null,
        url: "/dashboard/products",
      };
    }

    case "enquiry.received":
      return {
        title: "New enquiry",
        body: [actor, str(p.subject)].filter(Boolean).join(" · ") || null,
        url: str(event.subjectId)
          ? `/dashboard/enquiries/${event.subjectId}`
          : "/dashboard/enquiries",
      };

    case "whatsapp.message_received":
      return {
        title: "New WhatsApp message",
        // The preview is bounded at emit time; the sender's name or number is
        // the subject label.
        body: [subject, str(p.preview)].filter(Boolean).join(" · ") || null,
        url: str(event.subjectId)
          ? `/dashboard/inbox?c=${encodeURIComponent(str(event.subjectId) ?? "")}`
          : "/dashboard/inbox",
      };

    case "whatsapp.conversation_assigned":
      return {
        title: "WhatsApp conversation assigned to you",
        body:
          [subject, str(p.assignedBy) ? `by ${str(p.assignedBy)}` : null]
            .filter(Boolean)
            .join(" · ") || null,
        url: str(event.subjectId)
          ? `/dashboard/inbox?c=${encodeURIComponent(str(event.subjectId) ?? "")}`
          : "/dashboard/inbox",
      };

    // ── Content ───────────────────────────────────────────────────────────
    case "blog.submitted":
      return {
        title: "Blog submitted for review",
        body:
          [subject, actor && `by ${actor}`].filter(Boolean).join(" · ") || null,
        url: "/dashboard/blogs",
      };

    case "blog.published":
      return {
        title: `Blog published${subject ? ` · ${subject}` : ""}`,
        body: actor ? `Published by ${actor}` : null,
        url: "/dashboard/blogs",
      };

    case "blog.approved":
      return {
        title: "Your post is live",
        body: subject ? `“${subject}” was approved and published.` : null,
        url: str(p.slug) ? `/blogs/${str(p.slug)}` : "/blogs/my-submissions",
      };

    case "blog.rejected":
      return {
        title: "Your post wasn't published",
        body:
          str(p.reason) ??
          (subject ? `“${subject}” was not approved this time.` : null),
        url: "/blogs/my-submissions",
      };

    case "blog.comment_posted":
      return {
        title: "New blog comment",
        body:
          [subject, actor && `by ${actor}`].filter(Boolean).join(" · ") || null,
        url: "/dashboard/blogs",
      };

    // ── Marketing ─────────────────────────────────────────────────────────
    case "campaign.sent": {
      const sent = num(p.sent);
      return {
        title: "Email campaign sent",
        body: sent === null ? subject : `Delivered to ${sent} recipients.`,
        url: "/dashboard/marketing/coupons",
      };
    }

    // ── Team & security ───────────────────────────────────────────────────
    case "admin.invited":
      return {
        title: "Team member invited",
        body:
          [subject, actor && `by ${actor}`].filter(Boolean).join(" · ") || null,
        url: "/dashboard/admins",
      };

    case "admin.role_changed":
      return {
        title: "Team member's role changed",
        body:
          [subject, str(p.role) && `now ${str(p.role)}`, actor && `by ${actor}`]
            .filter(Boolean)
            .join(" · ") || null,
        url: "/dashboard/admins",
      };

    case "admin.removed":
      return {
        title: "Team member removed",
        body:
          [subject, actor && `by ${actor}`].filter(Boolean).join(" · ") || null,
        url: "/dashboard/admins",
      };

    case "security.password_changed":
      return {
        title: "Password changed",
        body: subject
          ? `The password for ${subject} was changed. If this wasn't you, reset it now.`
          : "An account password was changed. If this wasn't you, reset it now.",
        url: "/dashboard/settings/account",
      };

    // ── Plans & Billing ───────────────────────────────────────────────────
    case "plan.changed":
      return {
        title: `Plan changed${str(p.plan) ? ` · ${str(p.plan)}` : ""}`,
        body: str(p.note) ?? (actor ? `Changed by ${actor}` : null),
        url: "/dashboard/plans",
      };

    case "plan.expiring": {
      const days = num(p.daysLeft);
      return {
        title: "Your plan is expiring",
        body:
          days === null
            ? "Renew to keep your paid features."
            : `${days} day${days === 1 ? "" : "s"} left before this store returns to Free.`,
        url: "/dashboard/plans",
      };
    }

    case "subscription.payment_failed":
      return {
        title: "Subscription payment failed",
        body:
          str(p.reason) ??
          "We couldn't collect your plan payment. Update your payment method to avoid losing paid features.",
        url: "/dashboard/plans",
      };

    case "ai.credits_low": {
      const left = num(p.balance);
      return {
        title: "Mink credits running low",
        body:
          left === null
            ? "Top up to keep generating."
            : `${left} generation${left === 1 ? "" : "s"} left this month.`,
        url: "/dashboard/ai",
      };
    }

    case "ai.credits_purchased": {
      const credits = num(p.credits);
      return {
        title: "Mink credits added",
        body:
          credits === null
            ? null
            : `${credits} credits are now in your balance.`,
        url: "/dashboard/ai",
      };
    }

    case "mink.workflow_completed":
      return {
        title: "Mink workflow ready",
        body: subject ?? "Your requested Mink workflow is complete.",
        url: safeDashboardUrl(p.url),
      };

    case "mink.revamp_ready":
      return {
        title: "Your storefront redesign is ready",
        body: "Open Mink AI to review it and apply it to your Website Builder draft.",
        url: safeDashboardUrl(p.url),
      };

    case "mink.watch_ready":
      return {
        title: "Your Mink watch has an update",
        body: "Open your private watches to review the latest evidence.",
        url: "/dashboard/mink-watches",
      };

    // The merchant's own welcome. Deliberately separate from
    // platform.store_created below, which is the operators' copy of the same
    // moment — different audience, different words, different destination.
    case "store.created":
      return {
        title: `Welcome to StoreMink, ${subject ?? "your store"} is ready`,
        // Not "live": a new store stays behind a password until its owner
        // completes the go-live checklist and presses Go live.
        body: str(p.store_url) || null,
        url: "/dashboard",
      };

    // The moment the password page comes down. The address, not /dashboard:
    // the one thing anyone wants on being told this is to see the shop.
    case "store.launched":
      return {
        title: `${subject ?? "Your store"} is open to customers`,
        body: str(p.store_url) || null,
        url: str(p.store_url) || "/",
      };

    // The merchant milestone. platform.domain_verified below is the operators'
    // copy of the same moment, with the store named rather than addressed.
    case "store.domain_live":
      return {
        title: `${subject ?? "Your domain"} is live`,
        body: str(p.extra_hosts)
          ? `Also serving ${str(p.extra_hosts)}`
          : "Your store is now open on your own domain.",
        // The DOMAIN, not /dashboard: the one thing anyone wants on being told
        // this is to click through and see their own shop answer on it.
        url: str(p.store_url) || "/dashboard/settings/domain",
      };

    case "store.comp_ended":
      return {
        title: `Your free ${str(p.comp_plan) || "plan"} upgrade has ended`,
        body: `You're back on ${str(p.plan) || "your usual plan"}.`,
        url: "/dashboard/plans",
      };

    case "store.domain_reverted":
      return {
        title: `${subject ?? "Your domain"} has stopped working`,
        body:
          str(p.reason) ||
          "Your store is being served on its StoreMink address again.",
        // Straight to the domain settings, where the outstanding records are.
        url: "/dashboard/settings/domain",
      };

    // ── Data (CSV import/export) ──────────────────────────────────────────
    //
    // ★ THESE CARRY A URL NOW. All three used to fall through to the default,
    // which renders the event's label and NO link — so "Import finished" sat in
    // the bell as a dead end, next to an import whose whole point is the row-by-
    // row log one click away. `subjectId` is the job id (see the emit sites).
    case "data.import_started":
      return {
        title: `Importing ${subject ?? "data"}…`,
        body: str(p.file) ?? "Running in the background.",
        url: event.subjectId
          ? `/dashboard/logs/import-export/${event.subjectId}`
          : "/dashboard/logs/import-export?kind=import",
      };

    case "data.imported": {
      // Lead with what went wrong when something did — that is the reason
      // anyone opens this — and stay quiet about zeroes otherwise.
      const failed = Number(p.failed ?? 0);
      const changed = Number(p.created ?? 0) + Number(p.updated ?? 0);
      return {
        title: failed > 0 ? "Import finished with errors" : "Import finished",
        body:
          [
            subject,
            `${changed.toLocaleString("en-IN")} row${changed === 1 ? "" : "s"}`,
            failed > 0
              ? `${failed.toLocaleString("en-IN")} couldn't be imported`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || null,
        url: event.subjectId
          ? `/dashboard/logs/import-export/${event.subjectId}`
          : "/dashboard/logs/import-export?kind=import",
      };
    }

    case "data.exported":
      return {
        title: `Exported ${subject ?? "data"}`,
        body: [actor && `By ${actor}`, str(p.file)].filter(Boolean).join(" · "),
        url: event.subjectId
          ? `/dashboard/logs/import-export/${event.subjectId}`
          : "/dashboard/logs/import-export?kind=export",
      };

    // ── Platform (operator console) ───────────────────────────────────────
    case "platform.store_created":
      return {
        title: `New store · ${subject ?? "unnamed"}`,
        body: [str(p.slug), str(p.plan)].filter(Boolean).join(" · ") || null,
        url: "/dashboard",
      };

    case "platform.store_suspended":
      return {
        title: `Store ${str(p.status) === "active" ? "reinstated" : "suspended"}${subject ? ` · ${subject}` : ""}`,
        body: actor ? `By ${actor}` : null,
        url: "/dashboard",
      };

    case "platform.plan_changed":
      return {
        title: `Store plan changed${subject ? ` · ${subject}` : ""}`,
        body:
          [str(p.plan), actor && `by ${actor}`].filter(Boolean).join(" · ") ||
          null,
        url: "/dashboard",
      };

    case "platform.domain_verified":
      return {
        title: `Custom domain verified${subject ? ` · ${subject}` : ""}`,
        body: str(p.domain),
        url: "/dashboard",
      };

    // ── Theme Studio (the operator who started the theme) ─────────────────
    // The bell line and the email are the same copy (record.ts emailFor):
    // the theme's name in the title, a fixed sentence in the body, and a
    // link to the theme's own page in the operator console.
    case "platform.theme_studio_ready":
      return {
        title: subject
          ? `Ready to publish · ${subject}`
          : "A theme is ready to publish",
        body: "Theme Studio finished building and checking this theme. Open it to look it over, read any warnings and publish it.",
        url: themeStudioUrl(event),
      };

    case "platform.theme_studio_needs_fix":
      return {
        title: subject ? `Needs a fix · ${subject}` : "A theme needs a fix",
        body: "Theme Studio stopped before this theme was ready. Open it to see why and what to do next.",
        url: themeStudioUrl(event),
      };

    case "platform.theme_studio_questions":
      return {
        title: subject
          ? `Questions about ${subject}`
          : "Theme Studio has questions",
        body: "Theme Studio needs a few answers before it can design this theme. Open it to reply.",
        url: themeStudioUrl(event),
      };

    // ── Takedowns: StoreMink to the store (design 7.5) ─────────────────────
    // The words are copy.ts's; the subject is the block, the label its item.
    case "store.content_blocked":
    case "store.content_block_lifted":
    case "store.content_block_reply": {
      const kind = p.kind;
      const url = storeNoticeUrl(event);
      if (!isOneOf(BLOCK_KINDS, kind)) {
        const words =
          event.type === "store.content_blocked"
            ? STORE_EVENTS.contentBlocked
            : event.type === "store.content_block_lifted"
              ? STORE_EVENTS.blockLifted
              : STORE_EVENTS.reply;
        return { title: words.label, body: null, url };
      }
      const facts = {
        kind,
        contentType: str(p.contentType),
        itemLabel: subject,
      };
      const bell =
        event.type === "store.content_blocked"
          ? blockedBell(facts)
          : event.type === "store.content_block_lifted"
            ? liftedBell(facts)
            : replyBell(facts);
      return { title: bell.title, body: bell.body, url };
    }

    // ── Complaints and takedowns: the operators (design 7.5) ──────────────
    // Emitted with storeId null (lib/moderation/notify.ts); the store, if
    // any, is named in the payload, never carried as the event's store.
    case "platform.complaint_urgent": {
      const ref = complaintRefOf(subject);
      const kind = isOneOf(COMPLAINT_KINDS, p.kind) ? p.kind : null;
      const stage = isOneOf(DEADLINE_STAGES, p.stage) ? p.stage : "act";
      const due = istTime(p.dueAt);
      return {
        title: kind
          ? `Urgent: ${complaintKindLabel(kind)}${ref ? ` ${ref}` : ""}`
          : `Urgent complaint${ref ? ` ${ref}` : ""}`,
        body: kind && due ? `${deadlineLabel(kind, stage)} ${due}.` : null,
        url: complaintUrl(ref),
      };
    }

    case "platform.complaint_due": {
      const ref = complaintRefOf(subject);
      const kind = isOneOf(COMPLAINT_KINDS, p.kind) ? p.kind : null;
      const stage = isOneOf(DEADLINE_STAGES, p.stage) ? p.stage : null;
      const when = minutesWords(p.minutes);
      const what =
        kind && stage
          ? deadlineLabel(kind, stage).replace(/ by$/, "")
          : "A deadline";
      const timing = !when
        ? "due soon"
        : str(p.phase) === "overdue"
          ? `overdue by ${when}`
          : `due in ${when}`;
      const title = `${ref ? `${ref}: ` : ""}${what} ${timing}`;
      const store = str(p.storeName);
      return {
        title,
        body:
          [kind && `${complaintKindLabel(kind)}.`, store && `${store}.`]
            .filter(Boolean)
            .join(" ") || null,
        url: complaintUrl(ref),
      };
    }

    case "platform.takedown_reply": {
      const store = str(p.storeName);
      return {
        title:
          store && subject
            ? `${store} replied about ${subject}`
            : store
              ? `${store} replied about a block`
              : "A store replied about a block",
        body: p.askedForReview === true ? "They ask for a review." : null,
        url: consoleBlockUrl(event),
      };
    }

    default:
      return fallback;
  }
}
