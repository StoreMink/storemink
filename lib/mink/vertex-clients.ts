import "server-only";

import { GoogleGenAI } from "@google/genai";

// ---------------------------------------------------------------------------
// The one place a Mink Vertex client is built.
//
// ★ ONE SET OF OPTIONS. The chat session, the storefront writer and the chat
//   namer each built their own client with the same options; a change to the
//   API version, the retry policy or the auth had to be made three times.
// ★ THE SDK MAKES ONE ATTEMPT: every retry is StoreMink's own, so its count
//   reaches run telemetry and a retry policy is never multiplied by a second.
// ---------------------------------------------------------------------------

export function createMinkVertexClient(
  project: string,
  location: string,
): GoogleGenAI {
  return new GoogleGenAI({
    enterprise: true,
    project,
    location,
    apiVersion: "v1",
    httpOptions: { retryOptions: { attempts: 1 } },
  });
}

const shared = new Map<string, GoogleGenAI>();

/** One client per project and location for the life of the process. */
export function minkVertexClient(
  project: string,
  location: string,
): GoogleGenAI {
  const key = `${project}:${location}`;
  let client = shared.get(key);
  if (!client) {
    client = createMinkVertexClient(project, location);
    shared.set(key, client);
  }
  return client;
}
