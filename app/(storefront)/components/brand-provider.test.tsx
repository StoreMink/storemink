// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import type { StoreBrand } from "@/lib/store/brand";

// The footer's words are under test, not its links or its sign-up form.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined }),
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
vi.mock("@/app/(storefront)/components/newsletter-form", () => ({
  NewsletterForm: () => null,
}));

import Footer from "./footer/Footer";
import {
  BrandProvider,
  MAX_PREVIEW_BLURB,
  MAX_PREVIEW_TAGLINE,
  previewBrandFrom,
  readPreviewBrand,
  useBrand,
} from "./brand-provider";
import { ChromeProvider } from "./chrome-provider";

const BRAND: StoreBrand = {
  name: "Amber and Wick",
  logoUrl: null,
  primaryColor: "#17130f",
  tagline: "Candles for every room",
  blurb: "Our old footer words.",
  legalName: null,
  creditLine: null,
  email: null,
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: "storemink.com",
};

/** What the shop hero reads: the tagline, and the store's name. */
function Probe() {
  const brand = useBrand();
  return (
    <>
      <p data-testid="tagline">{brand.tagline ?? "(no tagline)"}</p>
      <p data-testid="name">{brand.name}</p>
    </>
  );
}

/** The storefront layout's nesting: brand outside, chrome (the gate) inside. */
function Store({
  brand = BRAND,
  live = true,
}: {
  brand?: StoreBrand;
  live?: boolean;
}) {
  return (
    <BrandProvider brand={brand}>
      <ChromeProvider chrome={DEFAULT_CHROME} live={live}>
        <div className="storefront-root">
          <Probe />
          <Footer />
        </div>
      </ChromeProvider>
    </BrandProvider>
  );
}

function renderStore({ live = true }: { live?: boolean } = {}) {
  return render(<Store live={live} />);
}

/** A message event as the dialog that frames the preview would send it. */
function messageEvent(
  data: unknown,
  options: { origin?: string; source?: unknown } = {},
) {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "origin", {
    value: options.origin ?? window.location.origin,
  });
  Object.defineProperty(event, "source", {
    value: "source" in options ? options.source : window.parent,
  });
  return event;
}

function send(
  data: unknown,
  options: { origin?: string; source?: unknown } = {},
) {
  const event = messageEvent(data, options);
  act(() => {
    window.dispatchEvent(event);
  });
}

describe("readPreviewBrand", () => {
  it("takes the tagline and footer description as the storefront reads them, and nothing else", () => {
    // Trimmed, and an empty one is no line at all (lib/store/brand.ts).
    expect(
      readPreviewBrand({ tagline: "  Hand poured  ", blurb: "", name: "Evil" }),
    ).toEqual({ tagline: "Hand poured", blurb: null });
    // A field that is missing, null or not text means "leave it".
    expect(readPreviewBrand({ blurb: "Family run" })).toEqual({
      blurb: "Family run",
    });
    expect(readPreviewBrand({ tagline: null, blurb: 3 })).toBeNull();
    expect(
      readPreviewBrand({ primaryColor: "#aa3300", logoUrl: null }),
    ).toBeNull();
    expect(readPreviewBrand("Family run")).toBeNull();
    expect(readPreviewBrand([{ blurb: "Family run" }])).toBeNull();
    expect(readPreviewBrand(null)).toBeNull();
  });

  it("ignores a line longer than the bound whole, rather than cutting it", () => {
    const longest = "x".repeat(MAX_PREVIEW_BLURB);
    expect(readPreviewBrand({ blurb: longest })).toEqual({ blurb: longest });
    expect(
      readPreviewBrand({
        tagline: "y".repeat(MAX_PREVIEW_TAGLINE + 1),
        blurb: `${longest}x`,
      }),
    ).toBeNull();
    expect(
      readPreviewBrand({
        tagline: "y".repeat(MAX_PREVIEW_TAGLINE + 1),
        blurb: "Family run",
      }),
    ).toEqual({ blurb: "Family run" });
  });
});

describe("previewBrandFrom", () => {
  it("★★ takes words only from this host and only from the window that frames the page", () => {
    const words = { type: "sm-brand", brand: { blurb: "Family run" } };
    expect(previewBrandFrom(messageEvent(words))).toEqual({
      blurb: "Family run",
    });
    expect(
      previewBrandFrom(messageEvent(words, { origin: "https://evil.example" })),
    ).toBeNull();
    expect(previewBrandFrom(messageEvent(words, { source: null }))).toBeNull();
    const sibling = document.createElement("iframe");
    document.body.append(sibling);
    expect(
      previewBrandFrom(messageEvent(words, { source: sibling.contentWindow })),
    ).toBeNull();
    sibling.remove();
    // Another message type, or none, is not brand words.
    expect(
      previewBrandFrom(messageEvent({ ...words, type: "sm-chrome" })),
    ).toBeNull();
    expect(previewBrandFrom(messageEvent(null))).toBeNull();
  });
});

