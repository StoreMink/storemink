/**
 * Marks the words of a search in a result's title or excerpt, the way the
 * Help search page shows them. Pure and client-safe.
 *
 * A word is a run of letters or digits in any script, so a Hindi or Tamil
 * search is marked as well as an English one. Short common English words
 * ("how", "my", "to") are left alone: marking them would light up most of
 * every excerpt and hide the words that matched.
 */

export interface HighlightPart {
  text: string;
  match: boolean;
}

/** At most this many words of a search are marked. */
export const MAX_HIGHLIGHT_TERMS = 6;

const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

const SKIP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "when",
  "where",
  "why",
  "with",
  "you",
  "your",
]);

/** The words of a search worth marking, longest first, without repeats. */
export function highlightTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.match(WORD) ?? []) {
    const word = raw.toLocaleLowerCase();
    if (word.length < 2 || SKIP_WORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    terms.push(raw);
    if (terms.length === MAX_HIGHLIGHT_TERMS) break;
  }
  // Longest first, so "domains" is marked whole rather than as "domain" + "s".
  return terms.sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits `text` into marked and unmarked parts. Matching ignores case, and a
 * word matches inside a longer one ("domain" in "domains"). Joining the parts'
 * text always gives back `text` exactly.
 */
export function highlightParts(
  text: string,
  terms: readonly string[],
): HighlightPart[] {
  if (!text) return [];
  if (terms.length === 0) return [{ text, match: false }];
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "giu");
  const parts: HighlightPart[] = [];
  let last = 0;
  for (const found of text.matchAll(pattern)) {
    const start = found.index ?? 0;
    if (found[0].length === 0) continue;
    if (start > last)
      parts.push({ text: text.slice(last, start), match: false });
    parts.push({ text: found[0], match: true });
    last = start + found[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts;
}
