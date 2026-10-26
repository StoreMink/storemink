// ---------------------------------------------------------------------------
// Words a merchant types into a search box, as a prefix text search. Pure and
// client-safe: the Mink AI History search sends the same words the server
// matches (lib/mink/conversation-history.ts), and the sidebar bolds those
// words in each title (app/dashboard/mink-history-sidebar.tsx).
//
// ★★ A WORD IS WHAT SITS BETWEEN SPACES, KEPT WHOLE. The message index is
//   built by Postgres's own text-search parser, which keeps an email, a
//   phone number with its "+", "98765-43210", "1299.50", "DIWALI-20", a file
//   name or a web address together, and keeps a zero-width joiner inside an
//   Indic word. Splitting the typed text by another rule found none of them.
//   So a word is only cut at spaces here; the server asks the SAME parser for
//   its lexemes (`prefixTsQuery` takes them) and matches those, and titles
//   are matched, and bolded, by the word itself.
// ★ A word needs at least two letters or numbers in any script ("a", "?",
//   "₹5" and an emoji search nothing).
// ---------------------------------------------------------------------------

/** At most this many words are searched; the rest are ignored. */
export const MAX_SEARCH_WORDS = 6;

/** A word needs this many letters or numbers; a shorter one matches nearly everything. */
export const MIN_SEARCH_WORD_LENGTH = 2;

/** What is searched of the typed text: trimmed, spaces collapsed, this long. */
export const MAX_SEARCH_QUERY_LENGTH = 80;

/** At most this many of one word's lexemes are matched (the longest). */
export const MAX_LEXEMES_PER_WORD = 8;

const SPACES = /\s+/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/gu;
// Control characters cannot reach Postgres text; a zero-width joiner (a
// format character, not a control one) stays inside its word.
const CONTROL = /\p{Cc}/gu;

/**
 * What a search box's text searches for: trimmed, every run of spaces one
 * space, cut to `MAX_SEARCH_QUERY_LENGTH` characters (never inside a letter
 * made of two UTF-16 units). The browser and the server cut it alike.
 */
export function normaliseSearchQuery(text: string): string {
  return Array.from(text.trim().replace(/\s+/g, " "))
    .slice(0, MAX_SEARCH_QUERY_LENGTH)
    .join("");
}

/**
 * The searchable words of what was typed: cut at spaces only, lower-cased,
 * each with at least two letters or numbers, each once, at most six. Empty
 * when nothing searchable was typed ("?", "a b", an emoji).
 */
export function searchWords(q: string): string[] {
  const words: string[] = [];
  for (const part of q.split(SPACES)) {
    const word = part.replace(CONTROL, "").toLowerCase();
    if (
      (word.match(LETTER_OR_NUMBER)?.length ?? 0) < MIN_SEARCH_WORD_LENGTH ||
      words.includes(word)
    )
      continue;
    words.push(word);
    if (words.length === MAX_SEARCH_WORDS) break;
  }
  return words;
}

/** One searched word and the lexemes Postgres's text-search parser made of it. */
export interface SearchWordLexemes {
  /** The word, lower-cased by Postgres. */
  word: string;
  lexemes: readonly string[];
}

/**
 * A lexeme as one prefix item of a text-search query. ★ Always quoted, with
 * its quotes and backslashes escaped, so no character in it can act as an
 * operator: the query never carries one of the merchant's making.
 */
function prefixItem(lexeme: string): string {
  return `'${lexeme.replace(/\\/g, "\\\\").replace(/'/g, "''")}':*`;
}

function byLengthThenText(left: string, right: string): number {
  if (left.length !== right.length) return right.length - left.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The words as a Postgres text-search query, read as `tsquery` input (no
 * second parse): every word required; a word matches when every lexeme the
 * parser made of it is a prefix of a lexeme of the message ("98765-43210" is
 * "98765" and "-43210"; "t-shirt" is "t-shirt" and "shirt"), or when the word
 * whole is (an email typed halfway, "priya.sharma@gm"). Lexemes of one
 * character are left out, as one-letter words are. Null when there is no word.
 */
export function prefixTsQuery(
  words: readonly SearchWordLexemes[],
): string | null {
  const parts = words.map(({ word, lexemes }) => {
    const items = [...new Set(lexemes)]
      .filter((lexeme) => Array.from(lexeme).length >= MIN_SEARCH_WORD_LENGTH)
      .sort(byLengthThenText)
      .slice(0, MAX_LEXEMES_PER_WORD);
    if (items.length === 0 || (items.length === 1 && items[0] === word))
      return prefixItem(word);
    const all = items.map(prefixItem).join(" & ");
    return items.includes(word) ? `(${all})` : `(${all} | ${prefixItem(word)})`;
  });
  return parts.length ? parts.join(" & ") : null;
}

/** The pieces of a search snippet: `«` and `»` wrap each matched word. */
export function splitSnippet(
  snippet: string,
): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  const re = /«([^»]*)»/g;
  let last = 0;
  for (const m of snippet.matchAll(re)) {
    if (m.index > last)
      out.push({ text: snippet.slice(last, m.index), hit: false });
    out.push({ text: m[1] ?? "", hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length)
    out.push({ text: snippet.slice(last), hit: false });
  return out;
}

/**
 * A title split around every case-insensitive occurrence of the searched
 * words, for bolding them where the server's title match found them. Plain
 * text pieces only: React renders each as text, never as markup.
 */
export function splitTitleMatches(
  title: string,
  words: readonly string[],
): { text: string; hit: boolean }[] {
  const lower = title.toLowerCase();
  // ★ Only when lower-casing kept every index where it was (true for the
  //   scripts merchants write in; a few letters change length, and then the
  //   title is shown unbolded rather than bolded in the wrong place).
  if (words.length === 0 || lower.length !== title.length)
    return title ? [{ text: title, hit: false }] : [];
  const hits = new Array<boolean>(title.length).fill(false);
  for (const word of words) {
    let from = lower.indexOf(word);
    while (from !== -1) {
      hits.fill(true, from, from + word.length);
      from = lower.indexOf(word, from + word.length);
    }
  }
  const out: { text: string; hit: boolean }[] = [];
  let start = 0;
  for (let index = 1; index <= title.length; index += 1) {
    if (index === title.length || hits[index] !== hits[start]) {
      out.push({ text: title.slice(start, index), hit: hits[start] });
      start = index;
    }
  }
  return out;
}
