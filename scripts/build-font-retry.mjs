// ---------------------------------------------------------------------------
// When is a failed `next build` worth running again?
//
// WHY (22 Nov 2026). `next/font/google` downloads every font file at build
// time, and this app declares about 35 families (app/layout.tsx: the theme
// font catalogue, plus the dashboard, console and Help layouts). Google's
// stylesheet lists every script a family covers, and each is its own file, so
// one build downloads about 150 font files from fonts.gstatic.com (149 in a
// local build on 22 Nov 2026). When ONE of them fails, the whole build fails.
//
// The older bundler asked again three times (next/dist/compiled/@next/font/
// dist/google/retry.js). The production build is Turbopack, which does not:
// a single dropped connection ends the build with 28 copies of
//   Module not found: Can't resolve
//   '@vercel/turbopack-next/internal/font/google/font'
// which names no network problem at all. It failed CI's Build job twice on
// 22 Nov 2026 with nothing wrong in the code, and the same failure would stop
// a production deploy, whose Docker build runs this same script.
//
// ★ ONLY THIS FAILURE IS RUN AGAIN. A type error, a missing module of ours or
//   any other build break fails at once, as before: running a real failure
//   three times would only triple the wait for the same answer.
// ★ Pure, no imports: scripts/build.mjs runs the build, and the test reads
//   the text of the real CI log.
// ---------------------------------------------------------------------------

/** How many times the build is run in all before the failure stands. */
export const BUILD_ATTEMPTS = 3;

/** Seconds to wait before each further attempt. */
export const BUILD_RETRY_WAIT_SECONDS = [15, 45];

const FONT_FETCH_FAILURES = [
  // Turbopack: a font FILE could not be fetched (the text names no network).
  /internal\/font\/google\/font/,
  // Either bundler: the family's stylesheet could not be fetched.
  /Failed to fetch [`'"][^`'"\n]+[`'"] from Google Fonts/i,
  /Failed to fetch font\b[^\n]*fonts\.(?:gstatic|googleapis)\.com/i,
  /fonts\.(?:gstatic|googleapis)\.com[^\n]*(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up)/i,
];

/**
 * Whether a failed build's output shows that a Google font could not be
 * downloaded, which is the one failure worth another attempt.
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
