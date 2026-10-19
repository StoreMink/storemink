import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MINK_TOOL_GROUPS,
  type MinkToolGroup,
  type MinkToolRoute,
} from "./tool-routing";
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

/**
 * A rule that only matters when a tool is present carries a tag at the start
 * of its line: `- [[when: tool_a, tool_b, propose_*, #group]] Rule text`.
 *
 * ★★ THE SPOKEN RULES' MECHANISM, APPLIED TO EVERY TOOL. The prompt was
 * 55,000 characters, most of it rules for tools the run had not been given or
 * did not need (the image generator's rule alone is 5,500), and every model
 * step re-sent all of it. A tagged rule is rendered when any listed tool is
 * declared for this run, any `prefix*` matches a declared tool, or a listed
 * `#group` is in the route; otherwise its whole line is left out. An untagged
 * rule always renders.
 *
 * ★ With no route, or the "all" route, every `#group` counts as present, so a
 * run that was not narrowed reads the rules for every tool it was given:
 * exactly the prompt it read before tags existed.
 */
const RULE_TAG = /^- \[\[when: ([^\]\n]*)\]\] /;
const TAG_ENTRY = /^(?:#[a-z_]+|[a-z_]+\*?)$/;

interface PromptRuleCondition {
  tools: string[];
  prefixes: string[];
  groups: MinkToolGroup[];
}

export function parseMinkPromptRuleTag(body: string): PromptRuleCondition {
  const entries = body.split(",").map((entry) => entry.trim());
  const condition: PromptRuleCondition = {
    tools: [],
    prefixes: [],
    groups: [],
  };
  if (entries.length === 0 || entries.some((entry) => !TAG_ENTRY.test(entry)))
    throw new Error(`Mink system prompt rule tag "${body}" is malformed.`);
  for (const entry of entries) {
    if (entry.startsWith("#")) {
      const group = entry.slice(1) as MinkToolGroup;
      if (!MINK_TOOL_GROUPS.includes(group))
        throw new Error(
          `Mink system prompt rule tag names an unknown group: ${entry}.`,
        );
      condition.groups.push(group);
    } else if (entry.endsWith("*")) {
      condition.prefixes.push(entry.slice(0, -1));
    } else {
      condition.tools.push(entry);
    }
  }
  return condition;
}

/** Every rule tag in a template, for the registry cross-check in the tests. */
export function listMinkPromptRuleTags(
  template: string,
): PromptRuleCondition[] {
  return template
    .split("\n")
    .map((line) => line.match(RULE_TAG))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => parseMinkPromptRuleTag(match[1]));
}

/**
 * Keep the rules this run needs. `groups` null means every group (no route,
 * or the "all" route).
 */
export function selectMinkPromptRules(
  template: string,
  declared: ReadonlySet<string>,
  groups: ReadonlySet<MinkToolGroup> | null,
): string {
  const names = [...declared];
  return template
    .split("\n")
    .flatMap((line) => {
      const tag = line.match(RULE_TAG);
      if (!tag) return [line];
      const condition = parseMinkPromptRuleTag(tag[1]);
      const keep =
        condition.tools.some((tool) => declared.has(tool)) ||
        condition.prefixes.some((prefix) =>
          names.some((name) => name.startsWith(prefix)),
        ) ||
        condition.groups.some((group) => groups === null || groups.has(group));
      return keep ? [`- ${line.slice(tag[0].length)}`] : [];
    })
    .join("\n");
}

export function renderMinkSystemInstruction(
  actor: PromptActor,
  declarations: MinkToolDeclaration[],
  route?: Pick<MinkToolRoute, "mode" | "groups"> | null,
): string {
  const rules = selectMinkPromptRules(
    getMinkSystemPromptTemplate(),
    new Set(declarations.map((declaration) => declaration.name)),
    route?.mode === "narrow" ? new Set(route.groups) : null,
  );
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
  return rules.replace(
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
  // A tag anywhere but the start of a rule line would reach the model as
  // literal brackets and never be evaluated, so it fails closed here.
  for (const line of template.split("\n")) {
    if (!line.includes("[[")) continue;
    const tag = line.match(RULE_TAG);
    if (!tag || line.indexOf("[[", tag[0].length) >= 0)
      throw new Error(
        "Mink system prompt rule tags must open a rule line as `- [[when: ...]] `.",
      );
    parseMinkPromptRuleTag(tag[1]);
  }
  return template;
}
