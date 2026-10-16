// ---------------------------------------------------------------------------
// One Meta `messages` webhook item → one inbox message. Pure, so every message
// type Meta documents can be pinned without a database or a token.
//
// Meta's shape (docs/whatsapp-phase0.md): `value.messages[n]` carries `from`
// (the customer's wa_id, digits with country code), `id` (wamid), `timestamp`
// (epoch seconds as a string), `type`, and one object named after the type:
// text{body}, image/video/document/sticker/audio{id, mime_type, caption?,
// filename?}, location{latitude, longitude, name?, address?}, contacts[],
// button{text, payload}, interactive{button_reply|list_reply{id, title}},
// order{catalog_id, product_items[]}, reaction{message_id, emoji}. `context`
// names the message replied to; `referral` carries a click-to-WhatsApp ad.
// `value.contacts[0].profile.name` is the sender's WhatsApp display name.
//
// ★ EVERYTHING HERE IS UNTRUSTED DATA. A display name is whatever the
// customer typed into WhatsApp, a caption is free text, a `payload` on a
// button is a string we did not write. Nothing is interpreted beyond its
// shape; bounds are applied so a hostile payload cannot grow a row without
// limit.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null;

/** WhatsApp's own message ceiling. */
export const MAX_BODY_CHARS = 4096;
const MAX_NAME_CHARS = 200;
const MAX_PAYLOAD_ITEMS = 50;

export type InboxMessageKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "contacts"
  | "order"
  | "interactive"
  | "button"
  | "reaction"
  | "template"
  | "unsupported";

export const MEDIA_KINDS: ReadonlySet<InboxMessageKind> = new Set([
  "image",
  "video",
  "audio",
  "document",
  "sticker",
]);

export interface ParsedMedia {
  id: string;
  mime: string | null;
  filename: string | null;
}

export interface ParsedInboundMessage {
  providerId: string;
  /** Digits, country code first — Meta's wa_id. */
  waId: string;
  /** E.164. */
  phone: string;
  profileName: string | null;
  kind: InboxMessageKind;
  body: string | null;
  media: ParsedMedia | null;
  payload: Rec | null;
  quotedProviderId: string | null;
  referral: Rec | null;
  /** ISO. Meta's clock; ours when the timestamp is missing or absurd. */
  sentAt: string;
}

