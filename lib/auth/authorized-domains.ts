import "server-only";

// ---------------------------------------------------------------------------
// Keeping store hosts in Identity Platform's authorized-domain list.
//
// ★ TWO SIGN-IN METHODS, TWO DIFFERENT RULES.
// - `signInWithPopup` (Google) checks the origin client-side with the SDK's
//   `matchDomain`, where an entry covers itself and every subdomain
//   (`entryCovers`). One `storemink.com` entry is enough for popups on every
//   `{slug}.storemink.com`.
// - Phone sign-in (signInWithPhoneNumber / verifyPhoneNumber, reCAPTCHA v2 and
//   Enterprise) is checked SERVER-SIDE against the EXACT hostname. Verified in
//   production 2026-10-10: echoss.storemink.com failed with "CAPTCHA_CHECK_FAILED
//   : Hostname match not found" while storemink.com was listed, and adding the
//   exact host fixed it at once. So coverage is not enough for phone codes.
//
// This module therefore lists every EXACT host a store serves, which satisfies
// both rules (an entry covers itself), via `ensureAuthorizedHosts` and the
// sweep in lib/auth/store-auth-hosts-sync.ts. Firebase accepts no wildcards.
//
// ★ NO REGISTRABLE ENTRIES ANY MORE. Custom domains used to add their
// registrable domain for popups, computed with the ICANN-only suffix list, so
// `acme.eu.org` added `eu.org` and authorised popups on every free `*.eu.org`
// site. Exact hosts make that entry redundant; removal still cleans up the
// ones already listed (`detachedDomainEntries`).
//
// ★ BEST EFFORT, ALWAYS. A failure here must never stop a domain going live or
// a sweep finishing; the next run retries.
// ---------------------------------------------------------------------------

