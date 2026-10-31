import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";
import { grievanceComplaints, moderationEvents } from "@/drizzle/schema";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import {
  COMPLAINT_ERRORS,
  acknowledgeComplaint,
  actionComplaintForBlock,
  actionVia,
  alertsAfterChange,
  deadlinesAfterChange,
  eraseResolvedComplaints,
  isEmailContact,
  logComplaint,
  markActioned,
  reopenComplaint,
  resolveComplaint,
  storeLabelFor,
  updateComplaint,
  validateComplaintInput,
  type ComplaintRow,
} from "./complaints";
import { computeDeadlines } from "./deadlines";

const OPS = { email: "ops@storemink.com", role: "member" as const };
const STORE = "a0000000-0000-4000-8000-000000000001";
const ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const BLOCK = "0e7e2a3c-1b2c-4d5e-8f90-123456789abc";
const NOW = new Date("2026-10-30T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function useDb(mock: ReturnType<typeof makeDbMock>) {
  vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
  return mock;
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

/** A logged complaint, received `receivedAgoH` hours before NOW, with its kind's deadlines. */
function row(
  overrides: Partial<ComplaintRow> & { receivedAgoH?: number } = {},
): ComplaintRow {
  const { receivedAgoH = 1, ...rest } = overrides;
  const received = new Date(NOW.getTime() - receivedAgoH * HOUR);
  const kind = (rest.kind ?? "grievance") as Parameters<
    typeof computeDeadlines
  >[0];
  const deadlines = computeDeadlines(kind, received);
  return {
    id: ID,
    refNo: 123,
    receivedAt: received.toISOString(),
    channel: "email",
    kind,
    complainantName: "Asha Rao",
    complainantContact: "asha@example.com",
    actingFor: "",
    authorityRef: "",
    storeId: STORE,
    storeLabel: "Crumb & Co (crumb.storemink.com)",
    urls: ["https://crumb.storemink.com/shop/blue-mug"],
    summary: "Remove the photo of me.",
    acknowledgeDueAt: deadlines.acknowledgeDueAt.toISOString(),
    actionDueAt: deadlines.actionDueAt.toISOString(),
    resolveDueAt: deadlines.resolveDueAt.toISOString(),
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgementEmailed: false,
    actionedAt: null,
    actionedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    outcome: null,
    outcomeNote: "",
    alerts: {},
    alertClaimedAt: null,
    erasedAt: null,
    createdBy: OPS.email,
    createdAt: received.toISOString(),
    updatedAt: received.toISOString(),
    ...rest,
  } as ComplaintRow;
}

function eventValues(mock: ReturnType<typeof makeDbMock>) {
  const index = mock.calls.insert.indexOf(moderationEvents);
  return index >= 0 ? mock.calls.values[index] : undefined;
}

const VALID = {
  receivedAt: "2026-10-30T09:30:00.000Z",
  channel: "email",
  kind: "intimate_or_impersonation",
  complainantName: " Asha Rao ",
  complainantContact: "asha@example.com",
  summary: "  Remove the photo of me.  ",
  urls: "https://crumb.storemink.com/shop/blue-mug\n\n https://crumb.storemink.com/shop/blue-mug \nhttps://crumb.storemink.com/blogs/me",
};

beforeEach(() => {
  useDb(makeDbMock());
});

// ── Validation ──────────────────────────────────────────────────────────────

describe("validateComplaintInput", () => {
  it("cleans a valid complaint", () => {
    const result = validateComplaintInput(VALID, NOW);
    expect(result).toEqual({
      ok: true,
      value: {
        receivedAt: new Date("2026-10-30T09:30:00.000Z"),
        channel: "email",
        kind: "intimate_or_impersonation",
        complainantName: "Asha Rao",
        complainantContact: "asha@example.com",
        actingFor: "",
        authorityRef: "",
        storeId: null,
        urls: [
          "https://crumb.storemink.com/shop/blue-mug",
          "https://crumb.storemink.com/blogs/me",
        ],
        summary: "Remove the photo of me.",
      },
    });
  });

  it.each([
    [{ receivedAt: "" }, COMPLAINT_ERRORS.receivedMissing, "receivedAt"],
    [
      { receivedAt: "yesterday-ish" },
      COMPLAINT_ERRORS.receivedMissing,
      "receivedAt",
    ],
    [
      { receivedAt: "2026-10-30T10:06:00.000Z" },
      COMPLAINT_ERRORS.receivedFuture,
      "receivedAt",
    ],
    [
      { receivedAt: "2025-10-30T10:00:00.000Z" },
      COMPLAINT_ERRORS.receivedTooOld,
      "receivedAt",
    ],
    [{ channel: "fax" }, COMPLAINT_ERRORS.channel, "channel"],
    [{ kind: "spam" }, COMPLAINT_ERRORS.kind, "kind"],
    [
      { complainantName: "x".repeat(201) },
      COMPLAINT_ERRORS.nameLong,
      "complainantName",
    ],
    [
      { complainantContact: "x".repeat(321) },
      COMPLAINT_ERRORS.contactLong,
      "complainantContact",
    ],
    [
      { actingFor: "x".repeat(201) },
      COMPLAINT_ERRORS.actingForLong,
      "actingFor",
    ],
    [
      { authorityRef: "x".repeat(501) },
      COMPLAINT_ERRORS.authorityRefLong,
      "authorityRef",
    ],
    [{ storeId: "crumb" }, COMPLAINT_ERRORS.storeNotFound, "storeId"],
    [
      { urls: Array.from({ length: 51 }, (_, i) => `https://a.example/${i}`) },
      COMPLAINT_ERRORS.urlsTooMany,
      "urls",
    ],
    [
      { urls: [`https://a.example/${"x".repeat(2000)}`] },
      COMPLAINT_ERRORS.urlTooLong,
      "urls",
    ],
    [{ summary: "   " }, COMPLAINT_ERRORS.summaryMissing, "summary"],
    [{ summary: "x".repeat(4001) }, COMPLAINT_ERRORS.summaryLong, "summary"],
  ])("refuses %j", (patch, error, field) => {
    expect(validateComplaintInput({ ...VALID, ...patch }, NOW)).toEqual({
      ok: false,
      error,
      field,
    });
  });

  it("accepts a received time a few minutes ahead of the clock", () => {
    const result = validateComplaintInput(
      { ...VALID, receivedAt: "2026-10-30T10:04:00.000Z" },
      NOW,
    );
    expect(result.ok).toBe(true);
  });
});

describe("helpers", () => {
  it("labels a store by its name and address", () => {
    expect(storeLabelFor({ name: "Crumb & Co", slug: "crumb" })).toBe(
      "Crumb & Co (crumb.storemink.com)",
    );
    expect(storeLabelFor({ name: "x".repeat(400), slug: "s" })).toHaveLength(
      300,
    );
  });

  it("knows an email contact", () => {
    expect(isEmailContact(" asha@example.com ")).toBe(true);
    expect(isEmailContact("+91 98765 43210")).toBe(false);
    expect(isEmailContact("")).toBe(false);
  });

  it("names how a complaint was met without a block", () => {
    expect(actionVia("information_order")).toBe("information_provided");
    expect(actionVia("data_request")).toBe("answered");
    expect(actionVia("other_removal")).toBe("no_removal");
  });
});

// ── Log ─────────────────────────────────────────────────────────────────────

describe("logComplaint", () => {
  it("stores the kind's deadlines from the time it reached us, and records it", async () => {
    const stored = row({ kind: "intimate_or_impersonation" });
    const mock = useDb(
      makeDbMock({
        selectQueue: [[{ name: "Crumb & Co", slug: "crumb" }]],
        returningQueue: [[stored], [{ id: "event-1" }]],
      }),
    );
    const result = await logComplaint({ ...VALID, storeId: STORE }, OPS, {
      now: NOW,
    });
    expect(result).toEqual({ ok: true, complaint: stored, urgent: true });
    expect(mock.calls.insert[0]).toBe(grievanceComplaints);
    const received = new Date("2026-10-30T09:30:00.000Z").getTime();
    expect(mock.calls.values[0]).toMatchObject({
      receivedAt: iso(received),
      kind: "intimate_or_impersonation",
      complainantName: "Asha Rao",
      storeId: STORE,
      storeLabel: "Crumb & Co (crumb.storemink.com)",
      summary: "Remove the photo of me.",
      acknowledgeDueAt: iso(received + 24 * HOUR),
      actionDueAt: iso(received + 2 * HOUR),
      resolveDueAt: iso(received + 36 * HOUR),
      createdBy: OPS.email,
    });
    expect(eventValues(mock)).toMatchObject({
      actor: OPS.email,
      action: "complaint_logged",
      complaintId: ID,
      storeId: STORE,
      detail: { kind: "intimate_or_impersonation", channel: "email" },
    });
  });

  it("answers urgent only for the kinds every operator hears about at once", async () => {
    useDb(makeDbMock({ returningQueue: [[row()], [{ id: "event-1" }]] }));
    const result = await logComplaint({ ...VALID, kind: "grievance" }, OPS, {
      now: NOW,
    });
    expect(result).toMatchObject({ ok: true, urgent: false });
  });

  it("refuses a store that does not exist, writing nothing", async () => {
    const mock = useDb(makeDbMock({ selectQueue: [[]] }));
    const result = await logComplaint({ ...VALID, storeId: STORE }, OPS, {
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.storeNotFound,
      field: "storeId",
    });
    expect(mock.calls.insert).toHaveLength(0);
  });

  it("reads the received-time CHECK as the form's sentence", async () => {
    const mock = makeDbMock();
    mock.db.insert = vi.fn(() => ({
      values: () => ({
        returning: () =>
          Promise.reject(
            Object.assign(new Error("Failed query"), {
              cause: {
                code: "23514",
                constraint: "grievance_complaints_received_check",
              },
            }),
          ),
      }),
    }));
    useDb(mock);
    const result = await logComplaint(VALID, OPS, { now: NOW });
    expect(result).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.receivedTooOld,
      field: "receivedAt",
    });
  });

  it("says it could not log on any other failure, and logs it", async () => {
    const mock = makeDbMock({ failInsertFor: [grievanceComplaints] });
    useDb(mock);
    const result = await logComplaint(VALID, OPS, { now: NOW });
    expect(result).toEqual({ ok: false, error: COMPLAINT_ERRORS.logFailed });
    expect(logError).toHaveBeenCalled();
  });

  it("checks before touching the database", async () => {
    const result = await logComplaint({ ...VALID, kind: "spam" }, OPS, {
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, error: COMPLAINT_ERRORS.kind });
    expect(withService).not.toHaveBeenCalled();
  });
});

