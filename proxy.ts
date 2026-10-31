import { type NextRequest, NextResponse } from "next/server";
import {
  parseHost,
  isHelpHost,
  isPosHost,
  isThemesHost,
  IS_PRODUCTION_PLATFORM,
  ROOT_DOMAIN,
} from "@/lib/store/host";
import { canonicalHostForSlug } from "@/lib/store/canonical";
import { logError } from "@/lib/observability/logger";
import {
  blockedMedia,
  isBlockedAddressIn,
  type BlockedMediaSet,
} from "@/lib/moderation/blocked-objects";
import {
  isInvalidMediaAddress,
  mediaKeyFromUrl,
} from "@/lib/moderation/media-key";
import {
  PLACEHOLDER_CONTENT_TYPE,
  placeholderWebp,
} from "@/lib/moderation/placeholder";
import { GCS_BUCKET_NAME } from "@/lib/storage/gcs";
import { SESSION_COOKIE, verifySessionCookie } from "@/lib/auth/session-cookie";
import {
  POS_DEVICE_COOKIE,
  POS_OPERATOR_COOKIE,
  verifyDeviceToken,
  verifyOperatorToken,
} from "@/lib/pos/session";

// POS routes served without any POS credential (see the /pos gate below).
const POS_PUBLIC_PATHS = ["/pos/login", "/pos/register", "/pos/reset"];

// File types served from public/ (today: ico, svg, txt, webp) plus the ones a
// future asset or app route would plausibly use. Deliberately explicit: see the
// note at the call site for what a permissive version cost us.
const ASSET_EXTENSION =
  /\.(?:avif|css|eot|gif|ico|jpe?g|js|json|map|mp4|otf|pdf|png|svg|ttf|txt|webm|webp|woff2?|xml|zip)$/i;

// ---------------------------------------------------------------------------
// Blocked media (takedown design 3.3 steps 3 and 4, 5.7).
//
// When StoreMink blocks a file, every page swaps its address for the
// placeholder (maskBlockedMedia), but two doors still lead to the file itself:
//
//   1. The image optimiser, `/_next/image?url=...`. It caches what it fetches
//      (4 hours by default), so it must never see a blocked address: the second
//      matcher entry runs this proxy on it, and a blocked `url` is answered here
//      with the placeholder's bytes, before the optimiser or its cache is
//      consulted. Bytes rather than a rewrite, so `Cache-Control: no-store` is
//      certainly the header that goes out and no cache keeps the placeholder
//      past a lift.
//   2. A file built into the app, `public/themes/...`. Next serves it on every
//      host, so the check runs before the host read and before the
//      ASSET_EXTENSION exit below, which would otherwise wave it through.
//
// ★ ONE KEY PER FILE. Every spelling is judged by mediaKeyFromUrl's key
// (`%2E`, `%2F`, a virtual-hosted bucket, `http`, a wrapper), so an encoded
// spelling of a blocked object is caught too. An address that cannot be read
// safely is answered 400 rather than passed on. Next also reads a request path
// the WHATWG way (dot segments, `%2e%2e`) and its static file server tries the
// path decoded once (`/%74hemes/...`), so those spellings are judged as well:
// this proxy is the only backstop for them (the page swap never sees them).
//
// ★ CHEAP. Only `/_next/image` and paths under `/themes/` read the blocked set,
// an in-memory copy reloaded at most every 30 seconds (a request waits for a
// reload at most 2 seconds, then the last good set decides). Pages never read
// it, so the storefront path gains no database work. The set never throws: a
// failed reload keeps the last good set, which is how a database outage fails
// open for pages while a file blocked before it stays blocked.
// ---------------------------------------------------------------------------

/** The image optimiser's path. Next serves it at exactly this path. */
const OPTIMIZER_PATH = "/_next/image";

/** Public files built into the app's themes (`public/themes/`). */
const THEMES_DIR = "/themes/";

/** Any spelling of the themes folder a static file server could read. */
const THEMES_PREFIX = /^\/themes\//i;

/** Nothing on this path may be kept by a browser or a CDN. */
const NO_STORE = "no-store";

