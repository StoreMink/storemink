// ---------------------------------------------------------------------------
// When is a failed `next build` worth running again?
//
// WHY (22 Nov 2026). `next/font/google` asks Google for one stylesheet per
// font family at build time, and this app declares about 35 families
// (app/layout.tsx: the theme font catalogue, plus the dashboard, console and
// Help layouts). About one answer in a hundred (measured: 1 of 90 requests)
// lists its font files in another form of address,
//   https://fonts.gstatic.com/l/font?kit=...&skey=...&v=...
// where the usual one is https://fonts.gstatic.com/s/<family>/<version>/<file>.
// Both are valid. But the production build is Turbopack, which carries the
// address inside a query string of its own and splits it at the "&", then
// refuses it: "next/font/google queries have exactly one entry", shown as
// one "Module not found ... /internal/font/google/font" for every file of
// that family. So with 35 families a build fails roughly one time in four to
// seven, on a different family each time, with nothing wrong in the code:
// Inter (28 errors) and then Roboto (18) failed CI's Build job within twelve
// minutes of each other. The same failure stops a production deploy, whose
// Docker build runs this same script.
//
// ★★ IT IS NOT A NETWORK FAILURE, AND WAITING DOES NOT CURE IT. The first
// version of this file took it for a dropped connection and ran the build
// again as it was: the second and third attempts failed in 8 and 2 seconds,
// because Turbopack had kept Google's answer in its cache and read the same
// one back. What cures it is ASKING GOOGLE AGAIN, so scripts/build.mjs
// clears the build cache before every further attempt. Each attempt is then
// an independent draw, and four of them failing is rare (about 1 in 600 at
// the measured rate).
// ★ ONLY THIS FAILURE IS RUN AGAIN. A type error, a missing module of ours or
//   any other build break fails at once, as before: running a real failure
//   again would only multiply the wait for the same answer.
// ★ Pure, no imports: scripts/build.mjs runs the build, and the test reads
//   the text of the real CI log.
// ⚠ A mitigation, not a cure: the lasting fix is a build that does not ask
//   Google at all (the font files kept in the repository), or a bundler that
//   reads these addresses. Either is a larger change than this script.
// ---------------------------------------------------------------------------

/** How many times the build is run in all before the failure stands. */
export const BUILD_ATTEMPTS = 4;

/** Seconds to wait before each further attempt. Short: the cure is a fresh
 *  answer from Google, not the passing of time. */
export const BUILD_RETRY_WAIT_SECONDS = [5, 5, 5];

const FONT_FETCH_FAILURES = [
  // Turbopack: a font file's address it could not read (see above).
  /next\/font\/google queries have exactly one entry/,
  /internal\/font\/google\/font/,
  // Either bundler: the family's stylesheet could not be fetched.
  /Failed to fetch [`'"][^`'"\n]+[`'"] from Google Fonts/i,
  /Failed to fetch font\b[^\n]*fonts\.(?:gstatic|googleapis)\.com/i,
  /fonts\.(?:gstatic|googleapis)\.com[^\n]*(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up)/i,
];

/**
 * Whether a failed build's output shows that a Google font could not be
 * taken in (an address the bundler refused, or a download that failed),
 * which is the one failure worth another attempt.
 */
export function isFontFetchFailure(output) {
  if (typeof output !== "string" || !output) return false;
  return FONT_FETCH_FAILURES.some((pattern) => pattern.test(output));
}

/** Seconds to wait before attempt number `next` (2 or more), or null when the
 *  attempts are used up. */
export function waitBeforeAttempt(next) {
  if (!Number.isInteger(next) || next < 2 || next > BUILD_ATTEMPTS) return null;
  return (
    BUILD_RETRY_WAIT_SECONDS[next - 2] ??
    BUILD_RETRY_WAIT_SECONDS[BUILD_RETRY_WAIT_SECONDS.length - 1]
  );
}
