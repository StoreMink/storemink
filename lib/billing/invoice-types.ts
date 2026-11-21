// ---------------------------------------------------------------------------
// Client-safe shapes for the §34 platform-billing invoices a merchant SEES.
//
// ★★ WHY ITS OWN FILE, and not `manual-pay.ts` or `subscribe-actions.ts`:
//
//   • `lib/billing/manual-pay.ts` is `server-only` — it imports the db client,
//     so a client component importing anything from it (a type included) drags
//     `pg`, and therefore `fs`, into the browser bundle.
//   • `app/actions/subscribe-actions.ts` is `"use server"`, where EVERY export
//     is registered as a server action. A `type` re-export looks free — `tsc`
//     and `eslint` both pass — and then the BUILD fails with "Export
//     PayableInvoice doesn't exist in target module", because Next emits an
//     action reference for it. Erasure happens too late to help.
//
// Same split as `lib/logs/failure-types.ts` (client half) vs `failures.ts`
// (server half), and the same trap as `EXTRA_LOCATION_KEY` living in
// `lib/plans.ts` rather than the `server-only` `lib/plans/pricing.ts`.
//
// Keep this module free of RUNTIME imports. It is types only: the two
// `import type` lines below are erased at build, and name shapes from the
// client-safe `quote-types.ts` and `tax-terms.ts` (GST design 7.5), so the
// Locations card reads the very types the server builds.
// ---------------------------------------------------------------------------

import type { AmountQuote } from "./quote-types";
import type { TaxTerms } from "./tax-terms";

/**
 * One row of the "invoices you still owe" list.
 *
 * Stated explicitly rather than inferred from a Drizzle select, so the client
 * component that renders it does not depend on the query's shape.
 */
export interface PayableInvoice {
  id: string;
  /** The document number, once finalized. Null on a draft. */
  invoiceRef: string | null;
  status: string;
  totalPaise: number;
  /** The service period this invoice covers. */
  periodStart: string | null;
  periodEnd: string | null;
  dueAt: string | null;
  createdAt: string;
  /**
   * The GST in `totalPaise` (GST design 5.9); 0 when the invoice carries none.
   * The "invoice to pay" panel keys its "Including ... GST" line on it.
   */
  taxPaise: number;
  /** The GST rate in basis points; null on an invoice that recorded none. */
  taxRateBps: number | null;
  /** The GST is inside the total (prices include GST). */
  taxInclusive: boolean;
  /**
   * Set while an automatic renewal is SCHEDULED for this invoice: the bank's
   * notice has gone out and the debit has not been sent yet. The earliest
   * instant the debit may be sent, as an ISO string. The panel then says
   * autopay is scheduled, where "payment in progress" would be untrue for the
   * day or more the notice period lasts. Null otherwise.
   */
  autopayAt: string | null;
}

/**
 * What the Locations page renders for metered extra locations (§34, POS 7).
 *
 * Here for the same reason `PayableInvoice` is: the card is a CLIENT component,
 * `lib/billing/locations.ts` is `server-only`, and a `type` re-export from the
 * `"use server"` action file fails the build.
 */
export type LocationBillingState = {
  /** Locations the plan includes at no extra cost. */
  included: number;
  /** Extra locations currently paid for. */
  billed: number;
  /** Locations that exist right now. */
  existing: number;
  /** included + billed — the ceiling createLocation enforces. */
  allowance: number;
  /** Extra locations that MUST stay paid for, given what exists. */
  required: number;
  /** Paid slots sitting unused, which could be released. */
  releasable: number;
  /** Set when a release is already booked for the end of this cycle. */
  scheduled: number | null;
  pricePerPeriodInr: number;
  period: "monthly" | "yearly";
  /** What buying ONE more costs right now, part-period. */
  nextPurchaseInr: number;
  canBuy: boolean;
  blockedReason?: string;
} & (
  | {
      // ── GST design 7.5 (GST Stage 16). `pricePerPeriodInr` and
      // `nextPurchaseInr` above stay for one release, so a browser still
      // running the old bundle keeps working. The six fields below are ALL
      // present or ALL absent: the reader (`getLocationBillingState`) sets
      // them whenever it reads the tax terms, and leaves every one out when
      // buying is blocked before that reading or the GST settings are
      // incomplete (the second branch).
      /** One location for one cycle, as its invoice carries it under today's terms. */
      perPeriod: AmountQuote;
      /**
       * What buying ONE more costs now, built by the same `prorationFor` and
       * `buildAddonInvoice` calls, and the same tax reading, as the charge.
       * Null when nothing is due now (buying is blocked, or the part period
       * rounds to nothing and the location is billed from the next renewal).
       */
      nextPurchase: AmountQuote | null;
      /**
       * One location at the next renewal (`quoteLocationRenewal`): priced
       * under the terms in force when that invoice is issued, four days
       * before the cycle. Every "from your next renewal" figure is
       * `perLocation.totalPaise`. Null when there is no renewal figure (no
       * live plan, a cancelling plan, a next plan without POS, or a read
       * failure).
       */
      nextRenewal: { perLocation: AmountQuote; issuedAt: string } | null;
      /** The GST terms in force now. */
      terms: TaxTerms;
      /**
       * The store's state is needed: now, because GST is charged and only
       * StoreMink's own state is known, so the payment would be refused; or
       * later, because GST is charged when the renewal is issued and the
       * store has no state anywhere.
       */
      needsState: boolean;
      /** GST is charged now and the business is outside India: the payment is refused. */
      outsideIndia: boolean;
    }
  | {
      perPeriod?: never;
      nextPurchase?: never;
      nextRenewal?: never;
      terms?: never;
      needsState?: never;
      outsideIndia?: never;
    }
);

