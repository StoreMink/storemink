/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// Certificates, Google Search and Resend are stubbed at their boundary. The
// Identity Platform half is NOT: the real authorized-domains module runs over
// a stubbed fetch, so these tests pin the exact list a detached domain leaves.
vi.mock("./certificates", () => ({
  getCertConfig: vi.fn(() => ({
    project: "p",
    location: "global",
    certificateMap: "m",
    loadBalancerIp: "1.2.3.4",
  })),
  deprovision: vi.fn(async () => ({})),
}));
vi.mock("@/lib/seo/search-engines", () => ({
  removeGoogleCustomDomain: vi.fn(async () => ({
    searchConsole: { ok: true },
    siteVerification: { ok: true },
  })),
}));
vi.mock("resend", () => ({
  Resend: vi.fn(function (this: any) {
    this.domains = { remove: vi.fn(async () => ({ error: null })) };
  }),
}));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn(function (this: any) {
    this.getClient = async () => ({
      getAccessToken: async () => ({ token: "access-token" }),
    });
  }),
}));
// Other stores, for the "is this host still served?" read that guards the
// removal. Returns the rows whose slug or custom domain the query names.
const db = vi.hoisted(() => ({
  stores: [] as Array<{
    slug: string;
    customDomain: string | null;
    settings: unknown;
  }>,
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (run: (d: unknown) => unknown) =>
    run({
      select: () => ({
        from: () => ({
          where: async (cond: unknown) => {
            const { params } = new PgDialect().sqlToQuery(cond as any);
            return db.stores.filter(
              (r) =>
                params.includes(r.slug) ||
                (r.customDomain !== null && params.includes(r.customDomain)),
            );
          },
        }),
      }),
    }),
  ),
}));
// Pin the root so the protected-entry assertions don't depend on the shell.
vi.mock("@/lib/store/host", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ROOT_DOMAIN: "storemink.com",
}));

import { cleanupDetachedDomain } from "./cleanup";
import { deprovision } from "./certificates";
import { removeGoogleCustomDomain } from "@/lib/seo/search-engines";
import { logError } from "@/lib/observability/logger";

const PLATFORM = [
  "localhost",
  "storemink-prod.firebaseapp.com",
  "storemink.com",
  "echoss.storemink.com",
];

interface ConfigCall {
  method: string;
  body?: { authorizedDomains: string[] };
}

function stubIdentityPlatform(
  domains: string[],
  opts: { patchStatus?: number } = {},
): ConfigCall[] {
  const calls: ConfigCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const method = String(init?.method);
      calls.push({
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === "PATCH" && opts.patchStatus) {
        return new Response(
          JSON.stringify({ error: { message: "PERMISSION_DENIED" } }),
          { status: opts.patchStatus },
        );
      }
      return new Response(
        JSON.stringify(
          method === "PATCH" ? {} : { authorizedDomains: domains },
        ),
        { status: 200 },
      );
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FIREBASE_PROJECT_ID", "storemink-prod");
  db.stores = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("cleanupDetachedDomain — sign-in hosts", () => {
  it("removes the exact apex + www in ONE write, nothing else", async () => {
    const calls = stubIdentityPlatform([
      ...PLATFORM,
      "acme.com",
      "www.acme.com",
      "other.com",
      "www.other.com",
    ]);

    const res = await cleanupDetachedDomain("acme.com", "disconnectDomain");

    expect(res).toEqual({ failures: [] });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    // The root, another store's subdomain host and another merchant's domain
    // all survive.
    expect(calls[1]!.body).toEqual({
      authorizedDomains: [...PLATFORM, "other.com", "www.other.com"],
    });
  });

  it("removes a www domain's apex and www hosts", async () => {
    const calls = stubIdentityPlatform([
      ...PLATFORM,
      "www.acme.com",
      "acme.com",
    ]);

    await cleanupDetachedDomain("www.acme.com", "updateCustomDomain");

    expect(calls[1]!.body).toEqual({ authorizedDomains: PLATFORM });
  });

  it("★ detaching shop.acme.com keeps acme.com when another store is live on it", async () => {
    db.stores = [
      {
        slug: "acme",
        customDomain: "acme.com",
        settings: { custom_domain_verified: true },
      },
    ];
    const calls = stubIdentityPlatform([
      ...PLATFORM,
      "acme.com",
      "www.acme.com",
      "shop.acme.com",
    ]);

    const res = await cleanupDetachedDomain(
      "shop.acme.com",
      "disconnectDomain",
    );

    expect(res).toEqual({ failures: [] });
    // Only the detached host goes; the other store's apex (which the old
    // popup model also listed as shop.acme.com's registrable entry) and its
    // www companion stay.
    expect(calls[1]!.body).toEqual({
      authorizedDomains: [...PLATFORM, "acme.com", "www.acme.com"],
    });
  });

  it("★ detaching acme.com keeps www.acme.com when another store owns it", async () => {
    db.stores = [
      {
        slug: "other",
        customDomain: "www.acme.com",
        settings: { custom_domain_verified: true },
      },
    ];
    const calls = stubIdentityPlatform([
      ...PLATFORM,
      "acme.com",
      "www.acme.com",
    ]);

    expect(
      await cleanupDetachedDomain("acme.com", "updateCustomDomain"),
    ).toEqual({ failures: [] });
    // That store serves both forms, so nothing is removed or written.
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("writes nothing when none of the domain's hosts are listed", async () => {
    const calls = stubIdentityPlatform(PLATFORM);

    expect(await cleanupDetachedDomain("acme.com", "deleteStore")).toEqual({
      failures: [],
    });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("reports a refused write and still runs the rest of the cleanup", async () => {
    stubIdentityPlatform([...PLATFORM, "acme.com", "www.acme.com"], {
      patchStatus: 403,
    });

    const res = await cleanupDetachedDomain("acme.com", "disconnectDomain");

    expect(res.failures).toEqual(["Identity Platform authorized domain"]);
    expect(logError).toHaveBeenCalledWith(
      "disconnectDomain (deauthorize)",
      "PERMISSION_DENIED",
      { domain: "acme.com" },
    );
    expect(deprovision).toHaveBeenCalledWith("acme.com");
    expect(removeGoogleCustomDomain).toHaveBeenCalledWith("acme.com");
  });

  it("asks Identity Platform nothing when there is no domain to detach", async () => {
    const calls = stubIdentityPlatform([...PLATFORM, "acme.com"]);

    expect(await cleanupDetachedDomain(null, "deleteStore")).toEqual({
      failures: [],
    });
    expect(calls).toEqual([]);
  });
});
