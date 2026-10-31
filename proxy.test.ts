/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The proxy gates dashboard/auth routes on the verified Firebase session cookie.
// Mock the verifier so we can drive signed-in / signed-out + claim outcomes.
vi.mock("@/lib/auth/session-cookie", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, verifySessionCookie: vi.fn() };
});

// The one-address-per-store redirect is production-only, and whether this deploy
// IS production is a build-time constant. A getter (rather than a plain value)
// lets a single test file drive both branches.
let isProdPlatform = true;
vi.mock("@/lib/store/host", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    get IS_PRODUCTION_PLATFORM() {
      return isProdPlatform;
    },
  };
});

// Hits the database; every store-subdomain test would otherwise open a connection.
vi.mock("@/lib/store/canonical", () => ({
  canonicalHostForSlug: vi.fn(),
}));

// Blocked media (takedown T7). The proxy reads the blocked set for
// `/_next/image` and `/themes/...`; the set is driven per test through
// `currentSet`, so no test reaches a database. The bucket is fixed, the
// database and the network refuse, and the placeholder is the real file.
vi.mock("@/lib/storage/gcs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    GCS_BUCKET_NAME: "sm-media",
    GCS_PUBLIC_HOST: "storage.googleapis.com",
  };
});
vi.mock("@/lib/db/client", () => {
  const refuse = vi.fn(async () => {
    throw new Error("no database in proxy tests");
  });
  return { withService: refuse, withAnon: refuse, withUser: refuse };
});
vi.mock("@/lib/observability/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, logError: vi.fn(), logWarn: vi.fn() };
});
let currentSet: any = null;
vi.mock("@/lib/moderation/blocked-objects", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, blockedMedia: vi.fn(async () => currentSet) };
});
vi.mock("@/lib/moderation/placeholder", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, placeholderWebp: vi.fn(actual.placeholderWebp) };
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "./proxy";
import { verifySessionCookie } from "@/lib/auth/session-cookie";
import { canonicalHostForSlug } from "@/lib/store/canonical";
import {
  blockedMedia,
  buildBlockedMediaSet,
  type BlockedObjectRow,
} from "@/lib/moderation/blocked-objects";
import { placeholderWebp } from "@/lib/moderation/placeholder";

function req(url: string, host = "shop.storemink.com") {
  return new NextRequest(new URL(url), { headers: { host } });
}

function signedIn(claims: {
  role?: string | null;
  forcePasswordReset?: boolean;
}) {
  vi.mocked(verifySessionCookie).mockResolvedValue({
    uid: "u1",
    email: "a@b.com",
    emailConfirmed: true,
    phone: null,
    phoneConfirmed: false,
    name: null,
    claims: {
      role: claims.role ?? null,
      forcePasswordReset: claims.forcePasswordReset ?? false,
    },
  });
}

const loc = (res: any) => res.headers.get("location");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifySessionCookie).mockResolvedValue(null); // signed out by default
  vi.mocked(canonicalHostForSlug).mockResolvedValue(null); // no custom domain
  isProdPlatform = true;
});

