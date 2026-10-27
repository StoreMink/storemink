// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RevampReview } from "@/lib/mink/revamp/contract";
import { readPreviewBrand } from "@/app/(storefront)/components/brand-provider";
import {
  MinkRevampPreview,
  afterPath,
  livePath,
  previewPath,
  revampPreviewDatasets,
} from "./mink-revamp-preview";

const CHROME = { header: { announcement: null }, footer: {} } as never;

const review = {
  summary: "A warm look.",
  pages: [
    {
      slug: "about",
      title: "About",
      create: false,
      sections: [
        {
          id: "story",
          type: "rich_text",
          enabled: true,
          config: { html: "<p>Our story</p>" },
        },
      ],
      changes: { added: 1, removed: 0, kept: 0, photos: 0 },
    },
    {
      slug: "our-candles",
      title: "Our candles",
      create: true,
      sections: [],
      changes: { added: 2, removed: 0, kept: 0, photos: 1 },
    },
  ],
  chrome: CHROME,
  photos: [],
  products: [
    {
      key: "Amber Pillar",
      name: "Amber pillar candle",
      imageUrl: "https://storage.googleapis.com/media/stores/x/amber.webp",
      price: 499,
      mrp: 599,
      categorySlug: "pillar",
      sizes: ["Small"],
    },
    {
      key: "",
      name: "Tea lights",
      imageUrl: null,
      price: 199,
      mrp: null,
      categorySlug: null,
      sizes: [],
    },
  ],
  categories: [],
  hiddenSampleProducts: 0,
  liveChanges: [],
  checks: [],
  skipped: [],
  notes: [],
} as unknown as RevampReview;

