import "server-only";

// ---------------------------------------------------------------------------
// WhatsApp Cloud API configuration — read in ONE place.
//
// A Meta app has exactly one webhook URL, so dev and production are two Meta
// apps and every value here is per environment (docs/whatsapp-phase0.md §3).
// `cloudbuild.yaml` sets them; locally they come from .env.
//
// ── ★ TWO SECRETS, TWO PROOFS ───────────────────────────────────────────────
// `appSecret` is Meta's: it signs every webhook POST and, with the app id,
// exchanges an Embedded Signup code for a business token. `verifyToken` is
// OURS and answers only the one-time GET handshake. Neither is ever sent to a
// browser; the app id and the Embedded Signup configuration id ARE (the SDK
// needs them) and are public identifiers.
// ---------------------------------------------------------------------------

/** Meta releases a Graph version roughly every four months and keeps each for
 *  ~two years. Pinned so a default roll cannot change a response shape under
 *  us; `WHATSAPP_GRAPH_VERSION` overrides. */
export const DEFAULT_GRAPH_VERSION = "v26.0";

export interface WhatsAppConfig {
  appId: string;
  appSecret: string;
  verifyToken: string;
  /** Embedded Signup configuration id; empty until runbook §4.3 is done. */
  configId: string;
  graphVersion: string;
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function whatsappConfig(): WhatsAppConfig {
  return {
    appId: env("WHATSAPP_APP_ID"),
    appSecret: env("WHATSAPP_APP_SECRET"),
    verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
    configId: env("WHATSAPP_CONFIG_ID"),
    graphVersion: env("WHATSAPP_GRAPH_VERSION") || DEFAULT_GRAPH_VERSION,
  };
}

/**
 * Can a merchant connect at all?
 *
 * Three values, because the connect button needs the first and third to open
 * Meta's popup and the exchange needs the second to finish it — and a card
 * that opens a popup the server cannot complete is §23's control that always
 * fails. The verify token is NOT part of this: it only matters at webhook
 * registration, which is a platform step, not a merchant one.
 */
export function whatsappConnectConfigured(): boolean {
  const c = whatsappConfig();
  return Boolean(c.appId && c.appSecret && c.configId);
}

export function graphBase(version = whatsappConfig().graphVersion): string {
  return `https://graph.facebook.com/${version}`;
}
