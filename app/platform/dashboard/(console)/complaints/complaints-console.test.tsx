// @vitest-environment jsdom
// The Complaints screens' words and tables (takedown design 6.2 to 6.4): India
// time, the deadline wording, the statuses, the history lines and every
// column and empty state, word for word.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BlockListRow,
  ComplaintDetail,
  ComplaintListRow,
  HoldListRow,
  ModerationEventRow,
} from "@/lib/moderation/console-read";
import {
  BLOCK_STATE_LABEL,
  BlocksTable,
  CHANNEL_LABEL,
  COMPLAINTS_TABS,
  ComplaintsTable,
  ComplaintsTabs,
  EMPTY_TEXT,
  FORM_CHANNELS,
  FilesTable,
  HoldsTable,
  KIND_HELP,
  KIND_INFO,
  OUTCOME_LABEL,
  RepliesTable,
  blockItemHref,
  calendarDate,
  complaintStatusText,
  complaintsHref,
  deadlineText,
  durationWords,
  eventLine,
  fileStateText,
  istDate,
  istDateTime,
  istNowForInput,
  istToday,
  stageStatus,
} from "./complaints-console";

afterEach(cleanup);

// 26 Oct 2026, 14:05 in India is 08:35 UTC.
const NOW = new Date("2026-10-26T08:35:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function complaint(over: Partial<ComplaintListRow> = {}): ComplaintListRow {
  return {
    id: "c-1",
    ref: "SM-000123",
    receivedAt: "2026-10-26T06:44:00.000Z",
    channel: "email",
    kind: "court_order",
    storeId: "store-1",
    storeLabel: "Crumb & Co (crumb.storemink.com)",
    status: "not_acknowledged",
    outcome: null,
    acknowledgedAt: null,
    actionedAt: null,
    resolvedAt: null,
    nextDue: { stage: "act", dueAt: at(112 * MIN), overdue: false },
    blockCount: 0,
    erased: false,
    ...over,
  };
}

function block(over: Partial<BlockListRow> = {}): BlockListRow {
  return {
    id: "b-1",
    kind: "product",
    label: "Blue mug",
    url: "https://crumb.storemink.com/shop/blue-mug",
    storeId: "store-1",
    storeLabel: "Crumb & Co (crumb.storemink.com)",
    complaintId: "c-1",
    complaintRef: "SM-000123",
    reasonKind: "court_order",
    tellStore: true,
    blockedAt: "2026-10-26T07:01:00.000Z",
    blockedBy: "a@storemink.com",
    liftedAt: null,
    liftedBy: null,
    status: "blocked",
    fileSource: null,
    objectPath: null,
    storageState: "none",
    storageError: "",
    fileStage: null,
    archive: null,
    parentBlockId: null,
    merchantNotifiedAt: null,
    merchantSeenAt: null,
    lastMessage: null,
    erased: false,
    ...over,
  };
}

function event(over: Partial<ModerationEventRow> = {}): ModerationEventRow {
  return {
    id: "e-1",
    at: "2026-10-26T06:44:00.000Z",
    actor: "a@storemink.com",
    action: "complaint_logged",
    complaintId: "c-1",
    blockId: null,
    holdId: null,
    storeId: null,
    detail: {},
    block: null,
    ...over,
  };
}

