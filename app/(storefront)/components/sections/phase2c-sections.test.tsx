// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CONFIG } from "@/lib/homepage/section-types";
import { MulticolumnSection } from "./multicolumn-section";
import { ImageMarqueeSection } from "./image-marquee-section";
import { ImageHotspotsSection } from "./image-hotspots-section";
import { BeforeAfterSection } from "./before-after-section";
import { ProductSpotlightSection } from "./product-spotlight-section";
import { LogoStripSection } from "./logo-strip-section";
import { CountdownSection, splitRemaining } from "./countdown-section";

// Plan Phase 2c, first slice. jsdom renders no layout, so these pin the
// structure a shopper and a screen reader get: what renders, what is
// announced, what a click or a key changes.

const IMG = "/themes/vitrine/hero.webp";

describe("multicolumn", () => {
  it("renders one column per item with an icon or a picture, and nothing when empty", () => {
    const { container } = render(
      <MulticolumnSection
        sectionId="m"
        config={{
          ...EMPTY_CONFIG.multicolumn,
          heading: "Why us",
          items: [
            {
              icon: "leaf",
              image_url: "",
              image_alt: "",
              heading: "Made to last",
              body: "Years, not seasons.",
              cta_label: "More",
              cta_href: "/about",
            },
            {
              icon: "",
              image_url: IMG,
              image_alt: "The workshop",
              heading: "By hand",
              body: "",
              cta_label: "",
              cta_href: "",
            },
          ],
        }}
      />,
    );
    expect(container.querySelectorAll(".home-multicolumn-item")).toHaveLength(
      2,
    );
    expect(container.querySelector(".home-multicolumn-icon")).toBeTruthy();
    expect(screen.getByAltText("The workshop")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "More" }).getAttribute("href"),
    ).toBe("/about");
    expect(
      render(
        <MulticolumnSection
          sectionId="e"
          config={{ ...EMPTY_CONFIG.multicolumn, items: [] }}
        />,
      ).container.firstChild,
    ).toBeNull();
  });
});

describe("image marquee", () => {
  it("repeats the pictures across two sequences and hides the second from readers", () => {
    const { container } = render(
      <ImageMarqueeSection
        sectionId="q"
        config={{
          ...EMPTY_CONFIG.image_marquee,
          items: [
            { image_url: IMG, image_alt: "One", href: "/shop" },
            { image_url: IMG, image_alt: "Two", href: "" },
            { image_url: "", image_alt: "Dropped", href: "" },
          ],
        }}
      />,
    );
    const seqs = container.querySelectorAll(".home-marquee-seq");
    expect(seqs).toHaveLength(2);
    expect(seqs[1].getAttribute("aria-hidden")).toBe("true");
    // Five repeats of two pictures fill the loop; the imageless one is gone.
    expect(seqs[0].querySelectorAll(".home-marquee-item")).toHaveLength(10);
    expect(
      seqs[0].querySelector("a.home-marquee-item")?.getAttribute("href"),
    ).toBe("/shop");
  });

  // 23 Nov 2026: with motion off the band stands still and wraps, and it used
  // to show all ten. The stylesheet drops `.is-repeat` then (pinned below).
  it("★★ marks every copy that only fills the loop, so each picture is shown, read and tabbed ONCE", () => {
    const { container } = render(
      <ImageMarqueeSection
        sectionId="q"
        config={{
          ...EMPTY_CONFIG.image_marquee,
          items: [
            { image_url: IMG, image_alt: "One", href: "/shop" },
            { image_url: IMG, image_alt: "Two", href: "" },
          ],
        }}
      />,
    );
    const first = container.querySelectorAll(".home-marquee-seq")[0];
    const originals = first.querySelectorAll(
      ".home-marquee-item:not(.is-repeat)",
    );
    expect(originals).toHaveLength(2);
    expect(first.querySelectorAll(".home-marquee-item.is-repeat")).toHaveLength(
      8,
    );
    // The two originals lead the sequence, are named, and one can be tabbed to.
    expect(first.children[0]).toBe(originals[0]);
    expect(first.children[1]).toBe(originals[1]);
    expect(screen.getAllByAltText("One")).toHaveLength(1);
    expect(screen.getAllByAltText("Two")).toHaveLength(1);
    expect(originals[0].getAttribute("tabindex")).toBeNull();
    expect(originals[0].getAttribute("aria-hidden")).toBeNull();
    // Every copy is silent and out of the tab order.
    for (const copy of first.querySelectorAll(".is-repeat")) {
      expect(copy.getAttribute("aria-hidden")).toBe("true");
      if (copy.tagName === "A")
        expect(copy.getAttribute("tabindex")).toBe("-1");
    }
  });
});

