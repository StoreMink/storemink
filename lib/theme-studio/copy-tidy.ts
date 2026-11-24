// ---------------------------------------------------------------------------
// Tidying a draft's copy before it is compiled (prompt v34+).
//
// Two faults of the first live v34 theme (22 Nov 2026, "Roast") that no check
// caught, because both are valid data:
//   - its announcement bar read "SIP BETTER, FEEL BETTER [long dash] FREE NATIONWIDE
//     SHIPPING": a long dash, which StoreMink's own rule keeps out of every
//     text it generates for a merchant (lib/text/long-dashes.ts);
//   - its header menu read "Our Story | Roast Specialty Coffee": the page's
//     browser-tab title, where a shopper taps a short name.
// Neither needs a model to mend, so neither is sent back to one.
//
// ★ ONLY TEXT A MODEL WROTE FOR A THEME is touched, on its way into a new
//   package. Copy a merchant types is theirs and is never rewritten.
// ★ A field that is JSON inside a string (configJson, templatesJson,
//   stylesheetJson, designPlanJson) is parsed, tidied and written back, never
//   edited as text: the dash rule also tidies commas, which JSON is made of.
// Pure.
// ---------------------------------------------------------------------------

import { withoutLongDashes } from "@/lib/text/long-dashes";

const LONG_DASH = /[\u2013\u2014]/;
const isRec = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function tidy(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    if (!LONG_DASH.test(value)) return value;
    if (key.endsWith("Json")) {
      try {
        return JSON.stringify(tidy(JSON.parse(value), ""));
      } catch {
        // Not JSON after all: its own validator will say so.
        return value;
      }
    }
    return withoutLongDashes(value);
  }
  if (Array.isArray(value)) return value.map((item) => tidy(item, key));
  if (isRec(value))
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, tidy(item, name)]),
    );
  return value;
}

/**
 * A menu label as a shopper reads it: the words before a title bar. "Our
 * Story | Roast Specialty Coffee" is "Our Story"; a label with no bar, or
 * with nothing before one, is left as written.
 */
export function navLabel(label: string): string {
  const [first] = label.split(/\s+\|\s+/);
  return first.trim() || label;
}

function tidyLinks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) =>
    isRec(item)
      ? {
          ...item,
          ...(typeof item.label === "string"
            ? { label: navLabel(item.label) }
            : {}),
          ...("children" in item ? { children: tidyLinks(item.children) } : {}),
          ...("links" in item ? { links: tidyLinks(item.links) } : {}),
        }
      : item,
  );
}

/** The longest a menu label may be. Longer ones overflowed the phone menu on
 *  the first live v34 theme, which the design review rejected. */
export const NAV_LABEL_MAX = 28;

/**
 * Menu labels still too long after tidying, as repair issues. A label is a
 * fixed part of every theme, so its length is a rule, not a preference.
 */
export function menuLabelIssues(draft: unknown): string[] {
  if (!isRec(draft) || !isRec(draft.menus)) return [];
  const issues: string[] = [];
  const walk = (value: unknown, where: string) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!isRec(item)) continue;
      if (typeof item.label === "string" && item.label.length > NAV_LABEL_MAX)
        issues.push(
          `${where} label ${JSON.stringify(item.label)} is ${item.label.length} characters; a menu label is at most ${NAV_LABEL_MAX}. Use the short name a shopper taps ("Our Story", "Brewing Guide").`,
        );
      walk(item.children, where);
      walk(item.links, where);
    }
  };
  walk(draft.menus.header, "menus.header");
  walk(draft.menus.footerGroups, "menus.footerGroups");
  walk(draft.menus.footerLegal, "menus.footerLegal");
  return issues;
}

/** The draft with its long dashes rewritten and its menu labels shortened. */
export function tidyDraftCopy(draft: unknown): unknown {
  if (!isRec(draft)) return draft;
  const tidied = tidy(draft, "") as Record<string, unknown>;
  if (!isRec(tidied.menus)) return tidied;
  return {
    ...tidied,
    menus: {
      ...tidied.menus,
      header: tidyLinks(tidied.menus.header),
      footerGroups: tidyLinks(tidied.menus.footerGroups),
      footerLegal: tidyLinks(tidied.menus.footerLegal),
    },
  };
}
