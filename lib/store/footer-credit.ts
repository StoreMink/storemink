// ---------------------------------------------------------------------------
// The last line of a storefront's footer: StoreMink's "Powered by" badge, the
// store's own credit line, or nothing.
//
// ★★ THE SERVER DECIDES, THE FOOTER DRAWS. The storefront layout calls
// footerCreditFor() with PLAN_LIMITS.removeBadge for the store's EFFECTIVE plan
// (effectivePlan + limitsFor, lib/plans.ts: an expired timed plan reads as
// Free, a live comp as its plan) and the saved credit line, and hands the
// answer to the footer, a client component, as a plain object. The footer only
// reads that answer (readFooterCredit); it never looks at the plan or at
// brand.creditLine itself, so nothing in the browser can put the badge back on
// a store that pays to remove it, or take it off a Free one.
//
// Pure and import-free, so the layout, the footer and the tests share it.
// ---------------------------------------------------------------------------

/** What the footer's credit line shows. */
export type FooterCredit =
  | { kind: "storemink" }
  | { kind: "custom"; text: string }
  | { kind: "none" };

/** The badge's own words, as the footer reads them out. */
export const STOREMINK_CREDIT_WORDS = "Powered by StoreMink";

/** The words of a line, ignoring case and every kind of spacing. */
function wordsKey(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

/**
 * Is this line nothing but the badge's default words, in any case or spacing
 * ("powered by storemink", "Powered  by Store Mink")?
 *
 * ★ The old Branding form showed these words as the Credit line's
 * placeholder, so a store may have typed them in meaning "the default". On a
 * paid plan that is not a line of the store's own, and printing it as plain
 * text would put StoreMink's name back on a store that pays to remove it.
 */
export function isDefaultCreditWords(line: string): boolean {
  return wordsKey(line) === wordsKey(STOREMINK_CREDIT_WORDS);
}

/**
 * What the footer's credit line shows for a store.
 *
 * - Free (`removeBadge` false): always StoreMink's badge, whatever the Credit
 *   line field holds. A line the store saved stays saved (soft downgrade: a
 *   plan change never deletes or resets a setting) and is simply not shown
 *   until the store is on Basic or Pro.
 * - Basic or Pro (`removeBadge` true): never the badge. The store's own line
 *   when it saved one; nothing when it saved none, or only the badge's words.
 */
export function footerCreditFor({
  removeBadge,
  creditLine,
}: {
  removeBadge: boolean;
  creditLine: string | null | undefined;
}): FooterCredit {
  if (!removeBadge) return { kind: "storemink" };
  const text = typeof creditLine === "string" ? creditLine.trim() : "";
  if (!text || isDefaultCreditWords(text)) return { kind: "none" };
  return { kind: "custom", text };
}

/**
 * The credit as the footer was handed it. Anything that is not a well-formed
 * answer reads as nothing: the footer never falls back to deciding for itself,
 * and showing nothing is the one answer that cannot put the badge on a store
 * that pays to remove it.
 */
export function readFooterCredit(value: unknown): FooterCredit {
  if (!value || typeof value !== "object") return { kind: "none" };
  const credit = value as { kind?: unknown; text?: unknown };
  if (credit.kind === "storemink") return { kind: "storemink" };
  if (credit.kind === "custom" && typeof credit.text === "string") {
    const text = credit.text.trim();
    if (text) return { kind: "custom", text };
  }
  return { kind: "none" };
}