describe("image hotspots", () => {
  it("opens one card at a time from its dot and closes on Escape", () => {
    const { container } = render(
      <ImageHotspotsSection
        sectionId="h"
        config={{
          ...EMPTY_CONFIG.image_hotspots,
          image_url: IMG,
          image_alt: "A set table",
          hotspots: [
            {
              x: 20,
              y: 30,
              title: "Jug",
              body: "Stoneware.",
              href: "/shop/jug",
              cta_label: "",
            },
            { x: 80, y: 70, title: "Bowl", body: "", href: "", cta_label: "" },
          ],
        }}
      />,
    );
    const dots = screen.getAllByRole("button");
    expect(dots).toHaveLength(2);
    expect(dots[0].getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(dots[0]);
    expect(dots[0].getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Stoneware.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Shop" }).getAttribute("href"),
    ).toBe("/shop/jug");
    // The second dot sits past the right and bottom thirds: its card opens inwards.
    expect(container.querySelectorAll(".home-hotspot")[1].className).toContain(
      "from-right",
    );
    fireEvent.click(dots[1]);
    expect(dots[0].getAttribute("aria-expanded")).toBe("false");
    expect(dots[1].getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dots[1].getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".home-hotspot-card")).toBeNull();
  });
});

describe("before / after", () => {
  it("is a slider: the range moves the clip, both pictures carry their alt", () => {
    const { container } = render(
      <BeforeAfterSection
        sectionId="b"
        config={{
          ...EMPTY_CONFIG.before_after,
          before: { image_url: IMG, image_alt: "Unglazed", label: "Before" },
          after: { image_url: IMG, image_alt: "Glazed", label: "After" },
          start: 30,
        }}
      />,
    );
    const range = screen.getByRole("slider") as HTMLInputElement;
    expect(range.value).toBe("30");
    expect(range.getAttribute("aria-label")).toBe("Reveal Before or After");
    const before = container.querySelector(
      ".home-before-after-layer.is-before",
    ) as HTMLElement;
    expect(before.style.clipPath).toBe("inset(0 70% 0 0)");
    fireEvent.change(range, { target: { value: "65" } });
    expect(before.style.clipPath).toBe("inset(0 35% 0 0)");
    expect(screen.getByAltText("Unglazed")).toBeTruthy();
    expect(screen.getByAltText("Glazed")).toBeTruthy();
  });
});

describe("product spotlight", () => {
  it("shows the product's own name and price with the authored copy, and nothing without a product", () => {
    const product = {
      id: "p1",
      name: "Stoneware jug",
      slug: "stoneware-jug",
      image_url: IMG,
      base_price: 1200,
      selling_price: 950,
      track_inventory: false,
      stock: 0,
      low_stock_threshold: null,
      allow_backorder: false,
    };
    const { container } = render(
      <ProductSpotlightSection
        sectionId="p"
        config={{
          ...EMPTY_CONFIG.product_spotlight,
          eyebrow: "New",
          heading: "The jug",
          body: "Poured every morning.",
          cta_label: "See it",
        }}
        product={product}
      />,
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "The jug",
    );
    expect(screen.getByText("Stoneware jug")).toBeTruthy();
    expect(
      container.querySelector(".home-spotlight-selling")?.textContent,
    ).toContain("950");
    expect(container.querySelector("s")?.textContent).toContain("1,200");
    const links = screen.getAllByRole("link");
    expect(
      links.every((a) => a.getAttribute("href") === "/shop/stoneware-jug"),
    ).toBe(true);
    expect(screen.getByRole("link", { name: "See it" })).toBeTruthy();
    expect(
      render(
        <ProductSpotlightSection
          sectionId="n"
          config={EMPTY_CONFIG.product_spotlight}
          product={null}
        />,
      ).container.firstChild,
    ).toBeNull();
  });
});

