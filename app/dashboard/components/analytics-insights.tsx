"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Lightbulb } from "lucide-react";
import { MinkFace } from "@/components/mink/mink-face";
import type { Insight } from "@/lib/analytics/insights";
import { useChat } from "../chat-context";
import { Sparkline } from "./analytics-trend";

// Shopify-style Insights panel: the list on the left, the selected insight on
// the right with its numbers, a small chart where there is one, and a button
// that asks Mink why (spending the seller's normal Mink credits).

const TONE_ICON = {
  good: ArrowUpRight,
  bad: ArrowDownRight,
  neutral: Lightbulb,
} as const;

export function InsightsPanel({
  insights,
  canAskMink,
}: {
  insights: Insight[];
  canAskMink: boolean;
}) {
  const [selected, setSelected] = useState(0);
  const { startExpandedChat } = useChat();
  if (insights.length === 0) return null;
  const insight = insights[Math.min(selected, insights.length - 1)];
  const values = insight.series?.map((point) => point.value) ?? [];
  const previous = insight.series
    ?.map((point) => point.previous)
    .filter((value): value is number => value !== null);

  return (
    <section className="dash-section dash-insights" aria-label="Insights">
      <h2>Insights</h2>
      <div className="dash-insights-panel">
        <ul className="dash-insights-list">
          {insights.map((item, index) => {
            const Icon = TONE_ICON[item.tone];
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-pressed={index === selected}
                  onClick={() => setSelected(index)}
                  className={`is-${item.tone}`}
                >
                  <Icon aria-hidden />
                  <span>{item.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="dash-insights-detail">
          <p className="dash-insights-kicker">Insight</p>
          <h3 className={`is-${insight.tone}`}>{insight.title}</h3>
          <p className="dash-insights-text">{insight.detail}</p>
          {values.length > 1 ? (
            <Sparkline
              data={values}
              previous={previous && previous.length > 1 ? previous : undefined}
              partial={{
                start: insight.series?.[0]?.partial ?? false,
                end: insight.series?.at(-1)?.partial ?? false,
              }}
              className="dash-insights-chart"
            />
          ) : null}
          {canAskMink ? (
            <button
              type="button"
              className="dash-an-btn dash-insights-ask"
              onClick={() => startExpandedChat(insight.askMink)}
            >
              <MinkFace size={18} /> Ask Mink why
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