// ── Deadlines after a change ────────────────────────────────────────────────

describe("deadlinesAfterChange", () => {
  const received = "2026-10-30T09:00:00.000Z";
  const at = (h: number) => new Date(new Date(received).getTime() + h * HOUR);

  it("applies a stricter kind's deadlines", () => {
    const next = deadlinesAfterChange({
      stored: computeDeadlines("grievance", received),
      storedReceivedAt: received,
      kind: "court_order",
      receivedAt: received,
    });
    expect(next).toEqual({
      acknowledgeDueAt: at(24),
      actionDueAt: at(3),
      resolveDueAt: at(3),
    });
  });

  it("never moves a deadline later for a looser kind", () => {
    const stored = computeDeadlines("intimate_or_impersonation", received);
    const next = deadlinesAfterChange({
      stored,
      storedReceivedAt: received,
      kind: "grievance",
      receivedAt: received,
    });
    expect(next).toEqual(stored);
  });

  it("moves every deadline with a corrected received time, keeping a tightening", () => {
    // Logged as Other complaint, tightened to Intimate image, put back to
    // Other complaint (act stays at +2h), then the received time corrected
    // one hour earlier: everything moves an hour earlier.
    const tightened = {
      acknowledgeDueAt: at(24),
      actionDueAt: at(2),
      resolveDueAt: at(36),
    };
    const next = deadlinesAfterChange({
      stored: tightened,
      storedReceivedAt: received,
      kind: "grievance",
      receivedAt: at(-1),
    });
    expect(next).toEqual({
      acknowledgeDueAt: at(23),
      actionDueAt: at(1),
      resolveDueAt: at(35),
    });
  });
});

