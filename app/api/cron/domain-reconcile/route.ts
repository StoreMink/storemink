// ---------------------------------------------------------------------------
// The custom-domain backstop.
//
// ★ WHY THIS EXISTS. Connecting a domain takes three steps that cannot complete
// in one sitting: the merchant adds DNS records at their registrar, Google
// issues the certificate (documented as up to ~30 minutes AFTER the challenge
// CNAME resolves), and only then can the certificate be attached to the load
// balancer's map and the store flipped live. Provisioning had exactly one
// caller — the settings page — which polled for ~10 minutes and made no
// progress at all while the tab was backgrounded. So in the ordinary case
// (merchant adds records, closes the dashboard, DNS propagates) the certificate
// reached ACTIVE at Google and NOTHING ever attached it. The domain never went
// live, and the dashboard still said "waiting for your DNS records".
//
// This is the same shape as /api/cron/expire-pending-payments and the refund
// sweep: reconcile-on-read for the person who is watching, a cron for everyone
// who isn't.
//
// Runs HOURLY. Issuance is measured in tens of minutes and merchants edit DNS on
// their own schedule, so a daily sweep would mean a domain connected at 09:05
// waits a day to serve.
//
// It ALSO health-checks domains that are already live, because the store
// subdomain now redirects to them — an unwatched broken domain is a lock-out, not
// a cosmetic problem. Still cheap: shouldHealthCheck returns early for a live
// domain checked in the last 6 hours, so the hourly run does almost nothing.
//
// ★ AND IT KEEPS PHONE SIGN-IN WORKING ON EVERY STORE HOST (`authHostsPass`).
// Phone codes are checked against the EXACT hostname in Identity Platform's
// authorizedDomains (lib/auth/store-auth-hosts.ts), so a store whose host is
// missing cannot send a single code. The pass is add-only and idempotent, so an
// hourly run repairs any miss within the hour and, on the first run after a
// deploy, backfills every existing store.
// ---------------------------------------------------------------------------

import { sweepPendingDomains } from "@/lib/domains/reconcile";
import { recordEvent } from "@/lib/notifications/record";
import { getStoreOriginById } from "@/lib/site";
import { logError } from "@/lib/observability/logger";
import { after } from "next/server";
import { ensureGoogleCoverageForStore } from "@/lib/seo/store-indexing";
import { reconcileStoreSearchSource } from "@/lib/seo/search-metrics";
import {
  syncStoreAuthHosts,
  type StoreAuthHostSyncResult,
} from "@/lib/auth/store-auth-hosts-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return (
    !!secret && request.headers.get("authorization") === `Bearer ${secret}`
  );
}

async function handle(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const domains = await reconcileDomains();

  // ★ AFTER the domain work, never beside it. The sweep's ensureAuthorizedDomain
  // (a domain that just went live) and this pass both read-modify-write the
  // same project-global list, so running them together can lose a write; in
  // sequence, a domain that just went live is read back as verified here and a
  // failed add on that edge is repaired in the same run. It runs even when the
  // sweep threw: its input is the stores table, not the sweep, so a Certificate
  // Manager outage must not also stop phone sign-in repairs.
  //
  // ★ ITS FAILURE NEVER CHANGES THE STATUS. The status is Cloud Scheduler's
  // retry signal for the DOMAIN sweep: a 500 for an Identity Platform or IAM
  // error would re-run certificate and health work three times for a problem
  // no retry fixes, then keep the job red every hour (the permanently-red-job
  // lesson below). The failure is logged for Error Reporting (by the sync, or
  // by authHostsPass if it throws) and named in the body.
  const authHosts = await authHostsPass();

  return Response.json(
    { ...domains.body, authHosts },
    { status: domains.status },
  );
}

/** Add every active store's missing exact hosts. Never throws. */
async function authHostsPass(): Promise<StoreAuthHostSyncResult> {
  try {
    return await syncStoreAuthHosts();
  } catch (err) {
    // The sync promises never to throw and logs its own failures, so only a
    // broken promise reaches here; log it, or it would be silent.
    logError("domain-reconcile auth-host sync failed", err);
    return {
      stores: 0,
      expected: 0,
      added: [],
      error: err instanceof Error ? err.message : "auth host sync failed",
    };
  }
}

async function reconcileDomains(): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  try {
    const result = await sweepPendingDomains();

    // recordEvent, NOT emitEvent: emitEvent defers through after(), which has
    // nothing to defer onto once a cron response is sent (§notifications).
    //
    // This is the path that MATTERS for the merchant mail. The whole reason the
    // sweep exists is that they are not watching, so in the ordinary case this
    // is what tells them their domain went live — the action path only fires for
    // someone who happened to be on the page at the moment it finished.
    for (const store of result.becameLive) {
      const subject = {
        type: "store",
        id: store.storeId,
        label: store.domain ?? "",
      };
      await recordEvent({
        type: "store.domain_live",
        storeId: store.storeId,
        actor: { type: "system" },
        subject,
        payload: {
          domain: store.domain ?? "",
          store_url: `https://${store.domain ?? ""}`,
          extra_hosts: (store.extraHosts ?? []).join(", "),
        },
      });
      await recordEvent({
        type: "platform.domain_verified",
        storeId: store.storeId,
        actor: { type: "system" },
        subject,
        payload: { domain: store.domain ?? "" },
      });
    }

    if (result.becameLive.length) {
      after(() =>
        Promise.allSettled(
          result.becameLive.flatMap((store) => [
            ensureGoogleCoverageForStore(store.storeId),
            reconcileStoreSearchSource(store.storeId),
          ]),
        ),
      );
    }

    // A domain that FELL OVER. The store's public address just changed under the
    // merchant and every link they have shared now goes somewhere else, so this
    // is the one notification in the flow that must not be missable.
    for (const store of result.reverted) {
      await recordEvent({
        type: "store.domain_reverted",
        storeId: store.storeId,
        actor: { type: "system" },
        subject: {
          type: "store",
          id: store.storeId,
          label: store.domain ?? "",
        },
        payload: {
          domain: store.domain ?? "",
          store_url: (await getStoreOriginById(store.storeId)) ?? "",
          reason: store.error ?? "",
        },
      });
    }

    // 200 even with failures still outstanding. Unlike seo-refresh — where a
    // failure means OUR configuration is broken and Cloud Scheduler's retries
    // are wanted — the overwhelmingly common "failure" here is a merchant who
    // hasn't added their DNS records yet. Retrying that within the hour cannot
    // help, and a permanently-red job is a job nobody looks at.
    return {
      status: 200,
      body: {
        ok: true,
        pending: result.pending,
        live: result.live,
        becameLive: result.becameLive.map((s) => s.domain),
        // Previously-live domains that failed repeated checks and were moved
        // back to their subdomain. Should be rare; if it is not, look at the
        // health thresholds in reissue/health.ts before assuming the domains
        // are at fault.
        reverted: result.reverted.map((s) => s.domain),
        // Hosts whose certificate was reset to escape Google's retry backoff.
        // If this is ever non-empty on consecutive runs for the same host, the
        // cooldown in reissue.ts is not doing its job — look there first.
        reissued: result.reissued,
        waiting: result.failures,
      },
    };
  } catch (err) {
    logError("domain-reconcile cron failed", err);
    return {
      status: 500,
      body: {
        ok: false,
        error: err instanceof Error ? err.message : "domain reconcile failed",
      },
    };
  }
}

export const GET = handle;
export const POST = handle;
