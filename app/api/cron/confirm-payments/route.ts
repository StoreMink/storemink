import { NextResponse } from "next/server";
import { confirmYoungPendingOrders } from "@/lib/orders/pending-payments";
import { logError } from "@/lib/observability/logger";

// The frequent half of the pending-payment safety net (21 Nov 2026).
//
// A shopper pays, and the tab closes before the store's page can confirm it:
// a UPI app switch on a phone is the common case. The order then waited for
// the hourly reaper, which only looks at orders older than 45 minutes, so it
// stayed unconfirmed for 45 to 105 minutes unless the merchant had set up the
// optional Razorpay webhook. Meanwhile the shopper saw a full cart and no
// confirmation.
//
// This job asks Razorpay about every order that has been waiting between 2
// and 45 minutes and marks the paid ones paid (`confirmYoungPendingOrders`,
// lib/orders/pending-payments.ts). ★★ IT NEVER CANCELS ANYTHING: cancelling
// stays with expire-pending-payments and its 45-minute rule. Looking for
// money can only help.
//
// ⚠ SCHEDULE IT EVERY 5 MINUTES. Deploying this route does not schedule it
// (docs/cron-jobs.md). Until the job exists the same pass still runs at the
// start of the hourly expire-pending-payments job, so nothing is lost, only
// slower.
//
// Auth: `Authorization: Bearer <CRON_SECRET>` (Cloud Scheduler sends it).

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // Fails CLOSED: with no secret set this endpoint would be open to anyone.
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const summary = await confirmYoungPendingOrders();
  if (summary.errors > 0) {
    logError(
      "checkout.confirm_payments_cron",
      new Error("the confirming pass reported errors"),
      { ...summary },
    );
    // 503 so Cloud Scheduler retries: an order may be paid and unconfirmed.
    return NextResponse.json({ ok: false, ...summary }, { status: 503 });
  }
  return NextResponse.json({ ok: true, ...summary });
}

export const GET = handle;
export const POST = handle;
