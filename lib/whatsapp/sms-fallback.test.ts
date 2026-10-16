/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// The SMS held behind a WhatsApp message: what is held, and that release and
// drop are each ONE conditional statement on a still-held row, so a worker
// and a status webhook racing settle it once. The CHECK and the release's
// INSERT ... SELECT were probed on real PostgreSQL with migration 0211.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import { sqlParamValues, sqlText } from "@/app/actions/_test-helpers";
import { dropHeldSms, heldSmsFrom, releaseHeldSms } from "./sms-fallback";

function db(rows: unknown[]) {
  return { execute: vi.fn(async () => ({ rows })) } as any;
}

describe("heldSmsFrom", () => {
  it("keeps exactly the SMS queue row's fields, values as text", () => {
    expect(
      heldSmsFrom({
        recipientId: "u1",
        recipientType: "customer",
        phone: "+919876543210",
        eventKey: "order.placed",
        values: ["ORD1", 240, null],
      }),
    ).toEqual({
      recipientId: "u1",
      recipientType: "customer",
      phone: "+919876543210",
      eventKey: "order.placed",
      values: ["ORD1", "240", "null"],
    });
    expect(
      heldSmsFrom({
        recipientId: "u1",
        recipientType: "customer",
        phone: "+919876543210",
        eventKey: "order.placed",
      }).values,
    ).toEqual([]);
  });
});

describe("releaseHeldSms", () => {
  it("★ claims held → released and queues the SMS in one statement", async () => {
    const d = db([{ id: "sms1" }]);
    await expect(releaseHeldSms(d, "q1")).resolves.toBe(true);
    expect(d.execute).toHaveBeenCalledTimes(1);
    const text = sqlText(d.execute.mock.calls[0][0]);
    expect(text).toMatch(/set fallback_state = 'released'/);
    expect(text).toMatch(/and fallback_state = 'held'/);
    expect(text).toMatch(/insert into public\.notification_sms_queue/);
    expect(text).toMatch(/from claimed/);
    expect(sqlParamValues(d.execute.mock.calls[0][0])).toContain("q1");
  });

  it("reports nothing released when the row was not held (already settled)", async () => {
    await expect(releaseHeldSms(db([]), "q1")).resolves.toBe(false);
  });
});

describe("dropHeldSms", () => {
  it("drops only a still-held SMS", async () => {
    const d = db([{ id: "q1" }]);
    await expect(dropHeldSms(d, "q1")).resolves.toBe(true);
    const text = sqlText(d.execute.mock.calls[0][0]);
    expect(text).toMatch(/set fallback_state = 'dropped'/);
    expect(text).toMatch(/and fallback_state = 'held'/);
    await expect(dropHeldSms(db([]), "q1")).resolves.toBe(false);
  });
});
