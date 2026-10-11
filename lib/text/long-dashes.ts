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

/** True when the text carries an em or en dash worth rewriting. */
export function hasLongDash(text: string): boolean {
  return /[–—]/.test(text);
}
