/**
 * Splits Mink's reply into what is SAID and what is SHOWN.
 *
 * On a voice turn the prompt asks Mink to open its final reply with a short
 * `<spoken>…</spoken>` block, what it would say to the merchant out loud,
 * followed by the ordinary written answer. The stream route runs every text
 * fragment through one splitter: spoken text goes to the browser as `spoken`
 * events the moment it arrives, written text keeps today's `delta` events,
 * and only the written text is persisted and shown. Pure and client-safe.
 *
 * ★ A TAG CAN BE SPLIT ACROSS FRAGMENTS. A delta may end in "</spo", so the
 * splitter holds back any tail that could still become a tag and classifies
 * it once the next fragment settles the question. The hold is bounded by the
 * longest proper tag prefix, so an ordinary "<" in written text is delayed by
 * one fragment at most.
 * ★ STRAY TAGS ARE DROPPED FROM BOTH SIDES. A second `<spoken>` after the
 * block closed, or a `</spoken>` with no block open, is model noise; neither
 * is spoken aloud nor printed.
 * ★ AN UNCLOSED BLOCK IS SPOKEN TO THE END, and the finished split falls back
 * to the same text for the written side, so a reply that forgot its closing
 * tag still shows something on screen.
 */

const OPEN = "<spoken>";
const CLOSE = "</spoken>";
/** The longest tail that could still be the start of a tag. */
const HOLD = CLOSE.length - 1;

export type SpokenAnswerPart =
  | { kind: "spoken"; text: string }
  | { kind: "written"; text: string }
  | { kind: "spoken_end" };

export type SpokenAnswerSplitter = {
  /** Classify one streamed fragment, in document order. */
  push(fragment: string): SpokenAnswerPart[];
  /** The run withdrew its text (a tool call follows); start again. */
  reset(): void;
  /** No more fragments: classify whatever was held back. */
  finish(): SpokenAnswerPart[];
};

function tagPrefixLength(tail: string): number {
  for (let length = Math.min(HOLD, tail.length); length > 0; length -= 1) {
    const candidate = tail.slice(tail.length - length);
    if (OPEN.startsWith(candidate) || CLOSE.startsWith(candidate)) {
      return length;
    }
  }
  return 0;
}

export function createSpokenAnswerSplitter(): SpokenAnswerSplitter {
  let held = "";
  let inside = false;
  let opened = false;

  const classify = (text: string, flush: boolean): SpokenAnswerPart[] => {
    const parts: SpokenAnswerPart[] = [];
    let rest = held + text;
    held = "";
    const emit = (chunk: string) => {
      if (!chunk) return;
      const last = parts[parts.length - 1];
      const kind = inside ? "spoken" : "written";
      if (last && last.kind === kind) last.text += chunk;
      else parts.push({ kind, text: chunk });
    };
    for (;;) {
      const openAt = rest.indexOf(OPEN);
      const closeAt = rest.indexOf(CLOSE);
      const next =
        openAt < 0 ? closeAt : closeAt < 0 ? openAt : Math.min(openAt, closeAt);
      if (next < 0) break;
      emit(rest.slice(0, next));
      if (next === openAt) {
        rest = rest.slice(next + OPEN.length);
        if (!opened && !inside) {
          opened = true;
          inside = true;
        }
        continue;
      }
      rest = rest.slice(next + CLOSE.length);
      if (inside) {
        inside = false;
        parts.push({ kind: "spoken_end" });
      }
    }
    if (!flush) {
      const hold = tagPrefixLength(rest);
      if (hold) {
        held = rest.slice(rest.length - hold);
        rest = rest.slice(0, rest.length - hold);
      }
    }
    emit(rest);
    return parts;
  };

  return {
    push: (fragment) => classify(fragment, false),
    reset: () => {
      held = "";
      inside = false;
      opened = false;
    },
    finish: () => classify("", true),
  };
}

/** The finished reply, split once: what to show, and what to say (null when nothing). */
export function splitSpokenAnswer(text: string): {
  written: string;
  spoken: string | null;
} {
  const splitter = createSpokenAnswerSplitter();
  const parts = [...splitter.push(text), ...splitter.finish()];
  let spoken = "";
  let written = "";
  let ended = false;
  for (const part of parts) {
    if (part.kind === "spoken") spoken += part.text;
    else if (part.kind === "written") written += part.text;
    else ended = true;
  }
  spoken = spoken.replace(/\s+/g, " ").trim();
  written = written.trim();
  if (spoken && !ended && !written) written = spoken;
  else if (spoken && !ended) written = `${written}\n\n${spoken}`.trim();
  return { written, spoken: spoken || null };
}
