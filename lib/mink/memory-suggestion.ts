/**
 * "Remember this?" after an answer: the one sentence of a merchant's message
 * that reads as a durable fact about them, offered back as a memory.
 *
 * ★ PURE, CLIENT-SAFE AND DETERMINISTIC. No model decides what to remember:
 * a fixed set of phrases ("from now on", "we only ship to", "our tone is")
 * marks a sentence as lasting rather than about this one request, and the
 * sentence itself becomes the memory text, so the merchant reads exactly
 * what will be kept. Saving still goes through the ordinary memories API
 * with the same explicit confirmation, limit and retention as the Memories
 * page; this only writes the suggestion, never the row.
 *
 * ★ QUESTIONS NEVER QUALIFY. "Why do I never get orders?" carries "never"
 * and is not a preference. Nor does a slash skill, an attachment reference,
 * a URL or a code block.
 */
import { MEMORY_KINDS, type MemoryKind } from "./memory-policy";

export type MinkMemorySuggestion = {
  title: string;
  content: string;
  kind: MemoryKind;
};

export const MEMORY_SUGGESTION_TITLE_MAX = 80;
export const MEMORY_SUGGESTION_CONTENT_MAX = 600;

const BUSINESS_CONTEXT =
  /\b(we (only )?(sell|make|stock|ship|deliver|serve|cater)|we('re| are) (a|an|based|located)|our (customers|buyers|shoppers|audience)\b|our (shop|store|brand|business|company) (is|does|sells|ships)|my (shop|store|brand|business) (is|does|sells|ships)|our (main|best|top)[- ]?(sell|product)|our (busiest|peak|slow) (season|month|week|day)|we (don't|do not|never) (ship|deliver|sell|offer))\b/i;
const BRAND_VOICE =
  /\b(brand voice|tone of voice|our tone|our voice|our style|house style|sound (more|less|like)|write (in|like|more|less|with)|(formal|casual|playful|friendly|warm|professional|witty|minimal|cheeky|luxurious|simple|plain) (tone|voice|style|language)|british english|american english|hinglish|emoji|emojis)\b/i;
const PREFERENCE =
  /\b(remember|from now on|going forward|in future|in the future|by default|always|never|prefer|i'd like you to|i want you to|please (keep|use|show|include|avoid))\b/i;
const QUESTION_START =
  /^(what|why|how|when|where|which|who|whose|is|are|was|were|do|does|did|can|could|should|would|will|may|might|have|has|tell me|show me|give me|find|list|check)\b/i;
const LEADING_FILLER =
  /^(ok(ay)?[,.!]?\s+|please[,]?\s+|also[,]?\s+|and\s+|btw[,]?\s+|fyi[,:]?\s+|just so you know[,]?\s+|note that\s+|note:\s+|remember that\s+|remember:\s+|remember[,]?\s+|keep in mind that\s+|keep in mind[,:]?\s+|for (future )?reference[,:]?\s+)+/i;

/** The one sentence worth remembering, or null when nothing in the message lasts. */
export function suggestMinkMemory(
  message: string,
): MinkMemorySuggestion | null {
  const text = message.normalize("NFKC").trim();
  if (!text || text.startsWith("/") || /```/.test(text)) return null;
  const sentences = text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    if (
      sentence.includes("?") ||
      /https?:\/\/|www\.|"url":|\[\[|data:/i.test(sentence) ||
      QUESTION_START.test(sentence)
    ) {
      continue;
    }
    const kind: MemoryKind | null = BUSINESS_CONTEXT.test(sentence)
      ? "business_context"
      : BRAND_VOICE.test(sentence)
        ? "brand_voice"
        : PREFERENCE.test(sentence)
          ? "preference"
          : null;
    if (!kind) continue;
    const content = cleanContent(sentence);
    if (content.split(/\s+/).length < 3 || content.length < 12) continue;
    return { kind, content, title: titleFor(content) };
  }
  return null;
}

function cleanContent(sentence: string) {
  let content = sentence.replace(LEADING_FILLER, "").trim();
  content = content.charAt(0).toUpperCase() + content.slice(1);
  if (!/[.!]$/.test(content)) content += ".";
  if (content.length > MEMORY_SUGGESTION_CONTENT_MAX) {
    content = content
      .slice(0, MEMORY_SUGGESTION_CONTENT_MAX - 1)
      .replace(/\s+\S*$/, "")
      .trimEnd();
    content += "…";
  }
  return content;
}

function titleFor(content: string) {
  const words = content.replace(/[.!…]+$/, "").split(/\s+/);
  let title = words.slice(0, 8).join(" ");
  if (words.length > 8) title += "…";
  if (title.length > MEMORY_SUGGESTION_TITLE_MAX) {
    title =
      title.slice(0, MEMORY_SUGGESTION_TITLE_MAX - 1).replace(/\s+\S*$/, "") +
      "…";
  }
  return title;
}

/** A suggestion read back off the wire, bounded the way the memories API bounds a save. */
export function readMinkMemorySuggestion(
  value: unknown,
): MinkMemorySuggestion | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.title !== "string" ||
    typeof row.content !== "string" ||
    typeof row.kind !== "string" ||
    !MEMORY_KINDS.includes(row.kind as MemoryKind) ||
    !row.title.trim() ||
    !row.content.trim() ||
    row.title.length > MEMORY_SUGGESTION_TITLE_MAX ||
    row.content.length > MEMORY_SUGGESTION_CONTENT_MAX
  ) {
    return null;
  }
  return {
    title: row.title,
    content: row.content,
    kind: row.kind as MemoryKind,
  };
}

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  preference: "Preference",
  brand_voice: "Brand voice",
  business_context: "About your business",
};

/**
 * A v4 UUID for the memories API's `id` and `requestKey`. `crypto.randomUUID`
 * is absent on a plain-http local host (localtest.me), so it falls back to
 * `getRandomValues`, which every browser has.
 */
export function minkRandomUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
