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
 * ★ CLOSED MEANS INERT. Once the block is closed the chat client clears its
 * spoken text (on the final message and again in its finally), and that
 * clearing must not read as a withdrawal that drops pieces still queued.
 * ★ THE FIRST PIECE IS CUT EARLY. A long opening sentence would otherwise
 * delay the first audio by the whole sentence, so past `firstPieceMax`
 * characters with no sentence end in sight the last clause break after 60
 * characters is taken instead.
 */

import {
  SPEAKABLE_MAX_CHARS,
  speakableMinkText,
  speechSentenceEnds,
  splitSpeechChunks,
} from "./speech-text";

export const MINK_FIRST_PIECE_MAX = 140;
const CLAUSE_MIN = 60;
const FIRST_PIECE_CHUNK = 160;
const PIECE_CHUNK = 600;

export type MinkSpeechSegmenter = {
  /** Feed the latest complete spoken text; returns the pieces ready to say. */
  push(spoken: string): { pieces: string[]; reset: boolean };
  /** The block is over: returns the unsaid tail; later pushes are ignored. */
  close(final?: string): string[];
  readonly emitted: number;
  readonly seen: string;
  readonly closed: boolean;
  /** Whether any piece has been handed out this turn. */
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
      spoke ? PIECE_CHUNK : FIRST_PIECE_CHUNK,
      PIECE_CHUNK,
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
      const source =
        typeof final === "string" && final.startsWith(seen) ? final : seen;
      const tail = source.slice(emitted);
      emitted = source.length;
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

const WORD = /[^\p{L}\p{N}]+/u;
function words(text: string): string[] {
  return text.toLowerCase().normalize("NFKC").split(WORD).filter(Boolean);
}

/**
 * Whether a transcript is Mink's own voice coming back through the
 * microphone: most of its words are in the last few hundred characters Mink
 * said. The backstop for an echo canceller that converged late; a short
 * transcript is never judged, because "yes" and "okay" overlap with anything.
 */
export function isEchoTranscript(text: string, said: string): boolean {
  const heard = words(text);
  if (heard.length < 3) return false;
  const recent = new Set(words(said.slice(-300)));
  if (!recent.size) return false;
  const overlap = heard.filter((word) => recent.has(word)).length;
  return overlap / heard.length >= 0.8;
}
