import { NextResponse, after } from "next/server";
import {
  answerVerifyChallenge,
  verifyMetaSignature,
} from "@/lib/whatsapp/webhook-signature";
import {
  isWhatsAppWebhook,
  summarizeWebhook,
} from "@/lib/whatsapp/webhook-events";
import {
  processPendingInboundEvents,
  recordWebhookDelivery,
} from "@/lib/whatsapp/inbound";
import { whatsappConfig } from "@/lib/whatsapp/config";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";

/**
 * WhatsApp Cloud API webhook — ONE URL for every merchant.
 *
 * Meta posts every WABA onboarded through the StoreMink app here; each
 * delivery is routed to a store by `metadata.phone_number_id`
 * (docs/whatsapp-commerce-plan.md §9), which is why there is no `[storeId]`
 * segment and why that column is globally unique.
 *
 * Security is the two-webhook pattern this codebase already runs:
 *   • GET  — Meta proves we own the URL: `hub.verify_token` must equal
 *            WHATSAPP_VERIFY_TOKEN; we echo `hub.challenge` as plain text.
 *   • POST — Meta proves it is Meta: `X-Hub-Signature-256` is HMAC-SHA256 over
 *            the RAW body with WHATSAPP_APP_SECRET, checked before parsing.
 *
 * ★ ACK FAST, WORK LATER. The handler writes raw rows (idempotent on Meta's
 * ids, so a redelivery is a no-op) and answers; processing runs in `after()`
 * and on the heartbeat. Meta retries any non-2xx for days, so a 503 here is
 * a deliberate "ask again" — used only when the rows could not be WRITTEN,
 * never for a row we have and merely failed to process.
 *
 * ★ `/api` BYPASSES proxy.ts (its matcher excludes it), so this route owns its
 * whole gate; there is no session and no store to fall back on.
 *
 * ⚠ The log line is a content-free summary (counts and ids — never message
 * text, never a `wa_id`). An unconfigured app secret now answers 503, not
 * 200: deliveries carry data (orders, opt-outs, statuses) that a silent ack
 * would lose for good.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Through the one config reader, which trims: a secret version saved with
  // a trailing newline would otherwise let Connect work (it reads the same
  // reader) while every webhook failed its check.
  const verifyToken = whatsappConfig().verifyToken;
  if (!verifyToken) {
    logWarn("whatsapp webhook: WHATSAPP_VERIFY_TOKEN not set");
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  const params = new URL(request.url).searchParams;
  const challenge = answerVerifyChallenge(params, verifyToken);
  if (challenge === null) {
    logWarn("whatsapp webhook: handshake refused", {
      mode: params.get("hub.mode") ?? null,
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  logInfo("whatsapp webhook: handshake verified", { ok: true });
  // The bare challenge, no JSON, no quotes — Meta compares it byte for byte.
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request: Request) {
  const appSecret = whatsappConfig().appSecret;
  if (!appSecret) {
    logWarn("whatsapp webhook: WHATSAPP_APP_SECRET not set; delivery refused");
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const raw = await request.text();
  const verdict = verifyMetaSignature(
    appSecret,
    raw,
    request.headers.get("x-hub-signature-256"),
  );
  if (!verdict.ok) {
    logWarn("whatsapp webhook: rejected", { reason: verdict.reason });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  if (!isWhatsAppWebhook(body)) {
    // A signed delivery for some other product on the same app. Nothing to do,
    // and a 200 is what stops Meta re-sending it.
    logInfo("whatsapp webhook: ignored non-WABA object", {
      object:
        typeof body === "object" && body && "object" in body
          ? String((body as { object?: unknown }).object)
          : "unknown",
    });
    return NextResponse.json({ ok: true, ignored: true });
  }

  const summary = summarizeWebhook(body);
  let recorded;
  try {
    recorded = await recordWebhookDelivery(body);
  } catch (err) {
    // Could not WRITE the rows: Meta must retry, so this is the one 503.
    logError("whatsapp webhook: record failed", err, { ...summary });
    return NextResponse.json({ error: "try again" }, { status: 503 });
  }

  logInfo("whatsapp webhook received", { ...summary, ...recorded });

  if (recorded.inserted > 0) {
    // Processing after the response, so Meta's deadline is never spent on
    // our database; the send-emails heartbeat drains anything this misses
    // (drainInboundEvents), including rows waiting out a retry backoff.
    after(async () => {
      try {
        const processed = await processPendingInboundEvents();
        // A failed WhatsApp released the SMS held behind it: send it now,
        // not at the next heartbeat (dev has no scheduler at all).
        if (processed.smsReleased > 0) await triggerEmailWorker();
      } catch (err) {
        logError("whatsapp webhook: deferred processing failed", err);
      }
    });
  }

  return NextResponse.json({ ok: true, acknowledged: true, ...recorded });
}
