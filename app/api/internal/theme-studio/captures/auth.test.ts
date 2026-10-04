import { afterEach, expect, it, vi } from "vitest";
import { cronAuthorized } from "./auth";
afterEach(() => vi.unstubAllEnvs());
const request = (headers: Record<string, string>) =>
  new Request("https://worker.run.app/api/internal/theme-studio/runs", {
    headers,
  });
it("accepts the original bearer boundary on web and workers", () => {
  vi.stubEnv("CRON_SECRET", "secret");
  expect(cronAuthorized(request({ authorization: "Bearer secret" }))).toBe(
    true,
  );
  expect(cronAuthorized(request({ authorization: "Bearer other" }))).toBe(
    false,
  );
});
it("accepts the second secret alongside OIDC only in a private worker container", () => {
  vi.stubEnv("CRON_SECRET", "secret");
  vi.stubEnv("THEME_STUDIO_WORKER_ONLY", "false");
  const headers = {
    authorization: "Bearer oidc-token",
    "x-theme-studio-secret": "secret",
  };
  expect(cronAuthorized(request(headers))).toBe(false);
  vi.stubEnv("THEME_STUDIO_WORKER_ONLY", "true");
  expect(cronAuthorized(request(headers))).toBe(true);
  expect(
    cronAuthorized(request({ ...headers, "x-theme-studio-secret": "other" })),
  ).toBe(false);
  vi.stubEnv("CRON_SECRET", "");
  expect(cronAuthorized(request(headers))).toBe(false);
});
