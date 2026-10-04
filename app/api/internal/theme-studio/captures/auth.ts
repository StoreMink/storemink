/** The capture job authenticates with CRON_SECRET, as every internal job. */
export function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return (
    typeof secret === "string" &&
    secret.length > 0 &&
    (request.headers.get("authorization") === `Bearer ${secret}` ||
      // Private Cloud Run requires Scheduler's OIDC Authorization header.
      // This second secret is accepted only on the isolated IAM-protected
      // workers. The public web service keeps its original bearer boundary.
      (process.env.THEME_STUDIO_WORKER_ONLY === "true" &&
        request.headers.get("x-theme-studio-secret") === secret))
  );
}
