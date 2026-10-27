// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { StudioAcceptanceProbe } from "./studio-acceptance-probe";
import { CHROME_STATES } from "@/lib/theme-studio/chrome-states";

vi.mock("axe-core", () => ({
  default: { run: vi.fn(async () => ({ violations: [] })) },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)
    .innerText;
});

it("reports distinct failing elements and axe's contrast measurements", async () => {
  vi.useFakeTimers();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const price =
    "Element has insufficient color contrast of 2.1 (foreground #aaaaaa, background #ffffff, expected 4.5:1).";
  vi.mocked(axe.run).mockResolvedValueOnce({
    violations: [
      {
        id: "color-contrast",
        impact: "serious",
        help: "Elements must meet minimum color contrast ratio thresholds",
        nodes: [
          ...Array.from({ length: 20 }, (_, i) => ({
            target: [`.shop-card:nth-child(${i + 1}) > .shop-card-base`],
            failureSummary: price,
            any: [
              {
                id: "color-contrast",
                data: { contrastRatio: 2.1, expectedContrastRatio: "4.5:1" },
              },
            ],
          })),
          {
            target: [".shop-card-off"],
            failureSummary: "Discount text fails contrast of 2.5:1.",
          },
          {
            target: [".columnTitle"],
            failureSummary: "Footer heading fails contrast of 2.3:1.",
          },
        ],
      },
    ],
  } as never);
  render(<StudioAcceptanceProbe />);
  const pending = window.__smThemeStudioMeasure!();
  await vi.runAllTimersAsync();
  const evidence = await pending;
  expect(evidence.violations).toEqual([
    expect.objectContaining({
      id: "color-contrast",
      nodes: 22,
      examples: [
        { target: ".shop-card:nth-child(1) > .shop-card-base", summary: price },
        {
          target: ".shop-card-off",
          summary: "Discount text fails contrast of 2.5:1.",
        },
        {
          target: ".columnTitle",
          summary: "Footer heading fails contrast of 2.3:1.",
        },
      ],
    }),
  ]);
  expect(
    (evidence.violations as { contrast: unknown[] }[])[0].contrast,
  ).toHaveLength(20);
  expect(
    (evidence.violations as { contrast: unknown[] }[])[0].contrast[0],
  ).toMatchObject({ ratio: 2.1, required: 4.5 });
});

it("distinguishes deliberate clipping and labelled controls from real defects", async () => {
  vi.useFakeTimers();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 360,
  });
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent ?? "";
    },
  });
  const { container } = render(
    <>
      <StudioAcceptanceProbe />
      <label
        id="hidden"
        style={{
          opacity: 1,
          overflowX: "hidden",
          clip: "rect(0px, 0px, 0px, 0px)",
        }}
      >
        Accessible label
      </label>
      <p
        id="ellipsis"
        style={{ opacity: 1, overflowX: "hidden", textOverflow: "ellipsis" }}
      >
        Long name
      </p>
      <p
        id="clamp"
        style={{ opacity: 1, overflowY: "hidden", WebkitLineClamp: 2 }}
      >
        Long description
      </p>
      <div className="home-ticker" style={{ opacity: 1, overflowX: "hidden" }}>
        <div
          className="home-ticker-track"
          style={{ animationName: "home-ticker-scroll" }}
        >
          Moving text
        </div>
      </div>
      <p id="broken" style={{ opacity: 1, overflowX: "hidden" }}>
        Unintentionally clipped text
      </p>
      <label id="consent">
        <input type="checkbox" style={{ opacity: 1 }} />
        Subscribe
      </label>
      <button id="tiny" style={{ opacity: 1 }}>
        Buy
      </button>
    </>,
  );
  for (const id of ["hidden", "ellipsis", "clamp", "broken"]) {
    Object.defineProperties(container.querySelector(`#${id}`)!, {
      scrollWidth: { value: id === "clamp" ? 100 : 200 },
      clientWidth: { value: id === "hidden" ? 1 : 100 },
      scrollHeight: { value: id === "clamp" ? 60 : 20 },
      clientHeight: { value: id === "hidden" ? 1 : 20 },
    });
  }
  Object.defineProperties(container.querySelector(".home-ticker")!, {
    scrollWidth: { value: 2000 },
    clientWidth: { value: 360 },
  });
  const rect = (width: number, height: number) => ({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON() {},
  });
  for (const [selector, width, height] of [
    ["input", 13, 13],
    ["#consent", 150, 30],
    ["#tiny", 20, 20],
  ] as const) {
    vi.spyOn(
      container.querySelector(selector)!,
      "getBoundingClientRect",
    ).mockReturnValue(rect(width, height));
  }
  const pending = window.__smThemeStudioMeasure!();
  await vi.runAllTimersAsync();
  const evidence = await pending;
  expect(evidence.clippedText).toEqual([
    { target: "p#broken", clippedX: 100, clippedY: 0 },
  ]);
  expect(evidence.smallTapTargets).toEqual([
    { target: "button#tiny", width: 20, height: 20 },
  ]);
});

