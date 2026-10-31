import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { searchPublishedHelpWithAi } from "@/app/actions/help-actions";
import { getHelpCategories } from "@/lib/help/queries";
import { highlightParts, highlightTerms } from "@/lib/help/highlight";
import { POPULAR_HELP_SEARCHES } from "@/lib/help/popular-searches";
import {
  filterByTopic,
  helpSearchHref,
  helpUrlTopic,
  searchTopicCounts,
} from "@/lib/help/search-topics";
import { MinkFace } from "@/components/mink/mink-face";
import { AskMinkButton } from "../components/ask-mink-button";

// Search results are query-dependent and not worth indexing.
export const metadata: Metadata = {
  title: "Search",
  robots: { index: false, follow: true },
};

type Params = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/** The search's words marked in a result's title or excerpt. */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((part, index) =>
        part.match ? <mark key={index}>{part.text}</mark> : part.text,
      )}
    </>
  );
}

function PopularSearches() {
  return (
    <div className="hc-results-popular">
      <span>Popular searches:</span>
      {POPULAR_HELP_SEARCHES.map((search) => (
        <Link
          key={search.query}
          href={helpSearchHref(search.query)}
          className="hc-chip"
        >
          {search.label}
        </Link>
      ))}
    </div>
  );
}

export default async function HelpSearchPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const query = first(params.q);
  const requestedTopic = first(params.topic);

  const [search, categories] = await Promise.all([
    query
      ? searchPublishedHelpWithAi(query)
      : Promise.resolve({ results: [], mode: "keyword" as const }),
    getHelpCategories(),
  ]);
  const { results } = search;

  const topics = searchTopicCounts(results, categories);
  // A topic in the address that holds none of these results (a stale link,
  // or a typed one) shows every result rather than an empty page.
  const activeTopic =
    topics.find((topic) => topic.slug === requestedTopic) ?? null;
  const shown = filterByTopic(results, activeTopic?.slug ?? null);
  const titleBySlug = new Map(categories.map((c) => [c.slug, c.title]));
  const terms = highlightTerms(query);

  const heading = !query
    ? "Search the Help Centre"
    : shown.length === 0
      ? `No guides for “${query}”`
      : `${shown.length} ${shown.length === 1 ? "guide" : "guides"} for “${query}”${
          activeTopic ? ` in ${activeTopic.title}` : ""
        }`;

  return (
    <main className="hc-main hc-search-main">
      <div className="hc-results-layout">
        {topics.length > 0 && (
          <nav className="hc-results-topics" aria-label="Filter by topic">
            <h2 className="hc-results-topics-title">Filter by topic</h2>
            <ul>
              <li>
                <Link
                  href={helpSearchHref(query)}
                  aria-current={activeTopic ? undefined : "page"}
                >
                  <span>All topics</span>
                  <span className="count">{results.length}</span>
                </Link>
              </li>
              {topics.map((topic) => (
                <li key={topic.slug}>
                  <Link
                    href={helpSearchHref(query, topic.slug)}
                    aria-current={
                      activeTopic?.slug === topic.slug ? "page" : undefined
                    }
                  >
                    <span>{topic.title}</span>
                    <span className="count">{topic.count}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <section className="hc-results" aria-labelledby="hc-results-title">
          <nav className="hc-crumbs" aria-label="Breadcrumb">
            <Link href="/help">Help Centre</Link>
            <span className="sep">/</span>
            <span aria-current="page">Search</span>
          </nav>

          <div className="hc-results-head">
            <h1 id="hc-results-title">{heading}</h1>
            {shown.length > 1 && (
              <span className="hc-results-sort">Sorted by best match</span>
            )}
          </div>

          {!query ? (
            <>
              <p className="hc-results-note">
                Type a question or a few words in the search box above.
              </p>
              <PopularSearches />
            </>
          ) : shown.length === 0 ? (
            <>
              <p className="hc-results-note">
                Try other words, ask Mink AI, or{" "}
                <Link href="/help#contact">contact support</Link>.
              </p>
              <PopularSearches />
            </>
          ) : (
            <>
              {search.mode === "ai" && (
                <div className="hc-ai-grounding" role="status">
                  <Sparkles size={16} aria-hidden />
                  AI interpreted your question. Every result below is a real,
                  published StoreMink guide.
                </div>
              )}
              <ul className="hc-results-list">
                {shown.map((result) => {
                  const topic = helpUrlTopic(result.url);
                  const topicTitle = topic ? titleBySlug.get(topic) : null;
                  return (
                    <li key={result.url}>
                      <Link href={result.url} className="hc-result">
                        {topicTitle && (
                          <span className="hc-result-topic">{topicTitle}</span>
                        )}
                        <span className="hc-result-title">
                          <Highlighted text={result.title} terms={terms} />
                        </span>
                        {result.excerpt && (
                          <span className="hc-result-excerpt">
                            <Highlighted text={result.excerpt} terms={terms} />
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <aside className="hc-results-rail" aria-label="More help">
          <div className="hc-rail-mink">
            <MinkFace size={52} className="hc-rail-mink-face" />
            <h2>Want a direct answer?</h2>
            <p>Ask Mink AI and get the steps for your exact problem.</p>
            {query && <p className="hc-rail-mink-quote">“{query}”</p>}
            <AskMinkButton
              className="hc-btn hc-btn-primary"
              question={query || undefined}
              expand
            >
              Ask Mink AI
            </AskMinkButton>
          </div>
          <div className="hc-rail-contact">
            <h2>Didn’t find it?</h2>
            <Link href="/help#contact">
              Contact support
              <ArrowRight size={15} aria-hidden />
            </Link>
          </div>
        </aside>
      </div>
    </main>
  );
}
