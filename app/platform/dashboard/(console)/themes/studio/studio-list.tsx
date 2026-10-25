import Link from "next/link";
import { ExternalLink, Plus } from "lucide-react";
import type {
  ThemeStudioList,
  ThemeStudioListFilter,
  ThemeStudioListRow,
} from "@/lib/theme-studio/progress";
import { subdomainOrigin } from "@/lib/store/host";
import { STUDIO_PAGE_PARAMS } from "./[projectId]/tab-types";
import {
  studioStatus,
  type StudioAction,
  type StudioStatus,
} from "./studio-status";
import { plainText, StudioBadge } from "./studio-ui";
import { durationWords } from "./studio-words";

// ---------------------------------------------------------------------------
// The Theme Studio list (wave TS-2, builder 2D; plan section 4, "Themes,
// Theme Studio tab", and contract section 8.3). A server component: the page
// reads the list behind its superadmin gate and hands it here.
//
// ★ ONE STATUS FUNCTION. Every row's words, tone and main button come from
// studio-status.ts `studioStatus`, the function the theme page's header and
// Design list use, so the list never says something the theme page does not.
//
// ★ THE MAIN BUTTON NEVER ACTS BY ITSELF. "Open live demo" opens the demo
// store; "Start a new theme from this brief" opens New theme with this
// theme's id (`?from=`); every other kind opens the theme page with that
// action in the address (`?do=`), where the control that owns it opens its
// dialog or confirm. A row with no main button opens the theme page.
//
// ★ WHAT THE LIST NEVER SHOWS: the model, the creator, codes and builds
// (the theme's Log tab has them), and the words candidate, approved and
// blocked, which are the code's names, not the operator's.
// ---------------------------------------------------------------------------

/** The filter chips, in display order. Every theme is in All and in exactly
 * one other (studio-status.ts studioListFilter). "Ready" means Ready to
 * publish. */
export const STUDIO_LIST_FILTERS: readonly {
  key: ThemeStudioListFilter;
  label: string;
}[] = [
  { key: "all", label: "All" },
  { key: "needs_you", label: "Needs you" },
  { key: "building", label: "Building" },
  { key: "ready", label: "Ready" },
  { key: "live", label: "Live" },
  { key: "archived", label: "Archived" },
];

/** The list's own address for a filter. */
export function listHref(filter: ThemeStudioListFilter): string {
  return filter === "all"
    ? "/dashboard/themes/studio"
    : `/dashboard/themes/studio?filter=${filter}`;
}

/** `?filter=` as a filter; anything else (absent, repeated, unknown) is All. */
export function parseListFilter(
  value: string | string[] | undefined,
): ThemeStudioListFilter {
  return STUDIO_LIST_FILTERS.find((f) => f.key === value)?.key ?? "all";
}

/** The theme page's address. */
export function themePageHref(projectId: string): string {
  return `/dashboard/themes/studio/${encodeURIComponent(projectId)}`;
}

/** Where a row's main button goes (contract section 8.3), or null when the
 * row has none. */
export function rowActionTarget(
  row: Pick<ThemeStudioListRow, "projectId" | "themeId">,
  action: StudioAction | null,
): { href: string; label: string; external: boolean } | null {
  if (!action) return null;
  if (action.kind === "open_live_demo") {
    return {
      href: subdomainOrigin(`demo-${row.themeId}`),
      label: action.label,
      external: true,
    };
  }
  if (action.kind === "start_new_from_brief") {
    return {
      href: `/dashboard/themes/studio/new?from=${encodeURIComponent(row.projectId)}`,
      label: action.label,
      external: false,
    };
  }
  return {
    href: `${themePageHref(row.projectId)}?${STUDIO_PAGE_PARAMS.intent}=${action.kind}`,
    label: action.label,
    external: false,
  };
}

const MINUTE = 60_000;

function at(iso: string | null | undefined): number {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : NaN;
}

/** "Just now", "12 min ago", "3 h ago", "2 days ago", then the date in India
 * time ("1 Oct", or "1 Oct 2025" in another year), measured against the
 * server's read time so the server and the browser never disagree. */
export function agoWords(iso: string, now: string): string {
  const then = at(iso);
  const current = at(now);
  if (!Number.isFinite(then) || !Number.isFinite(current)) return "";
  const minutes = Math.floor(Math.max(0, current - then) / MINUTE);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const year = (time: number) =>
    new Date(time).toLocaleDateString("en-GB", {
      year: "numeric",
      timeZone: "Asia/Kolkata",
    });
  return new Date(then).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(year(then) === year(current) ? {} : { year: "numeric" }),
    timeZone: "Asia/Kolkata",
  });
}

/** The row's time: how long the work has run while it works ("34 min so
 * far"), otherwise when the theme last changed. */
export function rowTimeWords(row: ThemeStudioListRow): string {
  const working = row.status.working;
  if (working) {
    const elapsed = at(row.status.now) - at(working.since);
    if (Number.isFinite(elapsed)) {
      return `${durationWords(Math.max(0, elapsed))} so far`;
    }
  }
  return agoWords(row.updatedAt, row.status.now);
}

/** The row's second line: the step working now ("Drawing pictures, 8 of
 * 18") or, while it waits for an answer, how many questions it asked. */
