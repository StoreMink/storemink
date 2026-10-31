/**
 * The shapes of the numbers a merchant is shown before they pay (GST design
 * 5.6) and of their Billing details (5.7).
 *
 * CLIENT-SAFE: type-only imports, nothing at runtime. The server modules
 * that produce these (`lib/billing/quote.ts`, `lib/billing/billing-details.ts`)
 * are server-only, and the "use server" actions that hand them to the screens
 * must not export types (every export of such a file is a public endpoint),
 * so the screens import the shapes from here.
 */

import type { Plan } from "@/lib/plans";
import type { CollectionRoute } from "./cycle";
import type { PlaceOfSupplyBasis } from "./gst";
import type { BillingDetailsPrefill, CopyAmount } from "./tax-copy";
import type { TaxTerms } from "./tax-terms";

export type QuotePeriod = "monthly" | "yearly";

/** The live prices the payment actions charge (`subscribe-actions.ts`). */
export type QuotePriceFor = (
  plan: Plan,
  period: QuotePeriod,
) => Promise<{ planPaise: number; locationPaise: number }>;

/**
 * One amount as the invoice that charges it will carry it.
 *
 * ★ It carries `CopyAmount`'s four fields, so a quote is passed straight to
 * the tax-copy sentences (`checkoutSummary`, `nextRenewalValue`, ...).
 */
export interface AmountQuote extends CopyAmount {
  /** The sum of the invoice's body lines: the price list. */
  listedPaise: number;
  /** subtotal - discount: the value GST is charged on. */
  taxablePaise: number;
}

/** Where an invoice is supplied, and which record said so. */
export interface QuotePlaceOfSupply {
  code: string | null;
  basis: PlaceOfSupplyBasis;
}

/** A renewal quoted with the subscribe or plan-change quote. */
export interface QuotedRenewal {
  plan: Plan;
  period: QuotePeriod;
  /** Priced under the GST terms in force when its invoice is issued. */
  amount: AmountQuote;
  /** When its invoice is issued (four days before `renewsOn`). */
  issuedAt: string;
  /** The renewal date. */
  renewsOn: string;
  /**
   * Will it be collected automatically? A new subscription: a mandate rail
   * can carry it (`autopayRailFor`). A plan change: the store's mandate
   * passes `collectionRoute`.
   */
  autopay: boolean;
}

/** What subscribing would charge now and at the first renewal. */
export interface SubscribeQuote {
  kind: "subscribe";
  plan: Plan;
  period: QuotePeriod;
  /**
   * An earlier payment of this store was captured and never confirmed: the
   * next Subscribe finishes that purchase instead of charging (RC-F1b), so
   * there is nothing to pay and `payNow` and `renewal` are null.
   */
  earlierPayment: boolean;
  /** What the payment window will ask for; null only with `earlierPayment`. */
  payNow: AmountQuote | null;
  /**
   * True when `payNow` is an order already open for this cycle, kept because
   * only the GST changed since it was made: the draft's total, with the GST
   * split the issue will carve out of it.
   */
  resumed: boolean;
  renewal: QuotedRenewal | null;
  /** The GST terms in force now. */
  terms: TaxTerms;
  /** GST would need the merchant's state (the payment would be refused, or
   *  the renewal would fall back to StoreMink's state). */
  needsState: boolean;
  /** GST is charged now and the business is outside India: the payment
   *  would be refused. */
  outsideIndia: boolean;
}

/** What a plan or period change would charge now and from the next renewal. */
export interface PlanChangeQuote {
  kind: "change";
  plan: Plan;
  period: QuotePeriod;
  /** An earlier, already paid change will be finished instead (RC-F1b). */
  earlierPayment: boolean;
  /** "now": a dearer change (or one applied free); "scheduled": at the cycle end. */
  timing: "now" | "scheduled";
  /** The part-period payment; null when nothing is charged now. */
  payNow: AmountQuote | null;
  /** A scheduled change: when it takes effect. */
  effectiveAt: string | null;
  renewal: QuotedRenewal | null;
  terms: TaxTerms;
  needsState: boolean;
  outsideIndia: boolean;
}

/** A quote, or the sentence the action it mirrors would refuse with. */
export type QuoteOutcome<T> =
  | { ok: true; quote: T }
  | { ok: false; error: string };

/** The checkout dialog's summary data (`quoteCheckout`). */
export type CheckoutQuoteResult =
  | {
      ok: true;
      plan: SubscribeQuote | PlanChangeQuote;
      /** A Mink credit pack bought with it, as a separate payment. */
      pack: AmountQuote | null;
      terms: TaxTerms;
      needsState: boolean;
      outsideIndia: boolean;
    }
  | { ok: false; error: string };

/** The store's next renewal (`getMyNextRenewal`). */
export interface RenewalQuote {
  plan: Plan;
  period: QuotePeriod;
  billedLocations: number;
  amount: AmountQuote;
  /** The next cycle's invoice is already issued and `amount` is its own. */
  issued: boolean;
  /** When it was (or will be) issued. */
  issuedAt: string;
  /** The renewal date: the end of the current cycle. */
  renewsOn: string;
  route: CollectionRoute;
  autoCollect: boolean;
  reason: "no_mandate" | "over_mandate" | "over_afa_limit" | null;
  /** The autopay limit the merchant approved, when there is a mandate. */
  mandateMaxPaise: number | null;
  /** The GST terms at the renewal's issue time. */
  terms: TaxTerms;
  /** The place of supply at the renewal's issue time. */
  placeOfSupply: QuotePlaceOfSupply;
}

/** What one extra location adds to the next renewal (Locations, 7.5). */
export interface LocationRenewalQuote {
  /** The renewal with one more location, less the renewal without it: the
   *  exact paisa the invoice grows by, never a line carved on its own (under
   *  GST included the two can differ by a paisa, R1-02). */
  perLocation: AmountQuote;
  issuedAt: string;
  renewsOn: string;
  period: QuotePeriod;
  terms: TaxTerms;
}

// ── Billing details (design 5.7) ───────────────────────────────────────────

export interface BillingDetailsView {
  /** The billing account has a state, a GSTIN or a country outside India. */
  saved: boolean;
  legalName: string;
  gstin: string;
  stateCode: string;
  /** An ISO code from lib/countries.ts, "OTHER", or "IN". */
  country: string;
  /** Shown, and required, when `country` is "OTHER". */
  countryName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postalCode: string;
  /** Where unsaved fields were filled in from; null once saved. */
  prefilledFrom: BillingDetailsPrefill | null;
  /** What StoreMink's invoices would use today, GST taken as charged. */
  placeOfSupply: {
    code: string | null;
    name: string | null;
    basis: PlaceOfSupplyBasis;
  };
}

/**
 * A save. The country, the GSTIN and the state are always decided by it (no
 * country means India); the business name and the address fields left out
 * keep their saved values, and a blank one removes it.
 */
export interface BillingDetailsInput {
  country?: string;
  countryName?: string;
  legalName?: string;
  gstin?: string;
  stateCode?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postalCode?: string;
}

export type BillingDetailsField =
  | "country"
  | "countryName"
  | "gstin"
  | "stateCode"
  | "postalCode";

export type SaveBillingDetailsResult =
  | { ok: true }
  | { ok: false; error: string; field?: BillingDetailsField };
