/**
 * The one question the top-bar "Ask Mink AI" bar offers. Pure and
 * client-safe: no database, no server imports.
 *
 * A page that already knows a better question than the skills catalogue
 * (the go-live card, which knows the task the merchant has open) offers it
 * through `MinkPageSuggestion`; otherwise the bar takes the first starter
 * skill for the page, the same source the panel's empty state uses.
 */

import { minkStarterSkills, type MinkSkill } from "./skills";

export interface MinkDockSuggestion {
  label: string;
  prompt: string;
}

/** A chip in the panel's empty state, or the bar's one suggestion. */
export interface MinkSuggestedPrompt extends MinkDockSuggestion {
  id: string;
  description: string;
}

function usableSuggestion(
  suggestion: MinkDockSuggestion | null | undefined,
): MinkDockSuggestion | null {
  if (!suggestion) return null;
  const label = suggestion.label.trim();
  const prompt = suggestion.prompt.trim();
  return label && prompt ? { label, prompt } : null;
}

/**
 * The questions offered for a page, best first: the page's own question
 * (only when it has both words to show and words to send), then the starter
 * skills for the path, a skill asking the same thing dropped. The bar shows
 * the first; the panel's empty state shows up to four. One helper, so the
 * two never disagree about what leads.
 */
export function minkSuggestedPrompts(
  skills: readonly MinkSkill[],
  pathname: string | null | undefined,
  pageSuggestion: MinkDockSuggestion | null | undefined,
  limit = 4,
): MinkSuggestedPrompt[] {
  if (limit <= 0) return [];
  const page = usableSuggestion(pageSuggestion);
  const starters = minkStarterSkills(skills, pathname, limit + 1)
    .filter((skill) => !page || skill.prompt.trim() !== page.prompt)
    .map((skill) => ({
      id: skill.id,
      label: skill.label,
      prompt: skill.prompt,
      description: skill.description,
    }));
  const lead: MinkSuggestedPrompt[] = page
    ? [{ id: "page-suggestion", ...page, description: page.label }]
    : [];
  return [...lead, ...starters].slice(0, limit);
}

export function minkDockSuggestion(
  skills: readonly MinkSkill[],
  pathname: string | null | undefined,
  pageSuggestion: MinkDockSuggestion | null | undefined,
): MinkDockSuggestion | null {
  const [first] = minkSuggestedPrompts(skills, pathname, pageSuggestion, 1);
  return first ? { label: first.label, prompt: first.prompt } : null;
}

/**
 * One plain question per required go-live task
 * (`lib/store/launch-checklist-rules.ts`). Any other key has none.
 */
const GO_LIVE_TASK_QUESTIONS: Readonly<Record<string, string>> = {
  phone: "How do I verify my mobile number?",
  theme: "How do I choose a theme for my store?",
  products: "How do I add my first product?",
  business: "Which business and delivery details does my store need?",
  policies: "How do I publish my store policies?",
};

export function goLiveTaskQuestion(
  key: string | null | undefined,
): MinkDockSuggestion | null {
  if (!key) return null;
  const question = Object.prototype.hasOwnProperty.call(
    GO_LIVE_TASK_QUESTIONS,
    key,
  )
    ? GO_LIVE_TASK_QUESTIONS[key]
    : undefined;
  if (!question) return null;
  return { label: question, prompt: question };
}