/**
 * The subscription, as the plans page shows it (§34).
 *
 * Replaces the old `SubscriptionState`. Two differences worth noting: `status`
 * carries OUR state vocabulary (`active`/`past_due`/`grace`/…), not Razorpay's,
 * and `scheduledPeriod` exists — the old shape could not express "same tier,
 * different billing period", which is why period changes were impossible.
 */
export interface SubscriptionView {
  plan: string | null;
  period: "monthly" | "yearly" | null;
  /** Our state machine's value. Null when there is no subscription. */
  status: string | null;
  /** End of the paid period: the next charge, or the last day of service. */
  currentEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: string | null;
  scheduledPeriod: "monthly" | "yearly" | null;
  /** A booked location release. */
  scheduledLocations: number | null;
  /** True when autopay is authorised, so it renews without being asked. */
  autopay: boolean;
  /** True when there is a live subscription to cancel or change. */
  active: boolean;
  /**
   * The next cycle's subscription invoice (`cycle_seq = current + 1`), when one
   * exists and the subscription is live. What it says decides the cancel
   * confirmation, the cancelling banner and the Keep my plan message.
   *
   * Required, like the three fields below: both builders of a view
   * (`getSubscriptionView` and the neutral view in `getMySubscription`) set
   * them, so a new builder cannot forget one and hide a sentence.
   */
  nextInvoice: NextInvoiceView | null;
  /** When grace ends, while the subscription is `past_due` or `grace`. */
  graceEndsAt: string | null;
  /** Who asked for the cancellation that stands, by kind only. Null when the
   *  subscription is not cancelling or the request was not recorded. */
  cancelRequestedBy: "merchant" | "operator" | null;
  /** When that cancellation was asked for. */
  cancelRequestedAt: string | null;
}

/**
 * The next cycle's subscription invoice, as Plans & Billing and the cancel
 * flow read it (renewal-cancel, design 6.3).
 */
export interface NextInvoiceView {
  id: string;
  status: string;
  totalPaise: number;
  /** The document number; null on a draft. */
  invoiceRef: string | null;
  /** A payment attempt on it is `created`, `processing`, `authorized` or
   *  `unknown`: money may still land, so it cannot be called unpaid. */
  inFlight: boolean;
}

/**
 * StoreMink's OWN tax identity, as the operator console edits it (§34).
 *
 * Here rather than in `lib/billing/platform-settings.ts` for the same reason as
 * everything else in this file: that module is `server-only`, and the form is a
 * client component.
 */
export interface PlatformTaxSettings {
  legalName: string | null;
  gstin: string | null;
  address: {
    line1?: string;
    line2?: string;
    city?: string;
    postalCode?: string;
  };
  /** NUMERIC GST state code ("07", "29") — the origin for intra/inter decisions. */
  stateCode: string | null;
  taxEnabled: boolean;
  taxRateBps: number;
  /** True = the advertised price INCLUDES tax; false = tax is added on top. */
  taxInclusive: boolean;
  invoicePrefix: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /**
   * Whether the hourly refund pass sends the refunds StoreMink owes by itself
   * (renewal-cancel, migration 0264). Ships false: until an operator turns it
   * on, an owed refund waits on the Refunds page for a person to press Send.
   * Refunds an operator issues are always sent at once.
   */
  autoRefunds: boolean;
  /**
   * The one scheduled change of GST (0266's `next_tax_*` columns), or null
   * when none is scheduled: what is charged from `startsAt` on, and the
   * Operational notice it was scheduled with.
   */
  nextTax: {
    enabled: boolean;
    inclusive: boolean;
    rateBps: number;
    startsAt: string;
    noticeId: string | null;
  } | null;
  /** StoreMink's SAC code, printed on every tax invoice. */
  sacCode: string | null;
  /** The LLP's identification number (LLPIN), printed on every invoice. */
  llpin: string | null;
  /** The LLP's registered office, as the operator typed it. */
  registeredOffice: string | null;
}

