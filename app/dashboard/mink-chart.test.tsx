// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinkArtifact } from "@/lib/mink/types";
import { readMinkArtifacts } from "./mink-artifact-parser";
import {
  MINK_CHART_SERIES_COLOURS,
  MinkChartCard,
  formatMinkChartValue,
  minkChartAxisIndices,
  minkChartPeakIndex,
  minkChartTsv,
} from "./mink-chart";

type ChartArtifact = Extract<MinkArtifact, { type: "chart" }>;

const DAYS = ["1 Oct", "2 Oct", "3 Oct", "4 Oct"];
const points = (values: number[]) =>
  values.map((value, index) => ({ label: DAYS[index], value }));

function lineChart(overrides: Partial<ChartArtifact> = {}): ChartArtifact {
  return {
    type: "chart",
    title: "Total sales by day",
    kind: "line",
    format: "currency",
    currency: "INR",
    series: [
      {
        label: "This period",
        points: points([100000, 250000, 180000, 120000]),
      },
      {
        label: "Previous period",
        points: points([90000, 80000, 110000, 70000]),
      },
    ],
    summary: {
      total: 350000,
      previousTotal: 180000,
      trendPercent: 94.44,
      comparisonLabel: "previous 30 days",
      goodWhen: "up",
    },
    filters: [{ label: "Period", value: "17 Sep 2026 to 16 Oct 2026" }],
    dashboardPath: "/dashboard/analytics/reports/explore?m=total_sales",
    ...overrides,
  };
}

