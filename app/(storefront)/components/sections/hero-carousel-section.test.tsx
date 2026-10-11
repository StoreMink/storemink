// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EMPTY_CONFIG } from "@/lib/homepage/section-types";
import { HeroCarouselSection } from "./hero-carousel-section";

// Plan Phase 2d: the split layout puts each slide's copy beside its photo on
// a colour field. jsdom renders no layout, so these pin the structure the
// CSS keys on: the layout class, the figure that becomes the photo's
// column, and that nothing meant for copy-over-photo (the tone probe, the
// tuned overlay) is rendered on a split slide.

const IMG = "/themes/vitrine/hero.webp";
const base = EMPTY_CONFIG.hero_carousel.slides[0];
const slides = [
  { ...base, heading: "One", image_url: IMG, theme: "dark" as const },
  {
    ...base,
    heading: "Two",
    image_url: IMG,
    theme: "light" as const,
    overlay_opacity: 30,
  },
];

describe("split carousel", () => {
  it("marks the band, wraps every slide's media in a figure and drops the overlay and tone probe", () => {
    const { container } = render(
      <HeroCarouselSection
        sectionId="c"
        config={{
          ...EMPTY_CONFIG.hero_carousel,
          autoplay: false,
          layout: "split",
          slides,
        }}
      />,
    );
    expect(container.querySelector(".home-carousel")).toHaveClass(
      "layout-split",
    );
    const figures = container.querySelectorAll(
      ".home-carousel-slide > .home-carousel-figure",
    );
    expect(figures).toHaveLength(2);
    expect(figures[0].querySelector(".home-carousel-media")).not.toBeNull();
    expect(container.querySelector(".home-hero-overlay")).toBeNull();
    expect(
      container.querySelector(".home-carousel-slide > span[hidden]"),
    ).toBeNull();
    // The copy and its text mode still render.
    expect(container.querySelectorAll(".home-carousel-copy")).toHaveLength(2);
    expect(container.querySelectorAll(".home-carousel-slide")[1]).toHaveClass(
      "theme-light",
    );
  });

  it("leaves the full layout exactly as before: no layout class, figure in flow, overlay and probe present", () => {
    const { container } = render(
      <HeroCarouselSection
        sectionId="c"
        config={{ ...EMPTY_CONFIG.hero_carousel, autoplay: false, slides }}
      />,
    );
    expect(container.querySelector(".home-carousel")).not.toHaveClass(
      "layout-split",
    );
    expect(
      container.querySelectorAll(
        ".home-carousel-slide > .home-carousel-figure",
      ),
    ).toHaveLength(2);
    expect(container.querySelector(".home-hero-overlay")).not.toBeNull();
    expect(
      container.querySelectorAll(".home-carousel-slide > span[hidden]"),
    ).toHaveLength(2);
  });
});