describe("proxy — store-host session gate", () => {
  it("redirects an unauthenticated /dashboard visit to /auth/login", async () => {
    const res = await proxy(req("https://shop.storemink.com/dashboard"));
    expect(res.status).toBe(307);
    expect(loc(res)).toContain("/auth/login");
  });

  it("lets a normal admin into /dashboard", async () => {
    signedIn({ role: "member" });
    const res = await proxy(req("https://shop.storemink.com/dashboard"));
    expect(loc(res)).toBeNull();
  });

  it("forces a password reset when the claim is set", async () => {
    signedIn({ role: "member", forcePasswordReset: true });
    const res = await proxy(req("https://shop.storemink.com/dashboard/orders"));
    expect(loc(res)).toContain("/auth/set-password");
  });

  // ★ The proxy no longer gates /dashboard/users or /dashboard/media on a role
  // CLAIM. It used to demand `role === "superadmin"`, but `createStore` writes
  // that role to the `admins` TABLE and never mints the claim — so every
  // wizard-created owner was bounced off their own Customers page while the
  // sidebar (which reads the database) happily showed the link. The route had
  // also been repurposed from staff management to the SHOPPER list, so locking it
  // to the owner contradicted the `users` permission existing at all.
  //
  // Both pages call requireSectionAccess() server-side, so authorisation still
  // happens — in one place, against the database, instead of two that disagreed.
  it("does not gate /dashboard/users on a role claim", async () => {
    signedIn({ role: "member" });
    const res = await proxy(req("https://shop.storemink.com/dashboard/users"));
    expect(loc(res)).toBeNull();
  });

  it("does not gate /dashboard/media on a role claim", async () => {
    // The same gate covered media, so an owner could not open it either.
    signedIn({ role: "member" });
    const res = await proxy(req("https://shop.storemink.com/dashboard/media"));
    expect(loc(res)).toBeNull();
  });

  it("lets an owner with NO role claim reach Customers — the reported bug", async () => {
    // Exactly the signup-created owner: superadmin in the database, no claim in
    // the session cookie.
    signedIn({});
    const res = await proxy(req("https://shop.storemink.com/dashboard/users"));
    expect(loc(res)).toBeNull();
  });

  it("still keeps POS staff out of the dashboard entirely", async () => {
    // The remaining claim checks are ALLOWLISTS, which is why they survive an
    // absent claim safely. This one must keep working.
    for (const role of ["cashier", "manager"]) {
      signedIn({ role });
      const res = await proxy(
        req("https://shop.storemink.com/dashboard/users"),
      );
      expect(loc(res), role).toContain("/pos");
    }
  });

  it("bounces a signed-in user away from /auth/login", async () => {
    signedIn({ role: "member" });
    const res = await proxy(req("https://shop.storemink.com/auth/login"));
    expect(loc(res)).toContain("/dashboard");
  });

  it("requires auth for /auth/set-password", async () => {
    const res = await proxy(
      req("https://shop.storemink.com/auth/set-password"),
    );
    expect(loc(res)).toContain("/auth/login");
  });

  it("does NOT gate the storefront (no auth check)", async () => {
    const res = await proxy(req("https://shop.storemink.com/shop"));
    expect(loc(res)).toBeNull();
    expect(verifySessionCookie).not.toHaveBeenCalled();
  });
});