/** A message as a frame on this host would send it. */
function message(data: unknown, source: Window | null) {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "origin", { value: window.location.origin });
  Object.defineProperty(event, "source", { value: source });
  act(() => {
    window.dispatchEvent(event);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the revamp preview", () => {
  it("★ loads each page's preview without the Builder's edit layer, and a new page borrows the homepage canvas", () => {
    // `review=1` keeps the draft canvas and its handshake but tells the page
    // to leave out the Builder's overlay and badge.
    expect(previewPath("")).toBe("/?preview=1&review=1");
    expect(previewPath("about")).toBe("/about?preview=1&review=1");
    expect(afterPath({ slug: "about", create: false })).toBe(
      "/about?preview=1&review=1",
    );
    expect(afterPath({ slug: "our-candles", create: true })).toBe(
      "/?preview=1&review=1",
    );
    expect(livePath("about")).toBe("/about");
    expect(livePath("")).toBe("/");
  });

  it("hands the canvas the new products as featured cards at the merchant's prices", () => {
    expect(revampPreviewDatasets(review).products).toEqual([
      {
        id: "revamp-amber-pillar",
        name: "Amber pillar candle",
        slug: "amber-pillar",
        image_url: "https://storage.googleapis.com/media/stores/x/amber.webp",
        base_price: 599,
        selling_price: 499,
        featured: true,
        category: null,
        category_id: null,
        track_inventory: false,
        stock: 0,
        low_stock_threshold: null,
        allow_backorder: false,
      },
      expect.objectContaining({
        id: "revamp-product-2",
        base_price: 199,
        selling_price: 199,
      }),
    ]);
  });

  it("★★ also hands the canvas the categories as Apply leaves them and the samples Apply takes off", () => {
    const datasets = revampPreviewDatasets({
      ...review,
      canvas: {
        categories: [
          {
            id: "fruit-id",
            slug: "fruit",
            name: "Seeds",
            imageUrl:
              "https://storage.googleapis.com/media/stores/x/seeds.webp",
            description: "Every seed we press",
            hidden: false,
          },
          {
            id: "dairy-id",
            slug: "dairy",
            name: "Dairy",
            imageUrl: null,
            description: null,
            hidden: true,
          },
        ],
        hiddenProductIds: ["sample-1", "sample-2"],
      },
    });
    expect(datasets.categories).toEqual([
      {
        id: "fruit-id",
        name: "Seeds",
        slug: "fruit",
        image_url: "https://storage.googleapis.com/media/stores/x/seeds.webp",
        description: "Every seed we press",
      },
    ]);
    expect(datasets.hiddenCategoryIds).toEqual(["dairy-id"]);
    expect(datasets.hiddenProductIds).toEqual(["sample-1", "sample-2"]);
    // A review written before the canvas data existed still previews.
    expect(revampPreviewDatasets(review).hiddenProductIds).toEqual([]);
  });

  it("is a labelled dialog with before and after frames, and Escape closes it", () => {
    const onClose = vi.fn();
    render(<MinkRevampPreview review={review} onClose={onClose} />);
    expect(
      screen.getByRole("dialog", { name: "Preview your redesign" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close preview" })).toHaveFocus();
    expect(screen.getByTitle("About, before")).toHaveAttribute(
      "src",
      "/about?preview=1&review=1",
    );
    expect(screen.getByTitle("About, after")).toHaveAttribute(
      "src",
      "/about?preview=1&review=1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Phone" }));
    expect(screen.getByRole("button", { name: "Phone" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    expect(screen.getByRole("button", { name: "Before" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("★ sends the proposed sections, products and header only to the after frame, once it says it is ready", () => {
    render(<MinkRevampPreview review={review} onClose={() => undefined} />);
    const after = screen.getByTitle("About, after") as HTMLIFrameElement;
    const before = screen.getByTitle("About, before") as HTMLIFrameElement;
    const post = vi.spyOn(after.contentWindow!, "postMessage");

    message({ type: "sm-preview-ready" }, before.contentWindow);
    expect(post).not.toHaveBeenCalled();

    message({ type: "sm-preview-ready" }, after.contentWindow);
    expect(post).toHaveBeenCalledWith(
      {
        type: "sm-draft",
        sections: review.pages[0].sections,
        datasets: revampPreviewDatasets(review),
      },
      window.location.origin,
    );

    message({ type: "sm-chrome-ready" }, after.contentWindow);
    expect(post).toHaveBeenLastCalledWith(
      { type: "sm-chrome", chrome: CHROME },
      window.location.origin,
    );
  });

  it("★ tells the after frame the footer description Apply writes, and only the half it changes", () => {
    const withBrand = {
      ...review,
      canvas: {
        categories: [],
        hiddenProductIds: [],
        brand: { tagline: null, blurb: "Family run since 1998" },
      },
    } as RevampReview;
    const { unmount } = render(
      <MinkRevampPreview review={withBrand} onClose={() => undefined} />,
    );
    const after = screen.getByTitle("About, after") as HTMLIFrameElement;
    const before = screen.getByTitle("About, before") as HTMLIFrameElement;
    const toAfter = vi.spyOn(after.contentWindow!, "postMessage");
    const toBefore = vi.spyOn(before.contentWindow!, "postMessage");
    message({ type: "sm-chrome-ready" }, after.contentWindow);
    // A missing tagline means "leave it", never an empty one that clears it.
    expect(toAfter).toHaveBeenCalledWith(
      { type: "sm-brand", brand: { blurb: "Family run since 1998" } },
      window.location.origin,
    );
    // ★ And the frame's receiver takes exactly what the dialog sends, so the
    //   two halves of the channel cannot drift apart on a field name.
    const sent = toAfter.mock.calls
      .map(([data]) => data as { type?: string; brand?: unknown })
      .find((data) => data.type === "sm-brand");
    expect(readPreviewBrand(sent?.brand)).toEqual({
      blurb: "Family run since 1998",
    });
    expect(toBefore).not.toHaveBeenCalled();
    unmount();

    // After Apply the text is already live, so nothing is pushed at all.
    render(
      <MinkRevampPreview
        review={withBrand}
        applied
        onClose={() => undefined}
      />,
    );
    const draft = screen.getByTitle("About, your draft") as HTMLIFrameElement;
    const toDraft = vi.spyOn(draft.contentWindow!, "postMessage");
    message({ type: "sm-chrome-ready" }, draft.contentWindow);
    fireEvent.load(draft);
    expect(toDraft).not.toHaveBeenCalled();
  });

  it("★★ once applied, compares what is live with the draft, and sends the draft nothing", () => {
    render(
      <MinkRevampPreview review={review} applied onClose={() => undefined} />,
    );
    const live = screen.getByTitle("About, live now") as HTMLIFrameElement;
    const draft = screen.getByTitle("About, your draft") as HTMLIFrameElement;
    // What shoppers see now, never the draft Apply already rewrote.
    expect(live).toHaveAttribute("src", "/about");
    expect(draft.getAttribute("src")).toMatch(/^\/about\?preview=1/);
    expect(
      Array.from(document.querySelectorAll("figcaption"), (c) => c.textContent),
    ).toEqual(["Live now", "Your draft"]);
    expect(
      screen.getByRole("button", { name: "Live now" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Nothing on your store changes until you apply the redesign.",
      ),
    ).toBeNull();
    expect(screen.getByText(/Publish to put them live/)).toBeInTheDocument();

    // The draft frame shows the draft as it is, the merchant's later edits
    // included: nothing proposed is pushed over it.
    const post = vi.spyOn(draft.contentWindow!, "postMessage");
    message({ type: "sm-preview-ready" }, draft.contentWindow);
    message({ type: "sm-chrome-ready" }, draft.contentWindow);
    expect(post).not.toHaveBeenCalled();
  });

  it("★ a page Apply created is in the draft, not yet on the store, and has its own address", () => {
    render(
      <MinkRevampPreview review={review} applied onClose={() => undefined} />,
    );
    fireEvent.change(screen.getByLabelText("Page"), { target: { value: "1" } });
    expect(
      screen.queryByText("This page does not exist on your store yet."),
    ).toBeNull();
    expect(
      screen.getByText(/goes on your store when you publish/),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle("Our candles, your draft").getAttribute("src"),
    ).toMatch(/^\/our-candles\?preview=1/);
  });

  it("after Publish, says the redesign is live and shows the live pages", () => {
    render(
      <MinkRevampPreview
        review={review}
        applied
        published
        onClose={() => undefined}
      />,
    );
    expect(
      screen.getByText("Your redesign is live on your store."),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Page"), { target: { value: "1" } });
    expect(screen.getByTitle("Our candles, live now")).toHaveAttribute(
      "src",
      "/our-candles",
    );
  });

  it("shows a created page as new, with no before", () => {
    render(<MinkRevampPreview review={review} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Page"), { target: { value: "1" } });
    expect(screen.getByText("New page")).toBeInTheDocument();
    expect(screen.queryByTitle("Our candles, before")).toBeNull();
    expect(screen.getByTitle("Our candles, after")).toHaveAttribute(
      "src",
      "/?preview=1&review=1",
    );
  });
});

describe("keyboard focus in the revamp preview", () => {
  afterEach(() => {
    document
      .querySelectorAll("[data-test-outside]")
      .forEach((el) => el.remove());
  });

  function outside(): HTMLButtonElement {
    const button = document.createElement("button");
    button.textContent = "Dashboard sidebar";
    button.setAttribute("data-test-outside", "");
    document.body.appendChild(button);
    return button;
  }

  it("★★ makes the dashboard behind it inert while open, and gives it back before focus returns", () => {
    const sidebar = outside();
    const onClose = vi.fn(() => {
      // The card moves focus back to its Preview button in onClose: an inert
      // page cannot take it, so the page must be released first.
      expect(sidebar.hasAttribute("inert")).toBe(false);
    });
    const { unmount } = render(
      <MinkRevampPreview review={review} onClose={onClose} />,
    );
    expect(sidebar.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("dialog").closest("[inert]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(sidebar.hasAttribute("inert")).toBe(false);
  });

  it("★ leaves an element that was inert already as it was", () => {
    const sidebar = outside();
    sidebar.setAttribute("inert", "");
    const { unmount } = render(
      <MinkRevampPreview review={review} onClose={() => undefined} />,
    );
    unmount();
    expect(sidebar.hasAttribute("inert")).toBe(true);
  });

  it("★ wraps focus that tabs out past the last frame back to the start", () => {
    // jsdom lays nothing out; every element counts as rendered here.
    vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    render(<MinkRevampPreview review={review} onClose={() => undefined} />);
    const end = document.querySelector<HTMLElement>(
      '[data-focus-sentinel="end"]',
    );
    expect(end).not.toBeNull();
    act(() => end!.focus());
    expect(screen.getByRole("button", { name: "Close preview" })).toHaveFocus();
  });

  it("★★ closes on Escape pressed inside a preview frame, where the dialog never hears the key", () => {
    const onClose = vi.fn();
    render(<MinkRevampPreview review={review} onClose={onClose} />);
    const after = screen.getByTitle("About, after") as HTMLIFrameElement;
    fireEvent.load(after);
    const frame = after.contentWindow as Window & typeof globalThis;
    act(() => {
      frame.dispatchEvent(
        new frame.KeyboardEvent("keydown", { key: "Escape" }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
