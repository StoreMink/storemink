// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHROME, type StoreChrome } from "@/lib/chrome/types";
import type { StoreBrand } from "@/lib/store/brand";
import { activeAnnouncement } from "@/lib/themes/announcement";
import {
  withThemeChromeDefaults,
  type ThemeChromeDefaults,
} from "@/lib/themes/footer";

// The frame's own router: StorefrontRefresh and PreviewBridge call refresh(),
// which the harness below answers the way the server does.
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/",
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The footer's columns are under test, not its sign-up form.
vi.mock("@/app/(storefront)/components/newsletter-form", () => ({
  NewsletterForm: () => null,
}));

import Footer from "./footer/Footer";
import { BrandProvider } from "./brand-provider";
import { ChromeProvider, useChrome } from "./chrome-provider";
import { StorefrontRefresh } from "./storefront-refresh";
import { PreviewBridge } from "./sections/preview-bridge";

const BRAND: StoreBrand = {
  name: "Amber and Wick",
  logoUrl: null,
  primaryColor: "#17130f",
  tagline: "Candles for every room",
  blurb: null,
  legalName: null,
  creditLine: null,
  email: null,
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: "storemink.com",
};

/** A chrome whose footer has one named column and whose header one line. */
function chromeWith(
  column: string,
  announcement: string,
  patch: Partial<StoreChrome> = {},
): StoreChrome {
  return {
    ...DEFAULT_CHROME,
    ...patch,
    header: {
      ...DEFAULT_CHROME.header,
      announcement: { enabled: true, text: announcement, href: "" },
    },
    footer: {
      ...DEFAULT_CHROME.footer,
      groups: [
        { title: column, links: [{ label: `${column} link`, href: "/shop" }] },
      ],
    },
  };
}

/** The saved Builder draft: what the server renders the frame with. */
const SAVED = chromeWith("Old column", "Our old line");
/** A newer saved draft (a save landed between two server renders). */
const NEWER = chromeWith("Newer column", "Our newer line");
/** What the redesign dialog hands its after frame. It is saved nowhere. */
const PROPOSED = chromeWith("Our candles", "Free delivery on every order", {
  appearance: { ...DEFAULT_CHROME.appearance, header: "centered" },
  design: { ...DEFAULT_CHROME.design, palette: { cream: "#fef6e4" } },
});

/** The pinned theme's bar and newsletter words, as the layout reads them. */
const THEME_CHROME: ThemeChromeDefaults = {
  announcement: { text: "Free delivery across Kochi", href: "/shop" },
  newsletter: {
    heading: "Notes from the workshop",
    subheading: "New candles first.",
    buttonLabel: "Join",
    consentText: "I agree to hear from Amber and Wick.",
  },
};

/**
 * One server render of the storefront layout as the client receives it:
 * FRESH objects every time (the RSC payload is parsed again on a refresh),
 * so the same saved draft arrives as a new chrome object. Like the layout,
 * it lays the theme's defaults over the saved chrome and hands them on.
 */
function serverRender(saved: StoreChrome, themeChrome?: ThemeChromeDefaults) {
  const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    chrome: fresh(withThemeChromeDefaults(saved, themeChrome)),
    themeChrome: themeChrome ? fresh(themeChrome) : undefined,
    themeVars: { "--brand-primary": BRAND.primaryColor, "--sm-cream": "#fff" },
    themeLayout: { header: "classic" as const },
  };
}

/** The chrome the page's components were last given. */
let seen: StoreChrome | null = null;

/** What the header draws from the chrome: its announcement line. */
function HeaderProbe() {
  const chrome = useChrome();
  // Recorded after the render commits (act flushes it before any assertion).
  useEffect(() => {
    seen = chrome;
  });
  return (
    <>
      <p data-testid="announcement">{chrome.header.announcement.text}</p>
      {/* The bar the header shows (AnnouncementBar's own rule). */}
      <p data-testid="bar">{activeAnnouncement(chrome)?.text ?? ""}</p>
      <p data-testid="newsletter">{chrome.footer.newsletter.heading}</p>
    </>
  );
}

/**
 * A storefront page in a preview frame, nested as the layout nests it, with
 * the frame's own refresh triggers mounted. `saved` is the draft the server
 * reads on the next refresh.
 */