describe("proxy — host routing (unchanged)", () => {
  it("permanently redirects www to the canonical apex", async () => {
    const res = await proxy(
      req(
        "https://www.storemink.com/legal/privacy?source=legacy",
        "www.storemink.com",
      ),
    );

    expect(res.status).toBe(308);
    expect(loc(res)).toBe("https://storemink.com/legal/privacy?source=legacy");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("passes static assets through untouched", async () => {
    const res = await proxy(req("https://shop.storemink.com/themes/x/a.webp"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(loc(res)).toBeNull();
  });

  it("rewrites platform-host paths into /platform/*", async () => {
    const res = await proxy(
      req("https://storemink.com/pricing", "storemink.com"),
    );
    expect(res.headers.get("x-middleware-rewrite")).toContain("/platform");
  });

  it("rewrites the reserved POS host into only the public POS product tree", async () => {
    const home = await proxy(
      req("https://pos.storemink.com/", "pos.storemink.com"),
    );
    expect(home.headers.get("x-middleware-rewrite")).toContain("/platform/pos");
    expect(verifySessionCookie).not.toHaveBeenCalled();

    const unknown = await proxy(
      req("https://pos.storemink.com/not-a-page", "pos.storemink.com"),
    );
    expect(unknown.headers.get("x-middleware-rewrite")).toContain(
      "/platform/pos/not-a-page",
    );
    expect(unknown.headers.get("x-middleware-rewrite")).not.toMatch(
      /\/platform\/not-a-page$/,
    );
  });

  it("rewrites the reserved themes host into the public catalog", async () => {
    const res = await proxy(
      req("https://themes.storemink.com/", "themes.storemink.com"),
    );
    expect(res.headers.get("x-middleware-rewrite")).toContain("/themes");
    expect(res.headers.get("x-middleware-rewrite")).not.toContain("/platform");
    expect(verifySessionCookie).not.toHaveBeenCalled();
  });
});

// A custom domain resolves to ONE load balancer backend, but
// `custom_domain_verified` is per-database — so a domain verified in the staging
// database made staging redirect to a host it can never serve. When that host's
// DNS is also incomplete the store is simply gone: storefront, /dashboard and
// /pos at once, with no cron off prod to run the auto-revert that would undo it.
describe("proxy — one address per store", () => {
  const shop = "https://shop.storemink.com/shop";

  it("redirects a subdomain to its verified custom domain in production", async () => {
    vi.mocked(canonicalHostForSlug).mockResolvedValue("xyz.com");
    const res = await proxy(req(shop));
    expect(res.status).toBe(308);
    expect(loc(res)).toBe("https://xyz.com/shop");
  });

  it("never caches the 308, so a revert reaches browsers that already followed it", async () => {
    vi.mocked(canonicalHostForSlug).mockResolvedValue("xyz.com");
    const res = await proxy(req(shop));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does NOT redirect off production, even with a verified domain", async () => {
    isProdPlatform = false;
    vi.mocked(canonicalHostForSlug).mockResolvedValue("storiq.in");
    const res = await proxy(
      req(
        "https://echos.staging.storemink.com/shop",
        "echos.staging.storemink.com",
      ),
    );
    expect(loc(res)).toBeNull();
  });

  it("skips the lookup entirely off production", async () => {
    // Not just the redirect: a per-request database round-trip on the storefront
    // path buys nothing when the answer can never be acted on.
    isProdPlatform = false;
    await proxy(
      req(
        "https://echos.staging.storemink.com/shop",
        "echos.staging.storemink.com",
      ),
    );
    expect(canonicalHostForSlug).not.toHaveBeenCalled();
  });

  it("leaves local dev alone (the case the old guard covered)", async () => {
    isProdPlatform = false;
    vi.mocked(canonicalHostForSlug).mockResolvedValue("xyz.com");
    const res = await proxy(
      req("http://shop.localhost:3000/shop", "shop.localhost:3000"),
    );
    expect(loc(res)).toBeNull();
  });

  it("stays on the subdomain when the store has no custom domain", async () => {
    const res = await proxy(req(shop));
    expect(loc(res)).toBeNull();
  });
});

// ── Blocked media (takedown design 3.3 steps 3 and 4) ────────────────────

const STORE = "a0000000-0000-4000-8000-000000000001";
const BUCKET = "https://storage.googleapis.com/sm-media";
const BLOCKED_OBJECT = `stores/${STORE}/media/a.webp`;
const BLOCKED_URL = `${BUCKET}/${BLOCKED_OBJECT}`;
const OK_URL = `${BUCKET}/stores/${STORE}/media/ok.webp`;
const BLOCKED_THEME = "/themes/vitrine/hero.webp";
const BLOCKED_OUTSIDE = "https://cdn.example.com/x/bag.jpg";

function blockRow(objectPath: string, fileSource: string): BlockedObjectRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    objectPath,
    fileSource,
    storeId: STORE,
    objectMd5: null,
    tellStore: true,
  };
}

const EMPTY_SET = buildBlockedMediaSet([], { bucket: "sm-media", loadedAt: 1 });
const BLOCKING_SET = buildBlockedMediaSet(
  [
    blockRow(BLOCKED_OBJECT, "bucket"),
    blockRow(BLOCKED_OUTSIDE, "external"),
    blockRow(BLOCKED_THEME, "bundled"),
  ],
  { bucket: "sm-media", loadedAt: 1 },
);

const PLACEHOLDER_FILE = readFileSync(
  path.join(process.cwd(), "public", "moderation", "image-unavailable.webp"),
);

function optimizer(url: string, host = "shop.storemink.com") {
  return req(
    `https://${host}/_next/image?url=${encodeURIComponent(url)}&w=640&q=75`,
    host,
  );
}

async function expectPlaceholder(res: any) {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/webp");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-middleware-next")).toBeNull();
  expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  const body = Buffer.from(await res.arrayBuffer());
  expect(body.equals(PLACEHOLDER_FILE)).toBe(true);
}

