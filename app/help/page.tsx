import Link from "next/link";
import { connection } from "next/server";
import {
  ArrowRight,
  AudioLines,
  ChevronRight,
  FileText,
  Mail,
} from "lucide-react";
import {
  getHelpArticleCardsByCategory,
  getHelpCategories,
  getHelpCategoryCounts,
  getHelpNavTree,
  getPopularHelpArticles,
} from "@/lib/help/queries";
import { getMinkConfig } from "@/lib/mink/config";
import { POPULAR_HELP_SEARCHES } from "@/lib/help/popular-searches";
import { MinkFace } from "@/components/mink/mink-face";
import { HelpSearchBox } from "./components/search-box";
import { CategoryIcon } from "./components/category-icon";
import { AskMinkButton } from "./components/ask-mink-button";

// Cloud Run supplies database credentials at runtime, not during image builds.
// Render per request; the successful Help reads still share the tagged cache.

/** The category new sellers start in, and how many of its guides to show. */
const START_CATEGORY_SLUG = "getting-started";
const START_GUIDES = 4;

/** How many of a topic's guides its card lists. */
const TOPIC_GUIDES = 3;

const SUPPORT_EMAIL = "support@storemink.com";

function searchHref(query: string): string {
  return `/help/search?q=${encodeURIComponent(query)}`;
}