describe("alertsAfterChange", () => {
  it("lets a moved deadline alert again, keeping an overdue alert that still holds", () => {
    const alerts = {
      act_soon: "2026-10-30T08:00:00Z",
      act_overdue: "2026-10-30T09:00:00Z",
      resolve_soon: "x",
      resolve_overdue: "y",
      acknowledge_soon: "z",
    };
    const next = alertsAfterChange(
      alerts,
      [
        { stage: "act", dueAt: new Date(NOW.getTime() - HOUR) },
        { stage: "resolve", dueAt: new Date(NOW.getTime() + HOUR) },
      ],
      NOW,
    );
    expect(next).toEqual({
      act_overdue: alerts.act_overdue,
      acknowledge_soon: "z",
    });
    expect(alerts).toHaveProperty("act_soon");
  });

  it("starts from an empty object when the stored value is not one", () => {
    expect(alertsAfterChange(null, [], NOW)).toEqual({});
    expect(alertsAfterChange([], [], NOW)).toEqual({});
  });
});

// ── Update ──────────────────────────────────────────────────────────────────

describe("updateComplaint", () => {
  it("tightens the deadlines when the kind becomes stricter, even after acknowledgement", async () => {
    const stored = row({
      kind: "grievance",
      acknowledgedAt: "2026-10-30 09:20:00+00",
      acknowledgedBy: OPS.email,
      alerts: { act_soon: "2026-10-30T09:30:00Z" },
    });
    const updated = { ...stored, kind: "intimate_or_impersonation" };
    const mock = useDb(
      makeDbMock({
        selectQueue: [[stored]],
        returningQueue: [[updated], [{ id: "event-1" }]],
      }),
    );
    const result = await updateComplaint(
      ID,
      { kind: "intimate_or_impersonation" },
      OPS,
      { now: NOW },
    );
    const received = new Date(stored.receivedAt).getTime();
    expect(result).toEqual({
      ok: true,
      complaint: updated,
      changed: ["kind", "deadlines"],
      passed: [],
    });
    expect(mock.calls.forUpdate).toEqual(["update"]);
    expect(mock.calls.set[0]).toMatchObject({
      kind: "intimate_or_impersonation",
      acknowledgeDueAt: stored.acknowledgeDueAt,
      actionDueAt: iso(received + 2 * HOUR),
      resolveDueAt: iso(received + 36 * HOUR),
      alerts: {},
    });
    expect(eventValues(mock)).toMatchObject({
      action: "complaint_updated",
      complaintId: ID,
      detail: {
        fields: ["kind", "deadlines"],
        kind: { from: "grievance", to: "intimate_or_impersonation" },
        deadlines: {
          from: {
            acknowledgeDueAt: stored.acknowledgeDueAt,
            actionDueAt: stored.actionDueAt,
            resolveDueAt: stored.resolveDueAt,
          },
          to: {
            acknowledgeDueAt: stored.acknowledgeDueAt,
            actionDueAt: iso(received + 2 * HOUR),
            resolveDueAt: iso(received + 36 * HOUR),
          },
        },
      },
    });
  });

  it("keeps the earlier deadline when the kind becomes looser", async () => {
    const stored = row({ kind: "intimate_or_impersonation" });
    const updated = { ...stored, kind: "grievance" };
    const mock = useDb(
      makeDbMock({
        selectQueue: [[stored]],
        returningQueue: [[updated], [{ id: "event-1" }]],
      }),
    );
    const result = await updateComplaint(ID, { kind: "grievance" }, OPS, {
      now: NOW,
    });
    expect(result).toMatchObject({ ok: true, changed: ["kind"], passed: [] });
    const set = mock.calls.set[0];
    expect(set.kind).toBe("grievance");
    expect(set.actionDueAt).toBeUndefined();
    expect(set.resolveDueAt).toBeUndefined();
    expect(set.acknowledgeDueAt).toBeUndefined();
    expect(eventValues(mock)?.detail).toEqual({
      fields: ["kind"],
      kind: { from: "intimate_or_impersonation", to: "grievance" },
    });
  });

  it("says which deadlines the change has already passed", async () => {
    // Received 3 hours ago as Other complaint; now an intimate image: its
    // 2-hour removal deadline passed an hour ago.
    const stored = row({ kind: "grievance", receivedAgoH: 3 });
    const mock = useDb(
      makeDbMock({
        selectQueue: [[stored]],
        returningQueue: [[stored], [{ id: "event-1" }]],
      }),
    );
    const result = await updateComplaint(
      ID,
      { kind: "intimate_or_impersonation" },
      OPS,
      { now: NOW },
    );
    expect(result).toMatchObject({ ok: true, passed: ["act"] });
    expect(mock.calls.set[0].actionDueAt).toBe(iso(NOW.getTime() - HOUR));
  });

  it("does not report a deadline already met", async () => {
    const stored = row({
      kind: "grievance",
      receivedAgoH: 3,
      actionedAt: "2026-10-30 08:00:00+00",
      actionedBy: OPS.email,
    });
    useDb(
      makeDbMock({
        selectQueue: [[stored]],
        returningQueue: [[stored], [{ id: "event-1" }]],
      }),
    );
    const result = await updateComplaint(ID, { kind: "court_order" }, OPS, {
      now: NOW,
    });
    // Court order: act and resolve 3h after receipt (now). Act is met;
    // resolve is due exactly now, so it has passed.
    expect(result).toMatchObject({ ok: true, passed: ["resolve"] });
  });

  it("corrects the received time before acknowledgement, moving the deadlines with it", async () => {
    const stored = row({ kind: "grievance", receivedAgoH: 1 });
    const mock = useDb(
      makeDbMock({
        selectQueue: [[stored]],
        returningQueue: [[stored], [{ id: "event-1" }]],
      }),
    );
    const earlier = new Date(NOW.getTime() - 5 * HOUR);
    const result = await updateComplaint(ID, { receivedAt: earlier }, OPS, {
      now: NOW,
    });
    expect(result).toMatchObject({
      ok: true,
      changed: ["receivedAt", "deadlines"],
    });
    expect(mock.calls.set[0]).toMatchObject({
      receivedAt: earlier.toISOString(),
      acknowledgeDueAt: iso(earlier.getTime() + 24 * HOUR),
      actionDueAt: iso(earlier.getTime() + 7 * 24 * HOUR),
    });
    expect(eventValues(mock)?.detail).toMatchObject({
      receivedAt: { from: stored.receivedAt, to: earlier.toISOString() },
    });
  });

  it("refuses to change the received time after acknowledgement", async () => {
    const stored = row({
      acknowledgedAt: "2026-10-30 09:20:00+00",
      acknowledgedBy: OPS.email,
    });
    const mock = useDb(makeDbMock({ selectQueue: [[stored]] }));
    const result = await updateComplaint(
      ID,
      { receivedAt: new Date(NOW.getTime() - 2 * HOUR) },
      OPS,
      { now: NOW },
    );
    expect(result).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.receivedLocked,
      field: "receivedAt",
    });
    expect(mock.calls.set).toHaveLength(0);
  });

  it("refuses a received time after the complaint was logged", async () => {
    const stored = row({
      receivedAgoH: 2,
      createdAt: iso(NOW.getTime() - HOUR),
    });
    useDb(makeDbMock({ selectQueue: [[stored]] }));
    const result = await updateComplaint(
      ID,
      { receivedAt: new Date(NOW.getTime() - 30 * 60 * 1000) },
      OPS,
      { now: NOW },
    );
    expect(result).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.receivedAfterLogged,
      field: "receivedAt",
    });
  });

  it("records the names of changed details, never their words", async () => {
    const stored = row();
    const mock = useDb(
      makeDbMock({
        selectQueue: [[stored]],
        returningQueue: [[stored], [{ id: "event-1" }]],
      }),
    );
    const result = await updateComplaint(
      ID,
      {
        summary: "Take down two photos of me.",
        complainantContact: "asha.rao@example.com",
        urls: ["https://crumb.storemink.com/shop/blue-mug"],
      },
      OPS,
      { now: NOW },
    );
    expect(result).toMatchObject({
      ok: true,
      changed: ["complainantContact", "summary"],
    });
    const detail = eventValues(mock)?.detail;
    expect(detail).toEqual({ fields: ["complainantContact", "summary"] });
    expect(JSON.stringify(detail)).not.toContain("example.com");
  });

  it("relabels the store it is about", async () => {
    const stored = row({ storeId: null, storeLabel: "" });
    const mock = useDb(
      makeDbMock({
        selectQueue: [[stored], [{ name: "Neem Ritual", slug: "neem" }]],
        returningQueue: [[stored], [{ id: "event-1" }]],
      }),
    );
    await updateComplaint(ID, { storeId: STORE }, OPS, { now: NOW });
    expect(mock.calls.set[0]).toMatchObject({
      storeId: STORE,
      storeLabel: "Neem Ritual (neem.storemink.com)",
    });
  });

  it("writes nothing when nothing changed", async () => {
    const stored = row();
    const mock = useDb(makeDbMock({ selectQueue: [[stored]] }));
    const result = await updateComplaint(
      ID,
      { kind: "grievance", summary: stored.summary },
      OPS,
      { now: NOW },
    );
    expect(result).toEqual({
      ok: true,
      complaint: stored,
      changed: [],
      passed: [],
    });
    expect(mock.calls.update).toHaveLength(0);
    expect(mock.calls.insert).toHaveLength(0);
  });

  it("refuses an erased complaint and a missing one", async () => {
    useDb(
      makeDbMock({
        selectQueue: [[row({ erasedAt: "2029-10-30 10:00:00+00" })]],
      }),
    );
    expect(await updateComplaint(ID, { kind: "court_order" }, OPS)).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.erased,
    });
    useDb(makeDbMock({ selectQueue: [[]] }));
    expect(await updateComplaint(ID, { kind: "court_order" }, OPS)).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.notFound,
    });
    expect(await updateComplaint("nope", { kind: "court_order" }, OPS)).toEqual(
      {
        ok: false,
        error: COMPLAINT_ERRORS.notFound,
      },
    );
  });

  it("checks a change before reading anything", async () => {
    expect(await updateComplaint(ID, { kind: "spam" }, OPS)).toMatchObject({
      error: COMPLAINT_ERRORS.kind,
    });
    expect(await updateComplaint(ID, { summary: " " }, OPS)).toMatchObject({
      error: COMPLAINT_ERRORS.summaryMissing,
    });
    expect(withService).not.toHaveBeenCalled();
  });
});