function Frame({
  saved = SAVED,
  live = true,
  bridge = false,
  themeChrome,
}: {
  saved?: StoreChrome;
  live?: boolean;
  bridge?: boolean;
  themeChrome?: ThemeChromeDefaults;
}) {
  const [server, setServer] = useState(() => serverRender(saved, themeChrome));
  useEffect(() => {
    // router.refresh() re-runs the server components for this address.
    router.refresh.mockImplementation(() =>
      setServer(serverRender(saved, themeChrome)),
    );
  }, [saved, themeChrome]);
  return (
    <BrandProvider brand={BRAND}>
      <ChromeProvider
        chrome={server.chrome}
        themeChrome={server.themeChrome}
        themeLayout={server.themeLayout}
        themeVars={server.themeVars}
        live={live}
      >
        <div className="storefront-root">
          <HeaderProbe />
          <StorefrontRefresh />
          <main>{bridge ? <PreviewBridge /> : null}</main>
          <Footer />
        </div>
      </ChromeProvider>
    </BrandProvider>
  );
}

/** A message from the window that frames this page (the dialog or Builder). */
function send(data: unknown, source: unknown = window.parent) {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "origin", { value: window.location.origin });
  Object.defineProperty(event, "source", { value: source });
  act(() => {
    window.dispatchEvent(event);
  });
}

/** A window of this host that is not the one framing the page. */
function anotherWindow(): Window {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  if (!frame.contentWindow) throw new Error("no frame window");
  return frame.contentWindow;
}

/** One click inside the frame: its window takes focus. */
function clickInsideFrame() {
  fireEvent.focus(window);
}

function root(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(".storefront-root");
  if (!element) throw new Error("no storefront root");
  return element;
}

function footerColumn(name: string) {
  return screen.queryByRole("heading", { name });
}

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