export default async function HelpHome() {
  await connection();
  const [categories, counts, popular, navTree] = await Promise.all([
    getHelpCategories(),
    getHelpCategoryCounts(),
    getPopularHelpArticles(8),
    getHelpNavTree(),
  ]);
  const voiceEnabled = getMinkConfig().enabled;

  const startCategory = categories.find((c) => c.slug === START_CATEGORY_SLUG);
  const startGuides = startCategory
    ? (await getHelpArticleCardsByCategory(startCategory.id)).slice(
        0,
        START_GUIDES,
      )
    : [];

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const guidesBySlug = new Map(navTree.map((c) => [c.slug, c.articles]));
  const popularLinks = popular.flatMap((article) => {
    const category = article.categoryId
      ? categoryById.get(article.categoryId)
      : undefined;
    return category
      ? [
          {
            ...article,
            href: `/help/${category.slug}/${article.slug}`,
            categoryTitle: category.title,
          },
        ]
      : [];
  });

  return (
    <>
      <section className="hc-hero">
        <div className="hc-wrap">
          <span className="kicker">Help Centre</span>
          <h1>How can we help?</h1>
          <p className="hc-hero-sub">
            Search the guides, or ask Mink AI for a step-by-step answer.
          </p>

          <div className="hc-hero-search">
            <HelpSearchBox placeholder="Search guides..." />
            <AskMinkButton className="hc-hero-mink-pill" expand>
              <MinkFace size={36} />
              <span>
                <strong>Ask Mink AI</strong>
                <small>Type or talk, in any language</small>
              </span>
            </AskMinkButton>
          </div>

          <div className="hc-hero-popular">
            <span>Popular searches:</span>
            {POPULAR_HELP_SEARCHES.map((search) => (
              <Link
                key={search.query}
                href={searchHref(search.query)}
                className={`hc-chip${search.phone ? "" : " hc-chip-wide"}`}
              >
                {search.label}
              </Link>
            ))}
          </div>

          <div className="hc-hero-mink">
            <div className="hc-hero-mink-top">
              <MinkFace size={48} animated className="hc-hero-mink-face" />
              <div className="hc-hero-mink-text">
                <strong>Ask Mink AI</strong>
                <span>Typed or spoken, in your language.</span>
              </div>
            </div>
            <div className="hc-hero-mink-actions">
              <AskMinkButton className="hc-btn hc-btn-primary" expand>
                Ask Mink AI
              </AskMinkButton>
              {voiceEnabled && (
                <AskMinkButton
                  className="hc-btn hc-btn-ghost"
                  mode="talk"
                  ariaLabel="Talk with Mink AI"
                >
                  <AudioLines size={16} aria-hidden />
                  <span>Talk</span>
                </AskMinkButton>
              )}
            </div>
          </div>
        </div>
      </section>

      <main className="hc-main">
        <div className="hc-wrap hc-wrap-wide">
          {popularLinks.length > 0 && (
            <section className="hc-home-section" aria-labelledby="hc-popular">
              <div className="hc-home-head">
                <h2 id="hc-popular" className="hc-home-title">
                  Popular guides
                </h2>
                <p className="hc-home-sub">What other sellers read most.</p>
              </div>
              <ul className="hc-popular">
                {popularLinks.map((article) => (
                  <li key={article.id}>
                    <Link href={article.href}>
                      <FileText className="doc" size={18} aria-hidden />
                      <span className="a-text">
                        <span className="a-title">{article.title}</span>
                        <span className="a-cat">{article.categoryTitle}</span>
                      </span>
                      <ChevronRight className="chev" size={18} aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section
            id="topics"
            className="hc-home-section"
            aria-labelledby="hc-topics"
          >
            <div className="hc-home-head">
              <h2 id="hc-topics" className="hc-home-title">
                Browse by topic
              </h2>
              <p className="hc-home-sub">
                Step-by-step guides for every part of your store.
              </p>
            </div>
            {categories.length === 0 ? (
              <div className="hc-empty">
                Articles are on their way. Meanwhile, email{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
              </div>
            ) : (
              <div className="hc-topic-grid">
                {categories.map((category) => {
                  const guides = (guidesBySlug.get(category.slug) ?? []).slice(
                    0,
                    TOPIC_GUIDES,
                  );
                  const total = counts[category.id] ?? 0;
                  return (
                    <article className="hc-topic" key={category.id}>
                      <Link
                        href={`/help/${category.slug}`}
                        className="hc-topic-head"
                      >
                        <span className="ic">
                          <CategoryIcon name={category.icon} />
                        </span>
                        <span className="hc-topic-title">{category.title}</span>
                        {category.description && (
                          <span className="hc-topic-desc">
                            {category.description}
                          </span>
                        )}
                      </Link>
                      {guides.length > 0 && (
                        <ul className="hc-topic-guides">
                          {guides.map((guide) => (
                            <li key={guide.slug}>
                              <Link
                                href={`/help/${category.slug}/${guide.slug}`}
                              >
                                {guide.title}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                      <Link
                        href={`/help/${category.slug}`}
                        className="hc-topic-all"
                        aria-label={`View all ${total} ${category.title} guides`}
                      >
                        View all {total} {total === 1 ? "guide" : "guides"}
                        <ArrowRight size={14} aria-hidden />
                      </Link>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {startCategory && startGuides.length > 0 && (
            <section className="hc-start" aria-labelledby="hc-start-title">
              <h2 id="hc-start-title" className="hc-home-title">
                New to StoreMink? Start here
              </h2>
              <p className="hc-home-sub">
                These guides take you from sign-up to your first order.
              </p>
              <ol className="hc-start-grid">
                {startGuides.map((guide, index) => (
                  <li key={guide.id}>
                    <Link href={`/help/${startCategory.slug}/${guide.slug}`}>
                      <span className="hc-start-number" aria-hidden>
                        {index + 1}
                      </span>
                      <strong>{guide.title}</strong>
                      {guide.excerpt && <span>{guide.excerpt}</span>}
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section
            id="contact"
            className="hc-still"
            aria-labelledby="hc-still-title"
          >
            <h2 id="hc-still-title" className="hc-home-title">
              Still need help?
            </h2>
            <div className="hc-still-grid">
              <div className="hc-still-card is-mink">
                <MinkFace size={52} className="hc-still-face" />
                <div>
                  <h3>Ask Mink AI</h3>
                  <p>
                    Instant answers from the guides, any time of day. Mink AI
                    links every answer to the guides it used.
                  </p>
                  <AskMinkButton className="hc-btn hc-btn-primary" expand>
                    Start a chat
                  </AskMinkButton>
                </div>
              </div>
              <div className="hc-still-card">
                <span className="hc-still-icon" aria-hidden>
                  <Mail size={22} />
                </span>
                <div>
                  <h3>Email support</h3>
                  <p>
                    Write to our team with your store address and what you were
                    trying to do. We reply by email.
                  </p>
                  <a
                    className="hc-btn hc-btn-ghost"
                    href={`mailto:${SUPPORT_EMAIL}`}
                  >
                    {SUPPORT_EMAIL}
                  </a>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
