/**
 * Rewrite em and en dashes as ordinary punctuation. StoreMink's own copy never
 * uses a long dash, so text StoreMink GENERATES for a merchant (AI drafts,
 * product descriptions, help articles) passes through this before the merchant
 * sees it. Copy a merchant types themselves is theirs and is never rewritten.
 * A number range becomes "2 to 4"; any other dash becomes a comma, and the
 * punctuation that leaves behind is tidied (no ", ," and no ", ." pairs).
 */
export function withoutLongDashes(text: string): string {
  return text
    .replace(/([\d%])[ \t]*[–—]+[ \t]*([₹$]?\d)/g, "$1 to $2")
    .replace(/[ \t]*[–—]+[ \t]*/g, ", ")
    .replace(/,[ \t]*([,.;:!?])/g, "$1")
    .replace(/^,[ \t]*/gm, "")
    .replace(/,[ \t]+$/gm, ",");
}

/**
 * The tail a later fragment could still change: spaces, commas, a dash, or a
 * currency sign after one. "2—" may become "2 to 4" and "Done —" may become
 * "Done." once the next fragment arrives, so none of it is sent yet.
 */
const UNSETTLED_TAIL = /[ \t,–—₹$]+$/;

/**
 * The same rule for text that arrives in fragments (Mink's answer as it
 * streams, and its spoken sentences, which are heard and captioned as they
 * come). ★ Rewriting each fragment on its own reads wrongly at the edges:
 * "takes 2" + "–4 days" became "2, 4 days", and "Done —" + "." left a stray
 * comma. So the rewriter holds back the unsettled tail and cleans everything
 * before it as one text: whatever the fragments, what it sends adds up to
 * exactly `withoutLongDashes` of the whole.
 */
export function createLongDashRewriter(): {
  push(fragment: string): string;
  finish(): string;
} {
  let raw = "";
  let sent = "";
  const settle = (final: boolean): string => {
    const hold = final ? 0 : (raw.match(UNSETTLED_TAIL)?.[0].length ?? 0);
    const clean = withoutLongDashes(raw.slice(0, raw.length - hold));
    // The rules only ever touch the dash and the punctuation around it, all of
    // which is held back, so what was sent stays a prefix. Should a future rule
    // break that, send only what is new rather than repeating text.
    const next = clean.startsWith(sent)
      ? clean.slice(sent.length)
      : clean.slice(Math.min(sent.length, clean.length));
    sent = clean;
    return next;
  };
  return {
    push(fragment) {
      raw += fragment;
      return settle(false);
    },
    finish() {
      return settle(true);
    },
  };
}

/** True when the text carries an em or en dash worth rewriting. */
export function hasLongDash(text: string): boolean {
  return /[–—]/.test(text);
}
