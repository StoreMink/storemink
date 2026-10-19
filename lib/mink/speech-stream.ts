/**
 * Turning Mink's streamed spoken text into pieces a read-aloud model can
 * start on before the sentence after it has been written.
 *
 * Pure and client-safe. The voice loop feeds it the WHOLE current spoken text
 * on every change (the chat client keeps spoken fragments as one growing
 * string); it remembers how much it has already handed out and returns only
 * the sentences that have completed since.
 *
 * ★ A SHRUNKEN OR REPLACED TEXT IS A WITHDRAWAL. The run resets its text
 * before a tool call (`delta_reset`), and React may batch that reset with the
 * fragments that follow it, so the segmenter never sees an empty string in
 * between: "not an extension of what I saw last" is the test, not "empty".
 * What follows is a new answer, so `spoke` and the length cap start again:
 * a withdrawn "Let me check" must not stop the answer after it being read.
 * ★ CLOSED MEANS INERT. Once the block is closed the chat client clears its
 * spoken text (on the final message and again in its finally), and that
 * clearing must not read as a withdrawal that drops pieces still queued.
 * ★ THE FIRST PIECE IS CUT EARLY. A long opening sentence would otherwise
 * delay the first audio by the whole sentence, so past `firstPieceMax`
 * characters with no sentence end in sight the last clause break after 60
 * characters is taken instead.
 */

import {
  MINK_SPEECH_FIRST_PIECE_MAX,
  MINK_SPEECH_PIECE_MAX,
  SPEAKABLE_MAX_CHARS,
  speakableMinkText,
  speechSentenceEnds,
  splitSpeechChunks,
} from "./speech-text";

export const MINK_FIRST_PIECE_MAX = 140;
const CLAUSE_MIN = 60;

export type MinkSpeechSegmenter = {
  /** Feed the latest complete spoken text; returns the pieces ready to say. */
  push(spoken: string): { pieces: string[]; reset: boolean };
  /** The block is over: returns the unsaid tail; later pushes are ignored. */
  close(final?: string): string[];
  readonly emitted: number;
  readonly seen: string;
  readonly closed: boolean;
  /** Whether any piece has been handed out since the text was last withdrawn. */
  readonly spoke: boolean;
};

