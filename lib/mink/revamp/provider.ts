import "server-only";

// ---------------------------------------------------------------------------
// Which models a storefront revamp calls: Gemini on Vertex, or the offline
// fakes (docs/mink-storefront-revamp.md, section 14).
//
// ★ ONE READ, SO THE STEPS CANNOT DISAGREE. The planner, the photos and the
//   product photos each pick their client from this. A run whose plan came
//   from the fake planner and whose photos came from the real image model
//   would spend real money on a design nobody asked for.
//
// ★ VERTEX UNLESS SAID OTHERWISE. `MINK_REVAMP_PROVIDER=fake` is for local
//   development and the opt-in integration test; production never sets it.
// ---------------------------------------------------------------------------

export type RevampProvider = "vertex" | "fake";

export function revampProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RevampProvider {
  return env.MINK_REVAMP_PROVIDER?.trim().toLowerCase() === "fake"
    ? "fake"
    : "vertex";
}
