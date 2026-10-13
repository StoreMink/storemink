import "server-only";

import { logError } from "@/lib/observability/logger";
import { graphBase, whatsappConfig } from "./config";

// ---------------------------------------------------------------------------
// Meta Graph API for WhatsApp, over plain fetch — the lib/sms/twilio.ts shape,
// for the same reasons: no SDK to keep current, no surprise dependency, every
// request shape visible in one file.
//
// ── ★ THE OUTCOME VOCABULARY IS THE POINT ──────────────────────────────────
// Every call has THREE outcomes. `rejected` is a verdict from Meta (a 4xx with
// an error object: bad token, unknown WABA, a template that does not exist);
// `unknown` is a timeout, a 5xx or a thrown request, where the thing may well
// have happened. A send that is `unknown` must not be retried — a phone
// buzzing twice is worse than once (§26's refund rule, §37's SMS rule).
//
// ── ★ THE TOKEN IS AN ARGUMENT, NEVER MODULE STATE ────────────────────────
// This client serves every merchant's WABA from one process. A token cached
// on the module is how one store's request goes out under another's identity.
// ---------------------------------------------------------------------------

export type GraphResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      outcome: "rejected" | "unknown";
      error: string;
      /** Meta's numeric error code when it gave one (190 = bad token, 100 =
       *  bad parameter, 131030 = recipient not allowed, …). */
      code?: number;
      /** Meta's sub-code, which distinguishes e.g. an expired token (463)
       *  from a revoked one (460) under code 190. */
      subcode?: number;
    };

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

const TIMEOUT_MS = 20_000;

export interface GraphRequest {
  method?: "GET" | "POST" | "DELETE";
  /** Path under the versioned base, e.g. `/123/subscribed_apps`. */
  path: string;
  /** Bearer token. Omit only for the app-level calls that use the app secret. */
  token?: string;
  /** Query parameters (GET) — appended to the path. */
  query?: Record<string, string>;
  /** JSON body (POST). */
  body?: unknown;
}

/**
 * One Graph call, classified.
 *
 * Exported for the few callers whose shape is not worth a named wrapper; the
 * wrappers below are the documented surface.
 */
export async function graphRequest<T>(
  req: GraphRequest,
): Promise<GraphResult<T>> {
  const url = new URL(`${graphBase()}${req.path}`);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {};
  if (req.token) headers.authorization = `Bearer ${req.token}`;
  if (req.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method ?? (req.body !== undefined ? "POST" : "GET"),
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Never reached Meta, or never heard back. The request may have landed.
    logError("whatsapp graph: request failed", err, {
      path: redactPath(req.path),
    });
    return { ok: false, outcome: "unknown", error: "Couldn't reach Meta." };
  }

  // ★ A 5xx IS NOT A REJECTION — no verdict was given.
  if (res.status >= 500) {
    return { ok: false, outcome: "unknown", error: `Meta ${res.status}.` };
  }

  const payload = (await res.json().catch(() => null)) as
    | (T & GraphErrorBody)
    | null;

  if (!res.ok || payload?.error) {
    const e = payload?.error;
    return {
      ok: false,
      outcome: "rejected",
      // Meta's own message names the real problem; `error_user_msg` is the
      // merchant-readable form when there is one.
      error:
        e?.error_user_msg ||
        e?.message ||
        `Meta rejected the request (${res.status}).`,
      code: e?.code,
      subcode: e?.error_subcode,
    };
  }

  if (payload === null) {
    return { ok: false, outcome: "unknown", error: "Meta sent no body." };
  }
  return { ok: true, data: payload };
}

/** Graph paths carry ids, never secrets, but a token can appear in a query
 *  string on the app-level calls; those pass it as a parameter, which is why
 *  only the path is logged. */
function redactPath(path: string): string {
  return path.split("?")[0];
}

// ── Embedded Signup ─────────────────────────────────────────────────────────

/**
 * Exchange the code Embedded Signup hands the browser for a business token.
 *
 * ★ SERVER-TO-SERVER, with the app secret. The browser only ever sees the
 * short-lived code; the token that can send as the merchant never leaves the
 * server (docs/whatsapp-phase0.md: Tech Providers use business tokens only).
 * Business integration tokens do not expire on a schedule; they die when the
 * merchant revokes the app or changes their password, which Meta reports as
 * code 190 on the next call — `needs_reauth` in the account row.
 */
export async function exchangeEmbeddedSignupCode(
  code: string,
): Promise<GraphResult<{ access_token: string }>> {
  const { appId, appSecret } = whatsappConfig();
  if (!appId || !appSecret) {
    return {
      ok: false,
      outcome: "rejected",
      error: "WhatsApp isn't configured on this environment.",
    };
  }
  return graphRequest<{ access_token: string }>({
    method: "GET",
    path: "/oauth/access_token",
    query: { client_id: appId, client_secret: appSecret, code },
  });
}

