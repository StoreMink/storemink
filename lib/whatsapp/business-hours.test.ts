import { describe, expect, it } from "vitest";
import {
  ALL_DAY,
  DEFAULT_BUSINESS_HOURS,
  endsNextDay,
  isOpenAt,
  normalizeBusinessHours,
  openedBetween,
  validateBusinessHours,
  type BusinessHours,
} from "./business-hours";

const IST = "Asia/Kolkata";

/** An IST wall-clock time as an instant (IST is UTC+5:30, no DST). */
function ist(iso: string): Date {
  return new Date(`${iso}+05:30`);
}

const CLOSED_WEEK: BusinessHours = {
  mon: null,
  tue: null,
  wed: null,
  thu: null,
  fri: null,
  sat: null,
  sun: null,
};

// 2026-10-12 is a Monday; 2026-10-17 a Saturday; 2026-10-18 a Sunday.

describe("isOpenAt", () => {
  it("reads the store's own clock, not the server's", () => {
    // Monday 10:00 to 19:00 in Kolkata.
    expect(isOpenAt(DEFAULT_BUSINESS_HOURS, IST, ist("2026-10-12T09:59"))).toBe(
      false,
    );
    expect(isOpenAt(DEFAULT_BUSINESS_HOURS, IST, ist("2026-10-12T10:00"))).toBe(
      true,
    );
    expect(isOpenAt(DEFAULT_BUSINESS_HOURS, IST, ist("2026-10-12T18:59"))).toBe(
      true,
    );
    // Closing time is the first closed minute.
    expect(isOpenAt(DEFAULT_BUSINESS_HOURS, IST, ist("2026-10-12T19:00"))).toBe(
      false,
    );
    // Sunday is closed all day.
    expect(isOpenAt(DEFAULT_BUSINESS_HOURS, IST, ist("2026-10-18T12:00"))).toBe(
      false,
    );
  });

  it("★ a span past midnight belongs to the day it begins on", () => {
    const hours: BusinessHours = {
      ...CLOSED_WEEK,
      fri: { open: "22:00", close: "02:00" },
    };
    // Friday 2026-10-16 23:00 and Saturday 01:00 are inside Friday's evening.
    expect(isOpenAt(hours, IST, ist("2026-10-16T23:00"))).toBe(true);
    expect(isOpenAt(hours, IST, ist("2026-10-17T01:59"))).toBe(true);
    expect(isOpenAt(hours, IST, ist("2026-10-17T02:00"))).toBe(false);
    // 01:00 on FRIDAY belongs to Thursday, which is closed.
    expect(isOpenAt(hours, IST, ist("2026-10-16T01:00"))).toBe(false);
    expect(endsNextDay(hours.fri!)).toBe(true);
  });

  it("open all day, and open until midnight", () => {
    const hours: BusinessHours = {
      ...CLOSED_WEEK,
      mon: ALL_DAY,
      tue: { open: "18:00", close: "00:00" },
    };
    expect(isOpenAt(hours, IST, ist("2026-10-12T00:00"))).toBe(true);
    expect(isOpenAt(hours, IST, ist("2026-10-12T23:59"))).toBe(true);
    expect(isOpenAt(hours, IST, ist("2026-10-13T23:59"))).toBe(true);
    // Until midnight does not spill into Wednesday.
    expect(isOpenAt(hours, IST, ist("2026-10-14T00:00"))).toBe(false);
    expect(endsNextDay(hours.tue!)).toBe(false);
  });

  it("follows daylight saving in a zone that has it", () => {
    const hours: BusinessHours = {
      ...CLOSED_WEEK,
      mon: { open: "09:00", close: "17:00" },
    };
    // 08:30 UTC is 08:30 in London in January and 09:30 in late March.
    expect(
      isOpenAt(hours, "Europe/London", new Date("2026-01-05T08:30:00Z")),
    ).toBe(false);
    expect(
      isOpenAt(hours, "Europe/London", new Date("2026-03-30T08:30:00Z")),
    ).toBe(true);
  });

  it("★ an unreadable zone counts as open, so nothing claims the shop is closed", () => {
    expect(isOpenAt(CLOSED_WEEK, "Not/AZone", new Date())).toBe(true);
  });
});