describe("ChromeProvider in a preview frame", () => {
  it("★★ keeps the header and footer the frame was handed when a click refreshes the frame", () => {
    const { container } = render(<Frame />);
    expect(footerColumn("Old column")).toBeInTheDocument();

    send({ type: "sm-chrome", chrome: PROPOSED });
    expect(footerColumn("Our candles")).toBeInTheDocument();
    expect(screen.getByTestId("announcement")).toHaveTextContent(
      "Free delivery on every order",
    );
    expect(root(container)).toHaveClass("sm-header-centered");
    expect(root(container).style.getPropertyValue("--sm-cream")).toBe(
      "#fef6e4",
    );

    // The redesign's after frame: one click inside it, and StorefrontRefresh
    // asks the server again, which answers with the saved draft.
    clickInsideFrame();
    expect(router.refresh).toHaveBeenCalledTimes(1);

    // ★ The proposal is saved nowhere, so nothing would ever send it back:
    //   the header, footer, layout and colours the frame was handed stay.
    expect(footerColumn("Our candles")).toBeInTheDocument();
    expect(footerColumn("Old column")).toBeNull();
    expect(screen.getByTestId("announcement")).toHaveTextContent(
      "Free delivery on every order",
    );
    expect(root(container)).toHaveClass("sm-header-centered");
    expect(root(container)).not.toHaveClass("sm-header-classic");
    expect(root(container).style.getPropertyValue("--sm-cream")).toBe(
      "#fef6e4",
    );
  });

  it("★ a later message replaces the one before it, and that one survives a refresh too", () => {
    render(<Frame />);
    send({ type: "sm-chrome", chrome: PROPOSED });
    // The Website Builder pushes on every header or footer edit.
    send({ type: "sm-chrome", chrome: chromeWith("Gifts", "New season") });
    expect(footerColumn("Gifts")).toBeInTheDocument();
    expect(footerColumn("Our candles")).toBeNull();

    clickInsideFrame();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(footerColumn("Gifts")).toBeInTheDocument();
    expect(screen.getByTestId("announcement")).toHaveTextContent("New season");
  });

  it("a frame handed nothing takes the server's newer chrome on a refresh (the before frame, the draft after Apply)", () => {
    const { rerender } = render(<Frame />);
    expect(footerColumn("Old column")).toBeInTheDocument();
    // A save lands; the next server render reads the newer draft.
    rerender(<Frame saved={NEWER} />);
    clickInsideFrame();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(footerColumn("Newer column")).toBeInTheDocument();
    expect(footerColumn("Old column")).toBeNull();
    expect(screen.getByTestId("announcement")).toHaveTextContent(
      "Our newer line",
    );
  });

  it("★★ outside a preview the storefront takes only the server's chrome", () => {
    const { rerender } = render(<Frame live={false} />);
    send({ type: "sm-chrome", chrome: PROPOSED });
    expect(footerColumn("Our candles")).toBeNull();
    expect(footerColumn("Old column")).toBeInTheDocument();

    // A shopper returning to the tab after the merchant published.
    rerender(<Frame live={false} saved={NEWER} />);
    clickInsideFrame();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(footerColumn("Newer column")).toBeInTheDocument();
  });

  it("★ a frame that stops being a preview drops what it was handed", () => {
    // A link clicked inside the frame leaves `?preview=1`; the next refresh
    // renders that page as the store, where nothing handed in applies.
    const { rerender } = render(<Frame />);
    send({ type: "sm-chrome", chrome: PROPOSED });
    expect(footerColumn("Our candles")).toBeInTheDocument();
    rerender(<Frame live={false} />);
    expect(footerColumn("Old column")).toBeInTheDocument();
    expect(footerColumn("Our candles")).toBeNull();
  });

  it("★★ a sent chrome with the defaults shows the theme's bar and newsletter words, as the live layout does", () => {
    // P-1: a bar left on with no text and the platform's newsletter copy
    // (every chrome saved before either was edited) read as the theme's
    // on the live store, and as nothing in a frame once chrome was sent.
    const sent: StoreChrome = {
      ...chromeWith("Our candles", ""),
      footer: {
        ...chromeWith("Our candles", "").footer,
        newsletter: { ...DEFAULT_CHROME.footer.newsletter },
      },
    };
    const live = withThemeChromeDefaults(sent, THEME_CHROME);
    expect(live.header.announcement.text).toBe("Free delivery across Kochi");

    render(<Frame themeChrome={THEME_CHROME} />);
    send({ type: "sm-chrome", chrome: sent });
    expect(footerColumn("Our candles")).toBeInTheDocument();
    expect(screen.getByTestId("bar")).toHaveTextContent(
      "Free delivery across Kochi",
    );
    expect(screen.getByTestId("announcement")).toHaveTextContent(
      live.header.announcement.text,
    );
    expect(screen.getByTestId("newsletter")).toHaveTextContent(
      "Notes from the workshop",
    );
    // ★ Exactly what the live store renders from that chrome, field for field.
    expect(seen).toEqual(live);

    // And it holds across the refresh a click inside the frame makes.
    clickInsideFrame();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("bar")).toHaveTextContent(
      "Free delivery across Kochi",
    );
    expect(screen.getByTestId("newsletter")).toHaveTextContent(
      "Notes from the workshop",
    );
  });

  it("a sent bar with words of its own, or switched off, is shown as sent", () => {
    render(<Frame themeChrome={THEME_CHROME} />);
    send({ type: "sm-chrome", chrome: chromeWith("Gifts", "Our own line") });
    expect(screen.getByTestId("bar")).toHaveTextContent("Our own line");

    const off = chromeWith("Gifts", "");
    off.header.announcement.enabled = false;
    send({ type: "sm-chrome", chrome: off });
    expect(screen.getByTestId("bar")).toHaveTextContent(/^$/);

    // Merchant newsletter words win over the theme's too.
    const own = chromeWith("Gifts", "Our own line");
    own.footer.newsletter = {
      ...own.footer.newsletter,
      heading: "Our subscriber club",
    };
    send({ type: "sm-chrome", chrome: own });
    expect(screen.getByTestId("newsletter")).toHaveTextContent(
      "Our subscriber club",
    );
  });

  it("★ chrome from a window that does not frame this page is ignored (P-2)", () => {
    const { container } = render(<Frame />);
    const other = anotherWindow();
    send({ type: "sm-chrome", chrome: PROPOSED }, other);
    expect(footerColumn("Old column")).toBeInTheDocument();
    expect(footerColumn("Our candles")).toBeNull();
    expect(root(container)).not.toHaveClass("sm-header-centered");
    // Nor does it repaint the brand colour.
    send({ type: "sm-brand", brand: { primaryColor: "#ff0000" } }, other);
    expect(root(container).style.getPropertyValue("--brand-primary")).not.toBe(
      "#ff0000",
    );
    // The window that frames the page is still heard.
    send({ type: "sm-chrome", chrome: PROPOSED });
    expect(footerColumn("Our candles")).toBeInTheDocument();
  });

  it("the Builder's refresh after Publish still runs, and its header and footer stay as it sent them", () => {
    // After Publish the Builder flushes its chrome, publishes, and pings the
    // frame (sm-preview-refresh); the saved draft then equals what it sent.
    const builderChrome = chromeWith("Collections", "Open on Sundays");
    render(<Frame bridge saved={builderChrome} />);
    send({ type: "sm-chrome", chrome: builderChrome });
    send({ type: "sm-preview-refresh" });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(footerColumn("Collections")).toBeInTheDocument();
    expect(screen.getByTestId("announcement")).toHaveTextContent(
      "Open on Sundays",
    );
  });
});
