import { NextResponse } from "next/server";
import {
  answerVerifyChallenge,
  verifyMetaSignature,
} from "@/lib/whatsapp/webhook-signature";
import {
  isWhatsAppWebhook,
  summarizeWebhook,
} from "@/lib/whatsapp/webhook-events";
import { logInfo, logWarn } from "@/lib/observability/logger";

/**
 * WhatsApp Cloud API webhook — Phase 0: verified, summarised, ACTING ON NOTHING.
 *
 * ★ ONE URL FOR EVERY MERCHANT. Meta posts every WABA onboarded through the
 * StoreMink app to this single endpoint; Phase 1 routes each delivery to a
 * store by `metadata.phone_number_id` (docs/whatsapp-commerce-plan.md §9).
 * Nothing here is per-store, which is why there is no `[storeId]` segment.
 *
 * ★ IT EXISTS BEFORE ANY TABLE DOES because Meta's app configuration cannot be
 * finished without it: registering a callback URL triggers the GET handshake
 * below, and App Review's demo video needs an inbound message to arrive
 * somewhere. So Phase 0's "no merchant code" rule has exactly this exception —
 * the two things Meta's console requires in order to proceed.
 *
 * Security is the two-webhook pattern this codebase already runs:
 *   • GET  — Meta proves we own the URL: `hub.verify_token` must equal
 *            WHATSAPP_VERIFY_TOKEN; we echo `hub.challenge` as plain text.
 *   • POST — Meta proves it is Meta: `X-Hub-Signature-256` is HMAC-SHA256 over
 *            the RAW body with WHATSAPP_APP_SECRET, checked before parsing.
 *
 * ★ `/api` BYPASSES proxy.ts (its matcher excludes it), so this route owns its
 * whole gate; there is no session and no store to fall back on.
 *
 * ⚠ NOTHING IS PERSISTED. The log line is a content-free summary (counts and
 * ids — never message text, never a `wa_id`). An unconfigured secret therefore
 * acks with 200 like the Resend route, because a delivery nobody processes is
 * not worth a retry storm; Phase 1 flips that to 503 the moment deliveries
 * carry data we would lose (orders, opt-outs, delivery statuses).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN ?? "";
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
  logInfo("whatsapp webhook: handshake verified");
  // The bare challenge, no JSON, no quotes — Meta compares it byte for byte.
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request: Request) {
  const appSecret = process.env.WHATSAPP_APP_SECRET ?? "";
  if (!appSecret) {
    logWarn("whatsapp webhook: WHATSAPP_APP_SECRET not set; delivery ignored");
    return NextResponse.json({ ok: false, reason: "not configured" });
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

  // Recorded in the log, not acted on. Phase 1 replaces this with the inbound
  // events table + worker (plan §9); the summary stays as the log line.
  const summary = summarizeWebhook(body);
  logInfo("whatsapp webhook received", { ...summary, acted: false });

  return NextResponse.json({ ok: true, acknowledged: true, acted: false });
}
