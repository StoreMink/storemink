import { afterEach, describe, expect, it, vi } from "vitest";

// PLATFORM_URL is computed once at module load, so each case re-imports.
async function platformUrl(): Promise<string> {
  vi.resetModules();
  return (await import("./host")).PLATFORM_URL;
}

describe("PLATFORM_URL", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses NEXT_PUBLIC_APP_URL as Cloud Build sets it, without a trailing slash", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://staging.storemink.com/");
    expect(await platformUrl()).toBe("https://staging.storemink.com");
  });

  it("adds the scheme a bare NEXT_PUBLIC_APP_URL host needs", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "storemink.com");
    expect(await platformUrl()).toBe("https://storemink.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "localhost:3000");
    expect(await platformUrl()).toBe("http://localhost:3000");
  });

  it("falls back to the root domain when NEXT_PUBLIC_APP_URL is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ROOT_DOMAIN", "storemink.com");
    expect(await platformUrl()).toBe("https://storemink.com");
    vi.stubEnv("NEXT_PUBLIC_ROOT_DOMAIN", "localhost:3000");
    expect(await platformUrl()).toBe("http://localhost:3000");
  });
});