export interface DebugTokenData {
  app_id?: string;
  is_valid?: boolean;
  type?: string;
  scopes?: string[];
  granular_scopes?: { scope: string; target_ids?: string[] }[];
}

/**
 * What a token can actually reach.
 *
 * ★ THIS IS HOW A WABA ID FROM THE BROWSER BECOMES TRUSTED. The SDK posts
 * `waba_id` and `phone_number_id` to the page, and a page can post anything.
 * The token's `granular_scopes` list the WABA ids the merchant granted; a
 * WABA not in that list is a claim, not a fact.
 */
export async function debugToken(
  token: string,
): Promise<GraphResult<{ data: DebugTokenData }>> {
  const { appId, appSecret } = whatsappConfig();
  return graphRequest<{ data: DebugTokenData }>({
    method: "GET",
    path: "/debug_token",
    query: { input_token: token, access_token: `${appId}|${appSecret}` },
  });
}

// ── WABA and phone number ───────────────────────────────────────────────────

export interface WabaInfo {
  id: string;
  name?: string;
  timezone_id?: string;
  message_template_namespace?: string;
  account_review_status?: string;
  currency?: string;
}

export async function getWaba(
  token: string,
  wabaId: string,
): Promise<GraphResult<WabaInfo>> {
  return graphRequest<WabaInfo>({
    path: `/${encodeURIComponent(wabaId)}`,
    token,
    query: {
      fields:
        "id,name,timezone_id,message_template_namespace,account_review_status,currency",
    },
  });
}

export interface PhoneNumberInfo {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  name_status?: string;
  quality_rating?: string;
  code_verification_status?: string;
  messaging_limit_tier?: string;
  platform_type?: string;
  status?: string;
  is_official_business_account?: boolean;
}

export async function getPhoneNumber(
  token: string,
  phoneNumberId: string,
): Promise<GraphResult<PhoneNumberInfo>> {
  return graphRequest<PhoneNumberInfo>({
    path: `/${encodeURIComponent(phoneNumberId)}`,
    token,
    query: {
      fields:
        "id,display_phone_number,verified_name,name_status,quality_rating,code_verification_status,messaging_limit_tier,platform_type,status,is_official_business_account",
    },
  });
}

/**
 * Subscribe OUR app to a merchant's WABA.
 *
 * ★★ NOT OPTIONAL, AND NOT DONE BY THE DASHBOARD. Phase 0 found that a WABA
 * with every webhook field subscribed delivers nothing to an app that is not
 * subscribed to that WABA, and nothing reports it — the merchant's inbox is
 * simply silent (docs/whatsapp-phase0.md §4.2). The token decides which app
 * is subscribed, so a business token from our Embedded Signup subscribes us.
 */
export async function subscribeAppToWaba(
  token: string,
  wabaId: string,
): Promise<GraphResult<{ success: boolean }>> {
  return graphRequest<{ success: boolean }>({
    method: "POST",
    path: `/${encodeURIComponent(wabaId)}/subscribed_apps`,
    token,
  });
}

export async function unsubscribeAppFromWaba(
  token: string,
  wabaId: string,
): Promise<GraphResult<{ success: boolean }>> {
  return graphRequest<{ success: boolean }>({
    method: "DELETE",
    path: `/${encodeURIComponent(wabaId)}/subscribed_apps`,
    token,
  });
}

/**
 * Register the number for Cloud API messaging with a two-step-verification
 * PIN. Idempotent at Meta: registering an already-registered number with the
 * same PIN succeeds. ★ A COEXISTENCE NUMBER IS ALREADY REGISTERED by the
 * WhatsApp Business app and this call is skipped for it (connect.ts).
 */
export async function registerPhoneNumber(
  token: string,
  phoneNumberId: string,
  pin: string,
): Promise<GraphResult<{ success: boolean }>> {
  return graphRequest<{ success: boolean }>({
    method: "POST",
    path: `/${encodeURIComponent(phoneNumberId)}/register`,
    token,
    body: { messaging_product: "whatsapp", pin },
  });
}

export interface BusinessProfileInput {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  websites?: string[];
  vertical?: string;
}

export async function updateBusinessProfile(
  token: string,
  phoneNumberId: string,
  profile: BusinessProfileInput,
): Promise<GraphResult<{ success: boolean }>> {
  return graphRequest<{ success: boolean }>({
    method: "POST",
    path: `/${encodeURIComponent(phoneNumberId)}/whatsapp_business_profile`,
    token,
    body: { messaging_product: "whatsapp", ...profile },
  });
}