/** Address shape shared by both parties on an invoice. */
export interface InvoiceAddress {
  line1?: string;
  line2?: string;
  city?: string;
  postalCode?: string;
}

/** One party on an issued invoice, as recorded when it was issued. */
export interface RecordedInvoiceParty {
  name: string | null;
  gstin: string | null;
  /**
   * NUMERIC GST state code. For the customer it is the place of supply only
   * when that came from the merchant's own records (migration 0266): a
   * supplier fallback or a place of supply outside India records none.
   */
  stateCode: string | null;
  address: InvoiceAddress;
  /** The supplier's LLPIN, recorded since migration 0266 (owner decision 7). */
  llpin?: string | null;
  /** The supplier's registered office, recorded since migration 0266. */
  registeredOffice?: string | null;
  /**
   * The customer's country, recorded since migration 0266: an ISO code, and
   * its name when the record carried one.
   */
  country?: { code: string; name?: string };
}

/**
 * Who an issued invoice is from and to: `billing_invoices.parties`, written
 * once by a trigger in the statement that issues the invoice (migration 0243).
 *
 * ★ A RECORD, NOT A LOOKUP. Deleting a store removes its billing account and
 * its business details, and StoreMink keeps the invoice for GST; without this
 * the document could no longer say who it was issued to. Not to be confused
 * with `InvoiceParties` in `invoice-store.ts`, which is only the GSTIN trio
 * stamped on the row's own columns.
 */
export interface RecordedInvoiceParties {
  version: 1;
  /** When it was taken: the issue time, or 0243's backfill for an older one. */
  capturedAt: string | null;
  supplier: RecordedInvoiceParty;
  customer: RecordedInvoiceParty & { email: string | null };
}

/** One row of a merchant's invoice history. */
export interface InvoiceSummary {
  id: string;
  invoiceRef: string | null;
  kind: string;
  status: string;
  totalPaise: number;
  /** The GST charged; above zero the list names the document a tax invoice. */
  taxPaise: number;
  periodStart: string | null;
  periodEnd: string | null;
  finalizedAt: string | null;
  paidAt: string | null;
  /**
   * What has been refunded against this invoice (renewal-cancel, design 6.9
   * and 8.5), read from `billing_refunds`. ★ A refund never changes its
   * invoice's status (rule R9): a refunded `paid` invoice stays `paid` and a
   * refunded `void` one stays `void`, so the list shows the status and this
   * line under it.
   */
  refunds: {
    /** Processed and recorded refunds, other than a returned duplicate
     *  payment: money given back for the supply (each has a credit note). */
    refundedPaise: number;
    /** Processed and recorded `duplicate_payment` refunds: an extra payment
     *  returned, which reduces no supply and carries no credit note. */
    extraReturnedPaise: number;
    /** Owed and pending refunds, whatever the reason: on their way. */
    inProgressPaise: number;
    /** Any refund is owed or pending. */
    inProgress: boolean;
    /** A failed refund with no later refund of the same payment: a person
     *  has to act on it (the console's "Needs a person" rule). */
    delayed: boolean;
  };
}

export interface InvoiceLineView {
  kind: string;
  description: string;
  quantity: number;
  unitAmountPaise: number;
  amountPaise: number;
}

/**
 * One issued invoice, as the printable document renders it.
 *
 * ★ The tax figures and identifiers come from the invoice's OWN row, and the
 * names and addresses from what was recorded when it was issued — see
 * `lib/billing/invoice-history.ts` for why that distinction is load-bearing.
 */
export interface InvoiceDocument {
  id: string;
  invoiceRef: string | null;
  kind: string;
  status: string;
  issuedAt: string | null;
  paidAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
  taxRateBps: number | null;
  supplierGstin: string | null;
  customerGstin: string | null;
  placeOfSupply: string | null;
  /** StoreMink's SAC code as written on the row when it was issued. */
  sacCode: string | null;
  /** The row's own mode: the amounts carry the GST inside them. */
  taxInclusive: boolean;
  /** `recipient`, `supplier` or `outside_india`; null on an older invoice. */
  placeOfSupplyBasis: string | null;
  /**
   * Every line on the row, `tax` and `discount` included; the sheet prints
   * only the body lines in its items table and the rest in its totals.
   */
  items: InvoiceLineView[];
  supplier: {
    legalName: string;
    address: InvoiceAddress;
    /** The row's own `supplierGstin`, beside the supplier's other facts. */
    gstin: string | null;
    /** The GSTIN's first two digits, else the recorded state. */
    stateCode: string | null;
    llpin: string | null;
    registeredOffice: string | null;
  };
  customer: {
    legalName: string | null;
    address: InvoiceAddress;
    billingEmail: string | null;
    /**
     * `recipientStateFor(row)`: the place of supply only when it came from the
     * merchant's own records, so a supplier fallback or 96 prints no State.
     */
    stateCode: string | null;
    /** The recorded country's name, or null when none was recorded. */
    country: string | null;
  };
  /**
   * The credit notes issued against this invoice, oldest first (design 8.7):
   * one per completed refund other than a returned duplicate payment, and the
   * note cancelling a closed unpaid invoice that charged GST. `issuedAt` is
   * the database's own timestamp text.
   */
  credits: {
    id: string;
    creditNoteRef: string;
    issuedAt: string;
    totalPaise: number;
  }[];
  /** The same refunds summary the invoice list shows. */
  refunds: InvoiceSummary["refunds"];
}

