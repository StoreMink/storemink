import "server-only";

import { execFile } from "node:child_process";
import { logError, logWarn } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// The web app's side of the image-matting service (services/image-matting,
// docs/image-matting-service.md): photo bytes in, a product mask out.
//
// ★ THE SERVICE IS PRIVATE. On Cloud Run the web app's runtime account
//   (storemink-run) holds roles/run.invoker on it and sends a Google identity
//   token minted for the service's URL. Locally, application-default
//   credentials are usually a USER account, which cannot mint one; outside
//   production the client then asks the gcloud CLI instead. A plain
//   http://localhost URL (the service run with `node server.mjs`) needs none.
// ★ ONE ATTEMPT. A cut-out takes 11-16 s on one instance that handles one
//   photo at a time; a retry on a busy service only makes the queue longer.
//   The caller tells the merchant to try again.
// ---------------------------------------------------------------------------

/** Cold start (about 7 s) + inference (11-16 s, occasionally 30) + a queue. */
export const MATTING_TIMEOUT_MS = 90_000;

export type MattingVerdict = "ok" | "empty" | "full";

export interface MattingResult {
  /** The mask as a PNG: 8-bit grey, white where the product is. */
  mask: Buffer;
  width: number;
  height: number;
  verdict: MattingVerdict;
  /** Share of pixels that are clearly product, 0-1. */
  coverage: number;
}

export type MattingErrorCode =
  | "not_configured"
  | "busy"
  | "unreadable"
  | "too_large"
  | "unavailable";

export class MattingError extends Error {
  constructor(
    readonly code: MattingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MattingError";
  }
}

/**
 * The service URL from IMAGE_MATTING_URL, or null when it is unset or not a
 * URL this client will send a photo to: https, or plain http to this machine.
 */
export function mattingUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.IMAGE_MATTING_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return null;
  }
  return url.origin;
}

export function mattingConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return mattingUrl(env) !== null;
}

function isLocal(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

type TokenSource = (audience: string) => Promise<string>;

let cachedCliToken: { value: string; expires: number } | null = null;

/** Local development only: `gcloud auth print-identity-token`. */
function cliIdentityToken(): Promise<string> {
  if (cachedCliToken && cachedCliToken.expires > Date.now()) {
    return Promise.resolve(cachedCliToken.value);
  }
  return new Promise((resolve, reject) => {
    execFile(
      "gcloud",
      ["auth", "print-identity-token"],
      { timeout: 15_000 },
      (error, stdout) => {
        const token = String(stdout ?? "").trim();
        if (error || !token) {
          reject(error ?? new Error("gcloud printed no identity token"));
          return;
        }
        // Identity tokens last an hour; refresh well before.
        cachedCliToken = { value: token, expires: Date.now() + 45 * 60_000 };
        resolve(token);
      },
    );
  });
}

let idTokenClient: Promise<{
  getRequestHeaders(url?: string): Promise<Headers>;
}> | null = null;

const defaultTokenSource: TokenSource = async (audience) => {
  try {
    if (!idTokenClient) {
      idTokenClient = import("google-auth-library").then(({ GoogleAuth }) =>
        new GoogleAuth().getIdTokenClient(audience),
      );
    }
    const headers = await (await idTokenClient).getRequestHeaders(audience);
    const value = headers.get("authorization") ?? "";
    const token = value.replace(/^Bearer\s+/i, "");
    if (token) return token;
    throw new Error("no identity token in the request headers");
  } catch (error) {
    idTokenClient = null;
    if (process.env.NODE_ENV === "production") throw error;
    return cliIdentityToken();
  }
};

async function readError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

function verdictFrom(value: string | null): MattingVerdict {
  return value === "empty" || value === "full" ? value : "ok";
}

/**
 * Cuts the product out of `photo` and returns its mask, at the photo's own
 * size after EXIF rotation (scaled to fit 4096 px if larger).
 */
export async function requestProductMask(
  photo: Buffer,
  options: {
    env?: NodeJS.ProcessEnv;
    tokenSource?: TokenSource;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<MattingResult> {
  const origin = mattingUrl(options.env);
  if (!origin) {
    throw new MattingError(
      "not_configured",
      "Background removal is not available right now.",
    );
  }
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  };
  if (!isLocal(origin)) {
    try {
      const token = await (options.tokenSource ?? defaultTokenSource)(origin);
      headers.authorization = `Bearer ${token}`;
    } catch (error) {
      logError("image matting: no identity token", error, {});
      throw new MattingError(
        "unavailable",
        "Background removal is not available right now.",
      );
    }
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${origin}/v1/matte?output=mask`,
      {
        method: "POST",
        headers,
        body: new Uint8Array(photo),
        signal: AbortSignal.timeout(MATTING_TIMEOUT_MS),
      },
    );
  } catch (error) {
    logError("image matting: request failed", error, {});
    throw new MattingError(
      "unavailable",
      "Background removal took too long. Nothing was charged; try again in a minute.",
    );
  }

  if (!response.ok) {
    const code = await readError(response);
    logWarn("image matting: refused", { status: response.status, code });
    if (response.status === 429 || response.status === 503) {
      throw new MattingError(
        "busy",
        "Background removal is busy. Nothing was charged; try again in a minute.",
      );
    }
    if (code === "too_large" || code === "too_many_pixels") {
      throw new MattingError(
        "too_large",
        "This photo is too large to process. Use one under 20 MB and 40 megapixels.",
      );
    }
    if (code === "unsupported_type" || code === "unreadable_image") {
      throw new MattingError(
        "unreadable",
        "This photo couldn't be read. Upload it again as a JPG, PNG or WebP.",
      );
    }
    throw new MattingError(
      "unavailable",
      "Background removal is not available right now. Nothing was charged.",
    );
  }

  const width = Number(response.headers.get("x-matting-width"));
  const height = Number(response.headers.get("x-matting-height"));
  const mask = Buffer.from(await response.arrayBuffer());
  if (!(width > 0) || !(height > 0) || mask.length === 0) {
    logWarn("image matting: malformed answer", {
      width,
      height,
      bytes: mask.length,
    });
    throw new MattingError(
      "unavailable",
      "Background removal returned nothing usable. Nothing was charged; try again.",
    );
  }
  return {
    mask,
    width,
    height,
    verdict: verdictFrom(response.headers.get("x-matting-verdict")),
    coverage: Number(response.headers.get("x-matting-coverage")) || 0,
  };
}
