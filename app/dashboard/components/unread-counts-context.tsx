"use client";

// The bell's unread counts, shared with the sidebar (takedown design 5.7 and
// 7.1, plan A14).
//
// ★ THE BELL IS THE ONLY READER. It already polls `getUnreadNotificationCount`
// (every 45 s while the tab is visible), and that one query now also answers
// how many unread notices from StoreMink there are. The bell REPORTS both
// numbers here and the sidebar READS the StoreMink one for the badge on
// Settings, Notices from StoreMink, so the dashboard layout gains no query:
// it only wraps its chrome in the provider.
//
// ★ WITHOUT A PROVIDER EVERYTHING IS ZERO. The operator console renders the
// same topbar (and so the same bell) with no provider: reporting is then a
// no-op and nothing reads a badge, which is right, since the console has no
// Notices page.

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type { UnreadCounts } from "@/app/actions/notification-inbox-actions";

export type { UnreadCounts };

/** Nothing unread: the value before the first poll, and after a failed one. */
export const NO_UNREAD: UnreadCounts = Object.freeze({
  total: 0,
  storemink: 0,
});

/** The Settings child the StoreMink badge sits on (permissions.ts). */
export const STORE_NOTICES_HREF = "/dashboard/settings/notices";

function whole(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Counts as the screen may show them: whole numbers of zero or more, and the
 * StoreMink count never above the total (it is a subset of the same rows).
 */
export function normalizeUnreadCounts(value: unknown): UnreadCounts {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const total = whole(raw.total);
  return { total, storemink: Math.min(total, whole(raw.storemink)) };
}

/** A badge's text: nothing at zero, "99+" past 99 (the bell's own cap). */
export function unreadBadge(count: number): string | undefined {
  const n = whole(count);
  if (n === 0) return undefined;
  return n > 99 ? "99+" : String(n);
}

const CountsContext = createContext<UnreadCounts>(NO_UNREAD);
const ReportContext = createContext<(counts: UnreadCounts) => void>(() => {});

/**
 * Wraps the merchant dashboard's chrome (topbar and sidebar) so the bell can
 * hand its counts to the sidebar. Two contexts, so the bell that reports does
 * not re-render on its own report.
 */
export function UnreadCountsProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<UnreadCounts>(NO_UNREAD);

  const report = useCallback((next: UnreadCounts) => {
    const clean = normalizeUnreadCounts(next);
    // The same numbers again (every quiet poll) keep the old object, so the
    // sidebar does not re-render for nothing.
    setCounts((prev) =>
      prev.total === clean.total && prev.storemink === clean.storemink
        ? prev
        : clean,
    );
  }, []);

  return (
    <ReportContext.Provider value={report}>
      <CountsContext.Provider value={counts}>{children}</CountsContext.Provider>
    </ReportContext.Provider>
  );
}

/** The latest counts the bell reported (zero without a provider). */
export function useUnreadCounts(): UnreadCounts {
  return useContext(CountsContext);
}

/** How the bell hands its counts over (a no-op without a provider). */
export function useReportUnreadCounts(): (counts: UnreadCounts) => void {
  return useContext(ReportContext);
}
