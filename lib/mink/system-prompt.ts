import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MinkActorContext, MinkToolDeclaration } from "./types";

const PROMPT_DOCUMENT_PATH = join(
  process.cwd(),
  "docs",
  "mink-ai-system-prompt.md",
);
const START_MARKER = "<!-- MINK_SYSTEM_PROMPT_START -->";
const END_MARKER = "<!-- MINK_SYSTEM_PROMPT_END -->";
const SPOKEN_START_MARKER = "<!-- MINK_SPOKEN_RULES_START -->";
const SPOKEN_END_MARKER = "<!-- MINK_SPOKEN_RULES_END -->";
const PLACEHOLDERS = [
  "effective_plan",
  "role_slug_or_custom",
  "current_dashboard_page",
  "selected_resource_type",
  "available_tool_names",
  "brand_voice_or_default",
  "answer_medium",
  "spoken_answer_rules",
] as const;

type PromptPlaceholder = (typeof PLACEHOLDERS)[number];
type PromptActor = Pick<
  MinkActorContext,
  | "effectivePlan"
  | "roleSlug"
  | "currentPath"
  | "selectedResource"
  | "brandVoice"
  | "answerMedium"
>;

let productionTemplate: string | null = null;
let productionSpokenRules: string | null = null;

export function renderMinkSystemInstruction(
  actor: PromptActor,
  declarations: MinkToolDeclaration[],
): string {
  const values: Record<PromptPlaceholder, string> = {
    effective_plan: actor.effectivePlan,
    role_slug_or_custom: actor.roleSlug || "custom",
    current_dashboard_page: actor.currentPath ?? "not supplied",
    selected_resource_type: actor.selectedResource?.type ?? "none",
    available_tool_names:
      declarations.map((tool) => tool.name).join(", ") || "none",
    brand_voice_or_default:
      actor.brandVoice ??
      "Use a warm, clear and honest voice. Never invent facts.",
    answer_medium: actor.answerMedium === "spoken" ? "spoken" : "written",
    // ★ The spoken rules enter the prompt only on a voice turn. A written turn
    // renders an empty line here, so the model is never told about a block it
    // must not write.
    spoken_answer_rules:
      actor.answerMedium === "spoken" ? getMinkSpokenAnswerRules() : "",
  };
  return getMinkSystemPromptTemplate().replace(
    /\{\{([a-z_]+)\}\}/g,
    (_token, key: string) => values[key as PromptPlaceholder],
  );
}

export function getMinkSystemPromptTemplate(): string {
  if (process.env.NODE_ENV === "production" && productionTemplate) {
    return productionTemplate;
  }
  const template = parseMinkSystemPromptDocument(
    readFileSync(PROMPT_DOCUMENT_PATH, "utf8"),
  );
  if (process.env.NODE_ENV === "production") productionTemplate = template;
  return template;
}

/**
 * The rules a voice turn adds, kept in the same reviewed document as the
 * prompt (§4a) rather than in code, so a reviewer reads them beside the rules
 * they extend.
 */
export function getMinkSpokenAnswerRules(): string {
  if (process.env.NODE_ENV === "production" && productionSpokenRules) {
    return productionSpokenRules;
  }
  const rules = parseMinkSpokenAnswerRules(
    readFileSync(PROMPT_DOCUMENT_PATH, "utf8"),
  );
  if (process.env.NODE_ENV === "production") productionSpokenRules = rules;
  return rules;
}

export function parseMinkSpokenAnswerRules(document: string): string {
  const start = document.indexOf(SPOKEN_START_MARKER);
  const end = document.indexOf(SPOKEN_END_MARKER);
  if (
    start < 0 ||
    end < 0 ||
    end <= start ||
    document.indexOf(SPOKEN_START_MARKER, start + SPOKEN_START_MARKER.length) >=
      0 ||
    document.indexOf(SPOKEN_END_MARKER, end + SPOKEN_END_MARKER.length) >= 0
  ) {
    throw new Error(
      "Mink system prompt document must contain exactly one ordered spoken rules marker pair.",
    );
  }
  const section = document
    .slice(start + SPOKEN_START_MARKER.length, end)
    .trim()
    .replace(/\r\n/g, "\n");
  const fenced = section.match(/^```text\n([\s\S]*?)\n```$/);
  if (!fenced) {
    throw new Error(
      "Mink spoken rules markers must contain exactly one text code fence.",
    );
  }
  const rules = fenced[1];
  // Substitution is one pass over the template, so a placeholder inside the
  // rules would reach the model as literal braces; refuse it outright.
  if (/\{\{/.test(rules)) {
    throw new Error("Mink spoken rules must not contain a placeholder.");
  }
  if (!rules.includes("<spoken>") || !rules.includes("</spoken>")) {
    throw new Error("Mink spoken rules must name both spoken tags.");
  }
  return rules;
}

export function parseMinkSystemPromptDocument(document: string): string {
  const start = document.indexOf(START_MARKER);
  const end = document.indexOf(END_MARKER);
  if (
    start < 0 ||
    end < 0 ||
    end <= start ||
    document.indexOf(START_MARKER, start + START_MARKER.length) >= 0 ||
    document.indexOf(END_MARKER, end + END_MARKER.length) >= 0
  ) {
    throw new Error(
      "Mink system prompt document must contain exactly one ordered prompt marker pair.",
    );
  }
  const section = document
    .slice(start + START_MARKER.length, end)
    .trim()
    .replace(/\r\n/g, "\n");
  const fenced = section.match(/^```text\n([\s\S]*?)\n```$/);
  if (!fenced) {
    throw new Error(
      "Mink system prompt markers must contain exactly one text code fence.",
    );
  }
  const template = fenced[1];
  const found = template.match(/\{\{[^{}]+\}\}/g) ?? [];
  for (const placeholder of PLACEHOLDERS) {
    const token = `{{${placeholder}}}`;
    if (found.filter((value) => value === token).length !== 1) {
      throw new Error(`Mink system prompt must contain ${token} exactly once.`);
    }
  }
  if (found.length !== PLACEHOLDERS.length) {
    throw new Error("Mink system prompt contains an unknown placeholder.");
  }
  return template;
}