describe("openedBetween", () => {
  it("is false within one closed spell and true once the shop has opened", () => {
    // Away message on Saturday evening; the shop next opens Monday 10:00.
    const away = ist("2026-10-17T19:30");
    expect(
      openedBetween(DEFAULT_BUSINESS_HOURS, IST, away, ist("2026-10-18T12:00")),
    ).toBe(false);
    expect(
      openedBetween(DEFAULT_BUSINESS_HOURS, IST, away, ist("2026-10-19T09:59")),
    ).toBe(false);
    expect(
      openedBetween(DEFAULT_BUSINESS_HOURS, IST, away, ist("2026-10-19T10:00")),
    ).toBe(true);
    expect(
      openedBetween(DEFAULT_BUSINESS_HOURS, IST, away, ist("2026-10-19T20:00")),
    ).toBe(true);
  });

  it("counts an opening that starts the night before", () => {
    const hours: BusinessHours = {
      ...CLOSED_WEEK,
      fri: { open: "22:00", close: "02:00" },
    };
    expect(
      openedBetween(
        hours,
        IST,
        ist("2026-10-16T21:00"),
        ist("2026-10-17T03:00"),
      ),
    ).toBe(true);
    expect(
      openedBetween(
        hours,
        IST,
        ist("2026-10-17T03:00"),
        ist("2026-10-18T03:00"),
      ),
    ).toBe(false);
  });

  it("a long gap holds every opening; a week with no hours holds none", () => {
    const from = ist("2026-09-01T12:00");
    const to = ist("2026-10-01T12:00");
    expect(openedBetween(DEFAULT_BUSINESS_HOURS, IST, from, to)).toBe(true);
    expect(openedBetween(CLOSED_WEEK, IST, from, to)).toBe(false);
  });

  it("is false when `to` is not after `from`", () => {
    const at = ist("2026-10-12T12:00");
    expect(openedBetween(DEFAULT_BUSINESS_HOURS, IST, at, at)).toBe(false);
  });
});

describe("validateBusinessHours", () => {
  it("accepts a week, and a day left out is closed", () => {
    const r = validateBusinessHours({
      mon: { open: "09:30", close: "18:00" },
      sun: ALL_DAY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hours.mon).toEqual({ open: "09:30", close: "18:00" });
    expect(r.hours.sun).toEqual(ALL_DAY);
    expect(r.hours.tue).toBeNull();
  });

  it("names the day it refuses", () => {
    expect(
      validateBusinessHours({ wed: { open: "10:00", close: "10:00" } }),
    ).toEqual({
      ok: false,
      error: expect.stringMatching(/^Wednesday: .*the same/),
    });
    expect(
      validateBusinessHours({ fri: { open: "9", close: "18:00" } }),
    ).toEqual({
      ok: false,
      error: expect.stringMatching(/^Friday: enter times/),
    });
    // 24:00 is only "all day"; anything else uses 00:00 for midnight.
    expect(
      validateBusinessHours({ sat: { open: "18:00", close: "24:00" } }).ok,
    ).toBe(false);
    expect(validateBusinessHours("09:00-18:00").ok).toBe(false);
  });

  it("normalize closes a day it cannot read, instead of guessing", () => {
    const hours = normalizeBusinessHours({
      mon: { open: "10:00", close: "19:00" },
      tue: { open: "junk", close: "19:00" },
      wed: "open",
    });
    expect(hours.mon).toEqual({ open: "10:00", close: "19:00" });
    expect(hours.tue).toBeNull();
    expect(hours.wed).toBeNull();
    expect(normalizeBusinessHours(null)).toEqual(CLOSED_WEEK);
  });
});