describe("India time", () => {
  it("writes a time as design 6.2 does, with the year only when it is another", () => {
    expect(istDateTime("2026-10-26T08:35:00.000Z", NOW)).toBe("26 Oct, 14:05");
    expect(istDateTime("2026-10-27T18:44:00.000Z", NOW)).toBe("28 Oct, 00:14");
    expect(istDateTime("2025-09-02T03:30:00.000Z", NOW)).toBe(
      "2 Sep 2025, 09:00",
    );
    expect(istDateTime(null, NOW)).toBe("-");
    expect(istDateTime("not a time", NOW)).toBe("-");
  });

  it("writes dates, review dates and the form's latest time in India time", () => {
    expect(istDate("2026-10-25T20:00:00.000Z")).toBe("26 Oct 2026");
    expect(calendarDate("2027-04-24")).toBe("24 Apr 2027");
    expect(calendarDate(null)).toBe("-");
    expect(istToday(new Date("2026-10-25T19:00:00.000Z"))).toBe("2026-10-26");
    expect(istNowForInput(NOW)).toBe("2026-10-26T14:05");
  });

  it("writes a stretch of time as the design does", () => {
    expect(durationWords(25 * MIN)).toBe("25 min");
    expect(durationWords(112 * MIN)).toBe("1 h 52 min");
    expect(durationWords(2 * HOUR)).toBe("2 h");
    expect(durationWords(23 * HOUR + 20 * MIN)).toBe("23 h");
    expect(durationWords(-25 * MIN)).toBe("25 min");
    expect(durationWords(3 * 24 * HOUR)).toBe("3 days");
  });
});

describe("the Next deadline wording (design 6.2)", () => {
  it("adds how long is left within a day", () => {
    expect(
      deadlineText(
        "court_order",
        { stage: "act", dueAt: at(112 * MIN), overdue: false },
        NOW,
      ),
    ).toEqual({
      text: "Remove or block by 26 Oct, 15:57 (in 1 h 52 min)",
      overdue: false,
    });
    expect(
      deadlineText(
        "grievance",
        { stage: "acknowledge", dueAt: at(23 * HOUR), overdue: false },
        NOW,
      ).text,
    ).toBe("Acknowledge by 27 Oct, 13:05 (in 23 h)");
  });

  it("leaves it off further out, and names the kind's own stage", () => {
    expect(
      deadlineText(
        "information_order",
        { stage: "act", dueAt: at(70 * HOUR), overdue: false },
        NOW,
      ).text,
    ).toBe("Provide by 29 Oct, 12:05");
    expect(
      deadlineText(
        "data_request",
        { stage: "act", dueAt: at(5 * 24 * HOUR), overdue: false },
        NOW,
      ).text,
    ).toBe("Answer by 31 Oct, 14:05");
  });

  it("says how long it is overdue, in red", () => {
    expect(
      deadlineText(
        "court_order",
        { stage: "act", dueAt: at(-25 * MIN), overdue: true },
        NOW,
      ),
    ).toEqual({
      text: "Overdue by 25 min: remove or block by 26 Oct, 13:40",
      overdue: true,
    });
  });
});