function decodedOnce(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Whether this request is for the image optimiser. A trailing slash and a
 * percent-encoded spelling count too: whatever reaches the optimiser must
 * pass through here, and anything else that matches is answered 404 by Next.
 */
function isOptimizerPath(pathname: string): boolean {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return path === OPTIMIZER_PATH || decodedOnce(path) === OPTIMIZER_PATH;
}

/**
 * The spellings under which Next's static file server could answer this
 * path from `public/themes/`: the path as sent and the path decoded once
 * (it tries both), each with the folder name in its own case. Empty when the
 * path cannot be a themes file.
 */
function themesSpellings(path: string): string[] {
  const spellings: string[] = [];
  for (const candidate of [path, decodedOnce(path)]) {
    if (candidate === null || !THEMES_PREFIX.test(candidate)) continue;
    const spelling = `${THEMES_DIR}${candidate.slice(THEMES_DIR.length)}`;
    if (!spellings.includes(spelling)) spellings.push(spelling);
  }
  return spellings;
}

/**
 * Every spelling of an optimiser `url` worth judging: as given, as Next's
 * router reads a relative one (dot segments and `%2e%2e` resolved, which is
 * what the optimiser's internal fetch asks for), as the WHATWG URL parser
 * writes an absolute one (what the optimiser fetches), and any themes file
 * the relative one could reach.
 */
function optimizerUrlSpellings(url: string): string[] {
  const spellings = [url];
  const text = url.replace(/[\t\n\r]/g, "").trim();
  try {
    if (text.startsWith("/") && !text.startsWith("//")) {
      const parsed = new URL(text, "http://n");
      spellings.push(`${parsed.pathname}${parsed.search}`);
      spellings.push(...themesSpellings(parsed.pathname));
    } else if (/^https?:\/\//i.test(text)) {
      spellings.push(new URL(text).href);
    }
  } catch {
    // Unreadable as a URL: the spelling as given decides.
  }
  return spellings;
}

/** The placeholder's bytes, never cached by anyone. */
async function placeholderAnswer(): Promise<NextResponse> {
  try {
    const bytes = await placeholderWebp();
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": PLACEHOLDER_CONTENT_TYPE,
        "cache-control": NO_STORE,
      },
    });
  } catch (error) {
    logError("proxy: placeholder image could not be read", error);
    return imageUnavailable();
  }
}

/**
 * The answer when a blocked file cannot be swapped: nothing is served, and
 * nothing is kept.
 */
function imageUnavailable(): NextResponse {
  return new NextResponse("Image not available", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": NO_STORE,
    },
  });
}

/** An optimiser `url` that cannot be read safely (Next's own wording). */
function invalidImageAddress(): NextResponse {
  return new NextResponse('"url" parameter is invalid', {
    status: 400,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": NO_STORE,
    },
  });
}

/**
 * `/_next/image`: 400 for an unreadable `url`, the placeholder for a blocked
 * one, and otherwise straight on to the optimiser. Every `url` is judged (Next
 * refuses more than one, but never let that be the only guard).
 */
async function optimizerAnswer(
  searchParams: URLSearchParams,
  read: (set: BlockedMediaSet) => void,
): Promise<NextResponse> {
  const urls = searchParams.getAll("url");
  const config = { bucket: GCS_BUCKET_NAME };
  if (urls.some((url) => isInvalidMediaAddress(mediaKeyFromUrl(url, config)))) {
    return invalidImageAddress();
  }
  if (urls.length === 0) return NextResponse.next();
  const set = await blockedMedia();
  read(set);
  if (set.size === 0) return NextResponse.next();
  const blocked = urls.some((url) =>
    optimizerUrlSpellings(url).some((spelling) =>
      isBlockedAddressIn(set, spelling),
    ),
  );
  return blocked ? placeholderAnswer() : NextResponse.next();
}