it("measures a storefront containing SVG icons and still detects clipped HTML text", async () => {
  vi.useFakeTimers();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  // jsdom does not implement innerText. Match browsers: only HTML has it.
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent ?? "";
    },
  });
  const { container } = render(
    <>
      <StudioAcceptanceProbe />
      <button>
        <svg>
          <path d="M0 0" />
        </svg>
        Search
      </button>
      <p style={{ overflowX: "hidden", opacity: 1 }}>Clipped heading</p>
    </>,
  );
  const paragraph = container.querySelector("p")!;
  Object.defineProperties(paragraph, {
    scrollWidth: { value: 200 },
    clientWidth: { value: 100 },
  });
  expect(container.querySelector("svg")).not.toHaveProperty("innerText");
  const pending = window.__smThemeStudioMeasure!();
  await vi.runAllTimersAsync();
  const evidence = await pending;
  expect(evidence.clippedText).toEqual([
    { target: "p", clippedX: 100, clippedY: 0 },
  ]);
  expect(evidence.violations).toEqual([]);
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)
    .innerText;
});

// A clip of a pixel or two is a warning and a larger one serious, so the
// list must keep the largest clips when it is cut: forty card titles clipped
// by 2px used to fill it before a heading clipped by 14px was ever measured.
it("measures every clipped element before cutting the list, the largest clip first", async () => {
  vi.useFakeTimers();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent ?? "";
    },
  });
  const { container } = render(
    <>
      <StudioAcceptanceProbe />
      {Array.from({ length: 40 }, (_, i) => (
        <p
          key={i}
          className="card-title"
          style={{ overflowX: "hidden", opacity: 1 }}
        >
          Card {i}
        </p>
      ))}
      <h2 style={{ overflowY: "hidden", opacity: 1 }}>Heading cut in half</h2>
    </>,
  );
  for (const title of container.querySelectorAll("p.card-title")) {
    Object.defineProperties(title, {
      scrollWidth: { value: 102 },
      clientWidth: { value: 100 },
    });
  }
  Object.defineProperties(container.querySelector("h2")!, {
    scrollHeight: { value: 34 },
    clientHeight: { value: 20 },
  });
  const pending = window.__smThemeStudioMeasure!();
  await vi.runAllTimersAsync();
  const evidence = await pending;
  expect(evidence.clippedTextFound).toBe(41);
  const listed = evidence.clippedText as {
    target: string;
    clippedX: number;
    clippedY: number;
  }[];
  expect(listed).toHaveLength(40);
  expect(listed[0]).toEqual({ target: "h2", clippedX: 0, clippedY: 14 });
  // Equal clips keep their page order.
  expect(listed[1]).toEqual({
    target: "p.card-title",
    clippedX: 2,
    clippedY: 0,
  });
});