describe("statuses and labels", () => {
  it("names each status as design 6.2 does", () => {
    expect(complaintStatusText(complaint())).toBe("Not acknowledged");
    expect(complaintStatusText(complaint({ status: "acknowledged" }))).toBe(
      "Acknowledged",
    );
    expect(
      complaintStatusText(complaint({ status: "actioned", blockCount: 2 })),
    ).toBe("Content blocked");
    expect(
      complaintStatusText(
        complaint({ status: "actioned", kind: "information_order" }),
      ),
    ).toBe("Information provided");
    expect(
      complaintStatusText(
        complaint({ status: "actioned", kind: "data_request" }),
      ),
    ).toBe("Request answered");
    expect(
      complaintStatusText(complaint({ status: "actioned", kind: "grievance" })),
    ).toBe("No removal needed");
    expect(
      complaintStatusText(
        complaint({ status: "resolved", outcome: "removed" }),
      ),
    ).toBe("Resolved: Removed");
    expect(
      complaintStatusText(
        complaint({ status: "resolved", outcome: "not_ours" }),
      ),
    ).toBe("Resolved: Not on StoreMink");
  });

  it("carries design 6.3's channels and kind lines word for word", () => {
    expect(FORM_CHANNELS.map((c) => CHANNEL_LABEL[c])).toEqual([
      "Email to support@storemink.com",
      "Letter",
      "Grievance Appellate Committee",
      "Court",
      "Government or police",
      "Other",
    ]);
    expect(FORM_CHANNELS).not.toContain("web_form");
    expect(KIND_HELP.court_order).toBe(
      "Court order: remove or block within 3 hours.",
    );
    expect(KIND_HELP.intimate_or_impersonation).toBe(
      "Intimate image or impersonation: remove or block within 2 hours, at any hour. Resolve within 36 hours.",
    );
    // What a kind covers sits behind its "i", not in the radio's name.
    expect(KIND_INFO.intimate_or_impersonation).toBe(
      "Shows someone naked, partly naked or in a sexual act, or pretends to be them, including faked or morphed images.",
    );
    expect(KIND_INFO.court_order).toBeUndefined();
    expect(KIND_HELP.data_request).toBe(
      "Personal data request: answer within 10 working days.",
    );
    expect(Object.values(OUTCOME_LABEL)).toEqual([
      "Removed",
      "Partly removed",
      "Not removed",
      "Not on StoreMink",
      "Withdrawn by them",
      "Answered",
    ]);
  });

  it("names a file's state as design 6.2 does", () => {
    expect(fileStateText({ fileStage: "copying", archive: null })).toBe(
      "Copying",
    );
    expect(fileStateText({ fileStage: "archived", archive: null })).toBe(
      "Still in storage, retrying",
    );
    expect(fileStateText({ fileStage: "copy_failed", archive: null })).toBe(
      "Copy failed, retry needed",
    );
    expect(fileStateText({ fileStage: "remove_by_hand", archive: null })).toBe(
      "Remove by hand",
    );
    expect(
      fileStateText({
        fileStage: "store_copy",
        archive: {
          filesState: "pending",
          total: 1200,
          copied: 412,
          missing: 0,
          changed: 0,
        },
      }),
    ).toBe("Store copy: 412 of 1,200 files");
    expect(
      fileStateText({
        fileStage: null,
        archive: {
          filesState: "failed",
          total: 1,
          copied: 0,
          missing: 0,
          changed: 0,
        },
      }),
    ).toBe("Copy failed, retry needed");
  });

  it("opens Block an item with the complaint chosen", () => {
    expect(blockItemHref("SM-000123")).toBe(
      "/dashboard/complaints/block?complaint=SM-000123",
    );
    expect(blockItemHref()).toBe("/dashboard/complaints/block");
  });
});

describe("the history (design 6.4)", () => {
  it("writes the design's example lines", () => {
    expect(eventLine(event())).toBe("Logged by a@storemink.com");
    expect(
      eventLine(
        event({
          action: "block_created",
          block: { kind: "product", label: "Blue mug" },
        }),
      ),
    ).toBe("Product blocked: Blue mug");
    expect(
      eventLine(
        event({
          action: "complaint_updated",
          detail: {
            fields: ["kind"],
            kind: { from: "grievance", to: "intimate_or_impersonation" },
          },
        }),
      ),
    ).toBe(
      "Kind changed from Other complaint to Intimate image or impersonation",
    );
    expect(
      eventLine(
        event({ action: "complaint_acknowledged", detail: { emailed: true } }),
      ),
    ).toBe("Acknowledgement emailed");
  });

  it("writes the other complaint events plainly", () => {
    expect(
      eventLine(
        event({ action: "complaint_acknowledged", detail: { emailed: false } }),
      ),
    ).toBe("Marked as acknowledged by a@storemink.com");
    expect(
      eventLine(
        event({
          action: "complaint_resolved",
          detail: { outcome: "removed", emailed: true },
        }),
      ),
    ).toBe("Resolved by a@storemink.com: Removed, outcome emailed");
    expect(
      eventLine(
        event({
          action: "complaint_alerted",
          actor: "system",
          detail: { stage: "act", phase: "overdue" },
        }),
      ),
    ).toBe("Operators alerted: the deadline to act has passed");
    expect(
      eventLine(
        event({
          action: "complaint_actioned",
          detail: { via: "no_removal", note: "Not on the store." },
        }),
      ),
    ).toBe("No removal needed by a@storemink.com: Not on the store.");
  });
});

