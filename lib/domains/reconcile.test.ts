/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

// Force the environment answer. It is a build-time constant in the real module,
// so a getter is the only way to drive both branches from one file.
let isProdPlatform = false;
vi.mock("@/lib/store/host", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    get IS_PRODUCTION_PLATFORM() {
      return isProdPlatform;
    },
  };
});

// The gate must return before ANY of these are reached. Mocking them means the
// assertions below are about the gate, not about how well the mocks imitate
// Certificate Manager.
vi.mock("./certificates", () => ({
  ensureProvisioned: vi.fn(),
  getCertConfig: vi.fn(() => ({
    project: "p",
    location: "global",
    certificateMap: "m",
    loadBalancerIp: "1.2.3.4",
  })),
  reissueCertificate: vi.fn(),
}));
vi.mock("./dns", () => ({
  checkCnameTarget: vi.fn(),
  checkDomainPointsTo: vi.fn(),
}));

// The live-domain tests below drive the whole healthy path, so the database,
// the cache tag and the logger are stubbed. Identity Platform is NOT: the real
// authorized-domains module runs against a stubbed fetch, so the assertions
// are about the exact list a live domain leaves behind.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({ STORE_TAG: "stores" }));
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

import { reconcileDomainForStore, NON_PRODUCTION_MESSAGE } from "./reconcile";
import { ensureProvisioned, getCertConfig } from "./certificates";
import { checkDomainPointsTo } from "./dns";
import { logInfo, logWarn } from "@/lib/observability/logger";

