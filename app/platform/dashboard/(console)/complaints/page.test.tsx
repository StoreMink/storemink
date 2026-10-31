// @vitest-environment jsdom
// The complaints list (takedown design 6.2): gated on its own, one tab's
// reader per view, the store filter, paging, and a read that fails says so
// instead of showing an empty list or zeroes.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ComplaintListRow,
  ConsoleCounts,
} from "@/lib/moderation/console-read";

const H = vi.hoisted(() => ({
  calls: [] as string[],
  operator: true,
}));

vi.mock("../require-operator", () => ({
  requireOperator: vi.fn(async () => {
    H.calls.push("requireOperator");
    if (!H.operator) throw new Error("redirect:/dashboard");
    return { email: "ops@storemink.com", role: "member" };
  }),
}));

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@/lib/moderation/console-read", () => ({
  consoleCounts: vi.fn(),
  listComplaints: vi.fn(),
  listBlocks: vi.fn(),
  listHolds: vi.fn(),
}));

import ComplaintsPage from "./page";
import {
  consoleCounts,
  listBlocks,
  listComplaints,
  listHolds,
} from "@/lib/moderation/console-read";

const STORE = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

const COUNTS: ConsoleCounts = {
  open: 4,
  due: 2,
  overdue: 1,
  replies: 0,
  blocks: 3,
  files: 0,
  holds: 1,
  resolved: 9,
};

function complaint(over: Partial<ComplaintListRow> = {}): ComplaintListRow {
  return {
    id: "c-1",
    ref: "SM-000123",
    receivedAt: "2026-10-26T06:44:00.000Z",
    channel: "email",
    kind: "grievance",
    storeId: null,
    storeLabel: "",
    status: "not_acknowledged",
    outcome: null,
    acknowledgedAt: null,
    actionedAt: null,
    resolvedAt: null,
    nextDue: {
      stage: "acknowledge",
      dueAt: "2030-01-01T00:00:00.000Z",
      overdue: false,
    },
    blockCount: 0,
    erased: false,
    ...over,
  };
}

async function renderPage(search: Record<string, string> = {}) {
  render(await ComplaintsPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  H.calls = [];
  H.operator = true;
  vi.mocked(consoleCounts).mockResolvedValue(COUNTS);
  vi.mocked(listComplaints).mockResolvedValue({ rows: [], total: 0 });
  vi.mocked(listBlocks).mockResolvedValue({ rows: [], total: 0 });
  vi.mocked(listHolds).mockResolvedValue([]);
});

afterEach(cleanup);

describe("the gate", () => {
  it("checks the operator before reading anything", async () => {
    H.operator = false;
    await expect(renderPage()).rejects.toThrow("redirect:/dashboard");
    expect(H.calls).toEqual(["requireOperator"]);
    expect(consoleCounts).not.toHaveBeenCalled();
    expect(listComplaints).not.toHaveBeenCalled();
  });
});

describe("the open complaints", () => {
  it("shows the design's header, buttons and tabs", async () => {
    vi.mocked(listComplaints).mockResolvedValue({
      rows: [complaint()],
      total: 1,
    });
    await renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "Complaints" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Every complaint, order and data request, with its deadlines. Log each one as soon as it arrives.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Log a complaint" }),
    ).toHaveAttribute("href", "/dashboard/complaints/new");
    expect(screen.getByRole("link", { name: "Block an item" })).toHaveAttribute(
      "href",
      "/dashboard/complaints/block",
    );
    const tabs = screen.getByRole("navigation", { name: "Complaints" });
    expect(within(tabs).getByRole("link", { name: "Open4" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "SM-000123" })).toBeInTheDocument();
    expect(listComplaints).toHaveBeenCalledWith({
      view: "open",
      storeId: null,
      limit: 50,
      offset: 0,
      now: expect.any(Date),
    });
  });

  it("says when there are none", async () => {
    await renderPage();
    expect(screen.getByText("No open complaints.")).toBeInTheDocument();
  });

  it("ignores an unknown view", async () => {
    await renderPage({ view: "everything" });
    expect(listComplaints).toHaveBeenCalledWith(
      expect.objectContaining({ view: "open" }),
    );
  });
});