export function rowSecondLine(
  row: ThemeStudioListRow,
  status: Pick<StudioStatus, "row">,
): string | null {
  if (row.status.working && row.activeStep) {
    const { label, detail } = row.activeStep;
    return plainText(detail ? `${label}, ${detail}` : label);
  }
  if (status.row === 7) {
    const count = row.status.questions.count;
    if (count > 0) {
      return `${count} ${count === 1 ? "question" : "questions"} for you`;
    }
  }
  return null;
}

const EMPTY_WORDS: Record<ThemeStudioListFilter, string> = {
  all: "No themes yet.",
  needs_you: "Nothing needs you right now.",
  building: "Nothing is building right now.",
  ready: "No theme is ready to publish.",
  live: "No Studio theme is live yet.",
  archived: "No theme was removed from the list.",
};

export function StudioFilters({
  filter,
  counts,
}: {
  filter: ThemeStudioListFilter;
  counts: ThemeStudioList["counts"];
}) {
  return (
    <nav
      aria-label="Show themes"
      className="dash-filter-tabs w-fit max-w-full flex-wrap"
    >
      {STUDIO_LIST_FILTERS.map(({ key, label }) => {
        const on = key === filter;
        return (
          <Link
            key={key}
            href={listHref(key)}
            aria-current={on ? "page" : undefined}
            className={`dash-filter-tab pointer-coarse:min-h-11 ${on ? "active" : ""}`}
          >
            {label}
            <span className="dash-tab-count">{counts[key] ?? 0}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function RowPicture({ url }: { url: string | null }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element -- the private catalogue card route
    <img
      src={url}
      alt=""
      width={64}
      height={48}
      loading="lazy"
      decoding="async"
      className="h-12 w-16 shrink-0 rounded-[var(--dash-radius-xs)] border border-[var(--dash-border)] bg-[var(--dash-surface-2)] object-cover object-top"
    />
  ) : (
    <span
      aria-hidden
      data-picture="none"
      className="h-12 w-16 shrink-0 rounded-[var(--dash-radius-xs)] border border-dashed border-[var(--dash-border-strong)] bg-[var(--dash-surface-2)]"
    />
  );
}

function ListRow({ row }: { row: ThemeStudioListRow }) {
  const status = studioStatus(row.status);
  const action = rowActionTarget(row, status.primary);
  const second = rowSecondLine(row, status);
  const when = rowTimeWords(row);
  return (
    <li
      data-project={row.projectId}
      className="relative flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition hover:bg-[var(--dash-surface-2)] sm:px-5"
    >
      <RowPicture url={row.pictureUrl} />
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* The name opens the theme; its box covers the whole row, so a
              tap anywhere on the row does too (the main button sits above). */}
          <Link
            href={themePageHref(row.projectId)}
            prefetch={false}
            className="min-w-0 break-words text-sm font-semibold text-[var(--dash-text)] after:absolute after:inset-0 after:content-['']"
          >
            {row.name}
          </Link>
          <StudioBadge status={status} />
          {when ? <span className="studio-muted text-sm">{when}</span> : null}
        </div>
        {second ? <p className="studio-muted mt-1 text-sm">{second}</p> : null}
      </div>
      {action ? (
        <div className="relative z-10 ml-auto shrink-0">
          {action.external ? (
            <a
              href={action.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${action.label}: ${row.name} (opens in a new tab)`}
              className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
            >
              {action.label}
              <ExternalLink aria-hidden className="h-3.5 w-3.5" />
            </a>
          ) : (
            <Link
              href={action.href}
              prefetch={false}
              aria-label={`${action.label}: ${row.name}`}
              className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
            >
              {action.label}
            </Link>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** The Theme Studio tab's body: the filters and the rows of one filter. */
export function StudioList({
  list,
  filter,
}: {
  list: ThemeStudioList;
  filter: ThemeStudioListFilter;
}) {
  if (list.counts.all === 0) {
    return (
      <div className="dash-card">
        <div className="dash-empty">
          <h2 className="dash-empty-title">No themes yet</h2>
          <p className="studio-muted mb-4 mt-1.5 max-w-md text-sm">
            Describe a store and Theme Studio designs a theme for it, draws its
            pictures and checks every page.
          </p>
          <Link
            href="/dashboard/themes/studio/new"
            className="dash-btn dash-btn-primary pointer-coarse:min-h-11"
          >
            <Plus aria-hidden className="h-4 w-4" /> New theme
          </Link>
        </div>
      </div>
    );
  }
  const shown = list.rows.length;
  const total = list.counts[filter] ?? shown;
  return (
    <div className="space-y-4">
      <StudioFilters filter={filter} counts={list.counts} />
      {shown === 0 ? (
        <div className="dash-card">
          <p className="studio-muted px-5 py-10 text-center text-sm">
            {EMPTY_WORDS[filter]}
          </p>
        </div>
      ) : (
        <div className="dash-card">
          <ul
            aria-label="Themes"
            className="divide-y divide-[var(--dash-border)]"
          >
            {list.rows.map((row) => (
              <ListRow key={row.projectId} row={row} />
            ))}
          </ul>
        </div>
      )}
      {/* The list read returns the most recently changed rows only (100). */}
      {total > shown ? (
        <p className="studio-muted text-sm">
          Showing the {shown} most recently changed of {total}.
        </p>
      ) : null}
    </div>
  );
}
