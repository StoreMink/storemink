import Link from "next/link";
import { AlertTriangle, ArrowLeft, ThumbsDown, ThumbsUp } from "lucide-react";
import { pickPage, pickParam } from "@/app/dashboard/lib/list-params";
import {
  countHelpFeedback,
  listHelpFeedback,
  type HelpFeedbackCounts,
  type HelpFeedbackFilter,
  type HelpFeedbackRow,
} from "@/lib/help/assistant-feedback";
import { helpLanguage, isHelpLanguageCode } from "@/lib/help/languages";
import { HELP_URL } from "@/lib/site";
import { requireOperator } from "../../require-operator";
import "../help-admin.css";

export const metadata = { title: "Mink AI feedback · StoreMink Admin" };
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// What visitors to help.storemink.com said about Mink AI's answers.
//
// A thumbs up or down in the Help Centre's Mink AI chat stores the question,
// the answer and the guides it cited (`help_assistant_feedback`, written by
// `rateHelpAnswer`). Visitors are anonymous, so there is no store or person
// to show: the point is to find the questions the guides answer badly.
// ---------------------------------------------------------------------------

const FILTERS: { id: HelpFeedbackFilter; label: string }[] = [
  { id: "down", label: "Not helpful" },
  { id: "up", label: "Helpful" },
  { id: "all", label: "All" },
];

function readFilter(value: string): HelpFeedbackFilter {
  return value === "up" || value === "all" ? value : "down";
}

function feedbackHref(filter: HelpFeedbackFilter, page = 1): string {
  const params = new URLSearchParams();
  if (filter !== "down") params.set("filter", filter);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/dashboard/help/feedback${query ? `?${query}` : ""}`;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

function languageLabel(code: string | null): string {
  if (!code || !isHelpLanguageCode(code)) return "English";
  return helpLanguage(code).name;
}

export default async function HelpFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();
  const sp = await searchParams;
  const filter = readFilter(pickParam(sp.filter));
  const page = pickPage(sp.page);

  let counts: HelpFeedbackCounts | null = null;
  let rows: HelpFeedbackRow[] = [];
  let hasMore = false;
  let failed = false;
  try {
    const [countResult, listResult] = await Promise.all([
      countHelpFeedback(),
      listHelpFeedback({ filter, page }),
    ]);
    counts = countResult;
    rows = listResult.rows;
    hasMore = listResult.hasMore;
  } catch {
    failed = true;
  }

  return (
    <div className="hc-admin">
      <div className="hca-topline">
        <div>
          <Link className="hca-back-link" href="/dashboard/help">
            <ArrowLeft size={15} aria-hidden /> Help Centre
          </Link>
          <h1>Mink AI feedback</h1>
          <p>
            Visitor ratings of Mink AI&apos;s answers on{" "}
            {HELP_URL.replace(/^https?:\/\//, "")}.
          </p>
        </div>
      </div>

      {failed ? (
        <div className="hca-feedback-error" role="alert">
          <AlertTriangle size={16} aria-hidden />
          The feedback couldn&apos;t be read just now. Reload the page to try
          again.
        </div>
      ) : (
        <>
          {counts ? (
            <dl className="hca-feedback-stats">
              <div>
                <dt>Not helpful, last 30 days</dt>
                <dd>{counts.last30Down}</dd>
              </div>
              <div>
                <dt>Helpful, last 30 days</dt>
                <dd>{counts.last30Up}</dd>
              </div>
              <div>
                <dt>All time</dt>
                <dd>
                  {counts.up} helpful · {counts.down} not helpful
                </dd>
              </div>
            </dl>
          ) : null}

          <nav className="hca-feedback-filters" aria-label="Filter feedback">
            {FILTERS.map((item) => (
              <Link
                key={item.id}
                href={feedbackHref(item.id)}
                className={item.id === filter ? "is-active" : undefined}
                aria-current={item.id === filter ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          {rows.length === 0 ? (
            <div className="hca-empty">
              {page > 1
                ? "There is nothing more to show."
                : filter === "down"
                  ? "No one has marked an answer as not helpful."
                  : filter === "up"
                    ? "No one has marked an answer as helpful yet."
                    : "No feedback yet."}
            </div>
          ) : (
            <ul className="hca-feedback-list">
              {rows.map((row) => (
                <li key={row.id}>
                  <div className="hca-feedback-meta">
                    <span
                      className={`hca-feedback-rating ${row.rating === "up" ? "up" : "down"}`}
                    >
                      {row.rating === "up" ? (
                        <ThumbsUp size={13} aria-hidden />
                      ) : (
                        <ThumbsDown size={13} aria-hidden />
                      )}
                      {row.rating === "up" ? "Helpful" : "Not helpful"}
                    </span>
                    <span>{languageLabel(row.language)}</span>
                    <span>{when(row.updatedAt)}</span>
                  </div>
                  <p className="hca-feedback-question">{row.question}</p>
                  <details>
                    <summary>Answer</summary>
                    <p className="hca-feedback-answer">{row.answer}</p>
                  </details>
                  {row.sources.length > 0 ? (
                    <div className="hca-feedback-sources">
                      <span>Guides cited:</span>
                      {row.sources.map((source) => (
                        <a
                          key={source.url}
                          href={`${HELP_URL}${source.url}`}
                          target="_blank"
                          rel="noopener"
                        >
                          {source.title}
                        </a>
                      ))}
                    </div>
                  ) : (
                    <p className="hca-feedback-none">No guides cited.</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {page > 1 || hasMore ? (
            <nav className="hca-feedback-pages" aria-label="Pages">
              {page > 1 ? (
                <Link
                  className="hca-btn ghost"
                  href={feedbackHref(filter, page - 1)}
                >
                  Newer
                </Link>
              ) : (
                <span />
              )}
              <span>Page {page}</span>
              {hasMore ? (
                <Link
                  className="hca-btn ghost"
                  href={feedbackHref(filter, page + 1)}
                >
                  Older
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
