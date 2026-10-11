/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// The stores table, for the "does a store still serve this host?" read that
// guards every removal. The mock returns the rows whose slug or custom domain
// is a parameter of the compiled WHERE, which is what the indexed IN lists ask.
const db = vi.hoisted(() => ({
  stores: [] as Array<{
    slug: string;
    customDomain: string | null;
    settings: unknown;
  }>,
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  fail: null as Error | null,
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (run: (d: unknown) => unknown) => {
    if (db.fail) throw db.fail;
    return run({
      select: () => ({
        from: () => ({
          where: async (cond: unknown) => {
            const q = new PgDialect().sqlToQuery(cond as any);
            db.queries.push({ sql: q.sql, params: q.params });
            return db.stores.filter(
              (r) =>
                q.params.includes(r.slug) ||
                (r.customDomain !== null && q.params.includes(r.customDomain)),
            );
          },
        }),
      }),
    });
  }),
}));
vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn(function (this: any) {
    this.getClient = async () => ({
      getAccessToken: async () => ({ token: "access-token" }),
    });
  }),
}));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { logWarn } from "@/lib/observability/logger";
import {
  detachedDomainEntries,
  ensureAuthorizedDomain,
  ensureAuthorizedHosts,
  entryCovers,
  legacyRegistrableEntry,
  normalizeAuthHost,
  planAddHosts,
  planRemoveHosts,
  removeAuthorizedDomain,
  removeAuthorizedHosts,
} from "./authorized-domains";

// ---------------------------------------------------------------------------
// entryCovers mirrors matchDomain in @firebase/auth: the rule that lets the
// one platform entry cover popups on every store subdomain.
// ---------------------------------------------------------------------------

const PLATFORM = [
  "localhost",
  "storemink-prod.firebaseapp.com",
  "storemink-prod.web.app",
  "storemink.com",
];