// ── Acknowledge ─────────────────────────────────────────────────────────────

describe("acknowledgeComplaint", () => {
  it("marks it acknowledged without an email", async () => {
    const acknowledged = row({
      acknowledgedAt: "2026-10-30 10:00:00+00",
      acknowledgedBy: OPS.email,
    });
    const mock = useDb(
      makeDbMock({ returningQueue: [[acknowledged], [{ id: "event-1" }]] }),
    );
    const result = await acknowledgeComplaint(ID, OPS);
    expect(result).toEqual({
      ok: true,
      complaint: acknowledged,
      emailed: false,
    });
    expect(mock.calls.set[0]).toMatchObject({
      acknowledgedBy: OPS.email,
      acknowledgementEmailed: false,
    });
    expect(eventValues(mock)).toMatchObject({
      action: "complaint_acknowledged",
      detail: { emailed: false },
    });
  });

  it("sends the email first, then marks it acknowledged", async () => {
    const stored = row();
    const mock = useDb(
      makeDbMock({
        selectQueue: [[stored]],
        returningQueue: [[stored], [{ id: "event-1" }]],
      }),
    );
    const deliver = vi.fn(async () => ({ sent: true }));
    const result = await acknowledgeComplaint(ID, OPS, { deliver });
    expect(result).toMatchObject({ ok: true, emailed: true });
    expect(deliver).toHaveBeenCalledWith({
      complaint: stored,
      to: "asha@example.com",
    });
    // The email went before the write, with no transaction open.
    expect(deliver.mock.invocationCallOrder[0]).toBeLessThan(
      mock.db.update.mock.invocationCallOrder[0],
    );
    expect(mock.calls.set[0]).toMatchObject({ acknowledgementEmailed: true });
    expect(eventValues(mock)?.detail).toEqual({ emailed: true });
  });

  it("does not mark it when the email fails", async () => {
    const mock = useDb(makeDbMock({ selectQueue: [[row()]] }));
    const result = await acknowledgeComplaint(ID, OPS, {
      deliver: vi.fn(async () => ({ sent: false })),
    });
    expect(result).toEqual({ ok: false, error: COMPLAINT_ERRORS.emailFailed });
    expect(mock.calls.update).toHaveLength(0);
  });

  it("needs an email address to send to", async () => {
    useDb(
      makeDbMock({
        selectQueue: [[row({ complainantContact: "+91 98765 43210" })]],
      }),
    );
    const deliver = vi.fn(async () => ({ sent: true }));
    const result = await acknowledgeComplaint(ID, OPS, { deliver });
    expect(result).toEqual({ ok: false, error: COMPLAINT_ERRORS.noEmail });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not send twice", async () => {
    useDb(
      makeDbMock({
        selectQueue: [
          [
            row({
              acknowledgedAt: "2026-10-30 09:20:00+00",
              acknowledgedBy: OPS.email,
            }),
          ],
        ],
      }),
    );
    const deliver = vi.fn(async () => ({ sent: true }));
    expect(await acknowledgeComplaint(ID, OPS, { deliver })).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.alreadyAcknowledged,
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("tells a lost race apart from a missing complaint", async () => {
    useDb(
      makeDbMock({
        returningQueue: [[]],
        selectQueue: [
          [{ acknowledgedAt: "2026-10-30 09:20:00+00", erasedAt: null }],
        ],
      }),
    );
    expect(await acknowledgeComplaint(ID, OPS)).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.alreadyAcknowledged,
    });
    useDb(makeDbMock({ returningQueue: [[]], selectQueue: [[]] }));
    expect(await acknowledgeComplaint(ID, OPS)).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.notFound,
    });
  });
});

