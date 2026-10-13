import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The system instruction for customer-facing Mink on WhatsApp
// (docs/mink-ai-whatsapp-prompt.md), read and validated like the image
// prompt: one marker pair, one text fence, exactly the two placeholders the
// code fills. A missing marker or a stray placeholder fails closed before a
// model call is made, so an edit to the document cannot silently send a
// customer an instruction with "{{store_name}}" left in it.
// ---------------------------------------------------------------------------

const PROMPT_DOCUMENT_PATH = join(
  process.cwd(),
  "docs",
  "mink-ai-whatsapp-prompt.md",
);
const START_MARKER = "<!-- MINK_WHATSAPP_PROMPT_START -->";
const END_MARKER = "<!-- MINK_WHATSAPP_PROMPT_END -->";
const STORE_PLACEHOLDER = "{{store_name}}";
const TODAY_PLACEHOLDER = "{{today}}";

let productionTemplate: string | null = null;

/**
 * The instruction for one store, today. Pure apart from the file read.
 * ★ ONE PASS: both placeholders are filled by a single replace, so a store
 * name that happens to contain "{{today}}" is inserted, never expanded.
 */
export function renderMinkWhatsAppPrompt(
  storeName: string,
  today: string,
): string {
  const values: Record<string, string> = {
    [STORE_PLACEHOLDER]: storeName,
    [TODAY_PLACEHOLDER]: today,
  };
  return getMinkWhatsAppPromptTemplate().replace(
    /\{\{(?:store_name|today)\}\}/g,
    (token) => values[token] ?? token,
  );
}

export function getMinkWhatsAppPromptTemplate(): string {
  if (process.env.NODE_ENV === "production" && productionTemplate) {
    return productionTemplate;
  }
  const template = parseMinkWhatsAppPromptDocument(
    readFileSync(PROMPT_DOCUMENT_PATH, "utf8"),
  );
  if (process.env.NODE_ENV === "production") productionTemplate = template;
  return template;
}

export function parseMinkWhatsAppPromptDocument(document: string): string {
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
      "Mink WhatsApp prompt document must contain exactly one ordered prompt marker pair.",
    );
  }
  const section = document
    .slice(start + START_MARKER.length, end)
    .trim()
    .replace(/\r\n/g, "\n");
  const fenced = section.match(/^```text\n([\s\S]*?)\n```$/);
  if (!fenced) {
    throw new Error(
      "Mink WhatsApp prompt markers must contain exactly one text code fence.",
    );
  }
  const template = fenced[1];
  const found = template.match(/\{\{[^{}]+\}\}/g) ?? [];
  if (
    found.length !== 2 ||
    !found.includes(STORE_PLACEHOLDER) ||
    !found.includes(TODAY_PLACEHOLDER) ||
    template.split(STORE_PLACEHOLDER).length !== 2 ||
    template.split(TODAY_PLACEHOLDER).length !== 2
  ) {
    throw new Error(
      `Mink WhatsApp prompt must contain ${STORE_PLACEHOLDER} and ${TODAY_PLACEHOLDER} exactly once and no other placeholders.`,
    );
  }
  return template;
}