describe("the brand in the live preview", () => {
  it("★ lays the after frame's footer description and tagline over the store's, a half at a time", () => {
    renderStore();
    expect(screen.getByText("Our old footer words.")).toBeInTheDocument();

    send({ type: "sm-brand", brand: { blurb: "Family run since 1998." } });
    expect(screen.getByText("Family run since 1998.")).toBeInTheDocument();
    expect(screen.queryByText("Our old footer words.")).toBeNull();
    // A half the message leaves out is the store's own.
    expect(screen.getByTestId("tagline")).toHaveTextContent(
      "Candles for every room",
    );

    send({ type: "sm-brand", brand: { tagline: "Hand poured in Pune" } });
    expect(screen.getByTestId("tagline")).toHaveTextContent(
      "Hand poured in Pune",
    );
    // The earlier message's half stands.
    expect(screen.getByText("Family run since 1998.")).toBeInTheDocument();
    expect(screen.getByTestId("name")).toHaveTextContent("Amber and Wick");
  });

  it("keeps the words when the server's brand arrives again (a refresh on focus)", () => {
    // StorefrontRefresh refreshes the frame whenever it takes focus, which
    // hands the layout a fresh brand object. The dialog does not send the
    // words again, so they must survive it.
    const { rerender } = render(<Store />);
    send({ type: "sm-brand", brand: { blurb: "Family run since 1998." } });
    rerender(<Store brand={{ ...BRAND, name: "Amber and Wick Co" }} />);
    expect(screen.getByText("Family run since 1998.")).toBeInTheDocument();
    expect(screen.getByTestId("name")).toHaveTextContent("Amber and Wick Co");
  });

  it("★★ a message from another origin or another window changes nothing", () => {
    renderStore();
    send(
      { type: "sm-brand", brand: { blurb: "From elsewhere" } },
      { origin: "https://evil.example" },
    );
    send(
      { type: "sm-brand", brand: { blurb: "From no window" } },
      { source: null },
    );
    // Same origin, but not the window that frames this page: a sibling
    // frame, a pop-up, or a frame this page embeds.
    const sibling = document.createElement("iframe");
    document.body.append(sibling);
    send(
      { type: "sm-brand", brand: { blurb: "From a sibling frame" } },
      { source: sibling.contentWindow },
    );
    sibling.remove();
    expect(screen.getByText("Our old footer words.")).toBeInTheDocument();
    expect(screen.getByTestId("tagline")).toHaveTextContent(
      "Candles for every room",
    );
    expect(
      screen.queryByText(/From elsewhere|From no window|From a sibling frame/),
    ).toBeNull();
  });

  it("★★ is never active outside the preview", () => {
    renderStore({ live: false });
    send({
      type: "sm-brand",
      brand: { tagline: "Not a preview", blurb: "Not a preview either" },
    });
    expect(screen.getByText("Our old footer words.")).toBeInTheDocument();
    expect(screen.getByTestId("tagline")).toHaveTextContent(
      "Candles for every room",
    );
  });

  it("takes only bounded text, and never the store's name or anything else", () => {
    renderStore();
    send({
      type: "sm-brand",
      brand: {
        name: "Someone else",
        tagline: 7,
        blurb: "x".repeat(MAX_PREVIEW_BLURB + 1),
      },
    });
    expect(screen.getByTestId("name")).toHaveTextContent("Amber and Wick");
    expect(screen.getByTestId("tagline")).toHaveTextContent(
      "Candles for every room",
    );
    expect(screen.getByText("Our old footer words.")).toBeInTheDocument();
  });

  it("the Builder's colour message still repaints the brand colour, and leaves the words", () => {
    const { container } = renderStore();
    send({
      type: "sm-brand",
      brand: { name: "Amber and Wick", primaryColor: "#aa3300", logoUrl: null },
    });
    const root = container.querySelector<HTMLElement>(".storefront-root");
    expect(root?.style.getPropertyValue("--brand-primary")).toBe("#aa3300");
    expect(screen.getByText("Our old footer words.")).toBeInTheDocument();
    expect(screen.getByTestId("tagline")).toHaveTextContent(
      "Candles for every room",
    );
  });
});
