import { afterEach, describe, it, expect } from "vitest";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from "next/constants";
import configForPhase from "./next.config";
import { matchHas } from "next/dist/shared/lib/router/utils/prepare-destination";
import { LOCAL_DEV_ROOT, ROOT_DOMAIN, parseHost } from "./lib/store/host";

/**
 * The dashboard redirects, and which paths they are allowed to swallow.
 *
 * ★★ A CATCH-ALL TOOK TWO LIVE SURFACES WITH IT. Folding coupons into offers
 * added `/dashboard/marketing/coupons/:path*` → `/dashboard/offers`, and Next
 * applies `redirects()` BEFORE filesystem routing — so it also captured
 * `[id]/edit` and `[id]/email`, neither of which had moved:
 *
 *   • Coupon EMAIL CAMPAIGNS are keyed on a `coupons` row throughout
 *     (`email_campaigns`, `lib/mink/campaign-*`). `[id]/email` is the only way
 *     to send one, so the Pro feature had no reachable UI at all.
 *   • Mink Phase 4C still CREATES `coupons`, and its own artifacts hand the
 *     merchant `/dashboard/marketing/coupons/{id}/edit`. That id may exist ONLY
 *     in `coupons`, so redirecting it to the offers list dead-ends on a list
 *     that cannot contain it.
 *
 * These are cheap to get wrong again — a catch-all reads like tidying up — so
 * the boundary is asserted rather than remembered.
 */

type HostCondition = { type: string; key?: string; value?: string };
type Redirect = {
  source: string;
  destination: string;
  permanent: boolean;
  has?: HostCondition[];
  missing?: HostCondition[];
};

async function redirects(phase: string): Promise<Redirect[]> {
  const nextConfig = configForPhase(phase);
  const fn = nextConfig.redirects;
  if (typeof fn !== "function")
    throw new Error("no redirects() in next.config");
  return (await fn.call(nextConfig)) as Redirect[];
}

/** Next's own matching, reduced to what these rules use: `:param` and `:p*`. */
function matches(source: string, path: string): boolean {
  const pattern = source
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:[A-Za-z]+\*/g, ".*")
    .replace(/:[A-Za-z]+/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(path);
}

const firstMatch = (rules: Redirect[], path: string) =>
  rules.find((r) => matches(r.source, path));

/** The redirect a request for `path` on `host` gets, if any. The host half is
 *  Next's OWN `matchHas` (port stripped, lower-cased, `^value$`), so these
 *  tests judge the rule the way the router will rather than a copy of it. */
const firstMatchOn = (rules: Redirect[], path: string, host: string) =>
  rules.find(
    (r) =>
      matches(r.source, path) &&
      matchHas(
        { headers: { host } } as never,
        {},
        r.has as never,
        r.missing as never,
      ) !== false,
  );

describe.each([
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
])("dashboard redirects (%s)", (phase) => {
  it("★★ leaves the coupon EMAIL campaign page reachable", async () => {
    const rules = await redirects(phase);
    expect(
      firstMatch(rules, "/dashboard/marketing/coupons/abc-123/email"),
    ).toBeUndefined();
  });

  it("★★ leaves a coupon EDIT page reachable, for Mink's own deep links", async () => {
    // `lib/mink/tools/draft-tools.ts` and `lib/mink/domain-actions.ts` hand the
    // merchant this exact path for a coupon Mink proposed.
    const rules = await redirects(phase);
    expect(
      firstMatch(rules, "/dashboard/marketing/coupons/abc-123/edit"),
    ).toBeUndefined();
  });

  it("still retires the destinations that genuinely moved", async () => {
    const rules = await redirects(phase);
    expect(firstMatch(rules, "/dashboard/marketing/coupons")?.destination).toBe(
      "/dashboard/offers",
    );
    // A new discount IS an offer now, so this lands on the editor rather than
    // bouncing to a list the merchant then has to act on.
    expect(
      firstMatch(rules, "/dashboard/marketing/coupons/new")?.destination,
    ).toBe("/dashboard/offers/new");
    expect(firstMatch(rules, "/dashboard/promotions")?.destination).toBe(
      "/dashboard/offers",
    );
  });

  it("★ every dashboard redirect is TEMPORARY", async () => {
    // These sit behind a login, so there are no SEO signals to consolidate —
    // and a 308 is cached by browsers indefinitely, which is the trap `proxy.ts`
    // already works around with `Cache-Control: no-store` (CODEBASE §30).
    const rules = await redirects(phase);
    for (const rule of rules.filter((r) => r.source.startsWith("/dashboard"))) {
      expect(rule.permanent).toBe(false);
    }
  });

  it("★ the retired log paths still resolve, because sent emails carry them", async () => {
    // Absolute `/dashboard/activity` links are in inboxes nobody can edit.
    const rules = await redirects(phase);
    expect(firstMatch(rules, "/dashboard/activity")?.destination).toBe(
      "/dashboard/logs",
    );
  });
});

