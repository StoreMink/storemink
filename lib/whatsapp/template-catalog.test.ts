import { describe, expect, it } from "vitest";
import { EVENTS } from "@/lib/notifications/events";
import { variableNamesFor } from "@/lib/notifications/variables";
import {
  WHATSAPP_TEMPLATE_CATALOG,
  bodyPlaceholders,
  catalogTemplateFor,
  renderWhatsAppBody,
  templateComponentsFor,
  whatsAppParameterText,
} from "./template-catalog";

// ---------------------------------------------------------------------------
// Every rule Meta applies at review, pinned — a template refused at submission
// is a store whose order updates silently never send.
// ---------------------------------------------------------------------------

const AUDIENCE_KEY = { team: "store-admins", customer: "customer" } as const;

describe("WHATSAPP_TEMPLATE_CATALOG", () => {
  it("names are Meta-safe and unique", () => {
    const names = WHATSAPP_TEMPLATE_CATALOG.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9_]{1,512}$/);
      expect(name.startsWith("sm_")).toBe(true);
    }
  });

  it("every template maps onto an event, an audience that event reaches, and variables that event carries", () => {
    for (const t of WHATSAPP_TEMPLATE_CATALOG) {
      const def = EVENTS.find((e) => e.key === t.eventKey);
      expect(def, `${t.name}: unknown event ${t.eventKey}`).toBeTruthy();
      expect(
        Object.keys(def!.audiences),
        `${t.name}: ${t.eventKey} never reaches ${t.audience}`,
      ).toContain(AUDIENCE_KEY[t.audience]);
      const allowed = variableNamesFor(t.eventKey);
      for (const v of t.variables) {
        expect(allowed.has(v), `${t.name}: ${t.eventKey} has no ${v}`).toBe(
          true,
        );
      }
    }
  });

  it("placeholders are sequential, never adjacent, never first or last, and each has an example", () => {
    for (const t of WHATSAPP_TEMPLATE_CATALOG) {
      const slots = bodyPlaceholders(t.body);
      expect(slots, t.name).toEqual(slots.map((_, i) => i + 1));
      expect(slots.length, t.name).toBe(t.variables.length);
      expect(t.examples.length, t.name).toBe(t.variables.length);
      expect(t.body, t.name).not.toMatch(/^\{\{\d+\}\}/);
      expect(t.body, t.name).not.toMatch(/\{\{\d+\}\}\.?$/);
      expect(t.body, t.name).not.toMatch(/\}\}\s*\{\{/);
      expect(t.body.length, t.name).toBeLessThanOrEqual(1024);
      expect(t.body, t.name).not.toMatch(/[\r\n\t]/);
      for (const e of t.examples) expect(e.trim(), t.name).not.toBe("");
    }
  });

  it("one template per event and audience, looked up by both", () => {
    const seen = new Set<string>();
    for (const t of WHATSAPP_TEMPLATE_CATALOG) {
      const key = `${t.eventKey}:${t.audience}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
      expect(catalogTemplateFor(t.eventKey, t.audience)).toBe(t);
    }
    expect(catalogTemplateFor("order.placed", "nobody")).toBeUndefined();
  });

  it("the components array carries the body and its examples", () => {
    const t = catalogTemplateFor("order.placed", "customer")!;
    expect(templateComponentsFor(t)).toEqual([
      {
        type: "BODY",
        text: t.body,
        example: { body_text: [t.examples] },
      },
    ]);
  });
});

describe("whatsAppParameterText", () => {
  it("strips what Meta refuses and never returns an empty parameter", () => {
    expect(whatsAppParameterText("a\nb\tc")).toBe("a b c");
    expect(whatsAppParameterText("a        b")).toBe("a    b");
    expect(whatsAppParameterText("")).toBe("-");
    expect(whatsAppParameterText(undefined)).toBe("-");
    expect(whatsAppParameterText("  x  ")).toBe("x");
  });
});

describe("renderWhatsAppBody", () => {
  it("fills placeholders in order and dashes a missing value", () => {
    expect(
      renderWhatsAppBody("Order {{1}} at {{2}}: {{3}}.", ["ORD1", "Acme"]),
    ).toBe("Order ORD1 at Acme: -.");
  });
});
