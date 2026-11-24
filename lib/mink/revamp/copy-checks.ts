// ---------------------------------------------------------------------------
// The storefront revamp's copy checks: English, claims and dashes, with no
// I/O (docs/mink-storefront-revamp.md, sections 5 and 7).
//
// Three callers must agree, so there is one implementation: the site
// compiler turns a problem into a repair sentence for the model, the
// finaliser fixes what the repairs left, and the self-checks refuse a card
// with a problem still in it.
//
// ★ A CLAIM NEEDS THE MERCHANT'S OWN WORDS BEHIND IT. Food and personal-care
//   words that FSSAI treats as conditional claims ("pure", "natural",
//   "organic", "chemical-free", "heart"...) and the marketing claims Theme
//   Studio already refuses (awards, press, ratings, counts, founding years)
//   are kept only when the merchant's brief, facts, product descriptions or
//   names say the same thing. A process the merchant described ("cold
//   pressed in our own mill") is not a claim word and passes.
//
// ★ PURE AND CLIENT-SAFE: no server import.
// ---------------------------------------------------------------------------

import {
  ORGANIC_CLAIM_LABEL,
  unsupportedClaimLabels,
} from "@/lib/theme-studio/claims";
import { withoutLongDashes } from "@/lib/text/long-dashes";
import type { RevampRequest, RevampSnapshot } from "./contract";

/** The share of Latin letters an English field must reach. */
export const REVAMP_MIN_LATIN_SHARE = 0.9;

interface ConditionalClaim {
  /** The word as the merchant reads it, for notes and repair sentences. */
  word: string;
  /** Matches the claim in copy. */
  re: RegExp;
  /** Matches the same claim in the merchant's words. */
  evidence: RegExp;
}

/**
 * Food and personal-care claims (section 7.3). Each one is matched where it
 * reads as a CLAIM, not wherever the letters appear: "best sellers" is a
 * shelf label, "made with heart" is a feeling; "the best", "good for your
 * heart" are claims.
 */
export const REVAMP_CONDITIONAL_CLAIMS: readonly ConditionalClaim[] = [
  {
    word: "pure",
    re: /\bpure(?:st|ly)?\b|\bpurity\b/i,
    evidence: /\bpur(?:e|est|ely|ity)\b/i,
  },
  {
    word: "100%",
    re: /\b100\s?(?:%|percent|per cent)/i,
    evidence: /\b100\s?(?:%|percent|per cent)/i,
  },
  {
    word: "natural",
    re: /\bnatural(?:ly)?\b|\ball[- ]natural\b/i,
    evidence: /\bnatural/i,
  },
  { word: "fresh", re: /\bfresh(?:est|ly|ness)?\b/i, evidence: /\bfresh/i },
  { word: "organic", re: /\borganic(?:ally)?\b/i, evidence: /\borganic/i },
  {
    word: "traditional",
    re: /\btradition(?:al|ally)?\b/i,
    evidence: /\btradition/i,
  },
  { word: "original", re: /\boriginal\b/i, evidence: /\boriginal\b/i },
  {
    word: "authentic",
    re: /\bauthentic(?:ity|ally)?\b/i,
    evidence: /\bauthentic/i,
  },
  {
    word: "chemical-free",
    re: /\bchemical[- ]free\b|\bfree (?:of|from) chemicals\b|\bno chemicals\b/i,
    evidence: /\bchemical/i,
  },
  {
    word: "preservative-free",
    re: /\bpreservative[- ]free\b|\bno preservatives?\b|\bfree (?:of|from) preservatives\b/i,
    evidence: /\bpreservative/i,
  },
  {
    word: "no added",
    re: /\bno added\b|\bnothing added\b/i,
    evidence: /\b(?:no|nothing) added\b/i,
  },
  {
    word: "healthy",
    re: /\bhealth(?:y|ier|iest|ful)\b/i,
    evidence: /\bhealth/i,
  },
  { word: "nutritious", re: /\bnutritio(?:us|n)\b/i, evidence: /\bnutriti/i },
  { word: "nutrient", re: /\bnutrients?\b/i, evidence: /\bnutrient/i },
  { word: "immunity", re: /\bimmun(?:ity|e)\b/i, evidence: /\bimmun/i },
  {
    word: "heart",
    re: /\bheart[- ]health(?:y)?\b|\bhealthy heart\b|\b(?:good|great|better|kind) for (?:your |the )?heart\b|\bfor (?:a |your )?(?:healthy )?heart\b/i,
    evidence: /\bheart\b/i,
  },
  { word: "cholesterol", re: /\bcholesterol\b/i, evidence: /\bcholesterol/i },
  {
    word: "small-batch",
    re: /\bsmall[- ]batch(?:es)?\b/i,
    evidence: /\bsmall[- ]batch/i,
  },
  {
    word: "handmade",
    re: /\bhand[- ]?(?:made|crafted)\b|\bmade by hand\b/i,
    evidence: /\bhand[- ]?(?:made|crafted)|\bby hand\b/i,
  },
  { word: "artisanal", re: /\bartisan(?:al|s)?\b/i, evidence: /\bartisan/i },
  {
    word: "award",
    re: /\bawards?\b|\baward[- ]winning\b/i,
    evidence: /\baward/i,
  },
  { word: "certified", re: /\bcertifi(?:ed|cation)\b/i, evidence: /\bcertif/i },
  {
    word: "best",
    re: /\b(?:the|our|your|india'?s|world'?s) (?:very )?best\b(?! ?sell)|\bbest[- ](?:quality|in[- ]class|in (?:the|india|town))\b/i,
    evidence: /\bbest\b(?! ?sell)/i,
  },
  {
    word: "number one",
    re: /\bnumber one\b|\bno\.?\s?1\b|(?:^|\s)#\s?1\b/i,
    evidence: /\bnumber one\b|\bno\.?\s?1\b|#\s?1\b/i,
  },
  {
    word: "doctor",
    re: /\bdoctors?\b|\bdr\.\s/i,
    evidence: /\bdoctor|\bdr\.\s/i,
  },
  { word: "clinically", re: /\bclinical(?:ly)?\b/i, evidence: /\bclinic/i },
  {
    word: "guaranteed",
    re: /\bguarantee(?:d|s)?\b/i,
    evidence: /\bguarantee/i,
  },
];

