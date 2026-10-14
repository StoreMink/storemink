import "server-only";

import { Resend } from "resend";
import { removeAuthorizedDomain } from "@/lib/auth/authorized-domains";
import { logError } from "@/lib/observability/logger";
import { removeGoogleCustomDomain } from "@/lib/seo/search-engines";
import { ROOT_DOMAIN } from "@/lib/store/host";
import { deprovision, getCertConfig } from "./certificates";
import { domainHosts } from "./domain";
import { hostsConnectedToStores } from "./ownership";

export interface DomainCleanupResult {
  failures: string[];
}

/**
 * Remove every StoreMink-managed external resource for a detached custom
 * domain. The operation is idempotent, so callers may safely retry it after a
 * partial control-plane failure.
 */
export async function cleanupDetachedDomain(
  domain: string | null,
  operation: string,
  legacyResendDomainId?: string | null,
): Promise<DomainCleanupResult> {
  const failures: string[] = [];

  if (domain) {
    if (!getCertConfig()) {
      failures.push("TLS certificate resources");
      logError(`${operation} (deprovision)`, undefined, {
        domain,
        reason: "custom-domain infrastructure is not configured",
      });
    } else {
      // ★★ KEEP WHAT ANOTHER STORE STILL SERVES. Certificate resources are named
      // by hostname alone, so `www.acme.com` detached here may be the companion
      // of `acme.com` that another store is live on — or this store's own new
      // domain after an apex → www change. Runs after the caller's row dropped
      // the domain, so "a store" here means "anyone still using it". An
      // unanswerable check removes nothing: a leftover certificate costs cents,
      // a deleted live one is an outage.
      let keep: Set<string> | null = null;
      try {
        keep = await hostsConnectedToStores(domainHosts(domain));
      } catch (err) {
        failures.push("TLS certificate resources");
        logError(`${operation} (deprovision ownership check)`, err, { domain });
      }
      if (keep) {
        const gone =
          keep.size > 0
            ? await deprovision(domain, { keep })
            : await deprovision(domain);
        if (gone.error) {
          failures.push("TLS certificate resources");
          logError(`${operation} (deprovision)`, gone.error, { domain });
        }
      }
    }

    // Stop trusting hosts we no longer serve for sign-in: one write removes
    // the exact apex + www hosts and any legacy registrable entry. ★ A host
    // another store still serves stays (one store on acme.com, another
    // detaching shop.acme.com), so this runs after the caller's own row has
    // dropped the domain. The store's subdomain host is untouched; deleteStore
    // removes that separately.
    const deauth = await removeAuthorizedDomain(domain, ROOT_DOMAIN);
    if (deauth.error) {
      failures.push("Identity Platform authorized domain");
      logError(`${operation} (deauthorize)`, deauth.error, { domain });
    }

    // The database write removes the public META token first. Google can then
    // release both the URL-prefix property and our ownership record.
    const google = await removeGoogleCustomDomain(domain);
    if (!google.searchConsole.ok && !google.searchConsole.skipped) {
      failures.push("Google Search Console property");
      logError(
        `${operation} (remove Search Console property)`,
        google.searchConsole.error,
        { domain, status: google.searchConsole.status },
      );
    }
    if (!google.siteVerification.ok && !google.siteVerification.skipped) {
      failures.push("Google Site Verification ownership");
      logError(
        `${operation} (remove Site Verification ownership)`,
        google.siteVerification.error,
        { domain, status: google.siteVerification.status },
      );
    }
  }

  // Storefront domains are no longer registered with Resend, but older stores
  // can still carry the provider id from that retired integration. Remove that
  // external resource too instead of dropping the only reference to it.
  if (legacyResendDomainId) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey || apiKey.includes("placeholder")) {
      failures.push("legacy Resend domain");
      logError(`${operation} (remove legacy Resend domain)`, undefined, {
        domain,
        resendDomainId: legacyResendDomainId,
        reason: "RESEND_API_KEY is not configured",
      });
    } else {
      try {
        const removed = await new Resend(apiKey).domains.remove(
          legacyResendDomainId,
        );
        if (removed.error && removed.error.statusCode !== 404) {
          failures.push("legacy Resend domain");
          logError(
            `${operation} (remove legacy Resend domain)`,
            removed.error,
            { domain, resendDomainId: legacyResendDomainId },
          );
        }
      } catch (err) {
        failures.push("legacy Resend domain");
        logError(`${operation} (remove legacy Resend domain)`, err, {
          domain,
          resendDomainId: legacyResendDomainId,
        });
      }
    }
  }

  return { failures };
}
