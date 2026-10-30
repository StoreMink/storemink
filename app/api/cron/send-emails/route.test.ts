/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `after` is the self-chaining hook; keep the real NextResponse.
const afterCalls = vi.hoisted(() => ({ fns: [] as (() => unknown)[] }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((fn: () => unknown) => {
      afterCalls.fns.push(fn);
    }),
  };
});
vi.mock("@/lib/email/campaign-worker", () => ({ processEmailQueue: vi.fn() }));
vi.mock("@/lib/email/notification-worker", () => ({
  processNotificationEmails: vi.fn(),
}));
vi.mock("@/lib/email/trigger-worker", () => ({ triggerEmailWorker: vi.fn() }));
vi.mock("@/lib/sms/worker", () => ({ runSmsWorker: vi.fn() }));
vi.mock("@/lib/whatsapp/worker", () => ({ runWhatsAppWorker: vi.fn() }));
vi.mock("@/lib/whatsapp/inbound", () => ({ drainInboundEvents: vi.fn() }));
vi.mock("@/lib/announcements/worker", () => ({
  processAnnouncements: vi.fn(),
}));
vi.mock("@/lib/moderation/follow-ups", () => ({
  runModerationFollowUps: vi.fn(),
}));

import { GET, POST } from "./route";
import { processEmailQueue } from "@/lib/email/campaign-worker";
import { processNotificationEmails } from "@/lib/email/notification-worker";
import { runSmsWorker } from "@/lib/sms/worker";
import { runWhatsAppWorker } from "@/lib/whatsapp/worker";
import { drainInboundEvents } from "@/lib/whatsapp/inbound";
import { processAnnouncements } from "@/lib/announcements/worker";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";
import { runModerationFollowUps } from "@/lib/moderation/follow-ups";

const FOLLOW_UPS = {
  alertsSent: 0,
  alertsWaiting: 0,
  archivesCopied: 0,
  archivesFailed: 0,
  filesSettled: 0,
  filesRetrying: 0,
  replaced: 0,
  replaceFailed: 0,
  replaceRetrying: 0,
  restored: 0,
  notRestored: 0,
  restoreRetrying: 0,
  noticesSent: 0,
  noticesFailed: 0,
  failedSteps: [],
  outOfTime: false,
  ms: 3,
};

function req(auth?: string): Request {
  return new Request("https://storemink.com/api/cron/send-emails", {
    headers: auth ? { authorization: auth } : {},
  });
}

