import "server-only";

import type { MinkVoiceProvider } from "./voice-provider";

export type MinkVoiceTranscript = {
  text: string;
  languageCode: string | null;
};

function cleanTranscript(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
        .trim()
    : "";
}

/**
 * The provider's own machine-readable reason for refusing, appended to the
 * thrown message so the SERVER LOG can name it.
 *
 * ★★ A BARE STATUS CODE IS NOT A DIAGNOSIS. `Chirp 3 returned 403.` is true of
 * an API nobody enabled on the project, a service account missing
 * `roles/speech.client`, and an expired credential — three different remedies,
 * two of them nothing to do with this codebase. Google answers all three with a
 * distinct `status` + `reason` pair (`PERMISSION_DENIED` / `SERVICE_DISABLED`),
 * and throwing it away is what made a disabled API take a hand-run probe
 * against the live endpoint to identify.
 *
 * ⚠ ENUMS ONLY, NEVER THE FREE-TEXT BODY. `message` is prose the provider may
 * change and may quote the request back; the codes are a closed vocabulary that
 * carries no audio, no transcript and no credential. Bounded, and any failure
 * to parse is simply omitted — a diagnostic must never be able to fail the call
 * it is describing.
 */
export async function refusalReason(response: Response): Promise<string> {
  try {
    const body = (await response.text()).slice(0, 4_000);
    const parsed = JSON.parse(body) as {
      error?: {
        status?: unknown;
        details?: Array<{ reason?: unknown }>;
      };
    };
    const codes = [
      parsed.error?.status,
      ...(parsed.error?.details ?? []).map((detail) => detail?.reason),
    ].filter((code): code is string => typeof code === "string");
    const unique = [...new Set(codes)].slice(0, 3);
    return unique.length ? ` (${unique.join(", ")})` : "";
  } catch {
    return "";
  }
}

type GoogleAuthClient = Awaited<
  ReturnType<import("google-auth-library").GoogleAuth["getClient"]>
>;
let authClient: Promise<GoogleAuthClient> | null = null;

/**
 * ★ ONE CLIENT PER INSTANCE. A new GoogleAuth per call threw away the token
 * the library caches, so every transcription and every read-aloud request
 * fetched a fresh token first (the metadata server on Cloud Run, a full
 * refresh exchange locally). The shared client reuses its token until shortly
 * before expiry and refreshes it itself; a failed setup is forgotten so the
 * next call can try again.
 */
export async function googleAccessToken(): Promise<string> {
  const client = (authClient ??= import("google-auth-library").then(
    ({ GoogleAuth }) =>
      new GoogleAuth({
        scopes: "https://www.googleapis.com/auth/cloud-platform",
      }).getClient(),
  ));
  try {
    const { token } = await (await client).getAccessToken();
    if (!token) throw new Error("Google Cloud credentials are unavailable.");
    return token;
  } catch (error) {
    // Forget only the client that failed: a concurrent caller may already
    // have replaced it with one that works, and dropping that would cost the
    // very token fetch this cache exists to avoid.
    if (authClient === client) authClient = null;
    throw error;
  }
}

async function transcribeWithChirp3(
  audio: Buffer,
  signal: AbortSignal,
): Promise<MinkVoiceTranscript> {
  const project = process.env.GCP_PROJECT_ID;
  if (!project) throw new Error("GCP_PROJECT_ID is not configured.");
  const location = process.env.MINK_CHIRP_LOCATION || "us";
  const token = await googleAccessToken();
  const response = await fetch(
    `https://${location}-speech.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/recognizers/_:recognize`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        config: {
          autoDecodingConfig: {},
          languageCodes: ["auto"],
          model: "chirp_3",
          features: { enableAutomaticPunctuation: true },
        },
        content: audio.toString("base64"),
      }),
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok)
    throw new Error(
      `Chirp 3 returned ${response.status}${await refusalReason(response)}.`,
    );
  const data = (await response.json()) as {
    results?: Array<{
      alternatives?: Array<{ transcript?: unknown }>;
      languageCode?: unknown;
    }>;
  };
  const text = (data.results ?? [])
    .map((result) => cleanTranscript(result.alternatives?.[0]?.transcript))
    .filter(Boolean)
    .join(" ")
    .trim();
  const languageCode = (data.results ?? []).find(
    (result) => typeof result.languageCode === "string",
  )?.languageCode;
  return {
    text,
    languageCode: typeof languageCode === "string" ? languageCode : null,
  };
}

async function transcribeWithSaarasV4(
  audio: Buffer,
  signal: AbortSignal,
): Promise<MinkVoiceTranscript> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("SARVAM_API_KEY is not configured.");
  const form = new FormData();
  form.set(
    "file",
    new Blob([Uint8Array.from(audio)], { type: "audio/wav" }),
    "voice-note.wav",
  );
  form.set("model", "saaras:v4");
  form.set("mode", "transcribe");
  form.set("language_code", "unknown");
  const response = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": apiKey },
    body: form,
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw new Error(
      `Saaras v4 returned ${response.status}${await refusalReason(response)}.`,
    );
  const data = (await response.json()) as {
    transcript?: unknown;
    language_code?: unknown;
  };
  const text = cleanTranscript(data.transcript);
  return {
    text,
    languageCode:
      typeof data.language_code === "string" ? data.language_code : null,
  };
}

/**
 * ★ NO WORDS IS AN ANSWER, NOT A FAILURE. A cough, a door or a breath that
 * crossed the speech floor comes back with an empty transcript, and throwing
 * on it turned it into a 503: dictation said the service was down, and voice
 * chat switched itself off over a sound in the room. The text is "" instead,
 * and each caller treats it as nothing heard.
 */
export function transcribeMinkVoice(
  provider: MinkVoiceProvider,
  audio: Buffer,
  signal: AbortSignal,
): Promise<MinkVoiceTranscript> {
  return provider === "saaras_v4"
    ? transcribeWithSaarasV4(audio, signal)
    : transcribeWithChirp3(audio, signal);
}
