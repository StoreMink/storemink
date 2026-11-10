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

export function minkDockSuggestion(
  skills: readonly MinkSkill[],
  pathname: string | null | undefined,
  pageSuggestion: MinkDockSuggestion | null | undefined,
): MinkDockSuggestion | null {
  if (pageSuggestion && pageSuggestion.label && pageSuggestion.prompt) {
    return { label: pageSuggestion.label, prompt: pageSuggestion.prompt };
  }
  const [first] = minkStarterSkills(skills, pathname, 1);
  if (!first) return null;
  return { label: first.label, prompt: first.prompt };
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