describe("the deadlines card (design 6.4)", () => {
  function detail(over: Partial<ComplaintDetail> = {}): ComplaintDetail {
    return {
      ...complaint(),
      complainantName: "Asha Rao",
      complainantContact: "asha@example.com",
      actingFor: "",
      authorityRef: "",
      urls: [],
      summary: "Remove it.",
      acknowledgeDueAt: at(23 * HOUR),
      actionDueAt: at(-25 * MIN),
      resolveDueAt: at(112 * MIN),
      acknowledgedBy: null,
      acknowledgementEmailed: false,
      actionedBy: null,
      resolvedBy: null,
      outcomeNote: "",
      erasedAt: null,
      createdBy: "a@storemink.com",
      createdAt: "2026-10-26T06:44:00.000Z",
      store: null,
      ...over,
    };
  }

  it("says done, in or overdue for each deadline", () => {
    const c = detail({
      acknowledgedAt: "2026-10-26T06:50:00.000Z",
      acknowledgedBy: "a@storemink.com",
    });
    expect(stageStatus(c, "acknowledge", NOW).text).toBe(
      "Done 26 Oct, 12:20 by a@storemink.com",
    );
    expect(stageStatus(c, "act", NOW)).toEqual({
      text: "Overdue by 25 min",
      overdue: true,
    });
    expect(stageStatus(c, "resolve", NOW).text).toBe("In 1 h 52 min");
  });

  it("reads Not done for a deadline a resolved complaint never met", () => {
    const c = detail({ resolvedAt: "2026-10-26T08:00:00.000Z" });
    expect(stageStatus(c, "act", NOW).text).toBe("Not done");
  });
});