// Drains all FOUR outbound queues (coupon campaigns, notification emails,
// platform announcements and SMS — the last two ride the same heartbeat rather
// than getting their own jobs).
// Auth is `Authorization: Bearer <CRON_SECRET>`; without the secret set the
// route must refuse rather than run unauthenticated.
describe("/api/cron/send-emails", () => {
  const OLD_ENV = process.env.CRON_SECRET;

  beforeEach(() => {
    // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS.
    vi.mocked(runWhatsAppWorker).mockResolvedValue({
      claimed: 0,
      sent: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
      smsReleased: 0,
      requeued: 0,
    });
    vi.mocked(runSmsWorker).mockResolvedValue({
      claimed: 0,
      sent: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
    });
    vi.mocked(drainInboundEvents).mockResolvedValue({
      claimed: 0,
      processed: 0,
      failed: 0,
      retrying: 0,
      smsReleased: 0,
    });
    vi.mocked(processAnnouncements).mockResolvedValue({
      processed: 0,
      sent: 0,
      failed: 0,
      remaining: 0,
    });
    vi.mocked(runModerationFollowUps).mockResolvedValue(FOLLOW_UPS as any);
    vi.clearAllMocks();
    afterCalls.fns = [];
    process.env.CRON_SECRET = "s3cret";
    vi.mocked(processEmailQueue).mockResolvedValue({
      sent: 0,
      remaining: 0,
    } as any);
    vi.mocked(processNotificationEmails).mockResolvedValue({
      sent: 0,
      remaining: 0,
    } as any);
  });

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = OLD_ENV;
  });

  it("refuses a request with no Authorization header", async () => {
    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(processEmailQueue).not.toHaveBeenCalled();
    expect(processNotificationEmails).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret", async () => {
    const res = await GET(req("Bearer wrong"));

    expect(res.status).toBe(401);
    expect(processEmailQueue).not.toHaveBeenCalled();
  });

  it("refuses a bare secret without the Bearer scheme", async () => {
    const res = await GET(req("s3cret"));

    expect(res.status).toBe(401);
  });

  it("refuses everything when CRON_SECRET is unset", async () => {
    // Fails CLOSED: an unset secret must not mean "let anyone drain the queue",
    // which is what comparing against undefined would allow.
    delete process.env.CRON_SECRET;

    expect((await GET(req("Bearer undefined"))).status).toBe(401);
    expect((await GET(req())).status).toBe(401);
    expect(processEmailQueue).not.toHaveBeenCalled();
  });

  it("drains all four queues on a valid secret", async () => {
    vi.mocked(processEmailQueue).mockResolvedValue({
      sent: 5,
      remaining: 0,
    } as any);
    vi.mocked(processNotificationEmails).mockResolvedValue({
      sent: 2,
      remaining: 0,
    } as any);

    const res = await GET(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      campaigns: { sent: 5, remaining: 0 },
      notifications: { sent: 2, remaining: 0 },
      // SMS rides the same heartbeat rather than getting its own schedule —
      // one more Cloud Scheduler entry is one more thing to forget, which
      // docs/cron-jobs.md records happening three times already.
      sms: { claimed: 0, sent: 0, failed: 0, unknown: 0, skipped: 0 },
      // WhatsApp rides it too (slice 2), a third provider on the same beat.
      whatsapp: {
        claimed: 0,
        sent: 0,
        failed: 0,
        unknown: 0,
        skipped: 0,
        smsReleased: 0,
        requeued: 0,
      },
      // And the WhatsApp webhook events the webhook's after() missed.
      inbound: {
        claimed: 0,
        processed: 0,
        failed: 0,
        retrying: 0,
        smsReleased: 0,
      },
      // Announcements ride it too, for the same reason.
      announcements: { processed: 0, sent: 0, failed: 0, remaining: 0 },
      // And the content takedown follow-ups, last (design 8.1).
      moderation: FOLLOW_UPS,
    });
  });

  it("★ runs the takedown follow-ups last, ending 52 seconds into the route at the latest", async () => {
    const routeStart = Date.now();
    await GET(req("Bearer s3cret"));
    const others = [
      processEmailQueue,
      processNotificationEmails,
      drainInboundEvents,
      runWhatsAppWorker,
      runSmsWorker,
      processAnnouncements,
    ].map((f) => vi.mocked(f as any).mock.invocationCallOrder[0] as number);
    const followUps = vi.mocked(runModerationFollowUps).mock
      .invocationCallOrder[0];
    expect(followUps).toBeGreaterThan(Math.max(...others));
    expect(runModerationFollowUps).toHaveBeenCalledTimes(1);
    const { deadline } = vi.mocked(runModerationFollowUps).mock.calls[0][0]!;
    // min(start + 40 s, routeStart + 52 s): both bounds hold.
    expect(deadline).toBeLessThanOrEqual(Date.now() + 40_000);
    expect(deadline).toBeLessThanOrEqual(routeStart + 52_000 + 50);
    expect(deadline).toBeGreaterThan(routeStart + 39_000);
  });

  it("★ a slow email step shortens the follow-ups to the route's 52 seconds", async () => {
    const spy = vi.spyOn(Date, "now");
    try {
      // The route starts at 0 and the email queues take 30 seconds.
      let now = 0;
      spy.mockImplementation(() => now);
      vi.mocked(processEmailQueue).mockImplementation(async () => {
        now = 30_000;
        return { sent: 0, remaining: 0 } as any;
      });
      await GET(req("Bearer s3cret"));
      expect(vi.mocked(runModerationFollowUps).mock.calls[0][0]!.deadline).toBe(
        52_000,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("★ a failing follow-up reads as null and fails nothing else", async () => {
    vi.mocked(runModerationFollowUps).mockRejectedValue(new Error("clock"));
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.moderation).toBeNull();
    expect(body.campaigns).toEqual({ sent: 0, remaining: 0 });
  });

  it("★ a throwing email queue still runs the follow-ups, and still fails the request", async () => {
    vi.mocked(processNotificationEmails).mockRejectedValue(
      new Error("resend down"),
    );
    await expect(GET(req("Bearer s3cret"))).rejects.toThrow("resend down");
    expect(runModerationFollowUps).toHaveBeenCalledTimes(1);
  });

  it("never chains another run for the follow-ups", async () => {
    vi.mocked(runModerationFollowUps).mockResolvedValue({
      ...FOLLOW_UPS,
      outOfTime: true,
    } as any);
    await GET(req("Bearer s3cret"));
    expect(afterCalls.fns).toHaveLength(0);
  });

  // ★ Same rule for announcements: a broadcast is the LEAST urgent thing in
  // this route, so a failure resolving one must never stop a merchant's order
  // confirmations going out.
  it("still reports the email queues when the announcement worker throws", async () => {
    vi.mocked(processEmailQueue).mockResolvedValue({
      sent: 5,
      remaining: 0,
    } as any);
    vi.mocked(processNotificationEmails).mockResolvedValue({
      sent: 2,
      remaining: 0,
    } as any);
    vi.mocked(processAnnouncements).mockRejectedValue(new Error("db down"));

    const res = await GET(req("Bearer s3cret"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.campaigns).toEqual({ sent: 5, remaining: 0 });
    expect(body.notifications).toEqual({ sent: 2, remaining: 0 });
    // Null, not absent: "we tried and it failed" is a different fact from
    // "we did not run it", and the response has to be able to say which.
    expect(body.announcements).toBeNull();
  });

  // ★ It must not be able to take the email queues down with it. SMS goes
  // through a different provider entirely, so a Twilio outage has no business
  // stopping a merchant's order confirmations.
  it("still reports the email queues when the SMS worker throws", async () => {
    vi.mocked(processEmailQueue).mockResolvedValue({
      sent: 5,
      remaining: 0,
    } as any);
    vi.mocked(processNotificationEmails).mockResolvedValue({
      sent: 2,
      remaining: 0,
    } as any);
    vi.mocked(runSmsWorker).mockRejectedValue(new Error("twilio down"));

    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.campaigns).toEqual({ sent: 5, remaining: 0 });
    expect(body.sms).toBeNull();
  });

  it("runs the workers sequentially, campaigns first", async () => {
    // They share a Resend account and claim from the same pool, so overlapping
    // them buys nothing and makes rate limits harder to reason about.
    const order: string[] = [];
    vi.mocked(processEmailQueue).mockImplementation(async () => {
      order.push("campaigns");
      return { sent: 0, remaining: 0 } as any;
    });
    vi.mocked(processNotificationEmails).mockImplementation(async () => {
      order.push("notifications");
      return { sent: 0, remaining: 0 } as any;
    });

    await GET(req("Bearer s3cret"));

    expect(order).toEqual(["campaigns", "notifications"]);
  });

  it("does not chain another run when both queues are drained", async () => {
    await GET(req("Bearer s3cret"));

    expect(afterCalls.fns).toHaveLength(0);
  });

  it("★ drains inbound WhatsApp, then outbound WhatsApp, then SMS (a released SMS goes in the same run)", async () => {
    await GET(req("Bearer s3cret"));
    const order = [drainInboundEvents, runWhatsAppWorker, runSmsWorker].map(
      (f) => vi.mocked(f as any).mock.invocationCallOrder[0],
    );
    expect([...order].sort((a, b) => a! - b!)).toEqual(order);
  });

  it("chains another run when a full inbound batch suggests more", async () => {
    vi.mocked(drainInboundEvents).mockResolvedValue({
      claimed: 50,
      processed: 50,
      failed: 0,
      retrying: 0,
      smsReleased: 0,
    });
    await GET(req("Bearer s3cret"));
    expect(afterCalls.fns).toHaveLength(1);
  });

  it("chains another run when campaigns have work left", async () => {
    vi.mocked(processEmailQueue).mockResolvedValue({
      sent: 100,
      remaining: 40,
    } as any);

    await GET(req("Bearer s3cret"));

    expect(afterCalls.fns).toHaveLength(1);
  });

  it("chains another run when notifications have work left", async () => {
    vi.mocked(processNotificationEmails).mockResolvedValue({
      sent: 100,
      remaining: 7,
    } as any);

    await GET(req("Bearer s3cret"));

    expect(afterCalls.fns).toHaveLength(1);
  });

  it("chains via triggerEmailWorker, after the response is sent", async () => {
    vi.mocked(processEmailQueue).mockResolvedValue({
      sent: 1,
      remaining: 1,
    } as any);

    await GET(req("Bearer s3cret"));
    // Deferred, not awaited inline — a large campaign must not sit on the
    // response.
    expect(triggerEmailWorker).not.toHaveBeenCalled();
    afterCalls.fns[0]();
    expect(triggerEmailWorker).toHaveBeenCalled();
  });

  it("serves POST identically to GET", async () => {
    const res = await POST(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("refuses an unauthorized POST too", async () => {
    expect((await POST(req("Bearer nope"))).status).toBe(401);
  });
});
