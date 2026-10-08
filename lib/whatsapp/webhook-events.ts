// ---------------------------------------------------------------------------
// A content-free summary of a WhatsApp webhook delivery.
//
// Pure and client-safe (no imports), so the route test and a future worker can
// share it. Phase 0 only LOGS deliveries; the one thing a log line must not
// carry is what a customer wrote or who they are. This reduces a payload to
// counts: which WABA, which phone number ids, how many messages of each kind,
// how many statuses of each kind, which template/account events. Never the
// text, never a `wa_id`, never a name.
//
// Shape: { object: "whatsapp_business_account", entry: [{ id: <waba>,
//   changes: [{ field, value: { metadata: { phone_number_id }, messages?,
//   statuses?, ... } }] }] }  — see docs/whatsapp-phase0.md for the fields.
// ---------------------------------------------------------------------------

export const WHATSAPP_WEBHOOK_OBJECT = "whatsapp_business_account";

export interface WebhookSummary {
  /** WABA ids seen in this delivery (an account identifier, not a person). */
  wabaIds: string[];
  /** Phone number ids seen (the routing key for Phase 1). */
  phoneNumberIds: string[];
  /** Webhook fields seen, e.g. `messages`, `message_template_status_update`. */
  fields: string[];
  /** Inbound messages by `type` (text, image, button, order, …). */
  messages: Record<string, number>;
  /** Delivery statuses by `status` (sent, delivered, read, failed). */
  statuses: Record<string, number>;
  /** Non-message events, e.g. `message_template_status_update:APPROVED`. */
  events: string[];
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function pushUnique(list: string[], value: unknown) {
  if (typeof value === "string" && value && !list.includes(value)) {
    list.push(value);
  }
}

/** True when the body is a WhatsApp Business Account notification at all. */
export function isWhatsAppWebhook(body: unknown): body is Rec {
  return isRec(body) && body.object === WHATSAPP_WEBHOOK_OBJECT;
}

export function summarizeWebhook(body: unknown): WebhookSummary {
  const out: WebhookSummary = {
    wabaIds: [],
    phoneNumberIds: [],
    fields: [],
    messages: {},
    statuses: {},
    events: [],
  };
  if (!isRec(body) || !Array.isArray(body.entry)) return out;

  for (const entry of body.entry) {
    if (!isRec(entry)) continue;
    pushUnique(out.wabaIds, entry.id);
    if (!Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      if (!isRec(change)) continue;
      const field = typeof change.field === "string" ? change.field : "";
      pushUnique(out.fields, field);
      const value = isRec(change.value) ? change.value : {};
      const metadata = isRec(value.metadata) ? value.metadata : {};
      pushUnique(out.phoneNumberIds, metadata.phone_number_id);

      if (Array.isArray(value.messages)) {
        for (const m of value.messages) {
          bump(
            out.messages,
            isRec(m) && typeof m.type === "string" ? m.type : "unknown",
          );
        }
      }
      if (Array.isArray(value.statuses)) {
        for (const s of value.statuses) {
          bump(
            out.statuses,
            isRec(s) && typeof s.status === "string" ? s.status : "unknown",
          );
        }
      }
      if (field && field !== "messages") {
        // Template / account / quality updates carry an `event` enum
        // (APPROVED, REJECTED, PAUSED, …). The enum is safe to log; the
        // template NAME is the merchant's and is not.
        const ev = typeof value.event === "string" ? value.event : null;
        out.events.push(ev ? `${field}:${ev}` : field);
      }
    }
  }
  return out;
}
