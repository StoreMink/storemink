import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVENTS } from "@/lib/notifications/events";
import { variableNamesFor } from "@/lib/notifications/variables";
import {
  COD_CONFIRM_VARIANT,
  KNOWN_TEMPLATE_STATUSES,
  WHATSAPP_TEMPLATE_CATALOG,
  bodyPlaceholders,
  catalogEntryForName,
  catalogTemplateFor,
  knownTemplateStatus,
  pickTemplateRow,
  templateBodyProblem,
  renderWhatsAppBody,
  templateComponentsFor,
  templateFamily,
  templateNameVersion,
  templateRowVariables,
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

  it("one template per event, audience and variant, looked up by all three", () => {
    const seen = new Set<string>();
    for (const t of WHATSAPP_TEMPLATE_CATALOG) {
      const key = `${t.eventKey}:${t.audience}:${t.variant ?? ""}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
      expect(catalogTemplateFor(t.eventKey, t.audience, t.variant)).toBe(t);
    }
    expect(catalogTemplateFor("order.placed", "nobody")).toBeUndefined();
    // Asking without a variant never returns one.
    expect(catalogTemplateFor("order.placed", "customer")?.variant).toBe(
      undefined,
    );
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

describe("the COD confirmation variant", () => {
  const cod = catalogTemplateFor(
    "order.placed",
    "customer",
    COD_CONFIRM_VARIANT,
  )!;

  it("is its own template family, never a version of the plain message", () => {
    expect(cod.name).toBe("sm_order_placed_customer_cod_confirm_v1");
    expect(templateFamily(cod.name)).not.toBe(
      templateFamily(catalogTemplateFor("order.placed", "customer")!.name),
    );
  });

  it("★ a stored row maps back to its own entry, whatever its version", () => {
    expect(catalogEntryForName("sm_order_placed_customer_cod_confirm_v4")).toBe(
      cod,
    );
    expect(catalogEntryForName("sm_order_placed_customer_v1")?.variant).toBe(
      undefined,
    );
    // An old version of a reworded entry still maps to that entry.
    expect(
      catalogEntryForName("sm_order_ready_for_pickup_customer_v1")?.eventKey,
    ).toBe("order.ready_for_pickup");
    expect(catalogEntryForName("diwali_promo")).toBeUndefined();
  });

  it("★ carries the two buttons in the order the payloads assume", () => {
    expect(cod.quickReplies).toEqual(["Confirm order", "Cancel order"]);
    expect(templateComponentsFor(cod)).toEqual([
      {
        type: "BODY",
        text: cod.body,
        example: { body_text: [cod.examples] },
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Confirm order" },
          { type: "QUICK_REPLY", text: "Cancel order" },
        ],
      },
    ]);
  });

  it("button labels fit Meta's 25-character limit", () => {
    for (const t of WHATSAPP_TEMPLATE_CATALOG) {
      for (const label of t.quickReplies ?? []) {
        expect(label.length, `${t.name}: ${label}`).toBeLessThanOrEqual(25);
      }
    }
  });

  it("only the COD variant has buttons", () => {
    const withButtons = WHATSAPP_TEMPLATE_CATALOG.filter(
      (t) => (t.quickReplies ?? []).length > 0,
    );
    expect(withButtons).toEqual([cod]);
  });

  // ★★ Store credit never lowers orders.total and the courier collects the
  // total less the credit, so a ₹500 order with ₹200 of credit was told to
  // pay ₹500 on delivery. The VALUE changed; the words Meta approved did not,
  // which is why the name is still v1.
  it("★★ quotes the amount due on delivery, in the words Meta approved", () => {
    expect(cod.body).toBe(
      "Please confirm your cash on delivery order {{1}} from {{2}}. Amount to pay on delivery: {{3}}. Tap Confirm order and we will prepare it, or Cancel order if you no longer want it.",
    );
    expect(cod.variables).toEqual([
      "subject_label",
      "store_name",
      "amount_due",
    ]);
    expect(cod.name).toBe("sm_order_placed_customer_cod_confirm_v1");
  });

  it("★ every body that promises an amount to pay on delivery fills it with amount_due", () => {
    let promises = 0;
    for (const t of WHATSAPP_TEMPLATE_CATALOG) {
      for (const m of t.body.matchAll(/pay on delivery\W*\{\{(\d+)\}\}/gi)) {
        promises++;
        expect(t.variables[Number(m[1]) - 1], t.name).toBe("amount_due");
      }
    }
    // The scan must still find the one it exists for.
    expect(promises).toBeGreaterThan(0);
  });
});

describe("templateRowVariables", () => {
  const cod = catalogTemplateFor(
    "order.placed",
    "customer",
    COD_CONFIRM_VARIANT,
  )!;
  const STORED_BEFORE = ["subject_label", "store_name", "total"];

  it("★★ the current catalogue row takes the catalogue's mapping over the copy it was stored with", () => {
    // A store connected before the mapping changed holds the old copy, and
    // the bootstrap upsert never rewrites it.
    expect(templateRowVariables(cod.name, STORED_BEFORE)).toEqual([
      "subject_label",
      "store_name",
      "amount_due",
    ]);
  });

  it("returns a copy, never the catalogue's own list", () => {
    const got = templateRowVariables(cod.name, STORED_BEFORE);
    got.push("x");
    expect(cod.variables).toHaveLength(3);
  });

  it("an older version keeps the mapping it was submitted with", () => {
    // Its words may hold other placeholders than the current entry's.
    expect(
      templateRowVariables("sm_order_ready_for_pickup_customer_v1", [
        "subject_label",
        "pickup_location",
      ]),
    ).toEqual(["subject_label", "pickup_location"]);
  });

  it("a merchant's own template keeps its stored mapping, and junk reads as none", () => {
    expect(templateRowVariables("diwali_promo", ["Name", 2])).toEqual([
      "Name",
      "2",
    ]);
    expect(templateRowVariables("diwali_promo", null)).toEqual([]);
    expect(templateRowVariables("diwali_promo", "total")).toEqual([]);
  });
});

describe("templateBodyProblem: the one body rule", () => {
  it("★ every catalogue body passes the rule a merchant's template is held to", () => {
    for (const t of WHATSAPP_TEMPLATE_CATALOG) {
      expect(templateBodyProblem(t.body, t.examples), t.name).toBeNull();
    }
  });

  it("names each refusal in the merchant's words", () => {
    expect(templateBodyProblem("", [])).toBe("Write the message.");
    expect(templateBodyProblem("{{1}} ok", ["x"])).toMatch(/cannot start/);
    expect(templateBodyProblem("ok {{1}}.", ["x"])).toMatch(/cannot end/);
    expect(templateBodyProblem("a {{1}} {{2}} b", ["x", "y"])).toMatch(
      /next to each other/,
    );
    expect(templateBodyProblem("a {{2}} b {{1}} c", ["x", "y"])).toMatch(
      /Number the placeholders/,
    );
    expect(templateBodyProblem("a {{1}} b", [])).toBe(
      "Give every placeholder a sample value.",
    );
    expect(templateBodyProblem("a\tb", [])).toMatch(/tab/);
    expect(templateBodyProblem("a {{x}} b", [])).toMatch(/written \{\{1\}\}/);
  });
});

describe("knownTemplateStatus", () => {
  it("keeps Meta's words the row can hold and refuses the rest", () => {
    expect(knownTemplateStatus("approved")).toBe("APPROVED");
    expect(knownTemplateStatus("PAUSED")).toBe("PAUSED");
    expect(knownTemplateStatus("FLAGGED")).toBeNull();
    expect(knownTemplateStatus(undefined)).toBeNull();
  });

  // ★★ Meta posts REINSTATED when a paused or disabled template "can be sent
  // in template messages again". Ignored, the row stayed PAUSED / DISABLED and
  // the loaders, which send only APPROVED, kept it unsendable.
  it("★★ a reinstated template is approved again", () => {
    expect(knownTemplateStatus("REINSTATED")).toBe("APPROVED");
    expect(knownTemplateStatus("reinstated")).toBe("APPROVED");
  });

  it("★ only ever answers with a status the 0174 CHECK admits", () => {
    const sql = readFileSync(
      "drizzle/migrations/sql/20261008_0174_whatsapp_accounts.sql",
      "utf8",
    );
    const list =
      /whatsapp_templates_status_check\s+CHECK \(status IN \(([^)]*)\)\)/.exec(
        sql,
      )?.[1];
    expect(list).toBeTruthy();
    const admitted = [...(list ?? "").matchAll(/'([A-Z_]+)'/g)].map(
      (m) => m[1],
    );
    expect([...KNOWN_TEMPLATE_STATUSES].sort()).toEqual([...admitted].sort());
    for (const word of [
      ...admitted,
      "REINSTATED",
      "FLAGGED",
      "ARCHIVED",
      "LOCKED",
      "UNKNOWN_WORD",
    ]) {
      const status = knownTemplateStatus(word);
      if (status !== null) expect(admitted, word).toContain(status);
    }
  });
});
