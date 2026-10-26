import { describe, expect, it } from "vitest";
import {
  normalizeMinkPageContext,
  normalizeMinkScreenContext,
  renderMinkScreenReference,
} from "./page-context";

const ID = "10000000-0000-4000-8000-000000000001";

describe("normalizeMinkPageContext", () => {
  it("keeps bounded dashboard context and a supported selected record", () => {
    expect(
      normalizeMinkPageContext({
        currentPath: "/dashboard/products/one?tab=inventory",
        selectedResource: { type: "product", id: ID },
      }),
    ).toEqual({
      currentPath: "/dashboard/products/one?tab=inventory",
      selectedResource: { type: "product", id: ID },
      screen: null,
      voice: false,
    });
  });

  it("keeps the voice flag only when it is exactly true", () => {
    expect(
      normalizeMinkPageContext({ currentPath: "/dashboard", voice: true })
        .voice,
    ).toBe(true);
    expect(normalizeMinkPageContext({ voice: "yes" }).voice).toBe(false);
    expect(normalizeMinkPageContext({ voice: 1 }).voice).toBe(false);
    expect(normalizeMinkPageContext(undefined).voice).toBe(false);
  });

  it("keeps a bounded screen and ignores a retired reply language", () => {
    // Tabs opened before the Reply language menu was removed still send it.
    const input = {
      currentPath: "/dashboard/orders",
      replyLanguage: "hi",
      screen: {
        title: "Orders · StoreMink",
        headings: ["Orders", 7, "x".repeat(200)],
        query: { status: "pending", prefill: "mink", q: "ORD1001" },
        rows: Array.from({ length: 30 }, (_, i) => `ORD10011${i} · pending`),
        selectedCount: 2,
        fields: [
          { label: "Search", value: "ORD1001" },
          { label: "API key", value: "secret" },
          { label: "Password", value: "hunter2" },
        ],
      },
    };
    const context = normalizeMinkPageContext(input);
    expect(context).not.toHaveProperty("replyLanguage");
    expect(context.screen?.headings).toEqual(["Orders", "x".repeat(80)]);
    expect(context.screen?.rows).toHaveLength(20);
    expect(context.screen?.selectedCount).toBe(2);
    expect(context.screen?.fields).toEqual([
      { label: "Search", value: "ORD1001" },
    ]);
    expect(normalizeMinkScreenContext({ title: "   " })).toBeNull();
    expect(normalizeMinkScreenContext("nope")).toBeNull();
    const reference = renderMinkScreenReference(
      context.screen,
      "/dashboard/orders",
    );
    expect(reference).toContain("untrusted reference data");
    expect(reference).toContain('"path":"/dashboard/orders"');
    expect(reference).not.toContain("hunter2");
    expect(renderMinkScreenReference(null, "/dashboard")).toBe("");
  });

  it("hides contact details a tab that did not mask sent, before bounding them", () => {
    // What a tab opened before the browser masked sends: textContent glued
    // each cell's parts together.
    const screen = normalizeMinkScreenContext({
      title: "Priya Sharma · priya@example.com · StoreMink",
      headings: ["Customer +91 98765 43210"],
      query: { q: "priya@example.com", status: "pending" },
      dialog: "Call 022 2345 6789",
      notice: "Invite sent to rahul@example.com",
      rows: [
        "PSPriya Sharmapriya@example.com · +919876543210 · 25 Oct 2026",
        "ORD10011027 · RSRahul Singh+91 98765 43210 · 12 MG Road, Indiranagar, Bengaluru 560038 · ₹1,240.5",
        // The email straddles the 160-character bound.
        `${"x".repeat(150)} priya.sharma.orders@examplecorp.com`,
      ],
      fields: [
        { label: "Search", value: "98765 43210" },
        { label: "Address line 1", value: "12 MG Road" },
        { label: "City", value: "Bengaluru" },
        { label: "Show business address", value: "on" },
      ],
    });
    expect(screen).toEqual({
      title: "Priya Sharma · [email hidden] · StoreMink",
      headings: ["Customer [phone hidden]"],
      query: { q: "[email hidden]", status: "pending" },
      dialog: "Call [phone hidden]",
      notice: "Invite sent to [email hidden]",
      rows: [
        "PSPriya [email hidden] · [phone hidden] · 25 Oct 2026",
        "ORD10011027 · RSRahul Singh[phone hidden] · [address hidden] · ₹1,240.5",
        `${"x".repeat(150)} [email hi`,
      ],
      fields: [
        { label: "Search", value: "[phone hidden]" },
        { label: "Address line 1", value: "[address hidden]" },
        { label: "City", value: "Bengaluru" },
        { label: "Show business address", value: "on" },
      ],
    });
    expect(JSON.stringify(screen)).not.toMatch(/priya\.|98765|560038/);
  });

  it("hides chained numbers and a PIN followed by a phone that a tab sent unmasked", () => {
    const screen = normalizeMinkScreenContext({
      rows: [
        "Asha Rao · Hello, please call me on my numbers 9876543210/9123456789 t… · New",
      ],
      fields: [
        { label: "Notes", value: "Call 9876543210/9123456789/9988776655" },
        {
          label: "Note",
          value:
            "Priya Sharma Lakeview Residency, Indiranagar Bengaluru 560038 98765 43210",
        },
      ],
    });
    expect(screen).toEqual({
      rows: [
        "Asha Rao · Hello, please call me on my numbers [phone hidden]/[phone hidden] t… · New",
      ],
      fields: [
        {
          label: "Notes",
          value: "Call [phone hidden]/[phone hidden]/[phone hidden]",
        },
        { label: "Note", value: "[address hidden]" },
      ],
    });
  });

  it("masks the path's query string before it reaches the prompt", () => {
    const context = normalizeMinkPageContext({
      currentPath: "/dashboard/users?q=priya%40example.com&filter=all",
    });
    expect(context.currentPath).toBe(
      "/dashboard/users?q=%5Bemail+hidden%5D&filter=all",
    );
    expect(
      renderMinkScreenReference({ title: "Customers" }, context.currentPath),
    ).not.toContain("priya");
  });

  it("drops foreign paths, malformed ids, and unsupported resource types", () => {
    expect(
      normalizeMinkPageContext({
        currentPath: "https://attacker.example/dashboard",
        selectedResource: { type: "customer", id: "not-an-id" },
      }),
    ).toEqual({
      currentPath: null,
      selectedResource: null,
      screen: null,
      voice: false,
    });
    expect(
      normalizeMinkPageContext({ currentPath: "/dashboard-attacker" }),
    ).toEqual({
      currentPath: null,
      selectedResource: null,
      screen: null,
      voice: false,
    });
  });
});
