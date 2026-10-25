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
  theme: null as any,
  preview: false,
  chromeProps: null as any,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(
    async () => new Headers(H.preview ? { "x-sm-preview": "1" } : {}),
  ),
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
  resolveInstalledThemeDefinition: vi.fn(async () => H.theme),
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
  ChromeProvider: ({ children, ...props }: any) => {
    H.chromeProps = props;
    return children;
  },
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
import { studio } from "@/lib/themes/definitions/studio";
import { themeChromeDefaults } from "@/lib/themes/footer";
import { DEFAULT_CHROME } from "@/lib/chrome/types";

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
  H.theme = null;
  H.preview = false;
  H.chromeProps = null;
});

// P-1: a preview frame that is sent chrome must lay the theme's bar and
// newsletter words over it exactly as the layout lays them over the page's
// own chrome, so the layout hands ChromeProvider the same defaults it used.
describe("StorefrontLayout theme chrome", () => {
  function themed() {
    const theme = structuredClone(studio);
    theme.preset.announcement = { text: "Free delivery across Kochi" };
    return theme;
  }

  it("★★ lays the theme's bar over the page's chrome and hands a preview frame the same defaults", async () => {
    H.store = store({ theme: { presetId: "studio" } });
    H.theme = themed();
    H.preview = true;
    const html = await render();
    // The page's own chrome: the theme's bar on an enabled, empty bar.
    expect(H.chromeProps.chrome.header.announcement).toEqual({
      enabled: true,
      text: "Free delivery across Kochi",
      href: "",
    });
    expect(html).toContain("sm-announce");
    // ★ The defaults a frame lays over chrome it is sent, read once.
    const defaults = themeChromeDefaults(H.theme);
    expect(H.chromeProps.themeChrome).toEqual(defaults);
    expect(defaults.announcement?.text).toBe("Free delivery across Kochi");
    expect(defaults.newsletter?.heading).toBeTruthy();
    expect(H.chromeProps.chrome.footer.newsletter.heading).toBe(
      defaults.newsletter?.heading,
    );
    expect(H.chromeProps.chrome.footer.newsletter.heading).not.toBe(
      DEFAULT_CHROME.footer.newsletter.heading,
    );
  });

  it("a shopper's page is never sent chrome, so it carries no defaults to lay over it", async () => {
    H.store = store({ theme: { presetId: "studio" } });
    H.theme = themed();
    await render();
    expect(H.chromeProps.themeChrome).toBeUndefined();
    expect(H.chromeProps.chrome.header.announcement.text).toBe(
      "Free delivery across Kochi",
    );
  });
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