import { inArray, or } from "drizzle-orm";
import { GoogleAuth } from "google-auth-library";
import { getDomain } from "tldts";
import { stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { domainHosts } from "@/lib/domains/domain";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { isLocalDevHostname } from "@/lib/store/host";
import { normalizeAuthHost, storeAuthHosts } from "./store-auth-hosts";

export { normalizeAuthHost };

const API = "https://identitytoolkit.googleapis.com/admin/v2";

/**
 * Entries we must never remove, whatever a caller passes.
 *
 * Removing `storemink.com` would break sign-in for the platform AND every
 * store subdomain in one call — the same class of hazard `assertManaged`
 * guards in the certificate map, and worth the same explicit list.
 */
const PROTECTED = [/^localhost$/i, /\.firebaseapp\.com$/i, /\.web\.app$/i];

/**
 * The platform's own hosts under the root domain. ★ Protected too: a store can
 * connect a custom domain shaped like one of them only by mistake, but a detach
 * removes what it added, and losing `www.` or `pos.` would break sign-in for the
 * whole platform host, not one store.
 */
const PLATFORM_HOST_LABELS = [
  "www",
  "app",
  "help",
  "pos",
  "themes",
  "staging",
  "dev",
];

/** Comparison form of a stored entry: trimmed, lowercase, no trailing dots. */
function entryKey(entry: string): string {
  return entry.trim().toLowerCase().replace(/\.+$/, "");
}

function isProtected(entry: string, rootDomain: string): boolean {
  const e = entryKey(entry);
  const root = normalizeAuthHost(rootDomain) ?? entryKey(rootDomain);
  if (e === root) return true;
  if (PLATFORM_HOST_LABELS.some((label) => e === `${label}.${root}`))
    return true;
  // ★ The local dev roots (localhost, localtest.me): staging's list carries
  // `localtest.me` for every developer's machine, and a store on staging that
  // connected and then detached it would otherwise take it off the list.
  if (isLocalDevHostname(e)) return true;
  return PROTECTED.some((re) => re.test(e));
}

/**
 * Does an authorized-domain ENTRY cover a given host for signInWithPopup?
 *
 * ★ A FAITHFUL MIRROR of `matchDomain` in @firebase/auth (v12):
 *
 *     new RegExp('^(.+\\.' + escaped + '|' + escaped + ')$', 'i')
 *
 * i.e. an entry authorises itself AND every subdomain beneath it — for the
 * POPUP check only. Phone sign-in needs the exact host listed (module header),
 * which `planAddHosts` maintains. Nothing here decides what to add by
 * coverage any more; this pins the SDK rule the root entry relies on.
 */
export function entryCovers(entry: string, host: string): boolean {
  const e = entryKey(entry);
  const h = entryKey(host);
  if (!e || !h) return false;
  // Extension origins never match a web host.
  if (e.startsWith("chrome-extension://")) return false;
  // An IP entry has to be exact — there are no subdomains of an address.
  if (/^\d+(\.\d+)+$/.test(e)) return h === e;
  const escaped = e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(.+\\.${escaped}|${escaped})$`, "i").test(h);
}

/**
 * The REGISTRABLE entry the old popup model added for a connected domain
 * (`www.acme.com` → `acme.com`, `acme.eu.org` → `eu.org`).
 *
 * ★ LEGACY, FOR REMOVAL ONLY. Nothing adds it now (module header). It is
 * computed exactly as it was added, ICANN-only suffix list included, so a
 * detach can find and clear the entries already on the list.
 */
export function legacyRegistrableEntry(domain: string): string | null {
  const host = normalizeAuthHost(domain);
  if (!host) return null;
  return getDomain(host) ?? host;
}

/**
 * Every entry a detached custom domain may have put on the list: its exact
 * apex/www hosts and the legacy registrable entry. Removal still checks each
 * one against the stores that serve it (`hostsStillServed`).
 */
export function detachedDomainEntries(domain: string): string[] {
  const legacy = legacyRegistrableEntry(domain);
  return cleanHosts([...exactHostsFor(domain), ...(legacy ? [legacy] : [])]);
}

/** Normalised, deduplicated hosts, input order kept; invalid ones dropped. */
function cleanHosts(hosts: string[]): string[] {
  const out = new Set<string>();
  for (const raw of hosts) {
    const host = typeof raw === "string" ? normalizeAuthHost(raw) : null;
    if (host) out.add(host);
  }
  return [...out];
}

/**
 * Append every host not already listed EXACTLY (case-insensitive).
 *
 * ★ Membership, never coverage: `storemink.com` present does NOT make
 * `acme.storemink.com` redundant, because phone sign-in checks the exact host.
 * Existing entries keep their order and spelling; new ones go on the end.
 */
export function planAddHosts(
  current: string[],
  hosts: string[],
): { next: string[]; added: string[] } {
  const present = new Set(current.map(entryKey));
  const added = cleanHosts(hosts).filter((h) => !present.has(h));
  return { next: added.length ? [...current, ...added] : current, added };
}

/**
 * Remove exactly these hosts. Never a protected entry (the root domain,
 * localhost, *.firebaseapp.com, *.web.app), and never by coverage.
 */
export function planRemoveHosts(
  current: string[],
  hosts: string[],
  rootDomain: string,
): { next: string[]; removed: string[] } {
  const targets = new Set(
    cleanHosts(hosts).filter((h) => !isProtected(h, rootDomain)),
  );
  const removed = new Set<string>();
  const next = current.filter((e) => {
    const key = entryKey(e);
    if (!targets.has(key)) return true;
    removed.add(key);
    return false;
  });
  return { next: removed.size ? next : current, removed: [...removed] };
}

// --- The API side -----------------------------------------------------------

let authClient: GoogleAuth | null = null;
function auth(): GoogleAuth {
  authClient ??= new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return authClient;
}

function projectId(): string {
  return (
    process.env.FIREBASE_PROJECT_ID ??
    process.env.DOMAIN_GCP_PROJECT_ID ??
    process.env.GCP_PROJECT_ID ??
    ""
  );
}

async function configRequest<T>(
  method: "GET" | "PATCH",
  project: string,
  body?: unknown,
  query = "",
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const client = await auth().getClient();
    const token = await client.getAccessToken();
    const res = await fetch(`${API}/projects/${project}/config${query}`, {
      method,
      headers: {
        authorization: `Bearer ${token.token ?? ""}`,
        "content-type": "application/json",
        // The Identity Platform API bills against a quota project. On Cloud Run
        // the attached SA supplies it, but stating it explicitly also makes this
        // work under local ADC, where it is otherwise a 403.
        "x-goog-user-project": project,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const err = json.error as { message?: string } | undefined;
      return { ok: false, error: err?.message ?? text };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "config request failed",
    };
  }
}

type ListResult =
  | { ok: true; project: string; current: string[] }
  | { ok: false; error: string };

async function readList(): Promise<ListResult> {
  const project = projectId();
  if (!project) return { ok: false, error: "no Firebase project configured" };
  const read = await configRequest<{ authorizedDomains?: string[] }>(
    "GET",
    project,
  );
  if (!read.ok) return { ok: false, error: read.error ?? "read failed" };
  return { ok: true, project, current: read.data?.authorizedDomains ?? [] };
}

/**
 * A size tripwire, not a known limit: Firebase publishes no cap for this
 * list, but with one entry per store host it grows with the platform, and a
 * refusal past an unpublished ceiling would silently break new stores' phone
 * sign-in with nothing pointing at the cause.
 */
const LIST_WARN_AT = 150;

function warnIfLong(next: string[]): void {
  if (next.length >= LIST_WARN_AT) {
    logWarn("authorized domains list is getting long", { count: next.length });
  }
}

/** ONE write of the whole list; the caller has already decided it changed. */
async function writeList(
  project: string,
  next: string[],
): Promise<{ ok: boolean; error?: string }> {
  return configRequest(
    "PATCH",
    project,
    { authorizedDomains: next },
    "?updateMask=authorizedDomains",
  );
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Make sure every host is listed EXACTLY. One GET, and one PATCH only when
 * something is missing. Never throws.
 *
 * ⚠ READ-MODIFY-WRITE on a project-global list, so two writers in the same
 * second can lose one update. Deliberately not locked: the sweep re-adds
 * whatever is missing on its next run.
 */
export async function ensureAuthorizedHosts(
  hosts: string[],
): Promise<{ added: string[]; error?: string }> {
  try {
    const wanted = cleanHosts(hosts);
    if (wanted.length === 0) return { added: [] };

    const list = await readList();
    if (!list.ok) return { added: [], error: list.error };

    const plan = planAddHosts(list.current, wanted);
    if (plan.added.length === 0) return { added: [] };

    warnIfLong(plan.next);
    const write = await writeList(list.project, plan.next);
    if (!write.ok) {
      logError("ensureAuthorizedHosts", write.error, {
        hosts: plan.added.length,
      });
      return { added: [], error: write.error };
    }
    // A first sweep can add hundreds; the count plus a sample is enough.
    logInfo("authorized hosts added", {
      count: plan.added.length,
      hosts: plan.added.slice(0, 20),
    });
    return { added: plan.added };
  } catch (err) {
    return { added: [], error: message(err, "ensureAuthorizedHosts failed") };
  }
}

/**
 * Which of `hosts` a store row still serves sign-in on, by the rule the sweep
 * adds them (`storeAuthHosts`). ONE indexed read: `stores.slug` and
 * `stores.custom_domain` are both unique.
 *
 * ★ WHY. Removal runs after a domain is detached or a store deleted, but the
 * same host can belong to someone else: a store live on `acme.com` owns the
 * registrable entry a `shop.acme.com` detach would clear, a store on
 * `www.acme.com` owns the companion an `acme.com` detach would clear, and a
 * store re-created on a deleted slug owns that slug's host. Dropping any of
 * them breaks a live store's phone codes until the next sweep.
 */
async function hostsStillServed(
  hosts: string[],
  rootDomain: string,
): Promise<Set<string>> {
  const root = normalizeAuthHost(rootDomain);
  const slugs = new Set<string>();
  const domains = new Set<string>();
  for (const host of hosts) {
    if (root && host.endsWith(`.${root}`)) {
      const label = host.slice(0, -(root.length + 1));
      if (!label.includes(".")) slugs.add(label);
      continue;
    }
    // A store on `acme.com` also serves `www.acme.com`, and the reverse.
    for (const h of domainHosts(host)) domains.add(h);
  }
  if (slugs.size === 0 && domains.size === 0) return new Set();

  const rows = await withService((db) =>
    db
      .select({
        slug: stores.slug,
        customDomain: stores.customDomain,
        settings: stores.settings,
      })
      .from(stores)
      .where(
        or(
          slugs.size ? inArray(stores.slug, [...slugs]) : undefined,
          domains.size ? inArray(stores.customDomain, [...domains]) : undefined,
        ),
      ),
  );

  const wanted = new Set(hosts);
  const served = new Set<string>();
  for (const row of rows) {
    const claimed = storeAuthHosts(
      {
        slug: row.slug,
        custom_domain: row.customDomain,
        settings: row.settings,
      },
      rootDomain,
    );
    for (const host of claimed) if (wanted.has(host)) served.add(host);
  }
  return served;
}

/**
 * The one removal path: drop the listed `hosts` that no store still serves.
 * One GET; the store read only when something listed would go; one PATCH.
 *
 * ★ The store read sits AFTER the list read, right before the write, so the
 * window in which a new claim can be missed is as short as it can be. A store
 * created inside it is re-added by the hourly sweep.
 *
 * ★ FAILS SAFE: an unreadable stores table removes nothing. Leaving a stale
 * entry costs one list slot; removing a live store's host costs its sign-in.
 */
async function removeUnservedHosts(
  hosts: string[],
  rootDomain: string,
  op: string,
  context: Record<string, unknown>,
): Promise<{ removed: string[]; kept: string[]; error?: string }> {
  const targets = cleanHosts(hosts);
  if (targets.length === 0) return { removed: [], kept: [] };

  const list = await readList();
  if (!list.ok) return { removed: [], kept: [], error: list.error };

  const listed = planRemoveHosts(list.current, targets, rootDomain).removed;
  if (listed.length === 0) return { removed: [], kept: [] };

  let served: Set<string>;
  try {
    served = await hostsStillServed(listed, rootDomain);
  } catch (err) {
    return {
      removed: [],
      kept: [],
      error: `could not check which stores still use these hosts: ${message(err, "store read failed")}`,
    };
  }
  const kept = listed.filter((h) => served.has(h));
  if (kept.length > 0) {
    logInfo("authorized hosts kept: a store still serves them", {
      ...context,
      hosts: kept,
    });
  }

  const plan = planRemoveHosts(
    list.current,
    listed.filter((h) => !served.has(h)),
    rootDomain,
  );
  if (plan.removed.length === 0) return { removed: [], kept };

  const write = await writeList(list.project, plan.next);
  if (!write.ok) {
    logError(op, write.error, { ...context, hosts: plan.removed.length });
    return { removed: [], kept, error: write.error };
  }
  logInfo("authorized hosts removed", {
    ...context,
    count: plan.removed.length,
    hosts: plan.removed.slice(0, 20),
  });
  return { removed: plan.removed, kept };
}

/**
 * Remove exactly these hosts, unless a store still serves one (a slug
 * re-created after a delete). Never a protected entry. Never throws.
 */
export async function removeAuthorizedHosts(
  hosts: string[],
  rootDomain: string,
): Promise<{ removed: string[]; error?: string }> {
  try {
    const result = await removeUnservedHosts(
      hosts,
      rootDomain,
      "removeAuthorizedHosts",
      {},
    );
    return result.error
      ? { removed: [], error: result.error }
      : { removed: result.removed };
  } catch (err) {
    return {
      removed: [],
      error: message(err, "removeAuthorizedHosts failed"),
    };
  }
}

/** The exact hosts a connected domain serves (apex + www companion). */
function exactHostsFor(domain: string): string[] {
  const host = normalizeAuthHost(domain);
  return host ? domainHosts(host) : [];
}

/**
 * Make sure `domain` can host both popup and phone sign-in. Idempotent: one
 * read, and one write only when a host is missing.
 *
 * ★ EXACT HOSTS ONLY. An exact entry covers itself for popups too
 * (`entryCovers`), so the hosts StoreMink serves need nothing wider, and a
 * registrable entry for a shared-hosting name (`acme.eu.org` → `eu.org`)
 * would authorise popups on every site under that suffix. Reconcile calls
 * this on every healthy pass, so whatever it adds comes back if removed.
 */
export async function ensureAuthorizedDomain(
  domain: string,
): Promise<{ added?: boolean; error?: string }> {
  const result = await ensureAuthorizedHosts(exactHostsFor(domain));
  if (result.error) return { error: result.error };
  return { added: result.added.length > 0 };
}

/**
 * Drop a domain we no longer serve, so the list can't grow without bound. ONE
 * write removes its exact apex/www hosts and the legacy registrable entry,
 * except any host another store still serves; protected entries are never
 * touched. Never throws.
 */
export async function removeAuthorizedDomain(
  domain: string,
  rootDomain: string,
): Promise<{ removed?: boolean; error?: string }> {
  try {
    const result = await removeUnservedHosts(
      detachedDomainEntries(domain),
      rootDomain,
      "removeAuthorizedDomain",
      { domain },
    );
    return result.error
      ? { error: result.error }
      : { removed: result.removed.length > 0 };
  } catch (err) {
    return { error: message(err, "removeAuthorizedDomain failed") };
  }
}
