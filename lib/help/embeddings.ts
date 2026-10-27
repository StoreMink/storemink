import "server-only";

import { vertexHost } from "@/lib/ai/gemini";

// Server-only transport for Help Centre retrieval embeddings. This module does
// not decide whether vector search should run and never throws provider errors:
// callers can keep lexical retrieval available whenever embeddings are
// unconfigured, throttled, malformed, or temporarily unavailable.
//
// ★★ THE MODEL IS gemini-embedding-2, THROUGH embedContent ON BOTH BACKENDS
// (2026-10-15). It was gemini-embedding-001 through Vertex's legacy `predict`
// endpoint, and Google has since capped that model at FIVE requests a minute
// per project, at the global location and in every region alike (measured on
// storemink-prod: `online_prediction_requests_per_base_model` and
// `global_embed_content_requests_per_minute_per_base_model`, base model
// `gemini-embedding`, effective limit 5). The reconciler sends five chunk
// requests at a time, so it could index one short guide per run and then hit
// 429 on the next, forever; the same bucket served every Help question's
// query embedding. gemini-embedding-2 is GA, answers this project at `global`
// with 768 dimensions, and carries a 300,000-a-minute bucket, but Vertex serves
// it only through `embedContent` (the `predict` endpoint reports it as not
// found), one input per request, with no batch form. So the Vertex path now
// sends the same EmbedContentRequest the Gemini Developer API path sends, and
// the per-document concurrency stays bounded rather than batched.
// ⚠ Chunks record the model they were embedded with, so changing this default
// re-embeds every guide on the next reconciler run; nothing else is needed.

export const HELP_EMBEDDING_DIMENSIONS = 768 as const;
export const DEFAULT_HELP_EMBEDDING_MODEL = "gemini-embedding-2";
export const HELP_EMBEDDING_MAX_TITLE_CHARS = 500;
export const HELP_EMBEDDING_MAX_DOCUMENTS = 100;

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_INPUT_CHARS = 20_000;
const DEVELOPER_BATCH_SIZE = 50;
const VERTEX_CONCURRENCY = 5;

type EmbeddingTask = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";

export type HelpEmbeddingBackend = "gemini-api" | "vertex-ai";

export type HelpEmbeddingErrorCode =
  | "invalid-input"
  | "not-configured"
  | "authentication"
  | "rate-limited"
  | "timeout"
  | "provider-rejected"
  | "provider-unavailable"
  | "invalid-response";

export interface HelpEmbeddingError {
  code: HelpEmbeddingErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
}

export type HelpEmbeddingResult<T> =
  | {
      ok: true;
      value: T;
      backend: HelpEmbeddingBackend;
      model: string;
      dimensions: typeof HELP_EMBEDDING_DIMENSIONS;
    }
  | { ok: false; error: HelpEmbeddingError };

export interface HelpEmbeddingDocument {
  title: string;
  text: string;
}

type EmbedMethod = "embedContent" | "batchEmbedContents";

interface Provider {
  backend: HelpEmbeddingBackend;
  model: string;
  url: (method: EmbedMethod) => string;
  headers: Record<string, string>;
}

type InternalFailure = { ok: false; error: HelpEmbeddingError };
type InternalResult<T> = { ok: true; value: T } | InternalFailure;

function failure(
  code: HelpEmbeddingErrorCode,
  message: string,
  retryable: boolean,
  status?: number,
): InternalFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(status === undefined ? {} : { status }),
    },
  };
}

function success<T>(provider: Provider, value: T): HelpEmbeddingResult<T> {
  return {
    ok: true,
    value,
    backend: provider.backend,
    model: provider.model,
    dimensions: HELP_EMBEDDING_DIMENSIONS,
  };
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").trim();
  return text.length > 0 && text.length <= max ? text : null;
}

export function configuredHelpEmbeddingModel(): string | null {
  const model =
    process.env.GEMINI_EMBEDDING_MODEL?.trim() || DEFAULT_HELP_EMBEDDING_MODEL;
  return /^[A-Za-z0-9._-]+$/.test(model) ? model : null;
}

async function vertexAccessToken(): Promise<string | null> {
  try {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({
      scopes: "https://www.googleapis.com/auth/cloud-platform",
    });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    return token?.trim() || null;
  } catch {
    return null;
  }
}