// ── Message templates ───────────────────────────────────────────────────────

export interface TemplateCreateInput {
  name: string;
  language: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  components: unknown[];
}

export interface TemplateCreateData {
  id: string;
  status?: string;
  category?: string;
}

/**
 * Submit a template for review. Meta answers with its id and an initial
 * status (PENDING, or APPROVED at once for a body it has seen before).
 * ★ ONE NAME PER WABA: resubmitting an existing name is REJECTED with code
 * 100 / subcode 2388023, which the bootstrap treats as "already there" and
 * resolves by listing (below) rather than as a failure.
 */
export async function createMessageTemplate(
  token: string,
  wabaId: string,
  input: TemplateCreateInput,
): Promise<GraphResult<TemplateCreateData>> {
  return graphRequest<TemplateCreateData>({
    method: "POST",
    path: `/${encodeURIComponent(wabaId)}/message_templates`,
    token,
    body: input,
  });
}

export interface TemplateListRow {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  rejected_reason?: string;
  quality_score?: { score?: string };
}

/** The WABA's templates, first page (Meta pages at 100; a store's bootstrap
 *  set is under 20, so one page is the whole answer for ours). */
export async function listMessageTemplates(
  token: string,
  wabaId: string,
  names?: string[],
): Promise<GraphResult<{ data: TemplateListRow[] }>> {
  const query: Record<string, string> = {
    fields: "id,name,language,status,category,rejected_reason,quality_score",
    limit: "100",
  };
  if (names && names.length === 1) query.name = names[0];
  return graphRequest<{ data: TemplateListRow[] }>({
    path: `/${encodeURIComponent(wabaId)}/message_templates`,
    token,
    query,
  });
}

/**
 * Delete a template at Meta. With `hsmId` (Meta's template id) only that
 * language is deleted; by name alone Meta deletes EVERY language of the name,
 * so the id is passed whenever the row holds one. Meta answers a template it
 * does not hold with an error, which the caller reads as already gone.
 */
export async function deleteMessageTemplate(
  token: string,
  wabaId: string,
  input: { name: string; hsmId?: string | null },
): Promise<GraphResult<{ success?: boolean }>> {
  const query: Record<string, string> = { name: input.name };
  if (input.hsmId) query.hsm_id = input.hsmId;
  return graphRequest<{ success?: boolean }>({
    method: "DELETE",
    path: `/${encodeURIComponent(wabaId)}/message_templates`,
    token,
    query,
  });
}

// ── Sending ─────────────────────────────────────────────────────────────────

export interface SendTemplateInput {
  /** Digits only, country code first — Meta's `to`. */
  to: string;
  name: string;
  language: string;
  /** Body parameters, positional. */
  bodyParams: string[];
  /** One payload per quick-reply button, in the template's button order. A
   *  tap comes back in the webhook carrying it. Absent: the template has no
   *  buttons, or none need telling apart. */
  quickReplyPayloads?: string[];
}

export interface SendMessageData {
  messaging_product?: string;
  contacts?: { input?: string; wa_id?: string }[];
  messages?: { id: string; message_status?: string }[];
}

/**
 * One template message. ★ ONLY `lib/whatsapp/send.ts` MAY CALL THIS — it is
 * the choke point that writes the log row, and `send-coverage.test.ts` fails
 * on any other caller.
 */
export async function sendTemplateMessage(
  token: string,
  phoneNumberId: string,
  input: SendTemplateInput,
): Promise<GraphResult<SendMessageData>> {
  const components: unknown[] =
    input.bodyParams.length > 0
      ? [
          {
            type: "body",
            parameters: input.bodyParams.map((text) => ({
              type: "text",
              text,
            })),
          },
        ]
      : [];
  (input.quickReplyPayloads ?? []).forEach((payload, index) => {
    components.push({
      type: "button",
      sub_type: "quick_reply",
      index: String(index),
      parameters: [{ type: "payload", payload }],
    });
  });
  return graphRequest<SendMessageData>({
    method: "POST",
    path: `/${encodeURIComponent(phoneNumberId)}/messages`,
    token,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "template",
      template: {
        name: input.name,
        language: { code: input.language },
        components,
      },
    },
  });
}

export interface SendTextInput {
  /** Digits only, country code first — Meta's `to`. */
  to: string;
  body: string;
  /** Meta's id of the message being replied to, for a quote bubble. */
  replyToProviderId?: string | null;
}

/**
 * One free-form text message — allowed only inside the 24-hour window the
 * customer opened by writing first; outside it Meta refuses with 131047.
 * ★ ONLY `lib/whatsapp/send.ts` MAY CALL THIS, for the template send's
 * reason: the choke point is what writes the log row.
 */
