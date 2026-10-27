/** Explicit request metadata only. Importing this module never enables a tier. */
export const PRIORITY_HEADERS: Readonly<Record<string, string>> = Object.freeze(
  {
    "X-Vertex-AI-LLM-Request-Type": "shared",
    "X-Vertex-AI-LLM-Shared-Request-Type": "priority",
  },
);

export const SERVED_AS_PRIORITY = "ON_DEMAND_PRIORITY";