// ── Act ─────────────────────────────────────────────────────────────────────

describe("markActioned", () => {
  it("needs a note", async () => {
    expect(await markActioned(ID, "  ", OPS)).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.noteMissing,
      field: "note",
    });
    expect(await markActioned(ID, "x".repeat(2001), OPS)).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.noteLong,
      field: "note",
    });
    expect(withService).not.toHaveBeenCalled();
  });

  it("sets actioned and records why", async () => {
    const stored = row({ kind: "information_order" });
    const mock = useDb(
      makeDbMock({
        selectQueue: [[stored]],
        returningQueue: [[stored], [{ id: "event-1" }]],
      }),
    );
    const result = await markActioned(
      ID,
      " Sent the order records to the cyber cell. ",
      OPS,
    );
    expect(result).toEqual({ ok: true, complaint: stored });
    expect(mock.calls.set[0]).toMatchObject({ actionedBy: OPS.email });
    expect(eventValues(mock)).toMatchObject({
      action: "complaint_actioned",
      detail: {
        via: "information_provided",
        note: "Sent the order records to the cyber cell.",
      },
    });
  });

  it("refuses a complaint already acted on or resolved", async () => {
    useDb(
      makeDbMock({
        selectQueue: [[row({ actionedAt: "x", actionedBy: OPS.email })]],
      }),
    );
    expect(await markActioned(ID, "note", OPS)).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.alreadyActioned,
    });
    useDb(
      makeDbMock({
        selectQueue: [
          [
            row({
              resolvedAt: "x",
              resolvedBy: OPS.email,
              outcome: "answered",
            }),
          ],
        ],
      }),
    );
    expect(await markActioned(ID, "note", OPS)).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.alreadyResolved,
    });
  });
});