it("keeps the contrast nodes axe could not judge, and opens the chrome states on the home page only", async () => {
  vi.useFakeTimers();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.mocked(axe.run).mockResolvedValueOnce({
    violations: [],
    incomplete: [
      {
        id: "color-contrast",
        nodes: [
          {
            target: [".home-hero-heading"],
            any: [{ id: "color-contrast", data: { messageKey: "bgImage" } }],
          },
          {
            target: [".shop-card:nth-child(2) .shop-card-name"],
            any: [{ id: "color-contrast", data: { messageKey: "bgGradient" } }],
          },
          {
            target: [".shop-card:nth-child(3) .shop-card-name"],
            any: [{ id: "color-contrast", data: { messageKey: "bgGradient" } }],
          },
        ],
      },
      { id: "region", nodes: [{ target: ["main"], any: [] }] },
    ],
  } as never);
  render(<StudioAcceptanceProbe />);
  const pending = window.__smThemeStudioMeasure!();
  await vi.runAllTimersAsync();
  const evidence = await pending;
  expect(evidence.contrastUnresolved).toEqual([
    { target: ".home-hero-heading", reason: "bgImage" },
    { target: ".shop-card:nth-child(2) .shop-card-name", reason: "bgGradient" },
  ]);
  // No header in this document: every state is reported absent, with the
  // uniform empty findings the server parses.
  expect(evidence.states).toEqual(
    CHROME_STATES.map((state) => ({
      state,
      measured: false,
      reason: "absent",
      violations: [],
      contrastUnresolved: [],
      clippedText: [],
      clippedTextFound: 0,
      smallTapTargets: [],
    })),
  );

  window.history.pushState({}, "", "/shop");
  vi.mocked(axe.run).mockResolvedValueOnce({ violations: [] } as never);
  const again = window.__smThemeStudioMeasure!();
  await vi.runAllTimersAsync();
  expect((await again).states).toEqual([]);
  window.history.pushState({}, "", "/");
});

// Measured on demo-ritual at 360px (2026-10-09): the product carousel's
// screen-reader-only labels are absolutely positioned, their containing block
// was the carousel wrapper OUTSIDE the scroll track, so they sat where their
// off-screen cards had scrolled to and widened the page by the whole hidden
// track — and the rectangle scan, walking parents, exempted them as "inside a
// fitting scroll container" and named nothing. An absolutely positioned box
// is clipped only by its containing block and that block's ancestors.
it("names an absolutely positioned box that escapes a fitting scroll container", async () => {
  vi.useFakeTimers();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    value: 360,
  });
  const { container } = render(
    <>
      <StudioAcceptanceProbe />
      <div id="wrap" style={{ position: "relative" }}>
        <div id="track" style={{ overflowX: "auto" }}>
          <div id="card">
            Tea
            <span className="sr-only" style={{ position: "absolute" }}>
              Was
            </span>
          </div>
          <div id="inside">
            Cup
            <span className="price" style={{ position: "absolute" }}>
              Now
            </span>
          </div>
        </div>
      </div>
    </>,
  );
  const rect = (right: number, width = right) => ({
    width,
    height: 20,
    top: 0,
    left: right - width,
    right,
    bottom: 20,
    x: right - width,
    y: 0,
    toJSON() {},
  });
  const wrap = container.querySelector("#wrap")!;
  const track = container.querySelector("#track")!;
  const card = container.querySelector("#card")!;
  const inside = container.querySelector("#inside")!;
  const escaping = container.querySelector(".sr-only")!;
  const contained = container.querySelector(".price")!;
  for (const [element, right, width] of [
    [wrap, 360, 360],
    [track, 360, 360],
    [card, 900, 155], // scrolled off-screen inside the track: deliberate
    [inside, 1100, 155],
    [escaping, 900, 1],
    [contained, 1100, 40],
  ] as const) {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
      rect(right, width),
    );
  }
  // jsdom lays nothing out, so the containing blocks are stated: the label's
  // nearest positioned ancestor is the wrapper outside the track; the price's
  // is its own card (as it would be once the track is positioned).
  Object.defineProperty(escaping, "offsetParent", { value: wrap });
  Object.defineProperty(contained, "offsetParent", { value: inside });
  const pending = window.__smThemeStudioMeasure!();
  await vi.runAllTimersAsync();
  const evidence = await pending;
  expect(evidence.overflowPx).toBe(540);
  expect(evidence.overflowOffenders).toEqual(["span.sr-only"]);
});
