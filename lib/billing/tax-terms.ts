/**
 * Which GST applies at an instant: one definition for the server, the renewal
 * worker, the console and the browser (GST design section 5.1).
 *
 * PURE and client-safe: it imports only types, reads no clock and no database.
 * The caller passes the settings row's columns and the instant.
 *
 * ★ ONE SCHEDULED CHANGE, APPLIED BY TIME, NOT BY A JOB. The settings row keeps
 * the values in force (`tax_enabled`, `tax_inclusive`, `tax_rate_bps`) and can
 * hold one scheduled change (`next_tax_*`). An invoice built at or after the
 * scheduled instant uses the scheduled values even if the hourly run has not
 * copied them into the in-force columns yet, so nothing anyone pays depends on
 * when that run happens to fire.
 */

import type { TaxContext } from "./invoice";

export interface TaxValues {
  enabled: boolean;
  inclusive: boolean;
  rateBps: number;
}

/** The settings columns that decide it (platform_billing_settings). */
export interface TaxTermsSource {
  taxEnabled: boolean;
  taxInclusive: boolean;
  taxRateBps: number;
  nextTaxEnabled: boolean | null;
  nextTaxInclusive: boolean | null;
  nextTaxRateBps: number | null;
  nextTaxStartsAt: string | null;
}

export interface TaxTerms {
  /** GST is charged on an invoice built at the instant these were read for. */
  active: boolean;
  inclusive: boolean;
  /** 0 when not active. */
  rateBps: number;
  /** A change still to come at that instant, or null. */
  upcoming: (TaxValues & { startsAt: string }) | null;
}

/**
 * May a rate rise set by law start without the 1-month notice?
 * false until the published Terms say that a change in the GST rate set by law
 * applies from the date the law sets (owner decision 6). The release that
 * publishes that sentence flips it, with its test.
 */
export const LAW_SET_RATE_RISE_WITHOUT_NOTICE = false;

const bps = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
};

/**
 * The scheduled change, or null when there is none.
 *
 * ★ ALL FOUR OR NOTHING. The database refuses a half-scheduled change
 * (`platform_billing_next_tax_shape`); a row that somehow has one anyway, or an
 * instant that does not parse, is read as no change at all rather than as a
 * change to "off" or to rate 0.
 */
function scheduledChange(
  src: TaxTermsSource,
): (TaxValues & { startsAt: string; startsAtMs: number }) | null {
  if (
    src.nextTaxStartsAt == null ||
    src.nextTaxEnabled == null ||
    src.nextTaxInclusive == null ||
    src.nextTaxRateBps == null
  ) {
    return null;
  }
  const startsAtMs = Date.parse(src.nextTaxStartsAt);
  if (!Number.isFinite(startsAtMs)) return null;
  return {
    enabled: src.nextTaxEnabled === true,
    inclusive: src.nextTaxInclusive === true,
    rateBps: bps(src.nextTaxRateBps),
    startsAt: src.nextTaxStartsAt,
    startsAtMs,
  };
}

function termsOf(v: TaxValues, upcoming: TaxTerms["upcoming"]): TaxTerms {
  return {
    active: v.enabled,
    // Kept while GST is off: the mandate provision reads the price mode even
    // before GST starts (`mandateSizePaise`, §34).
    inclusive: v.inclusive,
    rateBps: v.enabled ? bps(v.rateBps) : 0,
    upcoming,
  };
}

/** The GST that applies to an invoice built at `at`. */
export function termsAt(src: TaxTermsSource, at: Date): TaxTerms {
  const next = scheduledChange(src);
  const inForce: TaxValues = {
    enabled: src.taxEnabled === true,
    inclusive: src.taxInclusive === true,
    rateBps: bps(src.taxRateBps),
  };
  if (!next) return termsOf(inForce, null);

  const { startsAtMs, ...change } = next;
  const atMs = at.getTime();
  if (atMs >= startsAtMs) return termsOf(change, null);
  return termsOf(inForce, change);
}

/**
 * The same terms as they will be at a later instant (a renewal's issue time).
 *
 * Applies `upcoming` at and after its instant only; terms with nothing
 * upcoming are returned unchanged.
 */
export function termsLater(terms: TaxTerms, instant: Date): TaxTerms {
  const up = terms.upcoming;
  if (!up) return terms;
  const startsAtMs = Date.parse(up.startsAt);
  if (!Number.isFinite(startsAtMs) || instant.getTime() < startsAtMs) {
    return terms;
  }
  return termsOf(up, null);
}