/** One tax line a credit note prints: CGST and SGST, or IGST. */
export interface CreditNoteTaxLine {
  name: "CGST" | "SGST" | "IGST";
  /** The line's own rate: half the invoice rate for CGST and SGST. */
  rateBps: number;
  amountPaise: number;
}

/**
 * One of StoreMink's own credit notes in a list (renewal-cancel, design 8.5):
 * the merchant's invoices page and the operator console.
 */
export interface CreditNoteSummary {
  id: string;
  /** "CN/2026-27/00001". */
  creditNoteRef: string;
  issuedAt: string;
  /** billing_credit_notes.reason: why the invoice was credited. */
  reason: string;
  totalPaise: number;
  invoiceId: string;
  invoiceRef: string | null;
  /** The refund the note documents; null for a note cancelling an unpaid
   *  invoice (`invoice_cancelled`). */
  refundId: string | null;
}

/**
 * One credit note, as the printable sheet renders it (design 8.8).
 *
 * ★ EVERYTHING ON IT IS THE NOTE'S OWN RECORD. The amounts are the note's;
 * the tax rate, both GSTINs, the place of supply and both parties were copied
 * from the invoice by the issuing trigger when the note was issued, never
 * read live, so correcting a GSTIN or a legal name later cannot rewrite a
 * note already issued (the `InvoiceDocument` rule).
 */
export interface CreditNoteDocument {
  id: string;
  creditNoteRef: string;
  issuedAt: string;
  /** billing_credit_notes.reason; the sheet words it. */
  reason: string;
  /** The invoice the note reduces, and when that invoice was issued. */
  invoiceId: string;
  invoiceRef: string | null;
  invoiceIssuedAt: string | null;
  taxablePaise: number;
  taxPaise: number;
  totalPaise: number;
  taxRateBps: number | null;
  supplierGstin: string | null;
  customerGstin: string | null;
  /**
   * The invoice's place of supply: the customer's State, the supplier's State
   * on a supplier fallback, or 96 outside India. Not the customer's State to
   * print; that is `recipientStateCode` on `CreditNotePrintDocument`.
   */
  placeOfSupply: string | null;
  /** CGST and SGST, or IGST, split from the note's tax amount the way the
   *  invoice sheet splits an invoice's. Empty when the note credits no tax. */
  taxLines: CreditNoteTaxLine[];
  supplier: { legalName: string; address: InvoiceAddress };
  customer: {
    legalName: string | null;
    address: InvoiceAddress;
    billingEmail: string | null;
  };
  /**
   * The refund the note documents, for its "Refunded ..." line; null for a
   * note cancelling a closed unpaid invoice, which has no refund line.
   */
  refund: {
    /** `razorpay`: back to the original payment method (sent, or recorded
     *  after it was made by hand in the Razorpay dashboard).
     *  `bank_transfer`: recorded, with the transfer's UTR. */
    method: "razorpay" | "bank_transfer";
    /** When the refund completed: billing_refunds.resolved_at. */
    refundedAt: string | null;
    /** The UTR for a bank transfer; the Razorpay refund id otherwise. */
    reference: string | null;
  } | null;
}

/**
 * One row of the operator reconciliation queue (§34).
 *
 * Here rather than in `lib/billing/reconcile.ts` for the usual reason: that
 * module is `server-only` and the queue is rendered by a client component.
 */
export interface ReconciliationItem {
  id: string;
  storeId: string | null;
  /** Null when the item maps to no store — an orphan gateway payment. */
  storeName: string | null;
  storeSlug: string | null;
  kind: string;
  status: string;
  invoiceId: string | null;
  attemptId: string | null;
  providerPaymentId: string | null;
  providerOrderId: string | null;
  expectedPaise: number | null;
  observedPaise: number | null;
  detail: unknown;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}
