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
      replyLanguage: "auto",
    });
  });

  it("keeps a validated reply language and a bounded screen", () => {
    const context = normalizeMinkPageContext({
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
    });
    expect(context.replyLanguage).toBe("hi");
    expect(context.screen?.headings).toEqual(["Orders", "x".repeat(80)]);
    expect(context.screen?.rows).toHaveLength(20);
    expect(context.screen?.selectedCount).toBe(2);
    expect(context.screen?.fields).toEqual([
      { label: "Search", value: "ORD1001" },
    ]);
    expect(
      normalizeMinkPageContext({ replyLanguage: "fr" }).replyLanguage,
    ).toBe("auto");
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
      replyLanguage: "auto",
    });
    expect(
      normalizeMinkPageContext({ currentPath: "/dashboard-attacker" }),
    ).toEqual({
      currentPath: null,
      selectedResource: null,
      screen: null,
      replyLanguage: "auto",
    });
  });
});