function expectPassedOn(res: any) {
  expect(res.headers.get("x-middleware-next")).toBe("1");
  expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  expect(loc(res)).toBeNull();
}

beforeEach(() => {
  currentSet = EMPTY_SET;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in proxy tests");
    }),
  );
});

describe("proxy: blocked media at the image optimiser", () => {
  it("answers a blocked url with the placeholder's bytes, never cached", async () => {
    currentSet = BLOCKING_SET;
    await expectPlaceholder(await proxy(optimizer(BLOCKED_URL)));
  });

  it.each([
    ["an escaped dot", `${BUCKET}/stores/${STORE}/media/a%2Ewebp`],
    ["escaped slashes", `${BUCKET}/stores%2F${STORE}%2Fmedia%2Fa.webp`],
    [
      "a virtual-hosted bucket",
      `https://sm-media.storage.googleapis.com/${BLOCKED_OBJECT}`,
    ],
    ["plain http", `http://storage.googleapis.com/sm-media/${BLOCKED_OBJECT}`],
    [
      "an upper-case host",
      `https://STORAGE.googleapis.com/sm-media/${BLOCKED_OBJECT}`,
    ],
    ["a blocked outside address", BLOCKED_OUTSIDE],
    ["a blocked theme file", BLOCKED_THEME],
    [
      "a theme file reached through dot segments",
      "/x/%2e%2e/themes/vitrine/hero.webp",
    ],
    ["a theme file spelled with an escape", "/%74hemes/vitrine/hero.webp"],
    [
      "a theme file on the store's own host",
      `https://shop.storemink.com${BLOCKED_THEME}`,
    ],
    [
      "a wrapped optimiser address",
      `/_next/image?url=${encodeURIComponent(BLOCKED_URL)}`,
    ],
  ])("catches %s", async (_label, url) => {
    currentSet = BLOCKING_SET;
    await expectPlaceholder(await proxy(optimizer(url)));
  });

  it("judges every url, not only the first", async () => {
    currentSet = BLOCKING_SET;
    const res = await proxy(
      req(
        `https://shop.storemink.com/_next/image?url=${encodeURIComponent(OK_URL)}&url=${encodeURIComponent(BLOCKED_URL)}&w=640&q=75`,
      ),
    );
    await expectPlaceholder(res);
  });

  it.each([
    ["a malformed escape", `${BUCKET}/stores/${STORE}/media/%E0%A4%A.webp`],
    ["a dot segment", "/themes/vitrine/../hero.webp"],
    ["a backslash", "/themes\\vitrine/hero.webp"],
    [
      "user information",
      "https://someone@storage.googleapis.com/sm-media/x.webp",
    ],
  ])("refuses %s with 400, before the set is read", async (_label, url) => {
    currentSet = BLOCKING_SET;
    const res = await proxy(optimizer(url));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-middleware-next")).toBeNull();
    expect(blockedMedia).not.toHaveBeenCalled();
  });

  it("refuses an unreadable url even while nothing is blocked", async () => {
    const res = await proxy(optimizer("/themes/a/../b.webp"));
    expect(res.status).toBe(400);
  });

  it.each([
    ["an unblocked object of ours", OK_URL],
    ["a relative app file", "/brand/20260908/storemink-mark.webp"],
    [
      "another bucket's object",
      `https://storage.googleapis.com/other-bucket/${BLOCKED_OBJECT}`,
    ],
    ["an unblocked theme file", "/themes/vitrine/other.webp"],
  ])("passes %s on to the optimiser", async (_label, url) => {
    currentSet = BLOCKING_SET;
    expectPassedOn(await proxy(optimizer(url)));
  });

  it("passes everything on without judging while nothing is blocked", async () => {
    expectPassedOn(await proxy(optimizer(BLOCKED_URL)));
    expect(blockedMedia).toHaveBeenCalledTimes(1);
  });

  it("passes a request with no url on (the optimiser answers it)", async () => {
    const res = await proxy(
      req("https://shop.storemink.com/_next/image?w=640&q=75"),
    );
    expectPassedOn(res);
    expect(blockedMedia).not.toHaveBeenCalled();
  });

  it("runs no host or session logic on the optimiser path", async () => {
    // www in production 308s every other path; the optimiser is answered
    // before the host is read, so nothing redirects and no session is read.
    const www = await proxy(optimizer(OK_URL, "www.storemink.com"));
    expectPassedOn(www);
    const store = await proxy(optimizer(OK_URL));
    expectPassedOn(store);
    expect(verifySessionCookie).not.toHaveBeenCalled();
    expect(canonicalHostForSlug).not.toHaveBeenCalled();
  });

  it("answers 503, never the file, when the placeholder cannot be read", async () => {
    currentSet = BLOCKING_SET;
    vi.mocked(placeholderWebp).mockRejectedValueOnce(new Error("disk"));
    const res = await proxy(optimizer(BLOCKED_URL));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-middleware-next")).toBeNull();
  });
});

