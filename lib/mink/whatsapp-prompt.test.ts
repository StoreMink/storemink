import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getMinkWhatsAppPromptTemplate,
  parseMinkWhatsAppPromptDocument,
  renderMinkWhatsAppPrompt,
} from "./whatsapp-prompt";

const DOCUMENT_PATH = join(process.cwd(), "docs", "mink-ai-whatsapp-prompt.md");

describe("Mink WhatsApp answer prompt document", () => {
  it("loads the marked template and says what matters: facts only, hand over, no links of its own", () => {
    const template = getMinkWhatsAppPromptTemplate();
    expect(template).toContain("{{store_name}}");
    expect(template).toContain("{{today}}");
    for (const rule of [
      "only the STORE FACTS",
      "hand_over",
      "refund",
      "Include a link only if it appears in the facts",
      "untrusted",
      "never claim to be a person",
      "Never use a long dash",
      '"outcome"',
    ]) {
      expect(template).toContain(rule);
    }
    // Owner's rule for product text.
    expect(template).not.toMatch(/—/);
  });

  it("renders the store name and the date once, and leaves anything else alone", () => {
    const rendered = renderMinkWhatsAppPrompt(
      "Echoss {{today}}",
      "Tuesday, 14 October 2026",
    );
    expect(rendered).toContain("Echoss {{today}}'s WhatsApp number");
    expect(rendered).toContain("Today is Tuesday, 14 October 2026.");
    expect(rendered).not.toContain("{{store_name}}");
  });

  it("keeps the checked-in document parseable", () => {
    expect(() =>
      parseMinkWhatsAppPromptDocument(readFileSync(DOCUMENT_PATH, "utf8")),
    ).not.toThrow();
  });

  it("fails closed when markers, fences or placeholders drift", () => {
    const document = readFileSync(DOCUMENT_PATH, "utf8");
    expect(() =>
      parseMinkWhatsAppPromptDocument(
        document.replace("<!-- MINK_WHATSAPP_PROMPT_END -->", ""),
      ),
    ).toThrow(/marker pair/);
    expect(() =>
      parseMinkWhatsAppPromptDocument(document.replace("```text", "```md")),
    ).toThrow(/text code fence/);
    expect(() =>
      parseMinkWhatsAppPromptDocument(
        document.replace("{{today}}", "{{today}} {{facts}}"),
      ),
    ).toThrow(/no other placeholders/);
    expect(() =>
      parseMinkWhatsAppPromptDocument(document.replace("{{today}}", "today")),
    ).toThrow(/exactly once/);
  });
});