describe("actionComplaintForBlock", () => {
  it("acts on the complaint once, on the caller's transaction", async () => {
    const mock = makeDbMock({
      returningQueue: [[{ id: ID, storeId: STORE }], [{ id: "event-1" }]],
    });
    const set = await actionComplaintForBlock(mock.db, {
      complaintId: ID,
      actor: OPS.email,
      blockId: BLOCK,
    });
    expect(set).toBe(true);
    expect(withService).not.toHaveBeenCalled();
    expect(eventValues(mock)).toMatchObject({
      action: "complaint_actioned",
      complaintId: ID,
      blockId: BLOCK,
      storeId: STORE,
      detail: { via: "block" },
    });
  });

  it("does nothing when it was already acted on", async () => {
    const mock = makeDbMock({ returningQueue: [[]] });
    const set = await actionComplaintForBlock(mock.db, {
      complaintId: ID,
      actor: OPS.email,
      blockId: BLOCK,
    });
    expect(set).toBe(false);
    expect(mock.calls.insert).toHaveLength(0);
  });
});

// ── Resolve and reopen ──────────────────────────────────────────────────────

describe("resolveComplaint", () => {
  it("needs a known outcome, and a note for a refusal", async () => {
    expect(await resolveComplaint(ID, { outcome: "done" }, OPS)).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.outcome,
      field: "outcome",
    });
    expect(
      await resolveComplaint(ID, { outcome: "not_removed", note: " " }, OPS),
    ).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.outcomeNoteMissing,
      field: "note",
    });
    expect(
      await resolveComplaint(ID, { outcome: "partly_removed" }, OPS),
    ).toMatchObject({ error: COMPLAINT_ERRORS.outcomeNoteMissing });
    expect(
      await resolveComplaint(
        ID,
        { outcome: "removed", note: "x".repeat(4001) },
        OPS,
      ),
    ).toMatchObject({ error: COMPLAINT_ERRORS.outcomeNoteLong });
    expect(withService).not.toHaveBeenCalled();
  });

  it("resolves without a note for an outcome that needs none", async () => {
    const resolved = row({
      resolvedAt: "x",
      resolvedBy: OPS.email,
      outcome: "removed",
    });
    const mock = useDb(
      makeDbMock({ returningQueue: [[resolved], [{ id: "event-1" }]] }),
    );
    const result = await resolveComplaint(ID, { outcome: "removed" }, OPS);
    expect(result).toEqual({ ok: true, complaint: resolved, emailed: null });
    expect(mock.calls.set[0]).toMatchObject({
      resolvedBy: OPS.email,
      outcome: "removed",
      outcomeNote: "",
    });
    expect(eventValues(mock)).toMatchObject({
      action: "complaint_resolved",
      detail: { outcome: "removed", emailed: null },
    });
  });

  it("emails the outcome first, and resolves even when the email fails", async () => {
    const stored = row();
    const mock = useDb(
      makeDbMock({
        selectQueue: [[stored]],
        returningQueue: [[stored], [{ id: "event-1" }]],
      }),
    );
    const deliver = vi.fn(async () => ({ sent: false }));
    const result = await resolveComplaint(
      ID,
      {
        outcome: "not_removed",
        note: " It is our merchant's own design. ",
        deliver,
      },
      OPS,
    );
    expect(result).toMatchObject({ ok: true, emailed: false });
    expect(deliver).toHaveBeenCalledWith({
      complaint: stored,
      to: "asha@example.com",
      outcome: "not_removed",
      note: "It is our merchant's own design.",
    });
    expect(eventValues(mock)?.detail).toEqual({
      outcome: "not_removed",
      emailed: false,
    });
  });

  it("refuses a complaint already resolved", async () => {
    useDb(
      makeDbMock({
        returningQueue: [[]],
        selectQueue: [[{ resolvedAt: "x" }]],
      }),
    );
    expect(await resolveComplaint(ID, { outcome: "removed" }, OPS)).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.alreadyResolved,
    });
  });
});