describe("each tab reads its own list", () => {
  it("reads due, overdue and resolved complaints", async () => {
    for (const view of ["due", "overdue", "resolved"] as const) {
      await renderPage({ view });
      expect(listComplaints).toHaveBeenLastCalledWith(
        expect.objectContaining({ view }),
      );
      cleanup();
    }
    await renderPage({ view: "due" });
    expect(
      screen.getByText("Nothing is due in the next 6 hours."),
    ).toBeInTheDocument();
  });

  it("reads every block on the Blocks tab, and the files and replies on theirs", async () => {
    await renderPage({ view: "blocks" });
    expect(listBlocks).toHaveBeenLastCalledWith({
      view: "all",
      storeId: null,
      limit: 50,
      offset: 0,
    });
    expect(screen.getByText("No blocks yet.")).toBeInTheDocument();
    cleanup();
    await renderPage({ view: "files" });
    expect(listBlocks).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "files" }),
    );
    expect(
      screen.getByText("Every blocked file is finished."),
    ).toBeInTheDocument();
    cleanup();
    await renderPage({ view: "replies" });
    expect(listBlocks).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "replies" }),
    );
    expect(
      screen.getByText("No store is waiting for an answer."),
    ).toBeInTheDocument();
  });

  it("reads the active holds on the Holds tab", async () => {
    await renderPage({ view: "holds" });
    expect(listHolds).toHaveBeenCalledWith({
      view: "active",
      storeId: null,
      limit: 200,
      now: expect.any(Date),
    });
    expect(screen.getByText("No store is on hold.")).toBeInTheDocument();
  });
});

describe("a read that fails", () => {
  it("says the counts could not be read and still shows the list", async () => {
    vi.mocked(consoleCounts).mockRejectedValue(new Error("db down"));
    vi.mocked(listComplaints).mockResolvedValue({
      rows: [complaint()],
      total: 1,
    });
    await renderPage();
    expect(
      screen.getByText(
        "The counts could not be read just now. Refresh the page to try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "SM-000123" })).toBeInTheDocument();
  });

  it("says the list could not be read, never that it is empty", async () => {
    vi.mocked(listComplaints).mockRejectedValue(new Error("db down"));
    await renderPage();
    expect(
      screen.getByText(
        "This list could not be read just now. Refresh the page to try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("No open complaints.")).toBeNull();
  });
});

describe("one store's list", () => {
  it("narrows every read to the store and says so", async () => {
    await renderPage({ store: STORE, view: "holds" });
    expect(listHolds).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: STORE }),
    );
    expect(
      screen.getByText(
        "Only one store's complaints, blocks and holds are shown.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Show every store" }),
    ).toHaveAttribute("href", "/dashboard/complaints?view=holds");
    // The counts are every store's, so they are left off.
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/dashboard/complaints?store=${STORE}`,
    );
  });

  it("ignores a store that is not an id", async () => {
    await renderPage({ store: "crumb" });
    expect(listComplaints).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: null }),
    );
    expect(screen.queryByText("Show every store")).toBeNull();
  });
});

describe("paging", () => {
  it("reads the page asked for and links its neighbours", async () => {
    vi.mocked(listComplaints).mockResolvedValue({
      rows: [complaint()],
      total: 120,
    });
    await renderPage({ view: "resolved", page: "2" });
    expect(listComplaints).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 50, limit: 50 }),
    );
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute(
      "href",
      "/dashboard/complaints?view=resolved",
    );
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "/dashboard/complaints?view=resolved&page=3",
    );
  });

  it("shows no paging for one page", async () => {
    vi.mocked(listComplaints).mockResolvedValue({
      rows: [complaint()],
      total: 1,
    });
    await renderPage({ page: "junk" });
    expect(listComplaints).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0 }),
    );
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
  });
});
