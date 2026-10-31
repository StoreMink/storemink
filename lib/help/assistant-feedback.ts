import "server-only";

// Thumbs up and down on the public Help Centre's Mink AI answers
// (help_assistant_feedback, migration 0272). The table is service-only and has
// no Drizzle model, so every statement here is raw SQL under withService.
//
// ★ ONE ROW PER ANSWER. The browser makes a random id for its chat and one for
// each answer; the pair is unique, so a changed rating updates its row and a
// cleared rating deletes it. Nothing here identifies the visitor.
//
// ★ THE INPUT IS UNTRUSTED. It comes from a public page, so normalize() bounds
// every field to the table's CHECKs before anything is written, and the
// sources keep only Help Centre paths.

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { isHelpLanguageCode } from "@/lib/help/languages";

export const HELP_FEEDBACK_QUESTION_MAX = 1200;
export const HELP_FEEDBACK_ANSWER_MAX = 4000;
const SOURCE_LIMIT = 6;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export type HelpFeedbackRating = "up" | "down";

export interface HelpFeedbackSource {
  title: string;
  url: string;
  category: string | null;
}

export interface HelpFeedbackInput {
  conversationId: string;
  messageKey: string;
  /** null clears a rating the visitor gave earlier. */
  rating: HelpFeedbackRating | null;
  language: string | null;
  question: string;
  answer: string;
  sources: HelpFeedbackSource[];
}

export interface NormalizedHelpFeedback {
  conversationId: string;
  messageKey: string;
  rating: HelpFeedbackRating | null;
  language: string | null;
  question: string;
  answer: string;
  sources: HelpFeedbackSource[];
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, max)
    : "";
}

function cleanSources(value: unknown): HelpFeedbackSource[] {
  if (!Array.isArray(value)) return [];
  const sources: HelpFeedbackSource[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const url = cleanText(record.url, 300);
    const title = cleanText(record.title, 200);
    if (!title || !/^\/help\/[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(url)) continue;
    const category = cleanText(record.category, 120) || null;
    sources.push({ title, url, category });
    if (sources.length >= SOURCE_LIMIT) break;
  }
  return sources;
}

/**
 * Bounds a rating from the browser to what the table accepts, or answers why
 * it cannot be stored. Pure, so the action and its tests share one rule.
 */
export function normalizeHelpFeedback(
  raw: unknown,
): { ok: true; value: NormalizedHelpFeedback } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "That rating couldn't be read." };
  }
  const input = raw as Record<string, unknown>;
  const conversationId =
    typeof input.conversationId === "string" ? input.conversationId : "";
  const messageKey =
    typeof input.messageKey === "string" ? input.messageKey : "";
  if (!ID_PATTERN.test(conversationId) || !ID_PATTERN.test(messageKey)) {
    return { ok: false, error: "That rating couldn't be read." };
  }
  const rating =
    input.rating === "up" || input.rating === "down" ? input.rating : null;
  if (input.rating !== null && rating === null) {
    return { ok: false, error: "That rating couldn't be read." };
  }
  const question = cleanText(input.question, HELP_FEEDBACK_QUESTION_MAX);
  const answer = cleanText(input.answer, HELP_FEEDBACK_ANSWER_MAX);
  if (rating && (!question || !answer)) {
    return { ok: false, error: "That rating couldn't be read." };
  }
  return {
    ok: true,
    value: {
      conversationId,
      messageKey,
      rating,
      language: isHelpLanguageCode(input.language) ? input.language : null,
      question,
      answer,
      sources: cleanSources(input.sources),
    },
  };
}

/** Records, changes or clears one answer's rating. Throws on a database error. */
export async function saveHelpFeedback(
  feedback: NormalizedHelpFeedback,
): Promise<void> {
  await withService(async (db) => {
    if (feedback.rating === null) {
      await db.execute(sql`
        DELETE FROM public.help_assistant_feedback
         WHERE conversation_id = ${feedback.conversationId}
           AND message_key = ${feedback.messageKey}
      `);
      return;
    }
    await db.execute(sql`
      INSERT INTO public.help_assistant_feedback
        (conversation_id, message_key, rating, language, question, answer, sources)
      VALUES (
        ${feedback.conversationId},
        ${feedback.messageKey},
        ${feedback.rating},
        ${feedback.language},
        ${feedback.question},
        ${feedback.answer},
        ${JSON.stringify(feedback.sources)}::jsonb
      )
      ON CONFLICT (conversation_id, message_key) DO UPDATE
        SET rating = excluded.rating,
            language = excluded.language,
            question = excluded.question,
            answer = excluded.answer,
            sources = excluded.sources,
            updated_at = now()
    `);
  });
}

export interface HelpFeedbackRow {
  id: string;
  rating: HelpFeedbackRating;
  language: string | null;
  question: string;
  answer: string;
  sources: HelpFeedbackSource[];
  createdAt: string;
  updatedAt: string;
}

export interface HelpFeedbackCounts {
  up: number;
  down: number;
  last30Up: number;
  last30Down: number;
}

export type HelpFeedbackFilter = "all" | "down" | "up";

export const HELP_FEEDBACK_PAGE_SIZE = 50;

function readSources(value: unknown): HelpFeedbackSource[] {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;
  return cleanSources(parsed);
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}

/** The newest ratings, for the operator console. Throws on a database error. */
export async function listHelpFeedback(options: {
  filter: HelpFeedbackFilter;
  page: number;
}): Promise<{ rows: HelpFeedbackRow[]; hasMore: boolean }> {
  const page = Math.max(1, Math.floor(options.page) || 1);
  const offset = (page - 1) * HELP_FEEDBACK_PAGE_SIZE;
  const ratingFilter =
    options.filter === "all" ? sql`true` : sql`rating = ${options.filter}`;
  const result = await withService((db) =>
    db.execute(sql`
      SELECT id, rating, language, question, answer, sources,
             created_at, updated_at
        FROM public.help_assistant_feedback
       WHERE ${ratingFilter}
       ORDER BY updated_at DESC, id
       LIMIT ${HELP_FEEDBACK_PAGE_SIZE + 1}
      OFFSET ${offset}
    `),
  );
  const rows = (result.rows as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    rating: row.rating === "up" ? ("up" as const) : ("down" as const),
    language: typeof row.language === "string" ? row.language : null,
    question: String(row.question ?? ""),
    answer: String(row.answer ?? ""),
    sources: readSources(row.sources),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));
  return {
    rows: rows.slice(0, HELP_FEEDBACK_PAGE_SIZE),
    hasMore: rows.length > HELP_FEEDBACK_PAGE_SIZE,
  };
}

/** All-time and last-30-day counts. Throws on a database error. */
export async function countHelpFeedback(): Promise<HelpFeedbackCounts> {
  const result = await withService((db) =>
    db.execute(sql`
      SELECT
        count(*) FILTER (WHERE rating = 'up')::int AS up,
        count(*) FILTER (WHERE rating = 'down')::int AS down,
        count(*) FILTER (
          WHERE rating = 'up' AND updated_at > now() - interval '30 days'
        )::int AS last30_up,
        count(*) FILTER (
          WHERE rating = 'down' AND updated_at > now() - interval '30 days'
        )::int AS last30_down
      FROM public.help_assistant_feedback
    `),
  );
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    up: Number(row.up ?? 0),
    down: Number(row.down ?? 0),
    last30Up: Number(row.last30_up ?? 0),
    last30Down: Number(row.last30_down ?? 0),
  };
}