function unbalanced(text: string): boolean {
  const bold = (text.match(/\*\*/g) ?? []).length;
  const ticks = (text.match(/`/g) ?? []).length;
  return bold % 2 === 1 || ticks % 2 === 1;
}

/**
 * Where to cut `pending` so that everything before the cut can be spoken now:
 * the last sentence that provably ended, or a paragraph break, or, for the
 * first piece only, the last clause break once the text has run long with no
 * sentence end. 0 means wait for more text.
 */
export function speechCutPoint(
  pending: string,
  options: { first: boolean; firstPieceMax?: number },
): number {
  const firstPieceMax = options.firstPieceMax ?? MINK_FIRST_PIECE_MAX;
  const candidates = speechSentenceEnds(pending);
  for (const match of pending.matchAll(/\n[ \t]*\n/g)) {
    if (match.index > 0) candidates.push(match.index);
  }
  let cut = candidates.length ? Math.max(...candidates) : 0;
  if (cut <= 0 && options.first && pending.length > firstPieceMax) {
    const head = pending.slice(0, firstPieceMax);
    const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "));
    if (clause >= CLAUSE_MIN) cut = clause + 1;
  }
  const earlier = candidates.filter((at) => at < cut).sort((a, b) => b - a);
  while (cut > 0 && unbalanced(pending.slice(0, cut)))
    cut = earlier.shift() ?? 0;
  return cut;
}

/**
 * What the final spoken text adds after what has been said, compared with
 * whitespace collapsed; null when it does not continue it at all.
 */
function unsaidTail(final: string, said: string): string | null {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  const whole = flat(final);
  const done = flat(said);
  return whole.startsWith(done) ? whole.slice(done.length) : null;
}

export function createMinkSpeechSegmenter(
  options: { maxChars?: number; firstPieceMax?: number } = {},
): MinkSpeechSegmenter {
  const maxChars = options.maxChars ?? SPEAKABLE_MAX_CHARS;
  const firstPieceMax = options.firstPieceMax ?? MINK_FIRST_PIECE_MAX;
  let seen = "";
  let emitted = 0;
  let closed = false;
  let spoke = false;
  let spokenChars = 0;

  const bounded = (raw: string): string[] => {
    const clean = speakableMinkText(raw);
    if (!clean || spokenChars >= maxChars) return [];
    const pieces = splitSpeechChunks(
      clean,
      spoke ? MINK_SPEECH_PIECE_MAX : MINK_SPEECH_FIRST_PIECE_MAX,
      MINK_SPEECH_PIECE_MAX,
    );
    for (const piece of pieces) spokenChars += piece.length;
    if (pieces.length) spoke = true;
    return pieces;
  };

  return {
    push(spoken) {
      if (closed) return { pieces: [], reset: false };
      const text = typeof spoken === "string" ? spoken : "";
      let reset = false;
      if (!text.startsWith(seen)) {
        reset = true;
        emitted = 0;
        spoke = false;
        spokenChars = 0;
      }
      seen = text;
      const pending = text.slice(emitted);
      const cut = speechCutPoint(pending, { first: !spoke, firstPieceMax });
      if (cut <= 0) return { pieces: [], reset };
      emitted += cut;
      return { pieces: bounded(pending.slice(0, cut)), reset };
    },
    close(final) {
      if (closed) return [];
      closed = true;
      let tail: string;
      if (typeof final !== "string" || final.startsWith(seen)) {
        const source = typeof final === "string" ? final : seen;
        tail = source.slice(emitted);
      } else {
        // ★ The final text is the server's split, whitespace collapsed; the
        // stream kept its line breaks. Compared exactly, a block with one
        // never matched, and only what had streamed was said: the sentences
        // that arrived with the answer itself were lost.
        tail = unsaidTail(final, seen.slice(0, emitted)) ?? seen.slice(emitted);
      }
      emitted = seen.length;
      return bounded(tail);
    },
    get emitted() {
      return emitted;
    },
    get seen() {
      return seen;
    },
    get closed() {
      return closed;
    },
    get spoke() {
      return spoke;
    },
  };
}

// ★ Combining marks are part of a word. Devanagari, Bengali, Tamil and every
// other Indic script write vowels and the virama as marks (\p{M}), so a
// splitter on letters and digits alone cut "बिक्री" into fragments that
// matched almost anything Mink had said in Hindi.
const WORD = /[^\p{L}\p{M}\p{N}]+/u;
function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(WORD).filter(Boolean);
}

/**
 * Whether a transcript is Mink's own voice coming back through the
 * microphone: its words are in the last few hundred characters Mink said.
 * The backstop for an echo canceller that converged late, or a read-aloud
 * voice the canceller never heard.
 *
 * ★ The voice loop asks this ONLY for speech that began while Mink was
 * talking. Speech after Mink finished is the merchant's reply, and a reply
 * that reuses Mink's words ("keep it as a draft") is an answer, not an echo.
 * ★ A word or two counts as an echo only when every one of them is Mink's:
 * the clip a self-interruption captures is the fraction of a second of
 * Mink's voice before playback stopped ("sales are"), which used to be too
 * short to judge and was sent to Mink as a new question.
 */
export function isEchoTranscript(text: string, said: string): boolean {
  const heard = words(text);
  if (!heard.length) return false;
  const recent = new Set(words(said.slice(-300)));
  if (!recent.size) return false;
  const overlap = heard.filter((word) => recent.has(word)).length;
  if (heard.length < 3) return overlap === heard.length;
  return overlap / heard.length >= 0.8;
}
