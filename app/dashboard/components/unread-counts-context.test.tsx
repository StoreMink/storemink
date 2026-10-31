// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import type { UnreadCounts } from "@/app/actions/notification-inbox-actions";
import {
  NO_UNREAD,
  UnreadCountsProvider,
  normalizeUnreadCounts,
  unreadBadge,
  useReportUnreadCounts,
  useUnreadCounts,
} from "./unread-counts-context";

function Probe() {
  const { total, storemink } = useUnreadCounts();
  return <output data-testid="counts">{`${total}/${storemink}`}</output>;
}

let reportOut: ((counts: UnreadCounts) => void) | null = null;
function Reporter() {
  const report = useReportUnreadCounts();
  useEffect(() => {
    reportOut = report;
  }, [report]);
  return null;
}

describe("normalizeUnreadCounts", () => {
  it("keeps whole numbers and never lets the StoreMink count pass the total", () => {
    expect(normalizeUnreadCounts({ total: 5, storemink: 2 })).toEqual({
      total: 5,
      storemink: 2,
    });
    expect(normalizeUnreadCounts({ total: 1, storemink: 3 })).toEqual({
      total: 1,
      storemink: 1,
    });
    expect(normalizeUnreadCounts({ total: "4", storemink: "1.9" })).toEqual({
      total: 4,
      storemink: 1,
    });
  });

  it("reads anything unreadable as nothing unread", () => {
    expect(normalizeUnreadCounts(null)).toEqual(NO_UNREAD);
    expect(normalizeUnreadCounts(7)).toEqual(NO_UNREAD);
    expect(normalizeUnreadCounts({ total: -2, storemink: NaN })).toEqual(
      NO_UNREAD,
    );
    expect(
      normalizeUnreadCounts({ total: Infinity, storemink: undefined }),
    ).toEqual(NO_UNREAD);
  });
});

describe("unreadBadge", () => {
  it("shows nothing at zero and caps like the bell", () => {
    expect(unreadBadge(0)).toBeUndefined();
    expect(unreadBadge(-1)).toBeUndefined();
    expect(unreadBadge(1)).toBe("1");
    expect(unreadBadge(99)).toBe("99");
    expect(unreadBadge(100)).toBe("99+");
  });
});

describe("UnreadCountsProvider", () => {
  it("is zero, and reporting does nothing, without a provider (the console)", () => {
    reportOut = null;
    render(
      <>
        <Reporter />
        <Probe />
      </>,
    );
    expect(screen.getByTestId("counts")).toHaveTextContent("0/0");
    expect(() => reportOut?.({ total: 3, storemink: 1 })).not.toThrow();
    expect(screen.getByTestId("counts")).toHaveTextContent("0/0");
  });

  it("carries what the bell reports to every reader, cleaned", () => {
    reportOut = null;
    render(
      <UnreadCountsProvider>
        <Reporter />
        <Probe />
      </UnreadCountsProvider>,
    );
    expect(screen.getByTestId("counts")).toHaveTextContent("0/0");

    act(() => reportOut?.({ total: 6, storemink: 2 }));
    expect(screen.getByTestId("counts")).toHaveTextContent("6/2");

    act(() => reportOut?.({ total: 1, storemink: 4 }));
    expect(screen.getByTestId("counts")).toHaveTextContent("1/1");

    act(() => reportOut?.(NO_UNREAD));
    expect(screen.getByTestId("counts")).toHaveTextContent("0/0");
  });
});