async function resolveProvider(): Promise<InternalResult<Provider>> {
  const model = configuredHelpEmbeddingModel();
  if (!model) {
    return failure(
      "not-configured",
      "The Help embedding model is not configured correctly.",
      false,
    );
  }

  // Match lib/ai/gemini.ts: an API key wins when both backends are configured,
  // while production can omit the key and use Vertex AI through ADC.
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (apiKey) {
    return {
      ok: true,
      value: {
        backend: "gemini-api",
        model,
        url: (method) =>
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${method}`,
        headers: { "x-goog-api-key": apiKey },
      },
    };
  }

  const projectId = process.env.GCP_PROJECT_ID?.trim();
  if (!projectId) {
    return failure(
      "not-configured",
      "Help embeddings are not configured.",
      false,
    );
  }
  const token = await vertexAccessToken();
  if (!token) {
    return failure(
      "authentication",
      "Vertex AI credentials are unavailable.",
      false,
    );
  }
  const location = process.env.GCP_LOCATION?.trim() || "global";
  // ★ The host follows the kind of location (lib/ai/gemini.ts): `global`
  //   has none, the multi-regions `us` and `eu` have their own
  //   `aiplatform.<mr>.rep.googleapis.com`, a region prefixes the host. The
  //   old `${location}-aiplatform` rule named a host that does not exist for
  //   a multi-region.
  const host = vertexHost(location);
  return {
    ok: true,
    value: {
      backend: "vertex-ai",
      model,
      // One EmbedContentRequest per call; Vertex has no batch form of it.
      url: (method) =>
        `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:${method}`,
      headers: { Authorization: `Bearer ${token}` },
    },
  };
}

function providerFailure(status: number): InternalFailure {
  if (status === 401 || status === 403) {
    return failure(
      "authentication",
      "The embedding provider rejected its credentials.",
      false,
      status,
    );
  }
  if (status === 429) {
    return failure(
      "rate-limited",
      "The embedding provider is rate-limited.",
      true,
      status,
    );
  }
  if (status >= 500) {
    return failure(
      "provider-unavailable",
      "The embedding provider is temporarily unavailable.",
      true,
      status,
    );
  }
  return failure(
    "provider-rejected",
    "The embedding provider rejected the request.",
    false,
    status,
  );
}

function fetchFailure(error: unknown): InternalFailure {
  // DOMException may come from a different runtime realm (jsdom, undici, or
  // Next's worker), so `instanceof Error` is not a reliable timeout check.
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return failure("timeout", "The embedding request timed out.", true);
  }
  return failure(
    "provider-unavailable",
    "The embedding provider could not be reached.",
    true,
  );
}

async function postJson(
  provider: Provider,
  method: EmbedMethod,
  body: unknown,
): Promise<InternalResult<unknown>> {
  let response: Response;
  try {
    response = await fetch(provider.url(method), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...provider.headers,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return fetchFailure(error);
  }

  if (!response.ok) return providerFailure(response.status);
  const value = await response.json().catch(() => null);
  if (value === null) {
    return failure(
      "invalid-response",
      "The embedding provider returned invalid JSON.",
      true,
    );
  }
  return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Validate and unit-normalize every vector. A Gemini embedding requested at
 * a reduced dimension such as 768 is not unit length, so it is normalized here
 * before storage or comparison. */
function embeddingVector(value: unknown): number[] | null {
  if (!isRecord(value)) return null;
  const statistics = value.statistics;
  if (isRecord(statistics) && statistics.truncated === true) {
    return null;
  }
  const values = value.values;
  if (
    !Array.isArray(values) ||
    values.length !== HELP_EMBEDDING_DIMENSIONS ||
    !values.every(
      (item): item is number =>
        typeof item === "number" && Number.isFinite(item),
    )
  ) {
    return null;
  }
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm <= Number.EPSILON) return null;
  return values.map((item) => item / norm);
}

/** The EmbedContentRequest both backends accept. Vertex's embedContent honours
 * the same `embedContentConfig` block (verified on storemink-prod: 768
 * dimensions back, 3072 without it). */
function embedContentRequest(
  input: { text: string; title?: string },
  task: EmbeddingTask,
) {
  return {
    content: { parts: [{ text: input.text }] },
    // This is the REST wire field from EmbedContentRequest. The Google GenAI
    // JavaScript SDK calls its convenience input `config`, but serializes it
    // to this `embedContentConfig` object for the HTTP API.
    embedContentConfig: {
      taskType: task,
      outputDimensionality: HELP_EMBEDDING_DIMENSIONS,
      autoTruncate: false,
      ...(task === "RETRIEVAL_DOCUMENT" && input.title
        ? { title: input.title }
        : {}),
    },
  };
}

/** The Developer API names the model in the body as well; its batch form
 * requires it on every entry. */
function developerRequest(
  provider: Provider,
  input: { text: string; title?: string },
  task: EmbeddingTask,
) {
  return {
    model: `models/${provider.model}`,
    ...embedContentRequest(input, task),
  };
}

function parseSingleEmbedding(value: unknown): InternalResult<number[]> {
  const vector = isRecord(value) && embeddingVector(value.embedding);
  return vector
    ? { ok: true, value: vector }
    : failure(
        "invalid-response",
        "The embedding provider returned an invalid vector.",
        true,
      );
}

function parseDeveloperBatch(
  value: unknown,
  expected: number,
): InternalResult<number[][]> {
  const embeddings = isRecord(value) ? value.embeddings : null;
  if (!Array.isArray(embeddings) || embeddings.length !== expected) {
    return failure(
      "invalid-response",
      "The embedding provider returned an incomplete batch.",
      true,
    );
  }
  const vectors = embeddings.map(embeddingVector);
  return vectors.every((vector): vector is number[] => vector !== null)
    ? { ok: true, value: vectors }
    : failure(
        "invalid-response",
        "The embedding provider returned an invalid vector.",
        true,
      );
}

async function embedOne(
  provider: Provider,
  input: { text: string; title?: string },
  task: EmbeddingTask,
): Promise<InternalResult<number[]>> {
  const response = await postJson(
    provider,
    "embedContent",
    provider.backend === "gemini-api"
      ? developerRequest(provider, input, task)
      : embedContentRequest(input, task),
  );
  return response.ok ? parseSingleEmbedding(response.value) : response;
}

/** Embed one end-user retrieval query. Failure is data, never an exception, so
 * the caller can immediately continue with lexical Help Centre search. */
export async function embedHelpQuery(
  rawQuery: string,
): Promise<HelpEmbeddingResult<number[]>> {
  const query = cleanText(rawQuery, MAX_INPUT_CHARS);
  if (!query) {
    return failure(
      "invalid-input",
      `The embedding query must be between 1 and ${MAX_INPUT_CHARS.toLocaleString("en-IN")} characters.`,
      false,
    );
  }
  const resolved = await resolveProvider();
  if (!resolved.ok) return resolved;
  const embedded = await embedOne(
    resolved.value,
    { text: query },
    "RETRIEVAL_QUERY",
  );
  return embedded.ok ? success(resolved.value, embedded.value) : embedded;
}

/** Embed published Help Centre chunks. The Gemini Developer API uses its
 * synchronous batch endpoint; Vertex's embedContent takes one input per
 * request and has no batch form, so those calls run in small bounded groups. */
export async function embedHelpDocuments(
  rawDocuments: readonly HelpEmbeddingDocument[],
): Promise<HelpEmbeddingResult<number[][]>> {
  if (!Array.isArray(rawDocuments) || rawDocuments.length === 0) {
    return failure(
      "invalid-input",
      "Provide at least one Help Centre document to embed.",
      false,
    );
  }
  if (rawDocuments.length > HELP_EMBEDDING_MAX_DOCUMENTS) {
    return failure(
      "invalid-input",
      `Embed no more than ${HELP_EMBEDDING_MAX_DOCUMENTS} Help Centre documents at once.`,
      false,
    );
  }
  const documents: HelpEmbeddingDocument[] = [];
  for (const document of rawDocuments) {
    const title = cleanText(document?.title, HELP_EMBEDDING_MAX_TITLE_CHARS);
    const text = cleanText(document?.text, MAX_INPUT_CHARS);
    if (!title || !text) {
      return failure(
        "invalid-input",
        "Every Help Centre document needs a valid title and non-empty text.",
        false,
      );
    }
    documents.push({ title, text });
  }

  const resolved = await resolveProvider();
  if (!resolved.ok) return resolved;
  const provider = resolved.value;
  const vectors: number[][] = [];

  if (provider.backend === "gemini-api") {
    for (
      let offset = 0;
      offset < documents.length;
      offset += DEVELOPER_BATCH_SIZE
    ) {
      const batch = documents.slice(offset, offset + DEVELOPER_BATCH_SIZE);
      const response = await postJson(provider, "batchEmbedContents", {
        requests: batch.map((document) =>
          developerRequest(provider, document, "RETRIEVAL_DOCUMENT"),
        ),
      });
      if (!response.ok) return response;
      const parsed = parseDeveloperBatch(response.value, batch.length);
      if (!parsed.ok) return parsed;
      vectors.push(...parsed.value);
    }
    return success(provider, vectors);
  }

  // Vertex's embedContent allows one input per request and has no batch
  // form. Bounded concurrency keeps backfills useful without an unbounded
  // request spike; the model's bucket is 300,000 requests a minute.
  for (
    let offset = 0;
    offset < documents.length;
    offset += VERTEX_CONCURRENCY
  ) {
    const group = documents.slice(offset, offset + VERTEX_CONCURRENCY);
    const results = await Promise.all(
      group.map((document) =>
        embedOne(provider, document, "RETRIEVAL_DOCUMENT"),
      ),
    );
    for (const result of results) {
      if (!result.ok) return result;
      vectors.push(result.value);
    }
  }
  return success(provider, vectors);
}