describe("entryCovers", () => {
  it("covers the entry itself and every subdomain", () => {
    // The rule that makes ONE platform entry enough for every store subdomain.
    expect(entryCovers("storemink.com", "storemink.com")).toBe(true);
    expect(entryCovers("storemink.com", "acme.storemink.com")).toBe(true);
    expect(entryCovers("storemink.com", "a.b.storemink.com")).toBe(true);
  });

  it("does not cover a different registrable domain", () => {
    // The whole reason custom domains need their own entry.
    expect(entryCovers("storemink.com", "wholesip.com")).toBe(false);
    expect(entryCovers("storemink.com", "notstoremink.com")).toBe(false);
  });

  it("is not fooled by a domain that merely ends with the same text", () => {
    // "evilstoremink.com" must NOT match "storemink.com": the SDK requires a dot
    // before the suffix, and so must we.
    expect(entryCovers("storemink.com", "evilstoremink.com")).toBe(false);
  });

  it("requires an exact match for an IP entry", () => {
    expect(entryCovers("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(entryCovers("127.0.0.1", "sub.127.0.0.1")).toBe(false);
  });

  it("ignores trailing dots and case", () => {
    expect(entryCovers("Storemink.COM.", "ACME.storemink.com")).toBe(true);
  });

  it("never matches a chrome-extension entry against a web host", () => {
    expect(entryCovers("chrome-extension://abc", "storemink.com")).toBe(false);
  });
});

describe("legacyRegistrableEntry", () => {
  it("is the registrable domain the old popup model added", () => {
    expect(legacyRegistrableEntry("xyz.com")).toBe("xyz.com");
    expect(legacyRegistrableEntry("www.xyz.com")).toBe("xyz.com");
    expect(legacyRegistrableEntry("shop.xyz.co.uk")).toBe("xyz.co.uk");
  });

  it("★ uses the ICANN-only list, as the old code did, so cleanup finds eu.org", () => {
    // The entry this whole change stops adding, and must still clear.
    expect(legacyRegistrableEntry("acme.eu.org")).toBe("eu.org");
  });

  it("falls back to the host, and returns null for nothing usable", () => {
    expect(legacyRegistrableEntry("localhost")).toBe("localhost");
    expect(legacyRegistrableEntry("   ")).toBeNull();
  });
});

describe("detachedDomainEntries", () => {
  it("is the exact apex + www plus the legacy registrable entry, deduped", () => {
    expect(detachedDomainEntries("WholeSip.com")).toEqual([
      "wholesip.com",
      "www.wholesip.com",
    ]);
    expect(detachedDomainEntries("shop.acme.com")).toEqual([
      "shop.acme.com",
      "acme.com",
    ]);
    expect(detachedDomainEntries("acme.eu.org")).toEqual([
      "acme.eu.org",
      "eu.org",
    ]);
    expect(detachedDomainEntries("  ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Exact hosts. Phone sign-in's server-side reCAPTCHA check needs the EXACT
// hostname (verified 2026-10-10: echoss.storemink.com failed with "Hostname
// match not found" while storemink.com was listed), so these planners use
// membership, never coverage.
// ---------------------------------------------------------------------------

describe("normalizeAuthHost", () => {
  it("reduces a pasted URL to a bare lowercase host", () => {
    expect(
      normalizeAuthHost("  https://Echoss.StoreMink.com:443/auth?x=1 "),
    ).toBe("echoss.storemink.com");
    expect(normalizeAuthHost("shop.example.com.")).toBe("shop.example.com");
    expect(normalizeAuthHost("user@www.acme.com")).toBe("www.acme.com");
    expect(normalizeAuthHost("localhost:3000")).toBe("localhost");
  });

  it("returns null for nothing usable or an invalid host", () => {
    for (const bad of [
      "",
      "   ",
      "*.storemink.com",
      "bad_host.com",
      "-lead.example.com",
      "a..b.com",
      "[::1]",
      `${"a".repeat(64)}.com`,
    ]) {
      expect(normalizeAuthHost(bad), bad).toBeNull();
    }
  });
});

describe("planAddHosts", () => {
  it("★ adds an exact store host even though the root covers it for popups", () => {
    const p = planAddHosts(PLATFORM, ["echoss.storemink.com"]);
    expect(p.added).toEqual(["echoss.storemink.com"]);
    expect(p.next).toEqual([...PLATFORM, "echoss.storemink.com"]);
  });

  it("is case-insensitive, dedupes, and keeps existing order and spelling", () => {
    const current = ["localhost", "Echoss.StoreMink.com", "storemink.com"];
    const p = planAddHosts(current, [
      "ECHOSS.storemink.com",
      "acme.storemink.com",
      "Acme.Storemink.com.",
      "not valid!",
    ]);
    expect(p.added).toEqual(["acme.storemink.com"]);
    expect(p.next).toEqual([...current, "acme.storemink.com"]);
  });

  it("returns the same list when nothing is missing", () => {
    const p = planAddHosts(PLATFORM, ["storemink.com", "LOCALHOST"]);
    expect(p.added).toEqual([]);
    expect(p.next).toBe(PLATFORM);
  });
});

describe("planRemoveHosts", () => {
  const list = [...PLATFORM, "echoss.storemink.com", "Shop.Acme.com"];

  it("removes exact hosts, case-insensitively", () => {
    const p = planRemoveHosts(
      list,
      ["ECHOSS.storemink.com", "shop.acme.com", "never-listed.com"],
      "storemink.com",
    );
    expect(p.removed).toEqual(["echoss.storemink.com", "shop.acme.com"]);
    expect(p.next).toEqual(PLATFORM);
  });

  it("★ never removes a protected entry", () => {
    const p = planRemoveHosts(
      list,
      [
        "storemink.com",
        "localhost",
        "storemink-prod.firebaseapp.com",
        "storemink-prod.web.app",
      ],
      "storemink.com",
    );
    expect(p.removed).toEqual([]);
    expect(p.next).toBe(list);
  });

  it("★ never removes the platform's own hosts or the local dev roots", () => {
    const withPlatformHosts = [
      ...list,
      "www.storemink.com",
      "pos.storemink.com",
      "help.storemink.com",
      "localtest.me",
    ];
    const p = planRemoveHosts(
      withPlatformHosts,
      [
        "www.storemink.com",
        "pos.storemink.com",
        "help.storemink.com",
        "localtest.me",
        "echoss.storemink.com",
      ],
      "storemink.com",
    );
    // Only the store host goes; a detach can never take sign-in away from the
    // platform hosts or every developer's local machine.
    expect(p.removed).toEqual(["echoss.storemink.com"]);
  });

  it("★ never removes by coverage", () => {
    // A subdomain-shaped input must not delete the root that covers it.
    const p = planRemoveHosts(PLATFORM, ["x.storemink.com"], "storemink.com");
    expect(p.removed).toEqual([]);
    expect(p.next).toContain("storemink.com");
  });
});

// --- The API side -----------------------------------------------------------

interface Call {
  method: string;
  url: string;
  body?: { authorizedDomains: string[] };
}

function stubConfig(
  domains: string[],
  opts: { getStatus?: number; patchStatus?: number } = {},
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = String(init?.method);
      calls.push({
        method,
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const status = method === "PATCH" ? opts.patchStatus : opts.getStatus;
      if (status && status >= 400) {
        return new Response(
          JSON.stringify({ error: { message: `HTTP ${status} refused` } }),
          { status },
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
  vi.stubEnv("FIREBASE_PROJECT_ID", "storemink-prod");
  db.stores = [];
  db.queries = [];
  db.fail = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ensureAuthorizedHosts", () => {
  it("makes ONE GET and ONE PATCH with the updateMask when hosts are missing", async () => {
    const calls = stubConfig(PLATFORM);
    const r = await ensureAuthorizedHosts([
      "echoss.storemink.com",
      "ECHOSS.storemink.com",
      "acme.storemink.com",
    ]);
    expect(r).toEqual({
      added: ["echoss.storemink.com", "acme.storemink.com"],
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[0]!.url).toBe(
      "https://identitytoolkit.googleapis.com/admin/v2/projects/storemink-prod/config",
    );
    expect(calls[1]!.url).toBe(
      "https://identitytoolkit.googleapis.com/admin/v2/projects/storemink-prod/config?updateMask=authorizedDomains",
    );
    expect(calls[1]!.body).toEqual({
      authorizedDomains: [
        ...PLATFORM,
        "echoss.storemink.com",
        "acme.storemink.com",
      ],
    });
  });

  it("does not write when every host is already listed", async () => {
    const calls = stubConfig([...PLATFORM, "echoss.storemink.com"]);
    expect(await ensureAuthorizedHosts(["Echoss.storemink.com"])).toEqual({
      added: [],
    });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("makes no request when nothing valid is asked for", async () => {
    const calls = stubConfig(PLATFORM);
    expect(await ensureAuthorizedHosts([])).toEqual({ added: [] });
    expect(await ensureAuthorizedHosts(["  ", "*.x.com"])).toEqual({
      added: [],
    });
    expect(calls).toEqual([]);
  });

  it("reports a missing project without a request", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "");
    const calls = stubConfig(PLATFORM);
    expect(await ensureAuthorizedHosts(["echoss.storemink.com"])).toEqual({
      added: [],
      error: "no Firebase project configured",
    });
    expect(calls).toEqual([]);
  });

  it("returns the error, never throws, when the read or write fails", async () => {
    stubConfig(PLATFORM, { getStatus: 403 });
    expect(await ensureAuthorizedHosts(["echoss.storemink.com"])).toEqual({
      added: [],
      error: "HTTP 403 refused",
    });

    stubConfig(PLATFORM, { patchStatus: 500 });
    expect(await ensureAuthorizedHosts(["echoss.storemink.com"])).toEqual({
      added: [],
      error: "HTTP 500 refused",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await ensureAuthorizedHosts(["echoss.storemink.com"])).toEqual({
      added: [],
      error: "network down",
    });
  });

  it("warns once the list reaches the size tripwire", async () => {
    const long = Array.from({ length: 149 }, (_, i) => `s${i}.storemink.com`);
    stubConfig(long);
    await ensureAuthorizedHosts(["new.storemink.com"]);
    expect(logWarn).toHaveBeenCalledWith(
      "authorized domains list is getting long",
      { count: 150 },
    );
  });
});

describe("removeAuthorizedHosts", () => {
  it("removes exact hosts in one write and never a protected entry", async () => {
    const calls = stubConfig([...PLATFORM, "echoss.storemink.com"]);
    const r = await removeAuthorizedHosts(
      ["echoss.storemink.com", "storemink.com", "localhost"],
      "storemink.com",
    );
    expect(r).toEqual({ removed: ["echoss.storemink.com"] });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]!.url).toContain("?updateMask=authorizedDomains");
    expect(calls[1]!.body).toEqual({ authorizedDomains: PLATFORM });
  });

  it("does not write when nothing matches, and reports failures", async () => {
    const calls = stubConfig(PLATFORM);
    expect(
      await removeAuthorizedHosts(["gone.storemink.com"], "storemink.com"),
    ).toEqual({ removed: [] });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    // Nothing listed means nothing to protect: no store read either.
    expect(db.queries).toEqual([]);

    stubConfig([...PLATFORM, "echoss.storemink.com"], { patchStatus: 403 });
    expect(
      await removeAuthorizedHosts(["echoss.storemink.com"], "storemink.com"),
    ).toEqual({ removed: [], error: "HTTP 403 refused" });

    vi.stubEnv("FIREBASE_PROJECT_ID", "");
    expect(
      await removeAuthorizedHosts(["echoss.storemink.com"], "storemink.com"),
    ).toEqual({ removed: [], error: "no Firebase project configured" });
  });

  it("★ keeps a slug host a store owns again (re-created after a delete)", async () => {
    db.stores = [{ slug: "echoss", customDomain: null, settings: {} }];
    const calls = stubConfig([...PLATFORM, "echoss.storemink.com"]);

    expect(
      await removeAuthorizedHosts(["echoss.storemink.com"], "storemink.com"),
    ).toEqual({ removed: [] });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    // One indexed read, by slug.
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]!.sql).toContain('"slug" in');
    expect(db.queries[0]!.params).toEqual(["echoss"]);
  });

  it("removes a slug host whose new owner is a demo store (never takes sign-ins)", async () => {
    db.stores = [
      { slug: "echoss", customDomain: null, settings: { demo: true } },
    ];
    const calls = stubConfig([...PLATFORM, "echoss.storemink.com"]);

    expect(
      await removeAuthorizedHosts(["echoss.storemink.com"], "storemink.com"),
    ).toEqual({ removed: ["echoss.storemink.com"] });
    expect(calls[1]!.body).toEqual({ authorizedDomains: PLATFORM });
  });

  it("★ removes nothing when the store read fails", async () => {
    db.fail = new Error("db down");
    const calls = stubConfig([...PLATFORM, "echoss.storemink.com"]);

    const r = await removeAuthorizedHosts(
      ["echoss.storemink.com"],
      "storemink.com",
    );
    expect(r.removed).toEqual([]);
    expect(r.error).toMatch(/could not check which stores.*db down/);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});

describe("ensureAuthorizedDomain", () => {
  it("adds the exact apex + www in ONE write", async () => {
    const calls = stubConfig(PLATFORM);
    expect(await ensureAuthorizedDomain("WholeSip.com")).toEqual({
      added: true,
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]!.body).toEqual({
      authorizedDomains: [...PLATFORM, "wholesip.com", "www.wholesip.com"],
    });
  });

  it("★ adds only the exact host for a subdomain, never its registrable domain", async () => {
    const calls = stubConfig(PLATFORM);
    await ensureAuthorizedDomain("shop.acme.co.uk");
    expect(calls[1]!.body).toEqual({
      authorizedDomains: [...PLATFORM, "shop.acme.co.uk"],
    });
  });

  it("★ never adds a shared-hosting suffix (acme.eu.org must not authorise eu.org)", async () => {
    for (const domain of [
      "acme.eu.org",
      "myshop.vercel.app",
      "acme.is-a.dev",
    ]) {
      const calls = stubConfig(PLATFORM);
      await ensureAuthorizedDomain(domain);
      expect(calls[1]!.body, domain).toEqual({
        authorizedDomains: [...PLATFORM, domain],
      });
    }
  });

  it("adds only the missing www host when the apex is listed", async () => {
    const calls = stubConfig([...PLATFORM, "wholesip.com"]);
    expect(await ensureAuthorizedDomain("wholesip.com")).toEqual({
      added: true,
    });
    expect(calls[1]!.body).toEqual({
      authorizedDomains: [...PLATFORM, "wholesip.com", "www.wholesip.com"],
    });
  });

  it("does not write when everything is listed", async () => {
    const calls = stubConfig([...PLATFORM, "wholesip.com", "www.wholesip.com"]);
    expect(await ensureAuthorizedDomain("www.wholesip.com")).toEqual({
      added: false,
    });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("reports a missing project and a failed write", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "");
    expect(await ensureAuthorizedDomain("wholesip.com")).toEqual({
      error: "no Firebase project configured",
    });
    vi.stubEnv("FIREBASE_PROJECT_ID", "storemink-prod");
    stubConfig(PLATFORM, { patchStatus: 403 });
    expect(await ensureAuthorizedDomain("wholesip.com")).toEqual({
      error: "HTTP 403 refused",
    });
  });
});

describe("removeAuthorizedDomain", () => {
  const verified = { custom_domain_verified: true };

  it("removes the exact hosts AND the legacy registrable entry in ONE write", async () => {
    const calls = stubConfig([
      ...PLATFORM,
      "wholesip.com",
      "www.wholesip.com",
      "echoss.storemink.com",
    ]);
    expect(
      await removeAuthorizedDomain("www.wholesip.com", "storemink.com"),
    ).toEqual({ removed: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]!.body).toEqual({
      authorizedDomains: [...PLATFORM, "echoss.storemink.com"],
    });
  });

  it("★ keeps another live store's apex when a subdomain of it is detached", async () => {
    // Store B is live on acme.com; store A detaches shop.acme.com, whose
    // legacy registrable entry is B's exact apex.
    db.stores = [{ slug: "b", customDomain: "acme.com", settings: verified }];
    const calls = stubConfig([
      ...PLATFORM,
      "acme.com",
      "www.acme.com",
      "shop.acme.com",
    ]);

    expect(
      await removeAuthorizedDomain("shop.acme.com", "storemink.com"),
    ).toEqual({ removed: true });
    expect(calls[1]!.body).toEqual({
      authorizedDomains: [...PLATFORM, "acme.com", "www.acme.com"],
    });
    // One indexed read over the candidates and their apex/www companions.
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]!.sql).toContain('"custom_domain" in');
    expect(db.queries[0]!.params).toEqual(
      expect.arrayContaining(["shop.acme.com", "acme.com", "www.acme.com"]),
    );
  });

  it("★ keeps another store's www host when the apex is detached", async () => {
    db.stores = [
      { slug: "b", customDomain: "www.acme.com", settings: verified },
    ];
    const calls = stubConfig([...PLATFORM, "acme.com", "www.acme.com"]);

    expect(await removeAuthorizedDomain("acme.com", "storemink.com")).toEqual({
      removed: false,
    });
    // Store B serves both forms, so nothing goes and nothing is written.
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("removes a host whose only claimant has not verified the domain", async () => {
    db.stores = [{ slug: "b", customDomain: "acme.com", settings: {} }];
    const calls = stubConfig([...PLATFORM, "acme.com", "www.acme.com"]);

    expect(await removeAuthorizedDomain("acme.com", "storemink.com")).toEqual({
      removed: true,
    });
    expect(calls[1]!.body).toEqual({ authorizedDomains: PLATFORM });
  });

  it("★ clears a legacy shared-hosting entry on detach", async () => {
    const calls = stubConfig([...PLATFORM, "eu.org", "acme.eu.org"]);
    await removeAuthorizedDomain("acme.eu.org", "storemink.com");
    expect(calls[1]!.body).toEqual({ authorizedDomains: PLATFORM });
  });

  it("★ removes nothing when the store read fails", async () => {
    db.fail = new Error("db down");
    const calls = stubConfig([...PLATFORM, "acme.com", "www.acme.com"]);

    const r = await removeAuthorizedDomain("acme.com", "storemink.com");
    expect(r.removed).toBeUndefined();
    expect(r.error).toMatch(/could not check which stores.*db down/);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("★ never removes a protected entry, and is a no-op when nothing is listed", async () => {
    const calls = stubConfig(PLATFORM);
    expect(
      await removeAuthorizedDomain("storemink.com", "storemink.com"),
    ).toEqual({ removed: false });
    // A root-subdomain-shaped input names the root as its registrable entry.
    expect(
      await removeAuthorizedDomain("acme.storemink.com", "storemink.com"),
    ).toEqual({ removed: false });
    expect(
      await removeAuthorizedDomain("never-added.com", "storemink.com"),
    ).toEqual({ removed: false });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(db.queries).toEqual([]);
  });
});