/**
 * What a merchant pays per 10,000 of list price: 10000, or 10000 + rate when
 * GST is added on top.
 */
export function payableFactorBps(v: TaxValues): number {
  return v.enabled && !v.inclusive ? 10_000 + bps(v.rateBps) : 10_000;
}

/**
 * Does moving from `before` to `after` raise what merchants pay, and whose
 * choice is it?
 *
 * null when it does not. "rate" when GST is on with prices excluding it on
 * both sides and only the rate rose (the law can do that; see
 * LAW_SET_RATE_RISE_WITHOUT_NOTICE). "choice" for every other rise: switching
 * GST on with prices excluding it, or moving from prices that include GST to
 * prices that exclude it.
 */
export function raisesPayable(
  before: TaxValues,
  after: TaxValues,
): "choice" | "rate" | null {
  if (payableFactorBps(after) <= payableFactorBps(before)) return null;
  const exclusiveOn = (v: TaxValues) => v.enabled && !v.inclusive;
  return exclusiveOn(before) && exclusiveOn(after) ? "rate" : "choice";
}

/** The builder's tax configuration for terms read at one instant. */
export function taxContextFor(
  t: TaxTerms,
  supplierStateCode: string | null,
  placeOfSupply: string | null,
): TaxContext {
  return {
    enabled: t.active,
    rateBps: t.active ? t.rateBps : 0,
    inclusive: t.inclusive,
    supplierStateCode,
    placeOfSupply,
  };
}

// ── The notice rule ─────────────────────────────────────────────────────────

/**
 * The platform_announcements columns the notice rule reads, as stored:
 * `channels` and `audience` are the jsonb objects the composer saved.
 */
export interface NoticeCandidate {
  category: string;
  status: string;
  sent: number;
  sentAt: string | null;
  channels: unknown;
  audience: unknown;
}

/**
 * Why a notice does not count, in the order they are checked:
 *
 * - `not_operational`: product news, which honours the marketing opt-out, so
 *   it never reached every store owner;
 * - `not_sent`: still a draft or sending, or `failed` (a failed announcement
 *   also gets a `sent_at`, `lib/announcements/worker.ts`, so `sent_at` alone
 *   proves nothing);
 * - `nothing_delivered`: no email or SMS reached anyone;
 * - `not_email`: email was not one of its channels (the Terms promise an
 *   email);
 * - `audience`: it was aimed at some store owners only (a plan, status, age or
 *   launch filter, or owners not included at all).
 */
export type NoticeFailure =
  | "not_operational"
  | "not_sent"
  | "nothing_delivered"
  | "not_email"
  | "audience";

export type NoticeCheck = { ok: true } | { ok: false; reason: NoticeFailure };

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Does this announcement count as the notice a scheduled rise needs?
 *
 * ★ ONLY A NOTICE THAT REALLY REACHED STORE OWNERS COUNTS: Operational, sent
 * or partly sent with at least one delivery, by email, to the owners of every
 * store (excluding demo stores is allowed). The console's notice select and
 * `scheduleTaxChange` both call this, so what the operator can pick and what
 * the save accepts never disagree. The 1-month wait from `sent_at` is the
 * save's own rule.
 *
 * The audience is read the way the composer stores it (`normalizeAudience`,
 * `lib/announcements/audience.ts`): an `include` list that is missing or
 * empty means store owners, as the sender reads it.
 */
export function noticeQualifies(row: NoticeCandidate): NoticeCheck {
  if (row.category !== "operational") {
    return { ok: false, reason: "not_operational" };
  }
  if ((row.status !== "sent" && row.status !== "partial") || !row.sentAt) {
    return { ok: false, reason: "not_sent" };
  }
  if (!(Number(row.sent) > 0)) {
    return { ok: false, reason: "nothing_delivered" };
  }
  if (record(row.channels).email !== true) {
    return { ok: false, reason: "not_email" };
  }

  const audience = record(row.audience);
  const include = list(audience.include);
  const statuses = list(audience.statuses);
  const reachesEveryOwner =
    (include.length === 0 || include.includes("owner")) &&
    list(audience.plans).length === 0 &&
    (statuses.length === 0 ||
      (statuses.includes("active") && statuses.includes("suspended"))) &&
    !(Number(audience.newerThanDays) > 0) &&
    audience.launchedOnly !== true;
  if (!reachesEveryOwner) return { ok: false, reason: "audience" };

  return { ok: true };
}
