/**
 * What a Mink answer sounds like when it is read aloud.
 *
 * Pure and client-safe: the dashboard composer's voice chat hands a finished
 * answer to window.speechSynthesis, and a synthesiser reads markup literally
 * ("asterisk asterisk", "pipe", "slash dashboard slash orders"). Nothing here
 * imports React or the DOM, so the storefront, a worker or a test can call it.
 *
 * ★ A TABLE BECOMES "label: value" LINES, not a stream of cells: a row read as
 * "Milk 12 240" tells nobody which number is the stock, while "Product: Milk,
 * Units: 12, Sales: 240." does. The header row supplies the labels; a table
 * with no header uses each row's first cell as the label.
 * ★ CODE BLOCKS AND DASHBOARD PATHS ARE DROPPED, never spoken: a CSV header or
 * a `/dashboard/orders/abc` link carries nothing a listener can act on, and a
 * synthesiser spells a path one slash at a time.
 * ★ THE CAP IS AT A SENTENCE BOUNDARY. A long answer is cut where a sentence
 * ends, so the last thing heard is a whole thought rather than half a figure.
 */

export const SPEAKABLE_MAX_CHARS = 1_500;

/**
 * The longest text one read-aloud request may carry. ★ It is a cost bound,
 * not a style choice: the voice loop cuts every answer into pieces no longer
 * than this and the speech route refuses anything longer, so the route's rate
 * limits (a request per sentence or two) cap the characters a merchant can
 * have read aloud, which StoreMink pays for and does not charge.
 */
export const MINK_SPEECH_PIECE_MAX = 600;
/** The first piece of an answer is shorter, so the first words play sooner. */
export const MINK_SPEECH_FIRST_PIECE_MAX = 160;

/** A line that already ends a sentence, or one that clearly continues (a comma). */
const ENDED = /(?:[.!?।…]|[,;:])["')\]]*$/;
const SENTENCE_BOUNDARY = /[.!?।…]["')\]]*(?=\s)/g;
const TABLE_SEPARATOR = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;

function ensureStop(line: string): string {
  return ENDED.test(line) ? line : `${line}.`;
}

function isTableRow(line: string): boolean {
  return line.startsWith("|") && line.length > 1 && line.includes("|", 1);
}

function tableCells(line: string): string[] {
  const inner = line.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => inlineClean(cell));
}

/** Markup inside one line, reduced to the words a listener needs. */
function inlineClean(raw: string): string {
  let text = raw;
  // Images carry their alt text, links keep their text, everything else about
  // a URL is dropped: a spoken address is noise.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  text = text.replace(/<[^>\n]+>/g, " ");
  text = text.replace(/https?:\/\/\S+/g, "");
  text = text.replace(
    /(?:^|(?<=[\s(]))\/dashboard(?:\/[\w.~-]+)*\/?(?=[\s).,;:!?]|$)/g,
    "",
  );
  text = text.replace(/`([^`\n]*)`/g, "$1");
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  text = text.replace(/(^|[^\w*])\*(?!\s)([^*\n]*?[^\s*])\*(?![\w*])/g, "$1$2");
  text = text.replace(/(^|[^\w_])_(?!\s)([^_\n]*?[^\s_])_(?![\w_])/g, "$1$2");
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
  text = text.replace(/\(\s*\)/g, "");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function speakTable(rows: string[][]): string[] {
  if (!rows.length) return [];
  const hasHeader = rows.length > 1 && rows[1].every((cell) => cell === "");
  const header = hasHeader ? rows[0] : null;
  const data = hasHeader ? rows.slice(2) : rows;
  const lines: string[] = [];
  for (const cells of data) {
    const filled = cells.map((cell) => cell.trim());
    if (!filled.some(Boolean)) continue;
    let line: string;
    if (header) {
      line = filled
        .map((cell, index) => {
          if (!cell) return "";
          const label = header[index];
          return label ? `${label}: ${cell}` : cell;
        })
        .filter(Boolean)
        .join(", ");
    } else {
      const [label, ...rest] = filled;
      const values = rest.filter(Boolean).join(", ");
      line = values ? `${label}: ${values}` : label;
    }
    if (line) lines.push(ensureStop(line));
  }
  return lines;
}

function capAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let cut = -1;
  for (const match of head.matchAll(SENTENCE_BOUNDARY)) {
    cut = match.index + match[0].length;
  }
  if (cut <= 0) {
    const space = head.lastIndexOf(" ");
    cut = space > 0 ? space : max;
  }
  return head.slice(0, cut).trim();
}

/**
 * Markdown from Mink, reduced to spoken sentences: headings, emphasis and
 * links keep their words, list items and table rows become sentences, code
 * blocks and dashboard paths disappear, whitespace collapses, and the result
 * stops at a sentence boundary within SPEAKABLE_MAX_CHARS.
 */
export function speakableMinkText(markdown: string): string {
  if (typeof markdown !== "string" || !markdown.trim()) return "";
  let text = markdown.replace(/\r\n?/g, "\n");
  // Fenced code, closed or still open at the end of the answer.
  text = text.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, "");
  text = text.replace(/^[ \t]*(```|~~~)[\s\S]*$/m, "");

  const sentences: string[] = [];
  let table: string[][] = [];
  const flushTable = () => {
    if (table.length) sentences.push(...speakTable(table));
    table = [];
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushTable();
      continue;
    }
    if (isTableRow(line)) {
      table.push(
        TABLE_SEPARATOR.test(line)
          ? tableCells(line).map(() => "")
          : tableCells(line),
      );
      continue;
    }
    flushTable();
    if (/^(?:[-*_]\s*){3,}$/.test(line)) continue;
    let item = line.replace(/^(?:>\s?)+/, "");
    item = item.replace(/^#{1,6}\s+/, "");
    item = item.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
    item = item.replace(/^\[([ xX])\]\s+/, "");
    item = inlineClean(item);
    if (!item) continue;
    sentences.push(ensureStop(item));
  }
  flushTable();

  const joined = sentences.join(" ").replace(/\s+/g, " ").trim();
  return capAtSentence(joined, SPEAKABLE_MAX_CHARS);
}

