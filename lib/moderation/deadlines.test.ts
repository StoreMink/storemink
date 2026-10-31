import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { COMPLAINT_KINDS, type ComplaintKind } from "./kinds";
import {
  ACKNOWLEDGE_WITHIN_HOURS,
  COMPLAINT_DEADLINES,
  WORKING_DAYS_CAP_DAYS,
  alertKey,
  alertLeadMs,
  computeDeadlines,
  deadlineLabel,
  deadlineStages,
  dueAlert,
  endOfWorkingDaysIst,
  nextDeadline,
  tightenDeadlines,
  type ComplaintClock,
} from "./deadlines";

// ---------------------------------------------------------------------------
// The deadlines must sit inside migration 0269's grievance_complaints_due_check
// for every kind and every receipt time: the database refuses anything later,
// so a deadline the code computed past it would fail the complaint's insert.
// The limits are read from the file itself.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;

const SQL = readFileSync(
  "drizzle/migrations/sql/20261030_0269_content_takedown.sql",
  "utf8",
).replace(/--[^\n]*/g, " ");

function intervalMs(text: string): number {
  const m = /^(\d+)\s+(hours?|days?)$/.exec(text.trim());
  if (!m) throw new Error(`unreadable interval ${text}`);
  return Number(m[1]) * (m[2].startsWith("day") ? DAY : HOUR);
}

const DUE = (() => {
  const start = SQL.indexOf("CONSTRAINT grievance_complaints_due_check");
  const end = SQL.indexOf("CONSTRAINT", start + 20);
  const body = SQL.slice(start, end === -1 ? undefined : end);
  const ack = /acknowledge_due_at <= received_at \+ interval '([^']+)'/.exec(
    body,
  );
  const cases = [...body.matchAll(/WHEN '([a-z_]+)' THEN interval '([^']+)'/g)];
  const otherwise = /ELSE interval '([^']+)'/.exec(body);
  const intimate =
    /kind <> 'intimate_or_impersonation'\s+OR action_due_at <= received_at \+ interval '([^']+)'/.exec(
      body,
    );
  if (!ack || cases.length === 0 || !otherwise || !intimate) {
    throw new Error("could not read grievance_complaints_due_check");
  }
  const resolveLimit = new Map(cases.map((m) => [m[1], intervalMs(m[2])]));
  return {
    ackMs: intervalMs(ack[1]),
    resolveMs: (kind: ComplaintKind) =>
      resolveLimit.get(kind) ?? intervalMs(otherwise[1]),
    intimateActMs: intervalMs(intimate[1]),
    cases: resolveLimit,
  };
})();

/** Receipt times across the IST week and around midnight, in UTC. */
const RECEIVED = [
  "2026-10-30T18:00:00.000Z", // Fri 23:30 IST
  "2026-10-30T18:29:59.000Z", // Fri 23:59:59 IST
  "2026-10-30T18:30:00.000Z", // Sat 00:00 IST
  "2026-10-31T06:30:00.000Z", // Sat 12:00 IST
  "2026-11-01T12:00:00.000Z", // Sun 17:30 IST
  "2026-11-02T03:30:00.000Z", // Mon 09:00 IST
  "2026-11-04T09:15:00.000Z", // Wed 14:45 IST
  "2026-11-05T18:29:00.000Z", // Thu 23:59 IST
  "2026-12-31T18:45:00.000Z", // Fri 1 Jan 00:15 IST
];

describe("the CHECK is read as written", () => {
  it("names every kind it limits", () => {
    expect(DUE.ackMs).toBe(24 * HOUR);
    expect(DUE.intimateActMs).toBe(2 * HOUR);
    expect([...DUE.cases.keys()].sort()).toEqual(
      [
        "court_order",
        "data_request",
        "government_order",
        "information_order",
        "intimate_or_impersonation",
        "listed_content",
      ].sort(),
    );
    expect(DUE.resolveMs("grievance")).toBe(7 * DAY);
  });
});