function clip(value: string | null, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function epoch(value: unknown): string {
  const n = Number(value);
  if (Number.isFinite(n) && n > 1_000_000_000 && n < 100_000_000_000) {
    return new Date(n * 1000).toISOString();
  }
  return new Date().toISOString();
}

function mediaOf(obj: unknown): ParsedMedia | null {
  if (!isRec(obj)) return null;
  const id = str(obj.id);
  if (!id) return null;
  return {
    id,
    mime: clip(str(obj.mime_type), 120),
    filename: clip(str(obj.filename), 200),
  };
}

/** Meta's wa_id → E.164. A wa_id is always digits with the country code. */
export function phoneFromWaId(waId: string): string | null {
  const digits = waId.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/**
 * Parse one inbound message item plus the `contacts` array that arrived with
 * it. Returns null when the item cannot be a message we can file (no id, no
 * sender) — such an event is marked processed with an error, never retried.
 */
export function parseInboundMessage(
  message: unknown,
  contacts: unknown,
): ParsedInboundMessage | null {
  if (!isRec(message)) return null;
  const providerId = str(message.id);
  const waId = str(message.from)?.replace(/\D/g, "") ?? null;
  if (!providerId || !waId) return null;
  const phone = phoneFromWaId(waId);
  if (!phone) return null;

  let profileName: string | null = null;
  if (Array.isArray(contacts)) {
    for (const c of contacts) {
      if (!isRec(c)) continue;
      if (str(c.wa_id)?.replace(/\D/g, "") !== waId) continue;
      const profile = isRec(c.profile) ? c.profile : {};
      profileName = clip(str(profile.name)?.trim() ?? null, MAX_NAME_CHARS);
      break;
    }
  }

  const context = isRec(message.context) ? message.context : null;
  const quotedProviderId = context ? str(context.id) : null;
  const referral = isRec(message.referral)
    ? boundedPayload(message.referral)
    : null;
  const sentAt = epoch(message.timestamp);

  const base = {
    providerId,
    waId,
    phone,
    profileName,
    quotedProviderId,
    referral,
    sentAt,
    media: null as ParsedMedia | null,
    payload: null as Rec | null,
  };

  const type = str(message.type) ?? "unsupported";
  switch (type) {
    case "text": {
      const text = isRec(message.text) ? message.text : {};
      return {
        ...base,
        kind: "text",
        body: clip(str(text.body), MAX_BODY_CHARS),
      };
    }
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const obj = isRec(message[type]) ? message[type] : {};
      return {
        ...base,
        kind: type,
        body: clip(str(obj.caption), MAX_BODY_CHARS),
        media: mediaOf(obj),
      };
    }
    case "location": {
      const loc = isRec(message.location) ? message.location : {};
      const lat = Number(loc.latitude);
      const lng = Number(loc.longitude);
      const label = [str(loc.name), str(loc.address)]
        .filter(Boolean)
        .join(", ");
      return {
        ...base,
        kind: "location",
        body: clip(
          label
            ? `📍 ${label}`
            : Number.isFinite(lat) && Number.isFinite(lng)
              ? `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}`
              : "📍 Location",
          MAX_BODY_CHARS,
        ),
        payload:
          Number.isFinite(lat) && Number.isFinite(lng)
            ? {
                latitude: lat,
                longitude: lng,
                name: clip(str(loc.name), 200),
                address: clip(str(loc.address), 400),
              }
            : null,
      };
    }
    case "contacts": {
      const list = Array.isArray(message.contacts) ? message.contacts : [];
      const names: string[] = [];
      const shared: Rec[] = [];
      for (const c of list.slice(0, MAX_PAYLOAD_ITEMS)) {
        if (!isRec(c)) continue;
        const name = isRec(c.name) ? c.name : {};
        const formatted = clip(str(name.formatted_name), MAX_NAME_CHARS);
        const phones = Array.isArray(c.phones)
          ? c.phones
              .map((p) => (isRec(p) ? clip(str(p.phone), 40) : null))
              .filter((p): p is string => Boolean(p))
              .slice(0, 5)
          : [];
        if (formatted) names.push(formatted);
        shared.push({ name: formatted, phones });
      }
      return {
        ...base,
        kind: "contacts",
        body: clip(
          names.length ? `👤 ${names.join(", ")}` : "👤 Shared a contact",
          MAX_BODY_CHARS,
        ),
        payload: { contacts: shared },
      };
    }
    case "button": {
      const b = isRec(message.button) ? message.button : {};
      return {
        ...base,
        kind: "button",
        body: clip(str(b.text), MAX_BODY_CHARS),
        payload: { buttonPayload: clip(str(b.payload), 256) },
      };
    }
    case "interactive": {
      const i = isRec(message.interactive) ? message.interactive : {};
      const reply = isRec(i.button_reply)
        ? i.button_reply
        : isRec(i.list_reply)
          ? i.list_reply
          : {};
      return {
        ...base,
        kind: "interactive",
        body: clip(str(reply.title), MAX_BODY_CHARS),
        payload: {
          replyId: clip(str(reply.id), 256),
          replyType: isRec(i.button_reply) ? "button" : "list",
        },
      };
    }
    case "order": {
      const o = isRec(message.order) ? message.order : {};
      const items = Array.isArray(o.product_items)
        ? o.product_items.slice(0, MAX_PAYLOAD_ITEMS).filter(isRec)
        : [];
      const count = items.reduce(
        (n, it) => n + (Number(it.quantity) > 0 ? Number(it.quantity) : 1),
        0,
      );
      return {
        ...base,
        kind: "order",
        body: clip(
          `🛒 Sent a cart with ${count} item${count === 1 ? "" : "s"}${str(o.text) ? ` - ${str(o.text)}` : ""}`,
          MAX_BODY_CHARS,
        ),
        payload: {
          catalogId: clip(str(o.catalog_id), 64),
          items: items.map((it) => ({
            retailerId: clip(str(it.product_retailer_id), 128),
            quantity: Number(it.quantity) || 1,
            price: Number(it.item_price) || null,
            currency: clip(str(it.currency), 8),
          })),
        },
      };
    }
    case "reaction": {
      const r = isRec(message.reaction) ? message.reaction : {};
      return {
        ...base,
        kind: "reaction",
        body: clip(str(r.emoji), 16),
        quotedProviderId: str(r.message_id) ?? quotedProviderId,
      };
    }
    default: {
      const errors = Array.isArray(message.errors) ? message.errors : [];
      const first = isRec(errors[0]) ? errors[0] : null;
      return {
        ...base,
        kind: "unsupported",
        body: clip(
          first && str(first.title)
            ? `(Unsupported message: ${str(first.title)})`
            : `(Unsupported message type: ${type})`,
          MAX_BODY_CHARS,
        ),
      };
    }
  }
}

/** Keep a jsonb payload small: shallow, strings clipped, few keys. */
function boundedPayload(rec: Rec): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(rec).slice(0, 20)) {
    if (typeof v === "string") out[k] = clip(v, 500);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

export interface ParsedEchoMessage {
  providerId: string;
  /** The CUSTOMER's wa_id — `to` on an echo. */
  waId: string;
  phone: string;
  kind: InboxMessageKind;
  body: string | null;
  media: ParsedMedia | null;
  sentAt: string;
}

/**
 * A message the merchant sent from the WhatsApp Business app, echoed to us
 * under Coexistence (`smb_message_echoes`). Same inner shape as an inbound
 * message with `from` and `to` swapped: `to` is the customer.
 */
export function parseEchoMessage(echo: unknown): ParsedEchoMessage | null {
  if (!isRec(echo)) return null;
  const providerId = str(echo.id);
  const waId = str(echo.to)?.replace(/\D/g, "") ?? null;
  if (!providerId || !waId) return null;
  const phone = phoneFromWaId(waId);
  if (!phone) return null;
  // Re-use the inbound parser for the type switch by presenting the echo as
  // if the customer were the sender; only the kind/body/media are read.
  const parsed = parseInboundMessage({ ...echo, from: waId }, []);
  if (!parsed) return null;
  return {
    providerId,
    waId,
    phone,
    kind: parsed.kind,
    body: parsed.body,
    media: parsed.media,
    sentAt: parsed.sentAt,
  };
}

/** The first line of a message, for the conversation list and the bell. */
export function previewOf(body: string | null, kind: InboxMessageKind): string {
  const KIND_LABEL: Partial<Record<InboxMessageKind, string>> = {
    image: "📷 Photo",
    video: "🎥 Video",
    audio: "🎤 Voice message",
    document: "📄 Document",
    sticker: "Sticker",
    template: "Order update",
  };
  const line = (body ?? "").split(/\r?\n/)[0]?.trim() ?? "";
  const fallback = KIND_LABEL[kind] ?? "Message";
  const text = line
    ? MEDIA_KINDS.has(kind)
      ? `${fallback} · ${line}`
      : line
    : fallback;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
