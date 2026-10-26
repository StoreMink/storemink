// The client address for rate limits, abuse checks and audit evidence: the
// address that connected to our load balancer, never one the caller wrote.
//
// ★★ X-Forwarded-For IS READ FROM THE RIGHT. Production requests reach Cloud
// Run through Google's External Application Load Balancer, which APPENDS
// `<client-ip>,<load-balancer-ip>` to whatever X-Forwarded-For the caller sent
// (Google: "the load balancer appends its values to the existing header").
// Everything to the left of those two entries is caller-supplied, so the FIRST
// entry, which this rule used to take, let one client choose a fresh per-IP
// rate-limit key on every request (OTP, signup, POS PIN, checkout, enquiries)
// and write any address it liked into the POS audit trail and the consent
// records.
//
// So: find our load balancer's own forwarding-rule address (DOMAIN_LB_IP,
// which cloudbuild.yaml sets on every web revision; dev and production share
// the one load balancer), searching from the RIGHT, and take the entry before
// it: the address the load balancer saw, the same value as its
// `{client_ip_address}` header variable. Searching (not just looking at the
// last entry) keeps the rule right if Google ever adds a hop after the load
// balancer; a copy of the address a caller forged sits further left, so the
// rightmost copy is always ours. A single entry is a direct request naming
// its caller (local dev, where Next.js fills the header from the socket
// address, or a direct *.run.app request).
//
// x-real-ip is never read: nothing on Google Cloud sets it, so only a caller
// could.
//
// ★★ WITHOUT THE ANCHOR, FALL BACK TO THE FIRST ENTRY. When DOMAIN_LB_IP is
// empty or wrong, or a request reaches us through a frontend whose address is
// not DOMAIN_LB_IP (a second, IPv6 forwarding rule), the rightmost entry would
// be that frontend's own address: every visitor would share ONE key for every
// per-IP limit, and one busy store could lock everyone out (POS PIN, OTP,
// checkout). So the first entry is used instead, the rule before this fix: a
// caller can forge it, but every other visitor keeps a key of their own. On
// Cloud Run (K_SERVICE set) the first such request on each server instance
// logs "client-ip: X-Forwarded-For does not end in DOMAIN_LB_IP" at ERROR, with
// the configured value and the header's last entry, so the configuration gets
// fixed. A direct *.run.app request that writes its own header logs the same
// line, harmlessly. An IPv6 frontend needs its address accepted here before
// its AAAA record is published.
//
// A visitor behind a proxy that adds its own X-Forwarded-For entry (a
// data-saver browser, an office proxy, a CDN in front of a merchant's domain)
// is keyed by that proxy's address, shared with everyone behind it: the price
// of a key no caller can choose.

import { logError } from "@/lib/observability/logger";

/** Anything with Headers' `get`: Headers, Next's ReadonlyHeaders, a test double. */
type HeaderSource = { get(name: string): string | null | undefined };

/** Whether this server instance has reported a header that does not end in
 *  DOMAIN_LB_IP. The cause is configuration, so one line per instance says it;
 *  a line per request would only flood the log. */
let reportedUnanchored = false;

function reportUnanchored(hops: string[], loadBalancer: string | undefined) {
  if (reportedUnanchored || !process.env.K_SERVICE) return;
  reportedUnanchored = true;
  logError(
    "client-ip: X-Forwarded-For does not end in DOMAIN_LB_IP",
    undefined,
    {
      domainLbIp: loadBalancer || "(empty)",
      entries: hops.length,
      lastEntry: hops[hops.length - 1],
    },
  );
}

/** The address that connected to our load balancer, or null when the request
 *  names none (no X-Forwarded-For at all). */
export function clientIpOrNull(headers: HeaderSource): string | null {
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  if (hops.length === 0) return null;
  const loadBalancer = process.env.DOMAIN_LB_IP?.trim();
  // The rightmost copy of the anchor is the one the load balancer wrote.
  const anchor = loadBalancer ? hops.lastIndexOf(loadBalancer) : -1;
  if (anchor > 0) return hops[anchor - 1];
  // One entry is a direct request naming its caller.
  if (hops.length === 1 && loadBalancer) return hops[0];
  // Several entries without the anchor, or no anchor configured: the anchor is
  // wrong, so keep every visitor apart (see the header comment).
  reportUnanchored(hops, loadBalancer);
  return hops[0];
}

/** clientIpOrNull as a rate-limit key: "unknown" when the request names none. */
export function clientIp(headers: HeaderSource): string {
  return clientIpOrNull(headers) ?? "unknown";
}