describe("computeDeadlines stays inside the CHECK", () => {
  for (const kind of COMPLAINT_KINDS) {
    it(`${kind}, for every receipt time`, () => {
      for (const at of RECEIVED) {
        const received = new Date(at).getTime();
        const d = computeDeadlines(kind, at);
        const ack = d.acknowledgeDueAt.getTime();
        const act = d.actionDueAt.getTime();
        const resolve = d.resolveDueAt.getTime();
        expect(ack, `${kind} ${at} ack`).toBeGreaterThan(received);
        expect(ack - received).toBeLessThanOrEqual(DUE.ackMs);
        expect(act, `${kind} ${at} act`).toBeGreaterThan(received);
        expect(resolve).toBeGreaterThanOrEqual(act);
        expect(resolve - received, `${kind} ${at} resolve`).toBeLessThanOrEqual(
          DUE.resolveMs(kind),
        );
        if (kind === "intimate_or_impersonation") {
          expect(act - received).toBeLessThanOrEqual(DUE.intimateActMs);
        }
      }
    });
  }
});

describe("computeDeadlines, exactly", () => {
  const AT = "2026-11-04T09:15:00.000Z";
  const T = new Date(AT).getTime();
  const expectations: Record<
    Exclude<ComplaintKind, "data_request">,
    [number, number]
  > = {
    court_order: [3 * HOUR, 3 * HOUR],
    government_order: [3 * HOUR, 3 * HOUR],
    information_order: [72 * HOUR, 72 * HOUR],
    intimate_or_impersonation: [2 * HOUR, 36 * HOUR],
    listed_content: [36 * HOUR, 36 * HOUR],
    other_removal: [7 * DAY, 7 * DAY],
    grievance: [7 * DAY, 7 * DAY],
  };
  for (const [kind, [act, resolve]] of Object.entries(expectations)) {
    it(kind, () => {
      const d = computeDeadlines(kind as ComplaintKind, new Date(AT));
      expect(d.acknowledgeDueAt.getTime() - T).toBe(
        ACKNOWLEDGE_WITHIN_HOURS * HOUR,
      );
      expect(d.actionDueAt.getTime() - T).toBe(act);
      expect(d.resolveDueAt.getTime() - T).toBe(resolve);
    });
  }

  it("data_request: 10 working days, counted from the next India day", () => {
    // Wed 4 Nov 14:45 IST: Thu 5 .. Wed 18 Nov is ten working days.
    const d = computeDeadlines("data_request", AT);
    expect(d.actionDueAt.toISOString()).toBe("2026-11-18T18:29:59.000Z");
    expect(d.resolveDueAt.toISOString()).toBe("2026-11-18T18:29:59.000Z");
  });

  it("refuses a time that is not one", () => {
    expect(() => computeDeadlines("grievance", "not a date")).toThrow(
      RangeError,
    );
  });

  it("keeps the table it computes from in step with the kinds", () => {
    expect(Object.keys(COMPLAINT_DEADLINES).sort()).toEqual(
      [...COMPLAINT_KINDS].sort(),
    );
  });
});

describe("endOfWorkingDaysIst", () => {
  it("a Friday 23:30 IST receipt ends at Friday 23:59:59 IST two weeks on", () => {
    // Fri 30 Oct 23:30 IST: counting starts Sat 31 Oct; ten working days end
    // on Fri 13 Nov.
    const end = endOfWorkingDaysIst("2026-10-30T18:00:00.000Z", 10);
    expect(end.toISOString()).toBe("2026-11-13T18:29:59.000Z");
  });

  it("a Saturday receipt counts from Monday", () => {
    const end = endOfWorkingDaysIst("2026-10-31T06:30:00.000Z", 1);
    expect(end.toISOString()).toBe("2026-11-02T18:29:59.000Z");
  });

  it("a receipt just after India midnight belongs to the new day", () => {
    // Sat 00:00 IST is Fri 18:30 UTC: the India date is Saturday.
    const end = endOfWorkingDaysIst("2026-10-30T18:30:00.000Z", 1);
    expect(end.toISOString()).toBe("2026-11-02T18:29:59.000Z");
  });

  it("never reaches the 15-day cap for any receipt time", () => {
    const start = new Date("2026-10-30T00:00:00.000Z").getTime();
    for (let step = 0; step < 7 * 48; step += 1) {
      const received = start + step * 30 * MINUTE;
      const end = endOfWorkingDaysIst(new Date(received), 10).getTime();
      expect(end - received).toBeLessThan(WORKING_DAYS_CAP_DAYS * DAY);
      expect(end).toBeGreaterThan(received);
    }
  });

  it("refuses a day count below one", () => {
    expect(() => endOfWorkingDaysIst("2026-10-30T00:00:00.000Z", 0)).toThrow(
      RangeError,
    );
  });
});