beforeEach(() => {
  vi.clearAllMocks();
  isProdPlatform = false;
  // No store row by default, so the production short-circuit test still reads
  // "Add a domain first." rather than a database error.
  dbHolder.current = makeDbMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// A custom domain resolves to one load balancer, whose url-map sends everything
// that isn't *.staging.storemink.com to the PRODUCTION backend. So a domain
// connected off prod can never reach the store that connected it — it only
// creates billable resources in the shared certificate map.
describe("reconcileDomainForStore — production-only provisioning", () => {
  it("refuses off production", async () => {
    const res = await reconcileDomainForStore("store-1");
    expect(res.verified).toBe(false);
    expect(res.error).toBe(NON_PRODUCTION_MESSAGE);
  });

  it("creates no Certificate Manager resources off production", async () => {
    // The point of the gate: not just an unverified result, but nothing billable
    // left behind in a map shared with production.
    await reconcileDomainForStore("store-1");
    expect(ensureProvisioned).not.toHaveBeenCalled();
  });

  it("refuses before the config check, so it reads as impossible not misconfigured", async () => {
    // Ordering matters for the message the developer sees: "this environment
    // can't" is the useful answer, "custom domains aren't configured" sends them
    // to check env vars that are in fact set correctly.
    await reconcileDomainForStore("store-1");
    expect(getCertConfig).not.toHaveBeenCalled();
  });

  it("does not short-circuit on production", async () => {
    // The guard must be the ONLY thing this flag changes: on prod the call has
    // to get past it and start doing real work.
    isProdPlatform = true;
    const res = await reconcileDomainForStore("store-1");
    expect(res.error).not.toBe(NON_PRODUCTION_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// Sign-in hosts. Phone sign-in checks the EXACT hostname against Identity
// Platform's authorizedDomains (verified in production 2026-10-10), so a live
// custom domain needs its apex AND www listed, not just a registrable entry
// that covers them for Google popups.
// ---------------------------------------------------------------------------

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

/** Both store reads (domain row, then plan) come from `stores`. */
function storeWithDomain(domain: string, settings: Record<string, unknown>) {
  const row = {
    slug: "acme",
    custom_domain: domain,
    settings,
    plan: "pro",
    plan_expires_at: null,
    comp_plan: null,
    comp_expires_at: null,
  };
  dbHolder.current = makeDbMock({ selectByTable: { stores: [[row], [row]] } });
}

function hostState(host: string, ready: boolean) {
  return {
    host,
    ready,
    challenge: null,
    certificateState: ready ? "ACTIVE" : "PROVISIONING",
    attached: ready,
  };
}

function provisioned(domain: string, companion: string, ready = true) {
  vi.mocked(ensureProvisioned).mockResolvedValue({
    ...hostState(domain, ready),
    hosts: [hostState(domain, ready), hostState(companion, ready)],
  } as any);
  vi.mocked(checkDomainPointsTo).mockResolvedValue({
    pointsToUs: true,
    found: ["1.2.3.4"],
  });
}

function savedSettings(): Record<string, unknown> | undefined {
  const sets = dbHolder.current.calls.set as Array<{
    settings?: Record<string, unknown>;
  }>;
  return sets.at(-1)?.settings;
}

describe("reconcileDomainForStore — sign-in hosts on a live domain", () => {
  beforeEach(() => {
    isProdPlatform = true;
    vi.stubEnv("FIREBASE_PROJECT_ID", "storemink-prod");
  });

  it("going live lists the exact apex + www in ONE write", async () => {
    storeWithDomain("acme.com", {});
    provisioned("acme.com", "www.acme.com");
    const calls = stubIdentityPlatform(PLATFORM);

    const res = await reconcileDomainForStore("store-1");

    expect(res).toMatchObject({ verified: true, becameLive: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    // The platform entry and another store's subdomain host are kept as-is.
    expect(calls[1]!.body).toEqual({
      authorizedDomains: [...PLATFORM, "acme.com", "www.acme.com"],
    });
    expect(logInfo).toHaveBeenCalledWith("custom domain live", {
      storeId: "store-1",
      domain: "acme.com",
    });
  });

  it("★ a shared-hosting domain lists only itself, never its suffix", async () => {
    // getDomain("acme.eu.org") is "eu.org" on the ICANN list; adding it would
    // authorise Google popups on every free *.eu.org site.
    storeWithDomain("acme.eu.org", {});
    vi.mocked(ensureProvisioned).mockResolvedValue({
      ...hostState("acme.eu.org", true),
      hosts: [hostState("acme.eu.org", true)],
    } as any);
    vi.mocked(checkDomainPointsTo).mockResolvedValue({
      pointsToUs: true,
      found: ["1.2.3.4"],
    });
    const calls = stubIdentityPlatform(PLATFORM);

    const res = await reconcileDomainForStore("store-1");

    expect(res).toMatchObject({ verified: true, becameLive: true });
    expect(calls[1]!.body).toEqual({
      authorizedDomains: [...PLATFORM, "acme.eu.org"],
    });
  });

  it("★ a registrable entry that covers the host is not enough: the exact host is still added", async () => {
    // acme.com covers www.acme.com for a Google popup, which is all the old
    // check asked. Phone codes need www.acme.com itself.
    storeWithDomain("www.acme.com", {});
    provisioned("www.acme.com", "acme.com");
    const calls = stubIdentityPlatform([...PLATFORM, "acme.com"]);

    await reconcileDomainForStore("store-1");

    expect(calls[1]!.body).toEqual({
      authorizedDomains: [...PLATFORM, "acme.com", "www.acme.com"],
    });
  });

  it("★ an already-live domain's health pass asks Identity Platform nothing", async () => {
    // Backfill and retries belong to the hourly syncStoreAuthHosts pass, one
    // write for every store. Calling Identity Platform here on every healthy
    // pass put its latency inside the sweep's 300 s budget, once per domain.
    storeWithDomain("acme.com", { custom_domain_verified: true });
    provisioned("acme.com", "www.acme.com");
    const calls = stubIdentityPlatform([...PLATFORM, "acme.com"]);

    const res = await reconcileDomainForStore("store-1");

    expect(res).toMatchObject({ verified: true, becameLive: false });
    expect(calls).toEqual([]);
    // Not a second "went live" milestone.
    expect(logInfo).not.toHaveBeenCalledWith(
      "custom domain live",
      expect.anything(),
    );
  });

  it("a refused write never un-verifies the domain; it is logged for the next pass", async () => {
    storeWithDomain("acme.com", {});
    provisioned("acme.com", "www.acme.com");
    stubIdentityPlatform(PLATFORM, { patchStatus: 403 });

    const res = await reconcileDomainForStore("store-1");

    expect(res).toMatchObject({ verified: true, becameLive: true });
    expect(savedSettings()).toMatchObject({ custom_domain_verified: true });
    expect(logWarn).toHaveBeenCalledWith(
      "custom domain live but sign-in hosts not authorised",
      {
        storeId: "store-1",
        domain: "acme.com",
        error: "PERMISSION_DENIED",
      },
    );
  });

  it("a domain that is not serving yet asks Identity Platform nothing", async () => {
    storeWithDomain("acme.com", {});
    provisioned("acme.com", "www.acme.com", false);
    const calls = stubIdentityPlatform(PLATFORM);

    const res = await reconcileDomainForStore("store-1");

    expect(res.verified).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a live domain checked recently returns before any provider call", async () => {
    storeWithDomain("acme.com", {
      custom_domain_verified: true,
      domain_health_checked_at: new Date().toISOString(),
      domain_health_failures: 0,
    });
    const calls = stubIdentityPlatform(PLATFORM);

    const res = await reconcileDomainForStore("store-1");

    expect(res.verified).toBe(true);
    expect(ensureProvisioned).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