describe("the tables (design 6.2)", () => {
  function headers() {
    return screen.getAllByRole("columnheader").map((h) => h.textContent);
  }

  it("lists complaints with the design's columns, and an overdue one in red", () => {
    render(
      <ComplaintsTable
        rows={[
          complaint(),
          complaint({
            id: "c-2",
            ref: "SM-000124",
            nextDue: { stage: "act", dueAt: at(-25 * MIN), overdue: true },
          }),
        ]}
        now={NOW}
      />,
    );
    expect(headers()).toEqual([
      "Reference",
      "Received",
      "Kind",
      "Store",
      "Next deadline",
      "Status",
    ]);
    expect(screen.getByRole("link", { name: "SM-000123" })).toHaveAttribute(
      "href",
      "/dashboard/complaints/SM-000123",
    );
    const overdue = screen.getByText(
      "Overdue by 25 min: remove or block by 26 Oct, 13:40",
    );
    expect(overdue.className).toContain("--dash-red");
    expect(screen.getAllByText("Court order")).toHaveLength(2);
  });

  it("lists blocks with their states, and leaves the Complaint column off on a complaint's page", () => {
    render(<BlocksTable rows={[block()]} now={NOW} />);
    expect(headers()).toEqual([
      "Item",
      "Store",
      "Kind",
      "Blocked",
      "By",
      "Complaint",
      "State",
    ]);
    expect(screen.getByRole("link", { name: "Blue mug" })).toHaveAttribute(
      "href",
      "/dashboard/complaints/blocks/b-1",
    );
    cleanup();
    render(<BlocksTable rows={[block()]} now={NOW} showComplaint={false} />);
    expect(headers()).not.toContain("Complaint");
    expect(Object.values(BLOCK_STATE_LABEL)).toEqual([
      "Blocked",
      "Blocked, not told (order)",
      "Store suspended",
      "Lifted",
    ]);
  });

  it("lists files, holds and store replies with the design's columns", () => {
    render(
      <FilesTable
        rows={[block({ kind: "file", fileStage: "remove_by_hand" })]}
        now={NOW}
      />,
    );
    expect(headers()).toEqual(["File", "Store", "Blocked", "State"]);
    expect(screen.getByText("Remove by hand")).toBeInTheDocument();
    cleanup();

    const hold: HoldListRow = {
      id: "h-1",
      storeId: "store-1",
      storeLabel: "Crumb & Co (crumb.storemink.com)",
      reason: "Police enquiry",
      authorityRef: "",
      complaintId: null,
      complaintRef: null,
      setAt: "2026-10-20T06:00:00.000Z",
      setBy: "s@storemink.com",
      reviewOn: "2026-10-26",
      releasedAt: null,
      releasedBy: null,
      releaseNote: "",
    };
    render(<HoldsTable rows={[hold]} now={NOW} />);
    expect(headers()).toEqual([
      "Store",
      "On hold since",
      "Reason",
      "Review on",
      "Set by",
    ]);
    // A review date that has come is marked.
    expect(screen.getByText("26 Oct 2026").className).toContain(
      "--dash-amber-soft",
    );
    cleanup();

    render(
      <RepliesTable
        rows={[
          block({
            lastMessage: {
              fromSide: "store",
              author: "owner@crumb.in",
              at: "2026-10-26T07:30:00.000Z",
              asksReview: true,
            },
          }),
        ]}
        now={NOW}
      />,
    );
    expect(headers()).toEqual([
      "Item",
      "Store",
      "Last reply",
      "Asked for a review",
    ]);
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });

  it("carries every empty state of design 6.2", () => {
    expect(EMPTY_TEXT).toEqual({
      open: "No open complaints.",
      due: "Nothing is due in the next 6 hours.",
      overdue: "Nothing is overdue.",
      resolved: "No resolved complaints yet.",
      blocks: "No blocks yet.",
      files: "Every blocked file is finished.",
      holds: "No store is on hold.",
      replies: "No store is waiting for an answer.",
    });
  });
});

describe("the tabs (design 6.2)", () => {
  const counts = {
    open: 4,
    due: 2,
    overdue: 1,
    replies: 0,
    blocks: 3,
    files: 0,
    holds: 1,
    resolved: 9,
  };

  it("shows every tab with its count, work waiting in amber", () => {
    render(<ComplaintsTabs tab="due" counts={counts} store={null} />);
    const nav = screen.getByRole("navigation", { name: "Complaints" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Open4",
      "Due soon2",
      "Overdue1",
      "Store replies0",
      "Blocks3",
      "Files0",
      "Holds1",
      "Resolved9",
    ]);
    expect(COMPLAINTS_TABS.map((t) => t.label)).toEqual([
      "Open",
      "Due soon",
      "Overdue",
      "Store replies",
      "Blocks",
      "Files",
      "Holds",
      "Resolved",
    ]);
    expect(links[1]).toHaveAttribute("aria-current", "page");
    expect(links[1].className).toContain("has-alert");
    expect(links[3].className).not.toContain("has-alert");
    expect(links[0]).toHaveAttribute("href", "/dashboard/complaints");
    expect(links[1]).toHaveAttribute("href", "/dashboard/complaints?view=due");
  });

  it("leaves the counts off when they could not be read or one store is shown", () => {
    render(<ComplaintsTabs tab="open" counts={null} store={null} />);
    expect(screen.queryByText("4")).toBeNull();
    cleanup();
    render(<ComplaintsTabs tab="open" counts={counts} store="store-1" />);
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/dashboard/complaints?store=store-1",
    );
    expect(screen.queryByText("4")).toBeNull();
  });

  it("builds list addresses that keep the store and the page", () => {
    expect(complaintsHref({ view: "files", store: "s", page: 2 })).toBe(
      "/dashboard/complaints?view=files&store=s&page=2",
    );
  });
});