describe("tightenDeadlines", () => {
  it("an Other complaint relabelled Intimate image after acknowledgement moves its deadlines earlier, never later", () => {
    const received = "2026-11-04T09:15:00.000Z";
    const stored = computeDeadlines("grievance", received);
    const tightened = tightenDeadlines(
      stored,
      "intimate_or_impersonation",
      received,
    );
    const T = new Date(received).getTime();
    expect(tightened.actionDueAt.getTime() - T).toBe(2 * HOUR);
    expect(tightened.resolveDueAt.getTime() - T).toBe(36 * HOUR);
    expect(tightened.acknowledgeDueAt.getTime()).toBe(
      stored.acknowledgeDueAt.getTime(),
    );
    // The other way round changes nothing.
    const back = tightenDeadlines(
      {
        ...tightened,
        acknowledgeDueAt: tightened.acknowledgeDueAt.toISOString(),
      },
      "grievance",
      received,
    );
    expect(back.actionDueAt.getTime()).toBe(tightened.actionDueAt.getTime());
    expect(back.resolveDueAt.getTime()).toBe(tightened.resolveDueAt.getTime());
  });
});

describe("stages and labels", () => {
  it("shows the stages each kind has", () => {
    expect(deadlineStages("grievance")).toEqual(["acknowledge", "resolve"]);
    expect(deadlineStages("information_order")).toEqual(["acknowledge", "act"]);
    expect(deadlineStages("data_request")).toEqual(["acknowledge", "act"]);
    expect(deadlineStages("court_order")).toEqual([
      "acknowledge",
      "act",
      "resolve",
    ]);
  });

  it("names each stage the way the console writes it", () => {
    expect(deadlineLabel("court_order", "acknowledge")).toBe("Acknowledge by");
    expect(deadlineLabel("court_order", "act")).toBe("Remove or block by");
    expect(deadlineLabel("court_order", "resolve")).toBe("Resolve by");
    expect(deadlineLabel("information_order", "act")).toBe("Provide by");
    expect(deadlineLabel("data_request", "act")).toBe("Answer by");
    expect(deadlineLabel("grievance", "resolve")).toBe("Resolve by");
    for (const kind of COMPLAINT_KINDS) {
      for (const stage of ["acknowledge", "act", "resolve"] as const) {
        expect(deadlineLabel(kind, stage)).toMatch(/^[A-Z][a-z ]+ by$/);
      }
    }
  });
});

function clock(
  kind: ComplaintKind,
  received: string,
  extra: Partial<ComplaintClock> = {},
): ComplaintClock {
  const d = computeDeadlines(kind, received);
  return {
    kind,
    receivedAt: received,
    acknowledgeDueAt: d.acknowledgeDueAt,
    actionDueAt: d.actionDueAt,
    resolveDueAt: d.resolveDueAt,
    ...extra,
  };
}