/** Share of the letters in `text` that are Latin script. 1 with no letters. */
export function latinLetterShare(text: string): number {
  const letters = text.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return 1;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return latin / letters.length;
}

/** True when the language is English (or unset) and the text reads as it. */
export function readsAsLanguage(text: string, language: string): boolean {
  if (!isEnglish(language)) return true;
  return latinLetterShare(text) >= REVAMP_MIN_LATIN_SHARE;
}

/** "English", "english ", "" and "en" all mean English. */
export function isEnglish(language: string): boolean {
  const value = language.trim().toLowerCase();
  return value === "" || value === "en" || value.startsWith("english");
}

export function hasLongDash(text: string): boolean {
  return /[\u2013\u2014]/.test(text);
}

/** The store facts a claim may rest on: delivery, returns, the place. */
function factsText(
  facts: Partial<RevampSnapshot["facts"]> | undefined,
): string {
  const f = facts ?? {};
  const parts: string[] = [];
  if (typeof f.delivery === "string") parts.push(f.delivery);
  if (typeof f.returns === "string") parts.push(f.returns);
  if (typeof f.freeDeliveryAbove === "number") {
    parts.push(String(f.freeDeliveryAbove));
  }
  if (typeof f.city === "string") parts.push(f.city);
  if (typeof f.state === "string") parts.push(f.state);
  return parts.join("\n");
}

/**
 * The merchant's own words, the only evidence a claim may rest on: the
 * brief, the facts, a refinement's instruction, their products and their
 * store's name, the category changes they confirmed, their own catalogue's
 * names (a real product called "Organic Groundnut Oil" may be named in the
 * copy) and the store's facts (delivery, returns, its city and state).
 * ★★ ONE EVIDENCE FOR EVERY CALLER (output-3). The compiler accepts copy
 *    against it and the checks judge the same copy again, so the two must
 *    read the same words: a narrower set in the checks took the merchant's
 *    own category and product names out after the compiler kept them, and
 *    failed "No claims you did not make" on a header link that was theirs.
 * ★ What they want AVOIDED is deliberately left out, or "don't say organic"
 *   would read as the merchant saying organic. A theme's sample products and
 *   categories are the theme's words, never evidence, and so is the store's
 *   current tagline (a theme wrote most of them).
 */
