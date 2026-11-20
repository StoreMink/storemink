// ---------------------------------------------------------------------------
// Meta's Embedded Signup, in the browser.
//
// Two things come back from the popup by two different routes, and the
// connect call needs both:
//   • the CODE arrives in the FB.login callback (`authResponse.code`);
//   • the WABA id and phone number id arrive as a `message` event posted by
//     the popup to this window (`type: "WA_EMBEDDED_SIGNUP"`).
// This module joins them and hands the server one object. The server then
// proves the ids against the token (lib/whatsapp/connect.ts) — nothing a page
// posts is trusted on its own.
//
// ★ ONLY MESSAGES FROM facebook.com ARE READ. The event listener is the one
// place a third-party page could inject an id, so the origin is checked
// before the payload is parsed.
//
// ★ COEXISTENCE FINISHES WITH ITS OWN EVENT. Meta's onboarding for a number
// on the WhatsApp Business app (featureType whatsapp_business_app_onboarding)
// posts FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING carrying the WABA id alone.
// Reading only FINISH, which needs both ids, let that flow time out with
// "didn't return the WhatsApp account" after the merchant had finished. The
// number then comes from the server, which lists the WABA's numbers under the
// proven token (lib/whatsapp/connect.ts), so phoneNumberId may be null.
// ---------------------------------------------------------------------------

export interface EmbeddedSignupInput {
  appId: string;
  configId: string;
  graphVersion: string;
  /** The number is already on the WhatsApp Business app (Coexistence). */
  coexistence: boolean;
}

export type EmbeddedSignupOutcome =
  | {
      ok: true;
      code: string;
      wabaId: string;
      /** Null when the Coexistence finish named only the WABA. */
      phoneNumberId: string | null;
    }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

interface FbLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}

interface FbSdk {
  init(opts: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(
    cb: (response: FbLoginResponse) => void,
    opts: Record<string, unknown>,
  ): void;
}

declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";
let sdkPromise: Promise<FbSdk> | null = null;

export function loadFacebookSdk(
  appId: string,
  graphVersion: string,
): Promise<FbSdk> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("No window."));
  }
  if (window.FB) return Promise.resolve(window.FB);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<FbSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      if (!window.FB) return reject(new Error("Facebook SDK did not load."));
      window.FB.init({
        appId,
        autoLogAppEvents: false,
        xfbml: false,
        version: graphVersion,
      });
      resolve(window.FB);
    };
    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      sdkPromise = null;
      reject(
        new Error(
          "Couldn't load Meta's sign-in script. An ad blocker or privacy extension may be stopping it.",
        ),
      );
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

/** Parse one popup message. Exported for its test; returns null for anything
 *  that is not an Embedded Signup event. */
export function parseSignupMessage(
  origin: string,
  data: unknown,
):
  | { event: "FINISH"; wabaId: string; phoneNumberId: string }
  | {
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";
      wabaId: string;
      phoneNumberId: string | null;
    }
  | { event: "FINISH_ONLY_WABA"; wabaId: string }
  | { event: "CANCEL" }
  | { event: "ERROR"; message: string }
  | null {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (host !== "facebook.com" && !host.endsWith(".facebook.com")) return null;

  let parsed: unknown = data;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.type !== "WA_EMBEDDED_SIGNUP") return null;
  const inner =
    typeof p.data === "object" && p.data !== null
      ? (p.data as Record<string, unknown>)
      : {};
  const event = typeof p.event === "string" ? p.event : "";
  const wabaId = typeof inner.waba_id === "string" ? inner.waba_id : "";
  const phoneNumberId =
    typeof inner.phone_number_id === "string" ? inner.phone_number_id : "";

  if (event === "FINISH" && wabaId && phoneNumberId) {
    return { event: "FINISH", wabaId, phoneNumberId };
  }
  // The number id is read when Meta sends one, never required.
  if (event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" && wabaId) {
    return {
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      wabaId,
      phoneNumberId: phoneNumberId || null,
    };
  }
  if (event === "FINISH_ONLY_WABA" && wabaId) {
    return { event: "FINISH_ONLY_WABA", wabaId };
  }
  if (event === "CANCEL") return { event: "CANCEL" };
  if (event === "ERROR") {
    return {
      event: "ERROR",
      message:
        typeof inner.error_message === "string"
          ? inner.error_message
          : "Meta reported an error during sign-up.",
    };
  }
  return null;
}

/**
 * Open the popup and resolve once both halves have arrived (or the merchant
 * closed it). Never rejects; every outcome is a value.
 */
export async function runEmbeddedSignup(
  input: EmbeddedSignupInput,
): Promise<EmbeddedSignupOutcome> {
  let fb: FbSdk;
  try {
    fb = await loadFacebookSdk(input.appId, input.graphVersion);
  } catch (err) {
    return {
      ok: false,
      cancelled: false,
      error:
        err instanceof Error ? err.message : "Couldn't load Meta's sign-in.",
    };
  }

  return new Promise<EmbeddedSignupOutcome>((resolve) => {
    let code: string | null = null;
    let ids: { wabaId: string; phoneNumberId: string | null } | null = null;
    let settled = false;

    const finish = (outcome: EmbeddedSignupOutcome) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      resolve(outcome);
    };
    const tryComplete = () => {
      if (code && ids) finish({ ok: true, code, ...ids });
    };

    const onMessage = (event: MessageEvent) => {
      const msg = parseSignupMessage(event.origin, event.data);
      if (!msg) return;
      if (
        msg.event === "FINISH" ||
        msg.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"
      ) {
        ids = { wabaId: msg.wabaId, phoneNumberId: msg.phoneNumberId };
        tryComplete();
      } else if (msg.event === "FINISH_ONLY_WABA") {
        finish({
          ok: false,
          cancelled: false,
          error:
            "The sign-up finished without a phone number. Open it again and add the number you want customers to message.",
        });
      } else if (msg.event === "CANCEL") {
        finish({ ok: false, cancelled: true });
      } else if (msg.event === "ERROR") {
        finish({ ok: false, cancelled: false, error: msg.message });
      }
    };
    window.addEventListener("message", onMessage);

    fb.login(
      (response) => {
        const c = response.authResponse?.code;
        if (!c) {
          // Closed the Facebook login itself, before the WhatsApp steps.
          finish({ ok: false, cancelled: true });
          return;
        }
        code = c;
        tryComplete();
        // The ids usually arrive a beat later than the code; give the popup
        // time to post them before calling it a failure.
        setTimeout(() => {
          if (!settled) {
            finish({
              ok: false,
              cancelled: false,
              error:
                "Meta signed you in but didn't return the WhatsApp account. Try again.",
            });
          }
        }, 15_000);
      },
      {
        config_id: input.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          // The Coexistence onboarding variant: the number stays on the
          // WhatsApp Business app and the API is added beside it.
          featureType: input.coexistence
            ? "whatsapp_business_app_onboarding"
            : "",
          sessionInfoVersion: "3",
        },
      },
    );
  });
}
