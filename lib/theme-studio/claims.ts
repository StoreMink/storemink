import type { ThemePackageV2 } from "./contracts";
import { collectStrings } from "@/lib/themes/validation";

// Marketing claims a generated theme may make only when the brief supports
// them. The 2026-10-04 benchmark's cosmetics draft advertised awards and
// endorsements its synthetic brief never mentioned; a vision reviewer has no
// way to know that, and a merchant installing the theme inherits the claim.
// So this is checked where the brief IS known — inside generation, as a
// repair issue — never at acceptance, which only sees the package.
//
// Each rule pairs the phrase that makes the claim with the evidence the brief
// (or, for a revision, the already-accepted copy) must contain. Numeric rules
// require every number in the claim to appear in that evidence as well.

interface ClaimRule {
  re: RegExp;
  label: string;
  evidence: RegExp;
  numeric?: true;
}

/** The storefront redesign has its own word for this one (copy-checks.ts),
 *  and leaves this label out so a claim is reported once. */
export const ORGANIC_CLAIM_LABEL = "an organic claim";

const CLAIM_RULES: readonly ClaimRule[] = [
  {
    re: /\baward[- ]winning\b|\bwon (?:an?|the) [\w' ]{0,30}award/i,
    label: "an award",
    evidence: /\baward/i,
  },
  {
    re: /\bas (?:seen|featured) (?:in|on)\b/i,
    label: "press coverage",
    evidence: /\b(?:featured|seen in|press|magazine|coverage)\b/i,
  },
  {
    // A proper noun after "featured in/by" is a publication; lower case is
    // ordinary copy ("featured in this collection").
    re: /\bfeatured (?:in|by) [A-Z]/,
    label: "press coverage",
    evidence: /\b(?:featured|seen in|press|magazine|coverage)\b/i,
  },
  {
    re: /(?:^|[\s(])#\s?1\b|\bnumber one\b|\bno\.\s?1\b/i,
    label: "a #1 ranking",
    evidence: /#\s?1\b|\bnumber one\b|\bno\.\s?1\b/i,
  },
  {
    re: /\bvoted\b/i,
    label: "a vote or poll result",
    evidence: /\bvote|\bpoll\b/i,
  },
  {
    re: /\bclinically (?:proven|tested|shown)\b/i,
    label: "clinical testing",
    evidence: /\bclinic/i,
  },
  {
    re: /\bdermatologist[- ](?:recommended|tested|approved)\b/i,
    label: "a dermatologist endorsement",
    evidence: /\bdermatolog/i,
  },
  {
    re: /\bcertified\b/i,
    label: "a certification",
    evidence: /\bcertif/i,
  },
  // "Organic" is a certified status, with or without the word "certified":
  // the first live design review (22 Nov 2026) rejected "ORGANIC BEANS" on a
  // brand whose brief never said so, after this check had let it through.
  {
    re: /\borganic(?:ally)?\b/i,
    label: ORGANIC_CLAIM_LABEL,
    evidence: /\borganic/i,
  },
  {
    re: /\btrusted by (?:over |more than )?[\d,]+\+?/i,
    label: "a customer count",
    evidence: /\d/,
    numeric: true,
  },
  {
    re: /\b(?:over|more than) [\d,]+\+? (?:happy |satisfied |loyal )?(?:customers|clients|orders|reviews|homes|kitchens|families)\b/i,
    label: "a customer count",
    evidence: /\d/,
    numeric: true,
  },
  {
    re: /\brated [\d.]+\s?\/\s?5\b|\b[\d.]+\s?\/\s?5 stars?\b|\b[\d,]+\+? (?:five|5)[- ]star reviews\b/i,
    label: "a rating",
    evidence: /\d/,
    numeric: true,
  },
  {
    re: /\bsince (?:18|19|20)\d{2}\b|\b(?:est\.?|established|founded) (?:in )?(?:18|19|20)\d{2}\b/i,
    label: "a founding year",
    evidence: /\d/,
    numeric: true,
  },
  {
    re: /\b\d{1,3}% of (?:customers|users|people|buyers|testers)\b/i,
    label: "a percentage statistic",
    evidence: /\d/,
    numeric: true,
  },
];

/**
 * Appended to the Stage B system prompt (v34+). Both of the first two live
 * v34 drafts (22 Nov 2026) put "EST. 2021" and "EST. 2024" on a brand that
 * gave no founding year, and one a "certified organic" the brief never
 * claimed: each cost a repair round the prompt could have saved, because
 * until now the model was told about this rule only after breaking it.
 */
export const CLAIMS_PROMPT = `

Honest copy: the draft's customer copy is checked against the brief, and a claim the brief does not state is sent back. Never invent a founding year or date ("Est. 2021", "since 1998", "established in 2015"), an award, press coverage, a ranking, a rating or review count, a customer count, a percentage statistic, clinical or expert endorsement, or a certification ("certified organic", or the word "organic" by itself). Write none of these unless the brief itself states it; say what the store sells and how, not what it has won or how long it has run.
Plain copy: a menu label is the short name a shopper taps ("Our Story", "Brewing Guide"), never a page's title with the brand after a bar. Use no long dash in any copy: a comma, a colon or a full stop instead.`;

function numbersIn(text: string): Set<string> {
  return new Set(
    (text.match(/\d[\d,]*/g) ?? []).map((n) => n.replace(/,/g, "")),
  );
}

/** Theme copy that reads to a customer: pages, brand line, sample catalogue.
 * Menus and SEO fields are included; nothing a customer can't see is. The
 * page templates (trust labels, accordion rows, rich text, promo tiles) and
 * the announcement bar are copy on every product page or every page (v32+),
 * and a revision carries them forward (v33+). */
export function customerCopy(pkg: ThemePackageV2): string[] {
  const preset = pkg.definition.preset;
  return [
    ...collectStrings(preset.brand),
    ...collectStrings(preset.pages),
    ...collectStrings(preset.sampleData),
    ...collectStrings(preset.templates),
    ...collectStrings(preset.announcement),
  ];
}

/** The rules one piece of copy breaks: claims `evidence` does not support. */
function unsupportedRules(
  text: string,
  evidence: string,
  numbers: Set<string>,
): ClaimRule[] {
  const broken: ClaimRule[] = [];
  for (const rule of CLAIM_RULES) {
    const match = rule.re.exec(text);
    if (!match) continue;
    const supported = rule.numeric
      ? [...numbersIn(match[0])].every((n) => numbers.has(n))
      : rule.evidence.test(evidence);
    if (!supported) broken.push(rule);
  }
  return broken;
}

/**
 * The marketing claims ONE piece of copy makes that `evidence` does not
 * support, by label ("an award", "a rating"). The Mink storefront revamp
 * checks its copy field by field with this (lib/mink/revamp/copy-checks.ts).
 */
export function unsupportedClaimLabels(
  text: string,
  evidence: string,
): string[] {
  return [
    ...new Set(
      unsupportedRules(text, evidence, numbersIn(evidence)).map(
        (rule) => rule.label,
      ),
    ),
  ];
}

/**
 * Repair sentences for claims the evidence does not support. `evidence` is
 * the brief for an initial generation; a revision adds the base theme's own
 * copy, since claims already there passed this check when they were made.
 */
export function unsupportedClaimIssues(
  pkg: ThemePackageV2,
  evidence: string,
): string[] {
  const numbers = numbersIn(evidence);
  const issues = new Set<string>();
  for (const text of customerCopy(pkg)) {
    for (const rule of unsupportedRules(text, evidence, numbers)) {
      const excerpt = text.length > 80 ? `${text.slice(0, 77)}…` : text;
      issues.add(
        `Copy claims ${rule.label} ("${excerpt}") that the brief does not support. Remove the claim or rephrase without it; never invent awards, press, ratings, counts, certifications or dates.`,
      );
    }
  }
  return [...issues];
}