/** A blocked file under `public/themes/`: the placeholder; else null. */
async function themesFileAnswer(
  pathname: string,
  read: (set: BlockedMediaSet) => void,
): Promise<NextResponse | null> {
  const spellings = themesSpellings(pathname);
  if (spellings.length === 0) return null;
  const set = await blockedMedia();
  read(set);
  if (set.sourceCounts.bundled === 0) return null;
  const blocked = spellings.some((spelling) =>
    isBlockedAddressIn(set, spelling),
  );
  return blocked ? placeholderAnswer() : null;
}

/**
 * The takedown check: a response to send now, or null to carry on with the
 * host and session logic. For `/_next/image` it always answers (that path
 * never needs the host logic, and never had it before it was matched).
 */
async function blockedMediaAnswer(
  request: NextRequest,
): Promise<NextResponse | null> {
  const { pathname, searchParams } = request.nextUrl;
  const optimizer = isOptimizerPath(pathname);
  let set: BlockedMediaSet | null = null;
  const read = (loaded: BlockedMediaSet) => {
    set = loaded;
  };
  try {
    return optimizer
      ? await optimizerAnswer(searchParams, read)
      : await themesFileAnswer(pathname, read);
  } catch (error) {
    // Not expected: every step above is total and the set never throws. An
    // image that could not be judged is not served while anything is blocked;
    // with nothing blocked there is nothing to hide, so it goes on as before.
    logError("proxy: blocked media check failed", error, { path: pathname });
    const nothingBlocked = (set as BlockedMediaSet | null)?.size === 0;
    if (nothingBlocked) return optimizer ? NextResponse.next() : null;
    return imageUnavailable();
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- Blocked media: before the host read and the ASSET_EXTENSION exit ---
  // See "Blocked media" above. Pages that are neither `/_next/image` nor under
  // `/themes/` leave without touching the blocked set.
  const blockedAnswer = await blockedMediaAnswer(request);
  if (blockedAnswer) return blockedAnswer;

  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");

  // --- One canonical platform host: www.storemink.com -> storemink.com ---
  // Search Console found the www homepage as a duplicate because it served the
  // same 200 HTML as the apex. The page-level canonical is still useful, but a
  // permanent host redirect prevents duplicate crawling and consolidates every
  // path/query before rendering. Production-only keeps local/staging host
  // routing untouched.
  const hostname = host?.split(":", 1)[0]?.toLowerCase();
  if (IS_PRODUCTION_PLATFORM && hostname === `www.${ROOT_DOMAIN}`) {
    const url = request.nextUrl.clone();
    url.host = ROOT_DOMAIN;
    url.port = "";
    url.protocol = "https:";
    return NextResponse.redirect(url, 308);
  }

  // --- Static public assets (e.g. /themes/arcade/preview.webp, svgs) ---
  // Serve them as-is on EVERY host. Without this, the platform/help rewrites
  // below would map /themes/... to /platform/themes/... and 404 the file.
  // (robots.txt / sitemap.xml are host-aware app routes at the root, and also
  // need to skip the rewrite — the extension list covers them.)
  //
  // ⚠ This is an ALLOWLIST of real asset extensions, not "any path with a
  // dot". It used to be the latter, on the assumption that app routes never
  // contain dots — which stopped being true the moment a route segment carried
  // an id with a dot in it (the notification console's `order.placed`). Such a
  // path matched here, skipped the session gate below, and reached the page
  // with no edge auth check at all. The page's own requireSectionAccess still
  // held, so nothing leaked, but a route is not supposed to depend on a single
  // layer. Keep this list to genuine file types; never widen it back to `\.\w+`.
  if (ASSET_EXTENSION.test(pathname)) {
    return NextResponse.next();
  }

  // --- Help centre: help.storemink.com -> /help/* ---
  if (isHelpHost(host) && !pathname.startsWith("/help")) {
    const url = request.nextUrl.clone();
    url.pathname = `/help${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }

  // --- POS product site: pos.storemink.com -> /platform/pos/* ---
  // This is the public product/marketing surface. A merchant's operational
  // register remains `{slug}.storemink.com/pos` and reaches the credential gate
  // below. Unknown paths stay under the POS route tree and therefore 404 rather
  // than accidentally exposing unrelated platform pages on this host.
  if (isPosHost(host) && !pathname.startsWith("/platform/pos")) {
    const url = request.nextUrl.clone();
    url.pathname = `/platform/pos${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }

  // --- Theme catalog: themes.storemink.com -> /themes/* ---
  // Branch before the generic platform rewrite. `themes` is reserved in store
  // signup and parseHost classifies it as platform, so it can never become a
  // merchant storefront by accident.
  if (isThemesHost(host) && !pathname.startsWith("/themes")) {
    const url = request.nextUrl.clone();
    url.pathname = `/themes${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }

  // --- Platform (storemink.com / app.* / localhost / preview): landing, login,
  //     signup. Rewrite all paths into the /platform/* route group so the
  //     storefront `/`, `/shop`, ... routes only ever serve store hosts. ---
  if (parseHost(host).type === "platform") {
    if (pathname.startsWith("/platform")) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = `/platform${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }

  // --- One address per store: {slug}.storemink.com -> verified custom domain ---
  //
  // A store with a live custom domain should have ONE address, not two that both
  // work: two hosts serving identical content split SEO signals, and a merchant
  // who has told the world about xyz.com does not want half their links on
  // xyz.storemink.com.
  //
  // 308, not 302: permanent AND method-preserving, so a POSTed form (checkout,
  // a dashboard action) survives the hop instead of being silently downgraded to
  // GET and losing its body.
  //
  // ★ THE GATE IS storeOrigin(), borrowed rather than reimplemented — see
  // lib/store/canonical.ts. That means this redirect UNDOES ITSELF exactly when
  // serving does: a lapsed Pro plan or an un-verified domain makes storeOrigin
  // return the subdomain, so the store keeps working there with no extra logic.
  // A failed lookup returns null and simply does not redirect.
  //
  // Applies to /dashboard and /pos too, deliberately (the merchant asked for one
  // address). ⚠ POS device + operator cookies are host-only and SameSite=Strict
  // by design, so every paired till must be re-authorised once after a domain
  // goes live — there is no way to carry a host-scoped credential across origins.
  //
  // ★★ PRODUCTION ONLY, and this is a correctness gate rather than caution.
  // A custom domain has ONE A record pointing at ONE load balancer IP, and
  // cloudbuild.yaml gives staging the SAME `_DOMAIN_LB_IP` and the SAME
  // `_DOMAIN_CERT_MAP` as production (one HTTPS proxy holds one map — see
  // lib/domains/naming.ts). That LB routes by Host, so any given merchant domain
  // reaches exactly one backend. Yet `custom_domain_verified` is per-DATABASE,
  // and staging and prod have separate ones — so a domain verified in the
  // staging database makes staging redirect to a host it can never itself serve.
  // The merchant's staging store then either lands on PRODUCTION (a different
  // database, where that store may not exist) or, if the domain's DNS is
  // incomplete, nowhere at all.
  //
  // That is not hypothetical: echos.staging.storemink.com 308'd to storiq.in,
  // whose zone holds only NS + SOA records, taking the storefront, /dashboard
  // and /pos down together with no way back in. And it could not self-heal —
  // §30's health check reverts a dead domain after 3 consecutive failures, but
  // it only runs from /api/cron/domain-reconcile, and every Cloud Scheduler job
  // targets https://storemink.com (docs/cron-jobs.md). Off prod, the safety net
  // this redirect depends on does not exist.
  //
  // This subsumes the older `*.localhost` check, which excluded local dev for
  // the identical reason ("redirecting local dev to a production custom domain
  // would make that store impossible to work on") — same bug, narrower guard.
  const storeHost = parseHost(host);
  if (storeHost.type === "store-subdomain" && IS_PRODUCTION_PLATFORM) {
    const canonical = await canonicalHostForSlug(storeHost.slug);
    if (canonical) {
      const url = request.nextUrl.clone();
      url.host = canonical;
      url.port = "";
      url.protocol = "https:";
      const res = NextResponse.redirect(url, 308);
      // ★★ MUST NOT BE CACHED, and this is not a micro-optimisation — it is what
      // keeps the auto-revert safety net working. A 308 is heuristically
      // cacheable, and browsers cache it INDEFINITELY: without this header, a
      // merchant whose domain later breaks would have the dead redirect pinned in
      // their own browser, so reverting `custom_domain_verified` would restore
      // the subdomain for the whole internet EXCEPT the one person who needs it.
      // The status stays 308 so search engines still consolidate signals onto the
      // custom domain; only client caching is suppressed.
      res.headers.set("cache-control", "no-store");
      return res;
    }
  }

  // --- Store hosts ({slug}.storemink.com / custom domains) ---
  // Only the dashboard, auth, and POS routes need the session gate; the
  // storefront stays anonymous + cache-friendly (no per-request auth check).
  if (
    !pathname.startsWith("/dashboard") &&
    !pathname.startsWith("/auth") &&
    !pathname.startsWith("/pos")
  ) {
    // Surface the builder's ?preview=1 to the storefront LAYOUT as a header.
    // The layout renders the header and footer, and needs to know whether to
    // show the merchant their unpublished chrome — but a layout cannot read
    // searchParams at all (Next 16: "Layouts do not rerender on navigation, so
    // they cannot access search params"), and only pages get the prop. A
    // request header is the one channel that reaches both.
    //
    // This is a HINT, not authorisation: getDraftChromeForPreview still runs
    // the same getManagerUserId("builder") gate as the page-draft loader, so
    // anyone can set this header and still see only published content.
    if (request.nextUrl.searchParams.get("preview") === "1") {
      const headers = new Headers(request.headers);
      headers.set("x-sm-preview", "1");
      return NextResponse.next({ request: { headers } });
    }
    return NextResponse.next();
  }

  try {
    // Verify the Firebase session cookie (Node runtime — see the file-level note
    // in lib/auth/session-cookie.ts). role / force_password_reset ride in the
    // cookie's custom claims, so gating needs NO DB query.
    const session = request.cookies.get(SESSION_COOKIE)?.value;
    const user = await verifySessionCookie(session);

    const redirectTo = (path: string) => {
      const url = request.nextUrl.clone();
      url.pathname = path;
      return NextResponse.redirect(url);
    };

    // --- POS gate: /pos requires a Firebase session (owner/admin), a paired
    //     device, or an active operator. Fine-grained checks (Pro + pos.enabled,
    //     operator resolution, device revocation) live in the /pos layout. The
    //     signature-only verify here is cheap and DB-free; it returns null (→
    //     login) when POS_SESSION_SECRET is unset, never 500s. ---
    if (pathname.startsWith("/pos")) {
      // Public POS entry points — reachable with NO session, device or operator.
      //   /pos/login    — the sign-in / authorize-device screen.
      //   /pos/register — invited staff completing setup from their email link,
      //                   typically on their own phone. The emailed TOKEN is the
      //                   authorization and is validated server-side by
      //                   getInviteInfo; requiring a credential here would make
      //                   the invitation impossible to accept.
      //   /pos/reset    — same reasoning for the forgot-PIN/password link: a
      //                   locked-out cashier has no credential by definition.
      if (
        POS_PUBLIC_PATHS.some(
          (p) => pathname === p || pathname.startsWith(`${p}/`),
        )
      ) {
        return NextResponse.next();
      }
      const hasDevice = !!verifyDeviceToken(
        request.cookies.get(POS_DEVICE_COOKIE)?.value,
      );
      const hasOperator = !!verifyOperatorToken(
        request.cookies.get(POS_OPERATOR_COOKIE)?.value,
      );
      if (!user && !hasDevice && !hasOperator) {
        return redirectTo("/pos/login");
      }
      return NextResponse.next();
    }

    // --- Gate 1: Auth check for /dashboard routes ---
    if (pathname.startsWith("/dashboard")) {
      if (!user) {
        // ALWAYS the admin login. A POS cookie is not an identity, and it must
        // never decide where a signed-out human is sent.
        //
        // This used to check for a pos_device/pos_operator cookie and redirect
        // to /pos instead — "this browser is a till, so send it to the till".
        // It locked OWNERS out of their own dashboard, and by construction only
        // owners: authorizeThisDevice is superadmin-only, so the owner's laptop
        // is the one browser that can be both an authorised till AND an admin
        // session. pos_device lasts 90 days, sm_session 14 — so two weeks after
        // authorising a device, the owner opening /dashboard was bounced to a
        // PIN pad they may not even have a PIN for, with no way back.
        //
        // Nothing is lost by dropping it: POS staff have Firebase accounts, so
        // they arrive here WITH a user and the role check below sends them to
        // /pos correctly. Anyone genuinely POS-only just sees a login page,
        // which is the honest answer to "you need an admin account for this".
        return redirectTo("/auth/login");
      }

      // POS staff (cashier/manager) have Firebase accounts but are POS-only —
      // their role claim keeps them out of the dashboard entirely.
      if (user.claims.role === "cashier" || user.claims.role === "manager") {
        return redirectTo("/pos");
      }

      // --- Gate 2: Force password reset ---
      if (user.claims.forcePasswordReset)
        return redirectTo("/auth/set-password");

      // ★★ THE SUPERADMIN-ONLY GATE ON /dashboard/users + /dashboard/media IS
      // GONE, and it was breaking Customers for EVERY store owner.
      //
      // Three things were wrong with it.
      //
      // (1) It read `role` from the SESSION COOKIE, and `createStore` never sets
      // that claim. Signup writes `role: "superadmin"` to the `admins` TABLE
      // (store-signup.ts) but never calls setUserClaims, so a wizard-created
      // owner has NO role claim at all. The dashboard renders their "Superadmin"
      // badge and the Customers link from the DATABASE, then this gate bounced
      // the click straight back to /dashboard — a visible link that silently
      // refused to open, for every store created through signup.
      //
      // (2) It was STALE. `/dashboard/users` used to be staff management; it was
      // repurposed into the SHOPPER list (see permissions.ts: "Was 'Users',
      // which read as staff. This is the SHOPPER list"). Locking the customer
      // list to the owner contradicts the `users` section existing with
      // view/manage actions precisely so a merchant can delegate it.
      //
      // (3) It was redundant. Both pages already call requireSectionAccess()
      // server-side (`users` / `media`), so the permission system is the gate and
      // removing this loses no protection — it removes a SECOND, disagreeing one.
      //
      // ⚠ Note the asymmetry that hid this: every other claim check here is an
      // ALLOWLIST (`role === "cashier"` → send to /pos), which passes safely when
      // the claim is missing. This was the only DENYLIST, so it was the only one
      // that failed closed on an absent claim. Don't reintroduce that shape —
      // gate on the permission sections, which read the database.
    }

    // --- Gate for the "authenticated, but not yet allowed onward" screens ---
    // /auth/set-password  — a forced password reset (claim-driven, above).
    // /auth/policy-update — a policy published at a new version since this
    //                       person last agreed. Which documents are outstanding
    //                       needs a DB query, so the REDIRECT to here lives in
    //                       the dashboard layout; the proxy only enforces that
    //                       you can't reach the screen signed out.
    if (
      (pathname === "/auth/set-password" ||
        pathname === "/auth/policy-update") &&
      !user
    ) {
      return redirectTo("/auth/login");
    }

    // --- Redirect authenticated users away from login page ---
    if (pathname === "/auth/login" && user) {
      return redirectTo(
        user.claims.forcePasswordReset ? "/auth/set-password" : "/dashboard",
      );
    }

    return NextResponse.next();
  } catch (error: unknown) {
    logError("proxy: middleware exception", error, { path: pathname, host });
    return new NextResponse(
      JSON.stringify({ error: "Internal Server Error" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

export const config = {
  // Run on everything except Next internals, static files, and API routes,
  // plus the image optimiser itself, so a blocked image is answered with the
  // placeholder before the optimiser fetches or caches it (takedown design
  // 3.3 step 3; see "Blocked media" above). `/api/og-image` stays excluded: it
  // checks the same blocked set itself.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/).*)",
    "/_next/image",
  ],
};