const SCRIPTS: { lang: string; letters: RegExp; languages?: string[] }[] = [
  {
    lang: "hi-IN",
    letters: /[ऀ-ॣ०-ॿ]/g,
    languages: ["hi", "mr", "ne", "kok", "sa", "brx", "mai", "doi"],
  },
  { lang: "bn-IN", letters: /[ঀ-৿]/g, languages: ["bn", "as", "mni"] },
  { lang: "pa-IN", letters: /[਀-੿]/g },
  { lang: "gu-IN", letters: /[઀-૿]/g },
  { lang: "ta-IN", letters: /[஀-௿]/g },
  { lang: "te-IN", letters: /[ఀ-౿]/g },
  { lang: "kn-IN", letters: /[ಀ-೿]/g },
  { lang: "ml-IN", letters: /[ഀ-ൿ]/g },
  { lang: "or-IN", letters: /[଀-୿]/g },
  { lang: "ur-IN", letters: /[\u0600-\u06ff]/g, languages: ["ur", "ks", "sd"] },
  { lang: "sat-IN", letters: /[\u1c50-\u1c7f]/g },
  { lang: "mni-IN", letters: /[\uabc0-\uabff]/g },
];
const LATIN_LETTERS = /[A-Za-zÀ-ɏ]/g;

export const DEFAULT_SPEECH_LANG = "en-IN";

/** Provider metadata is a hint, never arbitrary text passed to browser APIs. */
export function normalizeSpeechLanguage(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^[a-z]{2,3}(?:-[a-z]{2})?$/i.test(value.trim())
  )
    return null;
  const [raw, region] = value.trim().toLowerCase().split("-");
  const language = raw === "od" ? "or" : raw;
  if (
    ![
      "en",
      "hi",
      "bn",
      "kn",
      "ml",
      "mr",
      "or",
      "pa",
      "ta",
      "te",
      "gu",
      "as",
      "ur",
      "ne",
      "kok",
      "ks",
      "sd",
      "sa",
      "sat",
      "mni",
      "brx",
      "mai",
      "doi",
    ].includes(language)
  )
    return null;
  return `${language}-${(region || "in").toUpperCase()}`;
}