describe("nextDeadline", () => {
  const RECEIVED_AT = "2026-11-04T09:15:00.000Z";
  const T = new Date(RECEIVED_AT).getTime();

  it("is the earliest open stage", () => {
    const c = clock("intimate_or_impersonation", RECEIVED_AT);
    const next = nextDeadline(c, new Date(T + MINUTE));
    expect(next?.stage).toBe("act");
    expect(next?.overdue).toBe(false);
    expect(nextDeadline(c, new Date(T + 3 * HOUR))?.overdue).toBe(true);
  });

  it("skips met stages and ends at resolution", () => {
    const c = clock("intimate_or_impersonation", RECEIVED_AT, {
      actionedAt: new Date(T + HOUR),
    });
    expect(nextDeadline(c, new Date(T))?.stage).toBe("acknowledge");
    const acked = { ...c, acknowledgedAt: new Date(T + HOUR).toISOString() };
    expect(nextDeadline(acked, new Date(T))?.stage).toBe("resolve");
    expect(
      nextDeadline({ ...acked, resolvedAt: new Date(T) }, new Date(T)),
    ).toBeNull();
  });

  it("a court order's act and resolve fall together: act comes first", () => {
    const c = clock("court_order", RECEIVED_AT);
    expect(nextDeadline(c, new Date(T))?.stage).toBe("act");
  });

  it("an information order is met once actioned", () => {
    const c = clock("information_order", RECEIVED_AT, {
      acknowledgedAt: new Date(T),
      actionedAt: new Date(T + HOUR),
    });
    expect(nextDeadline(c, new Date(T + 2 * HOUR))).toBeNull();
  });
});

describe("dueAlert", () => {
  const RECEIVED_AT = "2026-11-04T09:15:00.000Z";
  const T = new Date(RECEIVED_AT).getTime();

  it("leads a 2- or 3-hour deadline by 30 minutes and any other by 2 hours", () => {
    expect(alertLeadMs(RECEIVED_AT, new Date(T + 2 * HOUR))).toBe(30 * MINUTE);
    expect(alertLeadMs(RECEIVED_AT, new Date(T + 3 * HOUR))).toBe(30 * MINUTE);
    expect(alertLeadMs(RECEIVED_AT, new Date(T + 36 * HOUR))).toBe(2 * HOUR);
  });

  it("an intimate-image complaint: soon at 1h30, overdue at 2h, each once", () => {
    const c = clock("intimate_or_impersonation", RECEIVED_AT, {
      acknowledgedAt: new Date(T + MINUTE),
    });
    expect(dueAlert(c, new Date(T + HOUR))).toBeNull();
    const soon = dueAlert(c, new Date(T + 90 * MINUTE));
    expect(soon).toMatchObject({
      stage: "act",
      phase: "soon",
      key: "act_soon",
    });
    const sent = { ...c, alerts: { [alertKey("act", "soon")]: "x" } };
    expect(dueAlert(sent, new Date(T + 100 * MINUTE))).toBeNull();
    const overdue = dueAlert(sent, new Date(T + 2 * HOUR));
    expect(overdue).toMatchObject({ phase: "overdue", key: "act_overdue" });
    const both = { ...sent, alerts: { ...sent.alerts, act_overdue: "y" } };
    expect(dueAlert(both, new Date(T + 2 * HOUR + MINUTE))).toBeNull();
  });

  it("a deadline passed unseen fires overdue, never soon", () => {
    const c = clock("intimate_or_impersonation", RECEIVED_AT, {
      acknowledgedAt: new Date(T + MINUTE),
    });
    expect(dueAlert(c, new Date(T + 5 * HOUR))).toMatchObject({
      stage: "act",
      phase: "overdue",
    });
  });

  it("two stages due at one moment ring once", () => {
    const c = clock("court_order", RECEIVED_AT, {
      acknowledgedAt: new Date(T + MINUTE),
    });
    const first = dueAlert(c, new Date(T + 3 * HOUR));
    expect(first?.stage).toBe("act");
    const after = { ...c, alerts: { act_overdue: "x" } };
    expect(dueAlert(after, new Date(T + 3 * HOUR))).toBeNull();
  });

  it("an unacknowledged complaint alerts on acknowledgement first", () => {
    const c = clock("grievance", RECEIVED_AT);
    const alert = dueAlert(c, new Date(T + 23 * HOUR));
    expect(alert).toMatchObject({ stage: "acknowledge", phase: "soon" });
  });

  it("a resolved complaint never alerts", () => {
    const c = clock("court_order", RECEIVED_AT, { resolvedAt: new Date(T) });
    expect(dueAlert(c, new Date(T + 10 * HOUR))).toBeNull();
  });
});