describe("proxy: blocked files under /themes/", () => {
  it("answers a blocked theme file with the placeholder", async () => {
    currentSet = BLOCKING_SET;
    await expectPlaceholder(
      await proxy(req(`https://shop.storemink.com${BLOCKED_THEME}`)),
    );
  });

  it("catches the spelling the static file server decodes once", async () => {
    currentSet = BLOCKING_SET;
    await expectPlaceholder(
      await proxy(req("https://shop.storemink.com/%74hemes/vitrine/hero.webp")),
    );
  });

  it("answers before the host logic, on every host", async () => {
    currentSet = BLOCKING_SET;
    await expectPlaceholder(
      await proxy(
        req(`https://www.storemink.com${BLOCKED_THEME}`, "www.storemink.com"),
      ),
    );
    await expectPlaceholder(
      await proxy(
        req(
          `https://themes.storemink.com${BLOCKED_THEME}`,
          "themes.storemink.com",
        ),
      ),
    );
  });

  it("still passes an unblocked theme file through untouched", async () => {
    currentSet = BLOCKING_SET;
    const res = await proxy(
      req("https://shop.storemink.com/themes/vitrine/other.webp"),
    );
    expectPassedOn(res);
  });
});

describe("proxy: pages never read the blocked set", () => {
  it.each(["/shop", "/dashboard", "/shop/almond-shake", "/"])(
    "%s",
    async (pathname) => {
      currentSet = BLOCKING_SET;
      await proxy(req(`https://shop.storemink.com${pathname}`));
      expect(blockedMedia).not.toHaveBeenCalled();
    },
  );
});

describe("proxy: matcher", () => {
  it.each([
    ["/_next/image?url=%2Fthemes%2Fx.webp&w=64&q=75", true],
    ["/shop", true],
    ["/themes/vitrine/hero.webp", true],
    ["/_next/static/chunks/main.js", false],
    ["/api/og-image?url=x", false],
    ["/favicon.ico", false],
  ])("%s runs the proxy: %s", (url, expected) => {
    expect(
      unstable_doesMiddlewareMatch({
        config,
        url: `https://shop.storemink.com${url}`,
      }),
    ).toBe(expected);
  });
});