describe("logo strip", () => {
  it("renders marks in a row, or on the marquee track when scrolling", () => {
    const items = [
      { image_url: IMG, image_alt: "Paper A", href: "https://a.example" },
      { image_url: IMG, image_alt: "Paper B", href: "" },
    ];
    const row = render(
      <LogoStripSection
        sectionId="l"
        config={{ ...EMPTY_CONFIG.logo_strip, items }}
      />,
    );
    expect(row.container.querySelector(".home-logos-row")).toBeTruthy();
    expect(
      row.container.querySelector(".home-logos.is-monochrome"),
    ).toBeTruthy();
    expect(
      row.container.querySelector("a.home-logo")?.getAttribute("rel"),
    ).toBe("noopener noreferrer");
    const scroll = render(
      <LogoStripSection
        sectionId="s"
        config={{
          ...EMPTY_CONFIG.logo_strip,
          items,
          layout: "scroll",
          monochrome: false,
        }}
      />,
    );
    expect(scroll.container.querySelector(".home-marquee-track")).toBeTruthy();
    expect(scroll.container.querySelector(".is-monochrome")).toBeNull();
  });
});

describe("countdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("splits a remaining span into days, hours, minutes and seconds", () => {
    expect(splitRemaining(90_061_000)).toEqual([
      { unit: "days", value: 1 },
      { unit: "hours", value: 1 },
      { unit: "minutes", value: 1 },
      { unit: "seconds", value: 1 },
    ]);
    expect(splitRemaining(-5).map((p) => p.value)).toEqual([0, 0, 0, 0]);
  });

  it("renders blank tiles before the clock starts, then counts, then shows its message", () => {
    const { container, rerender } = render(
      <CountdownSection
        sectionId="c"
        config={{
          ...EMPTY_CONFIG.countdown,
          heading: "Ends in",
          ends_at: "2026-10-10T12:00:30Z",
          expired_message: "The sale has ended.",
        }}
      />,
    );
    // Mounted: the effect ticks once immediately.
    const values = () =>
      [...container.querySelectorAll(".home-countdown-value")].map(
        (e) => e.textContent,
      );
    expect(values()).toEqual(["01", "00", "00", "30"]);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(values()).toEqual(["01", "00", "00", "29"]);
    expect(screen.getByRole("timer")).toBeTruthy();
    rerender(
      <CountdownSection
        sectionId="c"
        config={{
          ...EMPTY_CONFIG.countdown,
          heading: "Ends in",
          ends_at: "2026-10-09T11:00:00Z",
          expired_message: "The sale has ended.",
        }}
      />,
    );
    expect(screen.getByText("The sale has ended.")).toBeTruthy();
    expect(container.querySelector(".home-countdown-tiles")).toBeNull();
  });

  it("renders nothing once past with no message, and nothing for an unparseable end", () => {
    const past = render(
      <CountdownSection
        sectionId="x"
        config={{ ...EMPTY_CONFIG.countdown, ends_at: "2026-10-09T11:00:00Z" }}
      />,
    );
    expect(past.container.firstChild).toBeNull();
    const junk = render(
      <CountdownSection
        sectionId="y"
        config={{ ...EMPTY_CONFIG.countdown, ends_at: "" }}
      />,
    );
    expect(junk.container.firstChild).toBeNull();
  });
});