export async function sendTextMessage(
  token: string,
  phoneNumberId: string,
  input: SendTextInput,
): Promise<GraphResult<SendMessageData>> {
  return graphRequest<SendMessageData>({
    method: "POST",
    path: `/${encodeURIComponent(phoneNumberId)}/messages`,
    token,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "text",
      ...(input.replyToProviderId
        ? { context: { message_id: input.replyToProviderId } }
        : {}),
      text: { preview_url: false, body: input.body },
    },
  });
}

export interface InteractiveButton {
  /** What a tap carries back (menu-payload.ts), at most 256 characters. */
  id: string;
  /** The label, at most 20 characters. */
  title: string;
}

export interface SendInteractiveInput {
  /** Digits only, country code first — Meta's `to`. */
  to: string;
  /** At most 1,024 characters. */
  body: string;
  /** One to three reply buttons, in the order shown. */
  buttons: InteractiveButton[];
}

/**
 * One reply-button message (Meta's `interactive` type, `button` sub-type):
 * a body and up to three buttons whose tap comes back as an `interactive`
 * message carrying the button's id. Like free text it is allowed only inside
 * the 24-hour window. ★ ONLY `lib/whatsapp/send.ts` MAY CALL THIS, for the
 * template send's reason: the choke point is what writes the log row.
 */
export async function sendInteractiveMessage(
  token: string,
  phoneNumberId: string,
  input: SendInteractiveInput,
): Promise<GraphResult<SendMessageData>> {
  return graphRequest<SendMessageData>({
    method: "POST",
    path: `/${encodeURIComponent(phoneNumberId)}/messages`,
    token,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: input.body },
        action: {
          buttons: input.buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    },
  });
}

// ── Media ───────────────────────────────────────────────────────────────────

export interface MediaInfo {
  id: string;
  url: string;
  mime_type?: string;
  sha256?: string;
  file_size?: number;
}

/**
 * Where to fetch an inbound media object. The URL Meta returns is on a
 * lookaside host, expires in minutes and needs the bearer token — which is
 * why inbound media is copied into our own bucket rather than linked.
 */
export async function getMediaInfo(
  token: string,
  mediaId: string,
): Promise<GraphResult<MediaInfo>> {
  return graphRequest<MediaInfo>({
    path: `/${encodeURIComponent(mediaId)}`,
    token,
  });
}

/**
 * The bytes behind a media URL, bounded. Not a Graph call — the URL is on
 * Meta's download host — but it is still the merchant's token being
 * presented, so it lives beside the client that owns that rule.
 */
export async function downloadMedia(
  token: string,
  url: string,
  maxBytes: number,
): Promise<GraphResult<{ bytes: Uint8Array; contentType: string | null }>> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, outcome: "rejected", error: "Bad media URL." };
  }
  // The token must only ever go to Meta. A payload naming another host would
  // otherwise have us present a merchant's token to a stranger.
  if (
    parsed.protocol !== "https:" ||
    !/(^|\.)(facebook\.com|fbcdn\.net|fbsbx\.com|whatsapp\.net)$/i.test(
      parsed.hostname,
    )
  ) {
    return {
      ok: false,
      outcome: "rejected",
      error: "Media URL is not on a Meta host.",
    };
  }
  let res: Response;
  try {
    res = await fetch(parsed, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    logError("whatsapp graph: media download failed", err);
    return { ok: false, outcome: "unknown", error: "Couldn't reach Meta." };
  }
  if (res.status >= 500) {
    return { ok: false, outcome: "unknown", error: `Meta ${res.status}.` };
  }
  if (!res.ok) {
    return {
      ok: false,
      outcome: "rejected",
      error: `Meta refused the download (${res.status}).`,
    };
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    return { ok: false, outcome: "rejected", error: "Media is too large." };
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > maxBytes) {
    return {
      ok: false,
      outcome: "rejected",
      error: buf.byteLength === 0 ? "Media is empty." : "Media is too large.",
    };
  }
  return {
    ok: true,
    data: { bytes: buf, contentType: res.headers.get("content-type") },
  };
}

/** Meta's "already exists" answer to a template create. */
export function isTemplateExistsError(result: GraphResult<unknown>): boolean {
  return (
    !result.ok &&
    result.outcome === "rejected" &&
    (result.subcode === 2388023 || /already exists/i.test(result.error))
  );
}

/** True when Meta says the token itself is dead (revoked, expired, password
 *  changed) rather than the request being wrong — the signal for
 *  `needs_reauth`. */
export function isTokenError(result: GraphResult<unknown>): boolean {
  return !result.ok && result.outcome === "rejected" && result.code === 190;
}