function barChart(): ChartArtifact {
  return {
    type: "chart",
    title: "Gross sales by product",
    kind: "bar",
    format: "currency",
    currency: "INR",
    series: [
      {
        label: "This period",
        points: [
          { label: "Almond shake", value: 400 },
          { label: "Oat cookies", value: 900 },
          { label: "Cold brew", value: 200 },
        ],
      },
      {
        label: "Previous period",
        points: [
          { label: "Almond shake", value: 300 },
          { label: "Oat cookies", value: 500 },
          { label: "Cold brew", value: 250 },
        ],
      },
    ],
    filters: [],
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("formatMinkChartValue", () => {
  it("prints the full figure with Indian grouping and compact axis units", () => {
    expect(formatMinkChartValue(350000, "currency")).toBe("₹3,50,000");
    expect(
      formatMinkChartValue(120000, "currency", "INR", { compact: true }),
    ).toBe("₹1.2L");
    expect(
      formatMinkChartValue(34000000, "currency", "INR", { compact: true }),
    ).toBe("₹3.4Cr");
    expect(
      formatMinkChartValue(950, "currency", "INR", { compact: true }),
    ).toBe("₹950");
    expect(formatMinkChartValue(1200, "number", "INR", { compact: true })).toBe(
      "1.2K",
    );
    expect(
      formatMinkChartValue(12.5, "percent", "INR", { compact: true }),
    ).toBe("12.5%");
    expect(formatMinkChartValue(Number.NaN, "number")).toBe("-");
  });
});

describe("minkChartAxisIndices", () => {
  it("shows every label when few, and at most eight evenly spaced ones otherwise", () => {
    expect(minkChartAxisIndices(["a", "b", "c"])).toEqual([0, 1, 2]);
    const month = Array.from({ length: 30 }, (_, i) => `${i + 1} Oct`);
    const shown = minkChartAxisIndices(month);
    expect(shown.length).toBeLessThanOrEqual(8);
    expect(shown.length).toBeGreaterThanOrEqual(2);
    expect(shown[0]).toBe(0);
    expect(shown[shown.length - 1]).toBe(29);
    expect(shown.every((index, i) => i === 0 || index > shown[i - 1])).toBe(
      true,
    );
  });

  it("thins harder when the labels are long", () => {
    const long = Array.from(
      { length: 20 },
      (_, i) => `Product number ${i + 1}`,
    );
    expect(minkChartAxisIndices(long).length).toBeLessThan(
      minkChartAxisIndices(Array.from({ length: 20 }, (_, i) => `${i}`)).length,
    );
  });
});

describe("minkChartPeakIndex", () => {
  it("finds the highest point and nothing when everything is zero", () => {
    expect(minkChartPeakIndex(points([1, 5, 5, 2]))).toBe(1);
    expect(minkChartPeakIndex(points([0, 0, 0, 0]))).toBeNull();
    expect(minkChartPeakIndex([])).toBeNull();
  });
});

describe("MinkChartCard", () => {
  it("leads with the period total and a green trend against the comparison period", () => {
    render(<MinkChartCard artifact={lineChart()} />);
    expect(screen.getByText("₹3,50,000")).toBeTruthy();
    const badge = screen.getByText("+94.4% vs previous 30 days");
    expect(badge.className).toContain("text-[#15803d]");
    expect(screen.getByText("Open in Reports").getAttribute("href")).toBe(
      "/dashboard/analytics/reports/explore?m=total_sales",
    );
  });

  it("reads a rise as bad and a fall as good for a good-when-down measure", () => {
    const { unmount } = render(
      <MinkChartCard
        artifact={lineChart({
          title: "Discounts by day",
          summary: {
            total: 5000,
            previousTotal: 4000,
            trendPercent: 25,
            comparisonLabel: "previous 30 days",
            goodWhen: "down",
          },
        })}
      />,
    );
    expect(screen.getByText("+25% vs previous 30 days").className).toContain(
      "text-[#b91c1c]",
    );
    unmount();
    render(
      <MinkChartCard
        artifact={lineChart({
          summary: {
            total: 3000,
            previousTotal: 4000,
            trendPercent: -25,
            comparisonLabel: "same period last year",
            goodWhen: "down",
          },
        })}
      />,
    );
    expect(
      screen.getByText("-25% vs same period last year").className,
    ).toContain("text-[#15803d]");
  });

  it("derives the trend from the totals when none was sent, and says so when there is no baseline", () => {
    const { unmount } = render(
      <MinkChartCard
        artifact={lineChart({ summary: { total: 200, previousTotal: 100 } })}
      />,
    );
    expect(screen.getByText("+100%")).toBeTruthy();
    unmount();
    render(
      <MinkChartCard
        artifact={lineChart({
          summary: {
            total: 200,
            previousTotal: 0,
            trendPercent: null,
            comparisonLabel: "previous 7 days",
          },
        })}
      />,
    );
    expect(screen.getByText("₹0 previous 7 days")).toBeTruthy();
  });

  it("renders without a hero when the artifact carries no summary", () => {
    render(<MinkChartCard artifact={lineChart({ summary: undefined })} />);
    expect(screen.queryByText("₹3,50,000")).toBeNull();
    expect(screen.getByRole("img")).toBeTruthy();
  });

  it("draws the comparison dashed and lighter, labels only the peak, and names the periods in the legend", () => {
    const { container } = render(<MinkChartCard artifact={lineChart()} />);
    const lines = container.querySelectorAll("polyline");
    expect(lines.length).toBe(2);
    expect(lines[0].getAttribute("stroke")).toBe(MINK_CHART_SERIES_COLOURS[0]);
    expect(lines[0].getAttribute("stroke-dasharray")).toBeNull();
    expect(lines[1].getAttribute("stroke-dasharray")).toBe("4 3");
    expect(lines[1].getAttribute("stroke-opacity")).toBe("0.55");
    const peaks = container.querySelectorAll("[data-peak-label]");
    expect(peaks.length).toBe(1);
    expect(peaks[0].textContent).toBe("₹2.5L");
    const legend = screen.getByLabelText("Series");
    expect(legend.textContent).toContain("This period");
    expect(legend.textContent).toContain("Previous period");
    // Hover titles, one per x slot.
    expect(container.querySelectorAll("rect > title").length).toBe(4);
  });

  it("groups bars per category with a 2px gap and never stacks them", () => {
    const { container } = render(<MinkChartCard artifact={barChart()} />);
    const bars = [...container.querySelectorAll('svg[role="img"] rect')].filter(
      (rect) => rect.getAttribute("fill") !== "transparent",
    );
    expect(bars.length).toBe(6);
    const read = (rect: Element, name: string) =>
      Number(rect.getAttribute(name));
    // Series are emitted series-major: bars 0..2 are the current series.
    const current = bars[0];
    const previous = bars[3];
    expect(
      read(previous, "x") - (read(current, "x") + read(current, "width")),
    ).toBeCloseTo(2, 5);
    expect(read(current, "y") + read(current, "height")).toBeCloseTo(
      read(previous, "y") + read(previous, "height"),
      5,
    );
    expect(previous.getAttribute("fill-opacity")).toBe("0.55");
    expect(container.querySelector("[data-peak-label]")?.textContent).toBe(
      "₹900",
    );
  });

  it("thins the x-axis so labels never crowd", () => {
    const labels = Array.from({ length: 40 }, (_, i) => `${i + 1} Sep`);
    const { container } = render(
      <MinkChartCard
        artifact={lineChart({
          series: [
            {
              label: "This period",
              points: labels.map((label, index) => ({ label, value: index })),
            },
          ],
          summary: undefined,
        })}
      />,
    );
    const axis = [...container.querySelectorAll("svg > text")].filter((text) =>
      text.textContent?.endsWith("Sep"),
    );
    expect(axis.length).toBeLessThanOrEqual(8);
    expect(axis[0].textContent).toBe("1 Sep");
    expect(axis[axis.length - 1].textContent).toBe("40 Sep");
  });

  it("switches to a table that lists every value", () => {
    render(<MinkChartCard artifact={lineChart()} />);
    fireEvent.click(screen.getByLabelText("Show as table"));
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("₹2,50,000")).toBeTruthy();
    expect(screen.getByLabelText("Show as chart")).toBeTruthy();
  });

  it("copies the table as tab-separated text, and is a no-op without a clipboard", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(
      async () => undefined,
    );
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<MinkChartCard artifact={lineChart()} />);
    fireEvent.click(screen.getByLabelText("Copy table"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0];
    const rows = text.split("\n");
    expect(rows[0]).toBe("Label\tThis period (INR)\tPrevious period (INR)");
    expect(rows[1]).toBe("1 Oct\t100000\t90000");
    expect(rows.length).toBe(5);
    expect(await screen.findByLabelText("Copied")).toBeTruthy();
    cleanup();

    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    render(<MinkChartCard artifact={lineChart()} />);
    expect(() =>
      fireEvent.click(screen.getByLabelText("Copy table")),
    ).not.toThrow();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("renders a second measure as a small multiple with its own figure", () => {
    const artifact = lineChart({
      panels: [
        {
          title: "Orders by day",
          kind: "line",
          format: "number",
          series: [
            { label: "This period", points: points([3, 6, 4, 2]) },
            { label: "Previous period", points: points([2, 2, 3, 1]) },
          ],
          summary: {
            total: 15,
            previousTotal: 8,
            trendPercent: 87.5,
            comparisonLabel: "previous 30 days",
            goodWhen: "up",
          },
        },
      ],
    });
    const { container } = render(<MinkChartCard artifact={artifact} />);
    expect(screen.getByText("Total sales by day · Orders by day")).toBeTruthy();
    expect(screen.getAllByRole("img").length).toBe(2);
    expect(screen.getByText("Orders by day")).toBeTruthy();
    expect(screen.getByText("+87.5% vs previous 30 days")).toBeTruthy();
    expect(container.querySelectorAll("[data-peak-label]").length).toBe(2);
    const tsv = minkChartTsv(artifact).split("\n");
    expect(tsv[0]).toBe(
      "Label\tTotal sales by day: This period (INR)\tTotal sales by day: Previous period (INR)\tOrders by day: This period\tOrders by day: Previous period",
    );
    expect(tsv[2]).toBe("2 Oct\t250000\t80000\t6\t2");
  });
});

describe("readMinkArtifacts for charts", () => {
  const chart = () => ({
    type: "chart",
    title: "Total sales by day",
    kind: "line",
    format: "currency",
    series: [{ label: "This period", points: [{ label: "1 Oct", value: 10 }] }],
    filters: [],
  });

  it("keeps a chart whose summary is malformed, without the summary", () => {
    const cases: Array<Record<string, unknown>> = [
      { total: 1, goodWhen: "sideways" },
      { total: Number.POSITIVE_INFINITY },
      { total: 1, trendPercent: Number.NaN },
      { total: 1, previousTotal: "12" },
      { total: 1, comparisonLabel: "x".repeat(81) },
      "not a summary",
    ] as Array<Record<string, unknown>>;
    for (const summary of cases) {
      const [artifact] = readMinkArtifacts([{ ...chart(), summary }]);
      expect(artifact?.type).toBe("chart");
      expect((artifact as { summary?: unknown }).summary).toBeUndefined();
    }
  });

  it("keeps a well-formed summary with only its known keys", () => {
    const [artifact] = readMinkArtifacts([
      {
        ...chart(),
        summary: {
          total: 5,
          previousTotal: 4,
          trendPercent: null,
          comparisonLabel: "previous 30 days",
          goodWhen: "down",
          extra: "junk",
        },
      },
    ]);
    expect((artifact as { summary?: unknown }).summary).toEqual({
      total: 5,
      previousTotal: 4,
      trendPercent: null,
      comparisonLabel: "previous 30 days",
      goodWhen: "down",
    });
  });

  it("drops a malformed panel list but keeps a well-formed one, cleaning each panel's summary", () => {
    const [broken] = readMinkArtifacts([
      {
        ...chart(),
        panels: [
          { title: "Orders", kind: "line", format: "number", series: [] },
        ],
      },
    ]);
    expect(broken?.type).toBe("chart");
    expect((broken as { panels?: unknown }).panels).toBeUndefined();

    const [kept] = readMinkArtifacts([
      {
        ...chart(),
        panels: [
          {
            title: "Orders by day",
            kind: "line",
            format: "number",
            series: [
              { label: "This period", points: [{ label: "1 Oct", value: 2 }] },
            ],
            summary: { total: 2, goodWhen: "nope" },
          },
        ],
      },
    ]);
    expect((kept as { panels?: Array<{ summary?: unknown }> }).panels).toEqual([
      {
        title: "Orders by day",
        kind: "line",
        format: "number",
        series: [
          { label: "This period", points: [{ label: "1 Oct", value: 2 }] },
        ],
      },
    ]);
  });

  it("still refuses a chart with no series", () => {
    expect(readMinkArtifacts([{ ...chart(), series: [] }])).toEqual([]);
  });
});