/**
 * ★★ `/dashboard/themes` IS TWO DIFFERENT PAGES. On a store host it was the
 * theme page, which moved to /dashboard/storefront; on the platform host it is
 * the operator console's theme catalogue and Theme Studio, which did not move.
 * Redirects run before proxy.ts rewrites the platform into /platform/*, so a
 * rule that fired on the platform host would strand operators on a page the
 * console does not have. The rule's host pattern is a hand copy of parseHost's
 * platform list (next.config.ts is evaluated outside the module graph), so the
 * two are checked against each other here rather than trusted to agree.
 */
describe("the old Themes page redirect", () => {
  const root = ROOT_DOMAIN.split(":", 1)[0];
  const PLATFORM_HOSTS = [
    root,
    `www.${root}`,
    `app.${root}`,
    `pos.${root}`,
    `themes.${root}`,
    "localhost:3000",
    "localhost",
    "127.0.0.1:3000",
    "pos.localhost:3000",
    `${LOCAL_DEV_ROOT}:3000`,
    `pos.${LOCAL_DEV_ROOT}`,
    "storemink-git-main.vercel.app",
  ];
  const STORE_HOSTS = [
    `echos.${root}`,
    `my-themes.${root}`,
    `demo-vitrine.${root}`,
    "echos.localhost:3000",
    `echos.${LOCAL_DEV_ROOT}:3000`,
    "wholesip.com",
    "www.wholesip.com",
    `evil${root}`,
    `${root}.evil.example`,
  ];

  const ENV_KEYS = ["NEXT_PUBLIC_ROOT_DOMAIN", "NEXT_PUBLIC_LOCAL_DEV_ROOT"];
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("sends a store's old Themes link to Storefront, temporarily", async () => {
    const rules = await redirects(PHASE_PRODUCTION_SERVER);
    for (const host of STORE_HOSTS) {
      const rule = firstMatchOn(rules, "/dashboard/themes", host);
      expect(rule?.destination, host).toBe("/dashboard/storefront");
      expect(rule?.permanent, host).toBe(false);
    }
  });

  it("★★ never touches the operator console's Themes page", async () => {
    const rules = await redirects(PHASE_PRODUCTION_SERVER);
    for (const host of PLATFORM_HOSTS) {
      expect(
        firstMatchOn(rules, "/dashboard/themes", host),
        host,
      ).toBeUndefined();
    }
  });

  it("★★ agrees with parseHost about which hosts are the platform", async () => {
    for (const phase of [
      PHASE_DEVELOPMENT_SERVER,
      PHASE_PRODUCTION_BUILD,
      PHASE_PRODUCTION_SERVER,
    ]) {
      const rules = await redirects(phase);
      for (const host of [...PLATFORM_HOSTS, ...STORE_HOSTS]) {
        const redirected = !!firstMatchOn(rules, "/dashboard/themes", host);
        expect(redirected, `${phase} ${host}`).toBe(
          parseHost(host).type !== "platform",
        );
      }
    }
  });

  it("leaves Theme Studio and every deeper path alone on every host", async () => {
    const rules = await redirects(PHASE_PRODUCTION_SERVER);
    for (const host of [...PLATFORM_HOSTS, ...STORE_HOSTS]) {
      expect(
        firstMatchOn(rules, "/dashboard/themes/studio", host),
        host,
      ).toBeUndefined();
      expect(
        firstMatchOn(rules, "/dashboard/themes/studio/abc/release", host),
        host,
      ).toBeUndefined();
    }
  });

  it("follows the deployment's root domain, port and all", async () => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = "staging.storemink.com";
    let rules = await redirects(PHASE_PRODUCTION_SERVER);
    expect(
      firstMatchOn(rules, "/dashboard/themes", "staging.storemink.com"),
    ).toBeUndefined();
    expect(
      firstMatchOn(rules, "/dashboard/themes", "echos.staging.storemink.com")
        ?.destination,
    ).toBe("/dashboard/storefront");

    // Local dev carries a port in the root domain; Next strips the host's.
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = "localhost:3000";
    rules = await redirects(PHASE_DEVELOPMENT_SERVER);
    expect(
      firstMatchOn(rules, "/dashboard/themes", "localhost:3000"),
    ).toBeUndefined();
    expect(
      firstMatchOn(rules, "/dashboard/themes", "echos.localhost:3000")
        ?.destination,
    ).toBe("/dashboard/storefront");
  });
});
