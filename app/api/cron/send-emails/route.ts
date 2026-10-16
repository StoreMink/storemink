import { after } from "next/server";
import { NextResponse } from "next/server";
import { processEmailQueue } from "@/lib/email/campaign-worker";
import { processNotificationEmails } from "@/lib/email/notification-worker";
import { runSmsWorker } from "@/lib/sms/worker";
import { runWhatsAppWorker } from "@/lib/whatsapp/worker";
import { drainInboundEvents } from "@/lib/whatsapp/inbound";
import { processAnnouncements } from "@/lib/announcements/worker";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";

// Drains every outbound queue:
//   • coupon campaigns          (email_campaign_recipients)
//   • notification emails       (notification_email_queue — CODEBASE.md §22)
//   • platform announcements    (platform_announcement_recipients — §38)
//   • notification SMS          (notification_sms_queue — §37)
//   • notification WhatsApp     (notification_whatsapp_queue — WhatsApp slice 2)
//   • WhatsApp webhook events   (whatsapp_inbound_events — what the webhook's
//                                after() missed, and rows whose retry is due)
//
// One route, because they share a trigger, a secret, and a self-chaining
// pattern — and because the cron plan allows few schedules (Vercel Hobby caps
// crons at one/day), so a single entry point that drains everything is more
// reliable than two half-fed ones.
//
// Driven three ways:
//   1. Cloud Scheduler once per minute as the reliable heartbeat. This cadence
//      is required by Phase 5E scheduled campaigns; vercel.json is inert in prod.
//   2. Self-chaining: if work remains after a run, kick another via after() so
//      a large campaign (or a burst of notifications) drains in minutes rather
//      than on the cron cadence.
//   3. On demand: emitting a notification that queues an instant email, an
//      SMS or a WhatsApp message calls triggerEmailWorker(), so "new order"
//      goes out in seconds.
//
// Auth: requires `Authorization: Bearer <CRON_SECRET>`. Vercel Cron is
// configured to send this header. Set CRON_SECRET in the environment.

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Sequential, not Promise.all: both workers send through the same Resend
  // account and claim from the same pool, so overlapping them buys nothing and
  // makes rate limits harder to reason about.
  const campaigns = await processEmailQueue();
  const notifications = await processNotificationEmails();

  // ★ INBOUND WHATSAPP FIRST, THEN OUTBOUND WHATSAPP, THEN SMS. A delivery
  // status that reports a failed WhatsApp, and a send the worker could not
  // make, both RELEASE the SMS held behind that message (0211); draining in
  // this order sends that SMS in the same run instead of a minute later.
  // Bounded so a backlog cannot eat the whole request.
  const inbound = await drainInboundEvents(15_000).catch(() => null);

  // ★ WHATSAPP RIDES THE SAME HEARTBEAT, for the SMS reason below. Meta is a
  // third provider with its own limits, so this shares nothing with the two
  // Resend queues; sequential only so one failure cannot mask another.
  const whatsapp = await runWhatsAppWorker().catch(() => null);

  // ★ SMS RIDES THE SAME HEARTBEAT rather than getting its own schedule. It is
  // the same job — drain what the fan-out queued — and a separate Cloud
  // Scheduler entry is one more thing to create and one more thing to forget,
  // which docs/cron-jobs.md records happening three times already.
  //
  // ⚠ It does NOT go through Resend, so unlike the two above it shares no rate
  // limit with them; it is sequential only to keep one failure from masking
  // another in the response.
  const sms = await runSmsWorker().catch(() => null);

  // ★ ANNOUNCEMENTS RIDE THE SAME HEARTBEAT, for the reason above: a separate
  // schedule is one more thing to create and one more thing to forget.
  // Sequential with the two Resend queues on purpose — it shares their account
  // and therefore their rate limit.
  const announcements = await processAnnouncements().catch(() => null);

  // More to do in ANY queue? Chain another run after this response is sent.
  // A full SMS batch means there is probably more behind it.
  if (
    campaigns.remaining > 0 ||
    notifications.remaining > 0 ||
    (announcements?.remaining ?? 0) > 0 ||
    (sms?.claimed ?? 0) >= 50 ||
    (whatsapp?.claimed ?? 0) >= 50 ||
    (inbound?.claimed ?? 0) >= 50
  ) {
    after(() => triggerEmailWorker());
  }

  return NextResponse.json({
    ok: true,
    campaigns,
    notifications,
    sms,
    whatsapp,
    inbound,
    announcements,
  });
}

export const GET = handle;
export const POST = handle;
