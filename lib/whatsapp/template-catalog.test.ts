import { describe, expect, it } from "vitest";
import { EVENTS } from "@/lib/notifications/events";
import { variableNamesFor } from "@/lib/notifications/variables";
import {
  WHATSAPP_TEMPLATE_CATALOG,
  bodyPlaceholders,
  catalogTemplateFor,
  pickTemplateRow,
  renderWhatsAppBody,
  templateComponentsFor,
  templateNameVersion,
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

  // ★ Meta rejected the pickup-ready template as INCORRECT_CATEGORY twice: a
  // promotional opener reads as MARKETING, and the collection code reads as
  // an AUTHENTICATION code whatever it is called ("code", "pickup reference").
  // Probes without it were accepted as UTILITY. Pinned so no body brings
  // either back.
  it("no UTILITY body reads as marketing or carries a verification-style code", () => {
    for (const t of WHATSAPP_TEMPLATE_CATALOG) {
      expect(t.body, t.name).not.toMatch(
        /^(good news|great news|congratulations|hurry|exciting)/i,
      );
      expect(t.body, t.name).not.toMatch(/\bcode\s*\{\{/i);
      expect(t.variables, t.name).not.toContain("collection_code");
    }
  });

  it("a reworded entry gets a new name; the others keep theirs", () => {
    expect(catalogTemplateFor("order.ready_for_pickup", "customer")?.name).toBe(
      "sm_order_ready_for_pickup_customer_v3",
    );
    expect(catalogTemplateFor("order.placed", "customer")?.name).toBe(
      "sm_order_placed_customer_v1",
    );
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

describe("templateNameVersion", () => {
  it("reads the _v<n> suffix, and 0 for a name without one", () => {
    expect(templateNameVersion("sm_order_placed_customer_v1")).toBe(1);
    expect(templateNameVersion("sm_order_ready_for_pickup_customer_v12")).toBe(
      12,
    );
    expect(templateNameVersion("diwali_promo")).toBe(0);
  });
});

describe("pickTemplateRow", () => {
  const V1 = "sm_order_ready_for_pickup_customer_v1";
  const V2 = "sm_order_ready_for_pickup_customer_v2";
  const row = (name: string, status: string) => ({ name, status });

  it("★ the current version wins once approved, whatever the row order", () => {
    const rows = [row(V2, "APPROVED"), row(V1, "APPROVED")];
    expect(pickTemplateRow(rows, V2)?.name).toBe(V2);
    expect(pickTemplateRow([...rows].reverse(), V2)?.name).toBe(V2);
  });

  it("★ an older approved version keeps sending while the new one is in review", () => {
    const rows = [row(V1, "APPROVED"), row(V2, "PENDING")];
    expect(pickTemplateRow(rows, V2)?.name).toBe(V1);
  });

  it("★ a rejected old version never hides its replacement", () => {
    const rows = [row(V1, "REJECTED"), row(V2, "PENDING")];
    expect(pickTemplateRow(rows, V2)?.name).toBe(V2);
  });

  it("without a current name, the newest approved, then the newest", () => {
    expect(
      pickTemplateRow([row(V1, "APPROVED"), row(V2, "APPROVED")], undefined)
        ?.name,
    ).toBe(V2);
    expect(
      pickTemplateRow([row(V1, "REJECTED"), row(V2, "PENDING")], undefined)
        ?.name,
    ).toBe(V2);
    expect(pickTemplateRow([], V2)).toBeUndefined();
  });
});