describe("reopenComplaint", () => {
  it("clears the resolution and keeps its note, recording why", async () => {
    const stored = row({
      resolvedAt: "2026-10-31 10:00:00+00",
      resolvedBy: OPS.email,
      outcome: "not_removed",
      outcomeNote: "Their own design.",
    });
    const reopened = {
      ...stored,
      resolvedAt: null,
      resolvedBy: null,
      outcome: null,
    };
    const mock = useDb(
      makeDbMock({
        selectQueue: [[stored]],
        returningQueue: [[reopened], [{ id: "event-1" }]],
      }),
    );
    const result = await reopenComplaint(ID, " They sent new evidence. ", OPS);
    expect(result).toEqual({ ok: true, complaint: reopened });
    expect(mock.calls.set[0]).toMatchObject({
      resolvedAt: null,
      resolvedBy: null,
      outcome: null,
    });
    expect(mock.calls.set[0]).not.toHaveProperty("outcomeNote");
    expect(eventValues(mock)).toMatchObject({
      action: "complaint_reopened",
      detail: {
        previousOutcome: "not_removed",
        note: "They sent new evidence.",
      },
    });
  });

  it("refuses a complaint that is not resolved, or erased", async () => {
    useDb(makeDbMock({ selectQueue: [[row()]] }));
    expect(await reopenComplaint(ID, "note", OPS)).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.notResolved,
    });
    useDb(
      makeDbMock({
        selectQueue: [
          [row({ resolvedAt: "x", erasedAt: "y", outcome: "removed" })],
        ],
      }),
    );
    expect(await reopenComplaint(ID, "note", OPS)).toEqual({
      ok: false,
      error: COMPLAINT_ERRORS.erased,
    });
  });
});

