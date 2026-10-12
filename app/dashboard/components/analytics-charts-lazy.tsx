"use client";

import dynamic from "next/dynamic";

// recharts (+ its d3 dependencies) is ~100KB+ gzipped; keep it out of the
// first paint. ssr:false is required (recharts touches the DOM) and is only
// allowed inside a Client Component, hence this wrapper.
export const AnalyticsTrendChart = dynamic(
  () => import("./analytics-trend-chart").then((m) => m.AnalyticsTrendChart),
  {
    ssr: false,
    loading: () => <div className="dash-an-chart-loading" aria-hidden />,
  },
);

export const AnalyticsDonut = dynamic(
  () => import("./analytics-donut").then((m) => m.AnalyticsDonut),
  {
    ssr: false,
    loading: () => (
      <div className="dash-an-chart-loading is-donut" aria-hidden />
    ),
  },
);
