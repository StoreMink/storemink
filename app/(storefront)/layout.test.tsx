/* eslint-disable @typescript-eslint/no-explicit-any */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The storefront layout's SHELL, rendered. A pending store's /in-progress
// page (and a locked visitor's /password) must sit in the minimal shell: no
// header, footer, cart or sign-in, whose menus and buttons would all lead
// straight back to the same page. The decision is storefrontShell()
// (lib/store/storefront-shell.test.ts); this pins that the layout actually
// obeys it, which a source regex cannot. The layout's data reads are stubbed;
// the theme and appearance resolvers run for real.

const H = vi.hoisted(() => ({
  store: null as any,
  access: "open" as "open" | "unlocked" | "locked",
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ has: () => false })),
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreOrNull: vi.fn(async () => H.store),
}));
// The predicates are pure; launch.ts itself only adds a database write.
vi.mock("@/lib/store/launch", async () =>
  vi.importActual("@/lib/store/launch-state"),
);
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
// ★ storefrontShell stays REAL: only the cookie/password lookup is stubbed.
vi.mock("@/lib/store/storefront-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store/storefront-access")>()),
  storefrontAccess: vi.fn(async () => H.access),
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: vi.fn(async () => ({
    name: "Acme Teas",
    logoUrl: null,
    primaryColor: "#123456",
    tagline: null,
  })),
}));
vi.mock("@/lib/chrome/queries", async () => {
  const { DEFAULT_CHROME } =
    await vi.importActual<typeof import("@/lib/chrome/types")>(
      "@/lib/chrome/types",
    );
  return {
    getStoreChrome: vi.fn(async () => DEFAULT_CHROME),
    getDraftChromeForPreview: vi.fn(async () => null),
  };
});
vi.mock("@/lib/site", () => ({
  getStoreUrl: vi.fn(async () => "https://acme.storemink.com"),
}));
vi.mock("@/lib/themes/runtime-registry", () => ({
  resolveInstalledThemeDefinition: vi.fn(async () => null),
}));
vi.mock("@/lib/analytics/platform-feature-store", () => ({
  getPlatformAnalyticsFeatures: vi.fn(async () => ({})),
}));
vi.mock("@/lib/seo/store-indexing", () => ({
  GOOGLE_VERIFICATION_TOKEN_KEY: "google_site_verification_token",
  normalizeGoogleVerificationToken: vi.fn(() => null),
}));

// The shop's chrome, as markers the assertions can look for.
vi.mock("@/app/(storefront)/components/header/Header", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("header", { "data-shell": "header" }) };
});
vi.mock("@/app/(storefront)/components/footer/Footer", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("footer", { "data-shell": "footer" }) };
});
vi.mock("@/app/(storefront)/components/cart/CartDrawer", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("aside", { "data-shell": "cart" }) };
});
vi.mock("@/app/(storefront)/components/auth/auth-modal-loader", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("div", { "data-shell": "sign-in" }) };
});
// Providers pass their children straight through.
vi.mock("@/app/(storefront)/components/auth/AuthProvider", () => ({
  default: ({ children }: any) => children,
}));
vi.mock("@/app/(storefront)/components/cart/CartProvider", () => ({
  default: ({ children }: any) => children,
}));
vi.mock(
  "@/app/(storefront)/components/delivery/delivery-location-provider",
  () => ({ DeliveryLocationProvider: ({ children }: any) => children }),
);
vi.mock("@/app/(storefront)/components/brand-provider", () => ({
  BrandProvider: ({ children }: any) => children,
}));
vi.mock("@/app/(storefront)/components/chrome-provider", () => ({
  ChromeProvider: ({ children }: any) => children,
}));
vi.mock("@/app/(storefront)/components/merchant-tracking", () => ({
  MerchantTracking: ({ children }: any) => children,
}));
vi.mock("@/app/(storefront)/components/studio-acceptance-probe", () => ({
  StudioAcceptanceProbe: () => null,
}));
vi.mock("@/app/(storefront)/components/scroll-reveal", () => ({
  ScrollReveal: () => null,
}));
vi.mock("./components/storefront-refresh", () => ({
  StorefrontRefresh: () => null,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));

import StorefrontLayout from "./layout";

function store(settings: Record<string, unknown>) {
  return {
    id: "s1",
    slug: "acme",
    name: "Acme",
    status: "active",
    plan: "free",
    plan_expires_at: null,
    comp_plan: null,
    comp_expires_at: null,
    custom_domain: null,
    settings,
  };
}

async function render(): Promise<string> {
  const tree = await StorefrontLayout({
    children: <main data-page="child">Store in progress</main>,
  });
  return renderToStaticMarkup(tree);
}

const CHROME = ["header", "footer", "cart", "sign-in"];

function chromeIn(html: string): string[] {
  return CHROME.filter((part) => html.includes(`data-shell="${part}"`));
}

beforeEach(() => {
  H.store = null;
  H.access = "open";
});

describe("StorefrontLayout shell", () => {
  it("renders a store with no theme past the password in the bare shell", async () => {
    H.store = store({ launched: false, themePending: true });
    H.access = "unlocked";
    const html = await render();
    expect(html).toContain('data-page="child"');
    // Still the store's own colours and type, just nothing to click away to.
    expect(html).toContain('class="storefront-root');
    expect(chromeIn(html)).toEqual([]);
  });

  it("renders a locked visitor in the bare shell", async () => {
    H.store = store({ launched: false, theme: { presetId: "basket" } });
    H.access = "locked";
    const html = await render();
    expect(html).toContain('data-page="child"');
    expect(chromeIn(html)).toEqual([]);
  });

  it("renders a themed store past the password with the whole shop", async () => {
    H.store = store({ launched: false, theme: { presetId: "basket" } });
    H.access = "unlocked";
    expect(chromeIn(await render())).toEqual(CHROME);
  });

  it("renders a legacy store with no themePending key with the whole shop", async () => {
    H.store = store({ template: "basket" });
    H.access = "open";
    expect(chromeIn(await render())).toEqual(CHROME);
  });

  it("404s an unknown host before choosing a shell", async () => {
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
