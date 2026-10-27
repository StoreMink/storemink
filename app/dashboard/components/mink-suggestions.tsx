"use client";

import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import {
  minkHomeSuggestionLinkLabel,
  type MinkHomeSuggestion,
} from "@/lib/mink/home-suggestion-rules";
import { useChat } from "../chat-context";

// "Mink suggests": the ranked next-best-actions card on Home (a Shopify
// Sidekick Pulse shape). The list is computed on the server from store data
// with no model call (lib/mink/home-suggestions.ts); the only thing that costs
// a credit is pressing "Ask Mink", which opens the chat with the row's
// question, the same hand-off as the Analytics Insights panel.

export function MinkSuggestions({
  suggestions,
  canAskMink,
}: {
  suggestions: MinkHomeSuggestion[];
  /** Mink is switched on for this store (the Insights panel's rule). */
  canAskMink: boolean;
}) {
  const { startExpandedChat } = useChat();
  if (suggestions.length === 0) return null;

  return (
    <section className="dash-card" aria-labelledby="mink-suggests-title">
      <div className="dash-card-header">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--dash-accent-soft)] text-[var(--dash-accent)]">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="mink-suggests-title" className="dash-card-title">
              Mink suggests
            </h2>
            <div className="dash-card-sub">
              What to do next, ranked from your store&apos;s own numbers.
            </div>
          </div>
        </div>
      </div>

      <ol className="divide-y divide-[var(--dash-border)]">
        {suggestions.map((item, index) => (
          <li
            key={item.id}
            className="flex flex-col gap-3 px-[22px] py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
          >
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--dash-surface-2)] text-[11.5px] font-semibold tabular-nums text-[var(--dash-text-2)]"
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-[var(--dash-text)]">
                  {item.title}
                </div>
                <div className="mt-0.5 text-[12.5px] leading-snug text-[var(--dash-text-3)]">
                  {item.detail}
                </div>
              </div>
            </div>
            {/* Phones (390px) stack the two actions full-width under the text;
                from sm they sit in a row at the end of the line. */}
            <div className="flex w-full flex-col gap-2 pl-9 sm:w-auto sm:shrink-0 sm:flex-row sm:items-center sm:pl-0">
              <Link
                href={item.href}
                className="dash-btn dash-btn-ghost dash-btn-sm"
              >
                {minkHomeSuggestionLinkLabel(item.href)}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
              {canAskMink ? (
                <button
                  type="button"
                  className="dash-btn dash-btn-ghost dash-btn-sm"
                  aria-label={`Ask Mink: ${item.title}`}
                  onClick={() => startExpandedChat(item.askMink)}
                >
                  <Sparkles
                    className="h-3.5 w-3.5 text-[var(--dash-accent)]"
                    aria-hidden
                  />
                  Ask Mink
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