export function revampClaimEvidence(
  request: Pick<
    RevampRequest,
    "brief" | "products" | "instruction" | "categories"
  >,
  snapshot: Pick<
    RevampSnapshot,
    "storeName" | "products" | "categories" | "facts"
  >,
): string {
  const changes = (request.categories ?? []).flatMap((change) =>
    change.action === "hide"
      ? []
      : [change.name ?? "", change.description ?? ""],
  );
  const catalogue = [
    ...(snapshot.products ?? [])
      .filter(
        (product) => !product.sample && !/\(sample\)\s*$/i.test(product.name),
      )
      .map((product) => product.name),
    ...(snapshot.categories ?? [])
      .filter((category) => !category.sample)
      .map((category) => category.name),
  ];
  const parts = [
    snapshot.storeName,
    request.brief.business,
    request.brief.look,
    request.brief.audience,
    ...request.brief.facts,
    request.instruction ?? "",
    ...request.products.flatMap((product) => [
      product.name,
      product.description,
    ]),
    ...changes,
    ...catalogue,
    factsText(snapshot.facts),
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * The shop's own names: the store, the merchant's products and the
 * catalogue's, the current categories and the confirmed category changes,
 * trimmed and longest first. A name is never translated, so the language
 * check reads copy with these taken out.
 * ★★ ONE LIST FOR EVERY CALLER (output-4). The compiler accepts copy with the
 *    names taken out and the checks read the same copy again, so they must
 *    take out the same names: otherwise "Welcome to मिठाई घर" passes the
 *    compiler and then fails "Written in English" on the card.
 * ★ Longest first, so "मिठाई घर" is taken out whole before "मिठाई" can split
 *   it and leave "घर" behind.
 */
export function revampStoreNames(
  request: Pick<RevampRequest, "products" | "categories">,
  snapshot: Pick<RevampSnapshot, "storeName" | "products" | "categories">,
): string[] {
  return [
    snapshot.storeName,
    ...request.products.map((product) => product.name),
    ...(snapshot.products ?? []).map((product) => product.name),
    ...(snapshot.categories ?? []).map((category) => category.name),
    ...(request.categories ?? []).flatMap((change) =>
      change.action === "hide" ? [] : [change.name ?? ""],
    ),
  ]
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .sort((a, b) => b.length - a.length);
}

/** The text with the shop's own names taken out (a name is never translated). */
export function withoutStoreNames(
  value: string,
  names: readonly string[],
): string {
  let out = value;
  for (const name of names) out = out.split(name).join(" ");
  return out;
}

/** The claim words in `text` that `evidence` does not support. */
export function unsupportedClaimsIn(text: string, evidence: string): string[] {
  const found = new Set<string>();
  for (const claim of REVAMP_CONDITIONAL_CLAIMS) {
    if (claim.re.test(text) && !claim.evidence.test(evidence)) {
      found.add(claim.word);
    }
  }
  // Theme Studio's own rules, less the one this list already has a word for
  // ("organic" above): one claim is reported once.
  for (const label of unsupportedClaimLabels(text, evidence))
    if (label !== ORGANIC_CLAIM_LABEL) found.add(label);
  return [...found];
}

export type RevampCopyIssueKind = "language" | "dash" | "claim";

export interface RevampCopyIssue {
  kind: RevampCopyIssueKind;
  /** What is wrong, in plain words: a repair sentence or a card note. */
  detail: string;
}

/** Every problem one field has. `where` names it for the repair sentence. */
export function copyIssues(
  text: string,
  options: { evidence: string; language: string; where: string },
): RevampCopyIssue[] {
  const issues: RevampCopyIssue[] = [];
  if (!text.trim()) return issues;
  if (!readsAsLanguage(text, options.language)) {
    issues.push({
      kind: "language",
      detail: `${options.where} is not in ${isEnglish(options.language) ? "English" : options.language}. Write it in ${isEnglish(options.language) ? "English" : options.language}.`,
    });
  }
  if (hasLongDash(text)) {
    issues.push({
      kind: "dash",
      detail: `${options.where} uses a long dash. Use a comma, a colon or " - " instead.`,
    });
  }
  const claims = unsupportedClaimsIn(text, options.evidence);
  if (claims.length) {
    issues.push({
      kind: "claim",
      detail: `${options.where} claims ${claims.map((claim) => `"${claim}"`).join(", ")} but the merchant never said so. Remove the claim or use only what the merchant stated.`,
    });
  }
  return issues;
}

/**
 * Long dashes rewritten, angle brackets dropped, spaces collapsed, ends
 * trimmed. ★ For plain-text copy only (taglines, product copy, menu labels,
 *   the announcement and newsletter lines): no such field is ever markup, so
 *   a bracket in one is dropped as defence in depth beside the JSON-LD
 *   escaping. A rich text's HTML never comes through here; the compiler
 *   sanitises it on its own.
 */
export function cleanRevampCopy(text: string): string {
  return withoutLongDashes(text)
    .replace(/[<>]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/**
 * The finaliser's last resort: drop each sentence that carries a claim the
 * merchant did not make, keep the rest. Returns "" when nothing survives;
 * the caller decides what a field with no copy becomes.
 */
export function withoutUnsupportedClaims(
  text: string,
  evidence: string,
): { text: string; removed: string[] } {
  const removed = new Set<string>();
  const kept = splitSentences(text).filter((sentence) => {
    const claims = unsupportedClaimsIn(sentence, evidence);
    for (const claim of claims) removed.add(claim);
    return claims.length === 0;
  });
  return { text: kept.join(" ").trim(), removed: [...removed] };
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}