/**
 * The BCP-47 tag a synthesiser should read `text` in, decided by the script
 * most of its letters are written in. Latin text takes `fallback` (the
 * browser's own language in the dashboard), and a blank fallback is en-IN.
 * The danda (। ॥) is punctuation shared across scripts, so it never votes.
 */
export function speechLangFor(
  text: string,
  fallback: string,
  detected?: string | null,
): string {
  const safeFallback = fallback?.trim() || DEFAULT_SPEECH_LANG;
  const hint = normalizeSpeechLanguage(detected);
  const hintLanguage = hint?.split("-")[0];
  if (typeof text !== "string" || !text) return safeFallback;
  let best = {
    lang: hint ?? safeFallback,
    count: (text.match(LATIN_LETTERS) ?? []).length,
  };
  for (const script of SCRIPTS) {
    const count = (text.match(script.letters) ?? []).length;
    const compatible =
      hintLanguage !== undefined &&
      (script.languages ?? [script.lang.split("-")[0]]).includes(hintLanguage);
    if (count > best.count)
      best = { lang: compatible ? hint! : script.lang, count };
  }
  return best.count > 0 ? best.lang : safeFallback;
}

/**
 * A sentence ends at . ! ? । ॥ (plus any closing quotes or brackets) only
 * when whitespace or the end of the text follows, and the next word does not
 * start with a lowercase Latin letter or a digit: "4.5", "Rs. 500", "v2.1"
 * and "e.g. this" stay in one piece. ★ OVER-JOINING IS THE SAFE DIRECTION:
 * a piece is only a unit of work for the model, which reads the punctuation
 * itself, while a split inside a number is spoken as two numbers with a
 * pause between them. A terminator that is not an end is an ordinary
 * character of the sentence it sits in, so a leading "..." is kept too.
 */
const SENTENCE_END = String.raw`[.!?।॥]+["'”’)\]]*(?=\s+(?![a-z0-9])|$)`;
const SENTENCE = new RegExp(
  String.raw`(?:[^.!?।॥]|[.!?।॥](?!["'”’)\]]*(?:\s+(?![a-z0-9])|$)))+(?:${SENTENCE_END}|$)\s*`,
  "g",
);

/**
 * Offsets just past each sentence that has PROVABLY ended: the same terminator
 * rule as `SENTENCE`, but the whitespace must be followed by a further word,
 * never the end of the text. Streamed text grows at its end, so a full stop
 * that is the last character may still be "Rs." with "500" on its way; a
 * stop with a capitalised word already after it is settled.
 */
const SENTENCE_END_FOLLOWED = /[.!?।॥]+["'”’)\]]*(?=\s+[^\sa-z0-9])/g;

export function speechSentenceEnds(text: string): number[] {
  if (typeof text !== "string" || !text) return [];
  const ends: number[] = [];
  for (const match of text.matchAll(SENTENCE_END_FOLLOWED)) {
    ends.push(match.index + match[0].length);
  }
  return ends;
}

function splitLong(sentence: string, max: number): string[] {
  const parts: string[] = [];
  let rest = sentence.trim();
  while (rest.length > max) {
    const cut = rest.lastIndexOf(" ", max);
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * An answer split for a read-aloud model, at sentence boundaries: a short
 * first piece (≤ `firstMax`) so the first words play quickly, then pieces of
 * up to `restMax` fetched while the one before is playing. A sentence longer
 * than its piece is cut at a space. Every character of `text` reaches exactly
 * one piece, in order.
 */
export function splitSpeechChunks(
  text: string,
  firstMax = MINK_SPEECH_FIRST_PIECE_MAX,
  restMax = MINK_SPEECH_PIECE_MAX,
): string[] {
  const clean =
    typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!clean) return [];
  const sentences = (clean.match(SENTENCE) ?? [clean])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const max = chunks.length === 0 ? firstMax : restMax;
    const joined = current ? `${current} ${sentence}` : sentence;
    if (joined.length <= max) {
      current = joined;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    const limit = chunks.length === 0 ? firstMax : restMax;
    const pieces = splitLong(sentence, Math.max(limit, 1));
    current = pieces.pop() ?? "";
    chunks.push(...pieces);
  }
  if (current) chunks.push(current);
  return chunks;
}
