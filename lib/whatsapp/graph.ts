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

/** True when Meta says the token itself is dead (revoked, expired, password
 *  changed) rather than the request being wrong — the signal for
 *  `needs_reauth`. */
export function isTokenError(result: GraphResult<unknown>): boolean {
  return !result.ok && result.outcome === "rejected" && result.code === 190;
}
