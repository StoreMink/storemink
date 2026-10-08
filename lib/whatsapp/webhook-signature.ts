import "server-only";

// ---------------------------------------------------------------------------
// Meta webhook authentication — two unrelated secrets, two unrelated checks.
//
// Written out rather than pulling in an SDK, matching the Razorpay HMAC
// (lib/payments/razorpay.ts) and the Svix verifier (lib/email/webhook-signature.ts):
// a webhook verifier is exactly the code you want to be able to read.
//
// ── ★ THE VERIFY TOKEN IS NOT THE APP SECRET ────────────────────────────────
// Meta's GET handshake proves WE own the URL (it sends `hub.verify_token`, a
// value we chose, and expects `hub.challenge` echoed back). Every POST after
// that is proved by META: `X-Hub-Signature-256` is an HMAC-SHA256 over the raw
// body keyed with the APP SECRET. One is a shared password for a one-time
// handshake; the other signs every delivery for the life of the app. Treating
// either as the other is how an endpoint ends up accepting unsigned payloads.
//
// ── ★ THE RAW BODY, BYTE FOR BYTE ───────────────────────────────────────────
// Meta escapes non-ASCII (`é` → `é`) before signing, so parsing and
// re-serialising the JSON produces different bytes and a digest that never
// matches. Callers pass `await request.text()`, never a parsed object.
// ---------------------------------------------------------------------------

import crypto from "crypto";

const PREFIX = "sha256=";

/**
 * Verify Meta's `X-Hub-Signature-256` header against the raw request body.
 *
 * @param appSecret the Meta app's App Secret (never a token, never the verify token)
 * @param body      the RAW request body
 * @param header    the `X-Hub-Signature-256` header, `sha256=<hex>`
 */
export function verifyMetaSignature(
  appSecret: string,
  body: string,
  header: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (!appSecret) return { ok: false, reason: "no app secret configured" };
  if (!header) return { ok: false, reason: "missing signature header" };
  if (!header.startsWith(PREFIX)) {
    return { ok: false, reason: "malformed signature header" };
  }

  const received = Buffer.from(header.slice(PREFIX.length), "hex");
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(body, "utf8")
    .digest();

  // ★ Length check first: `timingSafeEqual` THROWS on unequal lengths, and a
  // thrown verifier is a 500 that Meta retries for a week.
  if (received.length !== expected.length) {
    return { ok: false, reason: "signature mismatch" };
  }
  if (!crypto.timingSafeEqual(received, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

/**
 * Answer Meta's subscription handshake.
 *
 * Returns the challenge to echo back (as a plain-text 200) when the mode and
 * token match, otherwise null. Meta sends `hub.mode=subscribe`,
 * `hub.verify_token=<ours>` and `hub.challenge=<random>`; the body of the
 * response must be the bare challenge — no JSON, no quotes.
 */
export function answerVerifyChallenge(
  params: URLSearchParams,
  verifyToken: string,
): string | null {
  if (!verifyToken) return null;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge");
  if (mode !== "subscribe" || !challenge) return null;

  // Constant-time, like the signature: the token is a shared secret and the
  // endpoint is public.
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(verifyToken, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return challenge;
}
