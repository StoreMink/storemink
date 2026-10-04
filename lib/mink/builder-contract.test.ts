import { describe, expect, it } from "vitest";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import {
  builderDigest,
  builderPlan,
  patchChrome,
  navigationIssues,
  readBuilderPatch,
  assertSafeBuilderLinks,
  type BuilderTarget,
  type BuilderOperation,
} from "./builder-contract";
const chrome = () => ({
  ...structuredClone(DEFAULT_CHROME),
  header: {
    ...DEFAULT_CHROME.header,
    links: [
      { label: "MEN", href: "/shop?category=mens-shoes" },
      { label: "WOMEN", href: "/collections/women" },
    ],
  },
});
const target = (
  operation: BuilderOperation = "chrome_update",
): BuilderTarget => ({
  operation,
  pageSlug: "home",
  exists: true,
  chrome: chrome(),
  publishedChrome: null,
  version: "v1",
});
const patch = (t: BuilderTarget, changes: Record<string, unknown> = {}) => ({
  operation: t.operation,
  pageSlug: t.pageSlug,
  expectedDigest: builderDigest(t),
  changes,
});
const pageTarget = (operation: BuilderOperation): BuilderTarget => ({
  operation,
  pageSlug: "about",
  exists: true,
  page: {
    id: "page1",
    slug: "about",
    title: "About",
    status: "published",
    seoTitle: "",
    seoDescription: "",
    seoNoindex: false,
    sections: [],
    publishedSections: [],
    updatedAt: "v1",
    publishedAt: "2026-01-01T00:00:00Z",
  },
});
describe("Website Builder controls", () => {
  it("diagnoses the screenshot's hidden MEN destination and resolves its active category", () => {
    expect(
      navigationIssues(
        chrome(),
        [
          { slug: "mens-shoes", name: "Shoes", status: "hidden" },
          { slug: "men", name: "Men", status: "active" },
          { slug: "women", name: "Women", status: "active" },
        ],
        [],
      ).filter((issue) => issue.path.startsWith("header")),
    ).toEqual([
      expect.objectContaining({
        path: "header.links.0.href",
        href: "/shop?category=mens-shoes",
        suggestedHref: "/collections/men",
      }),
    ]);
  });
  it("fixes one navigation link while preserving footer, design, toggles and other links", () => {
    const t = target();
    const p = builderPlan(
      patch(t, {
        fields: [{ path: "header.links.0.href", value: "/collections/men" }],
      }),
      t,
      true,
      "pro",
    );
    expect(p.live).toBe(false);
    expect(p.changes).toEqual([
      {
        field: "header.links.0.href",
        before: '"/shop?category=mens-shoes"',
        after: '"/collections/men"',
      },
    ]);
    expect(p.next).toEqual({
      ...t.chrome,
      header: {
        ...t.chrome!.header,
        links: [
          { label: "MEN", href: "/collections/men" },
          t.chrome!.header.links[1],
        ],
      },
    });
  });
  it("refuses an outdated snapshot after another tab saves", () => {
    const t = target();
    const p = patch(t, { fields: [{ path: "header.sticky", value: false }] });
    expect(() => builderPlan(p, { ...t, version: "v2" }, true, "pro")).toThrow(
      "changed",
    );
  });
  it.each([
    "header.__proto__.polluted",
    "header.constructor",
    "header.links.99.href",
    "design.palette.ink",
    "header.notASetting",
  ])("rejects unsupported field path %s", (path) => {
    expect(() => patchChrome(chrome(), [{ path, value: true }])).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("rejects invalid appearance values instead of silently resetting to the theme", () => {
    expect(() =>
      patchChrome(chrome(), [
        { path: "appearance.cart", value: "custom-checkout" },
      ]),
    ).toThrow("Invalid chrome");
  });
  it("can configure card/cart behavior through supported Builder choices", () => {
    const t = target();
    const p = builderPlan(
      patch(t, {
        fields: [
          { path: "appearance.card", value: "quick_add" },
          { path: "appearance.cart", value: "compact" },
          { path: "header.showSearch", value: false },
        ],
      }),
      t,
      true,
      "pro",
    );
    expect(p.changes.map((c) => c.field)).toEqual(
      expect.arrayContaining([
        "appearance.card",
        "appearance.cart",
        "header.showSearch",
      ]),
    );
  });
  it.each([
    "javascript:alert(1)",
    "//evil.test",
    "/\\evil.test",
    "data:text/html,attack",
  ])("rejects unsafe navigation %s", (href) => {
    expect(() =>
      assertSafeBuilderLinks({ links: [{ label: "Men", href }] }),
    ).toThrow("safe store path");
  });
  it("creates a private page and rejects reserved routes", () => {
    const t: BuilderTarget = {
      operation: "page_create",
      pageSlug: "size-guide",
      exists: false,
      page: null,
    };
    expect(
      builderPlan(patch(t, { title: "Size guide" }), t, true, "pro"),
    ).toMatchObject({
      live: false,
      next: { slug: "size-guide", title: "Size guide", sections: [] },
    });
    expect(() =>
      builderPlan(
        patch(t, { title: "Checkout", slug: "cart" }),
        t,
        true,
        "pro",
      ),
    ).toThrow("reserved route");
  });
  it("marks published page metadata as live and keeps its sections", () => {
    const t = pageTarget("page_update");
    const p = builderPlan(
      patch(t, { seoTitle: "About our store" }),
      t,
      true,
      "pro",
    );
    expect(p.live).toBe(true);
    expect(p.next).toMatchObject({ seoTitle: "About our store", sections: [] });
  });
  it.each(["page_delete", "page_unpublish"] as const)(
    "protects the homepage from %s",
    (op) => {
      const t = pageTarget(op);
      t.pageSlug = "home";
      t.page!.slug = "";
      expect(() => builderPlan(patch(t), t, true, "pro")).toThrow("homepage");
    },
  );
  it("requires an existing draft before header/footer publication", () => {
    const t = target("chrome_publish");
    t.exists = false;
    expect(() => builderPlan(patch(t), t, true, "pro")).toThrow(
      "before publishing",
    );
  });
  it("enforces the normal plan restriction and rejects non-Builder settings", () => {
    const t: BuilderTarget = {
      operation: "settings_update",
      pageSlug: "home",
      exists: true,
      customCode: false,
    };
    expect(() =>
      builderPlan(patch(t, { "pages.customCode": true }), t, false, "free"),
    ).toThrow("Basic or Pro");
    expect(() =>
      builderPlan(
        patch(t, { "orders.allowCustomerCancellation": false }),
        t,
        false,
        "pro",
      ),
    ).toThrow("unsupported");
  });
  it("rejects unknown operations and unsupported patch keys", () => {
    expect(() =>
      readBuilderPatch({ ...patch(target()), operation: "run_shell" }),
    ).toThrow("Unknown Builder operation");
    expect(() =>
      readBuilderPatch({ ...patch(target()), storeId: "other-store" }),
    ).toThrow("unsupported");
  });
  it("requires sandbox-safe newly authored custom code", () => {
    const t = pageTarget("page_update");
    const section = {
      id: "new-code",
      type: "custom_code",
      enabled: true,
      config: {
        html: "<button>Open</button>",
        css: "",
        js: "fetch('/api/orders')",
        height_mode: "auto",
        fixed_height: 200,
      },
    };
    expect(() =>
      builderPlan(patch(t, { sections: [section] }), t, true, "pro"),
    ).toThrow("network");
    expect(() =>
      builderPlan(patch(t, { sections: [section] }), t, false, "free"),
    ).toThrow("disabled");
  });
  it("requires desktop/mobile checks when publishing changed custom code", () => {
    const t = pageTarget("page_publish");
    t.page!.sections = [
      {
        id: "new-code",
        type: "custom_code",
        enabled: true,
        config: {
          html: "<p>Welcome</p>",
          css: "",
          js: "",
          height_mode: "auto",
          fixed_height: 200,
        },
      },
    ];
    const p = builderPlan(patch(t), t, true, "pro");
    expect(p.live).toBe(true);
    expect(p.codeChecks.map((c) => c.id)).toEqual(["new-code"]);
  });
});

it("preserves an unchanged legacy link when correcting a different field", () => {
  const old = { href: "http://legacy.example/" };
  expect(() =>
    assertSafeBuilderLinks({ ...old, label: "Legacy" }, old),
  ).not.toThrow();
  expect(() =>
    assertSafeBuilderLinks({ href: "javascript:alert(1)" }, old),
  ).toThrow();
});
it("reports malformed collection paths without crashing diagnosis", () => {
  const c = chrome();
  c.header.links = [{ label: "Men", href: "/collections/%zz" }];
  expect(navigationIssues(c, [], [])[0].href).toBe("/collections/%zz");
});
it("rejects invalid page aliases before charging for a proposal", () => {
  expect(() =>
    readBuilderPatch({ ...patch(target()), pageSlug: "../../other" }),
  ).toThrow("pageSlug");
});

it("reviews live logo/accent changes and refuses store identity fields", () => {
  const t: BuilderTarget = {
    operation: "brand_update",
    pageSlug: "home",
    exists: true,
    brand: { primaryColor: "#17130f", logoUrl: null },
  };
  expect(
    builderPlan(patch(t, { primaryColor: "#3355AA" }), t, true, "pro"),
  ).toMatchObject({
    live: true,
    next: { primaryColor: "#3355AA", logoUrl: null },
  });
  expect(() =>
    builderPlan(patch(t, { name: "Change invoice name" }), t, true, "pro"),
  ).toThrow("unsupported");
  expect(() =>
    builderPlan(patch(t, { primaryColor: "url(unsafe)" }), t, true, "pro"),
  ).toThrow("six-digit");
});