// ── Erase ───────────────────────────────────────────────────────────────────

describe("eraseResolvedComplaints", () => {
  const FLOOR = new Date("2023-10-30T00:00:00.000Z");

  it("refuses a floor less than a year old", async () => {
    await expect(
      eraseResolvedComplaints(new Date("2026-01-01T00:00:00Z"), 50, {
        now: NOW,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      eraseResolvedComplaints("soon", 50, { now: NOW }),
    ).rejects.toThrow(RangeError);
    expect(withService).not.toHaveBeenCalled();
  });

  it("does nothing for an empty batch", async () => {
    expect(await eraseResolvedComplaints(FLOOR, 0, { now: NOW })).toBe(0);
    expect(withService).not.toHaveBeenCalled();
  });

  it("empties every detail in one statement, skipping held ones, and records each", async () => {
    const mock = useDb(
      makeDbMock({
        executeQueue: [
          [
            { id: ID, store_id: STORE },
            { id: "77777777-7777-4777-8777-777777777777", store_id: null },
          ],
        ],
      }),
    );
    const erased = await eraseResolvedComplaints(FLOOR, 5000, { now: NOW });
    expect(erased).toBe(2);
    const statement = sqlText(mock.calls.execute[0]);
    expect(statement).toContain("for update of c skip locked");
    expect(statement).toContain("store_legal_holds h");
    expect(statement).toContain("h.complaint_id = c.id");
    expect(statement).toContain("a.legal_hold");
    for (const column of [
      "complainant_name = ''",
      "complainant_contact = ''",
      "acting_for = ''",
      "authority_ref = ''",
      "summary = ''",
      "urls = '{}'::text[]",
      "outcome_note = ''",
      "erased_at = now()",
    ]) {
      expect(statement).toContain(column);
    }
    // The batch is capped.
    expect(sqlParamValues(mock.calls.execute[0])).toEqual([
      FLOOR.toISOString(),
      500,
    ]);
    const events = mock.calls.values;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actor: "system",
      action: "complaint_erased",
      complaintId: ID,
      storeId: STORE,
    });
  });

  it("answers 0 when nothing is due", async () => {
    const mock = useDb(makeDbMock({ executeQueue: [[]] }));
    expect(await eraseResolvedComplaints(FLOOR, 10, { now: NOW })).toBe(0);
    expect(mock.calls.insert).toHaveLength(0);
  });
});
