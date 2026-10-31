/**
 * Every GST sentence about StoreMink's own fees, in one place: what a
 * merchant, a visitor or an operator reads (GST design sections 5.2, 5.8, 6
 * and 7, with "Plans & Billing" for the page, owner decision 11).
 *
 * PURE and client-safe: no server import, no clock, no database. Screens,
 * server actions and emails pass the tax terms (`termsAt`, tax-terms.ts) and
 * the amounts they already hold, and get back the exact text. The wording is
 * tested once here, for every state, and every output is swept for long
 * dashes, the old page name, credit prices and old POS words
 * (tax-copy.test.ts).
 *
 * The states the copy is chosen by (design 7):
 *   OFF       no GST now and no switch to prices that exclude GST ahead. A
 *             scheduled switch-on to prices that INCLUDE GST changes nothing
 *             anyone pays, so it reads as OFF, except the state prompts
 *             (`asksForState`), which appear as soon as any switch-on is
 *             scheduled;
 *   SCHED-EX  no GST now, a switch-on to prices that exclude GST scheduled;
 *   ON-IN     GST charged, included in every price;
 *   ON-EX     GST charged, added on top of every price.
 *
 * ★ DATES ARE INDIA DATES. Every date passes `timeZone: "Asia/Kolkata"`:
 * 00:00 IST on 1 December is 18:30 UTC on 30 November, and a server in UTC
 * would otherwise print "30 Nov".
 *
 * ★ AMOUNTS ARE PAISE, printed by `formatRupees`: whole rupees without
 * decimals, anything else to the paisa ("₹1,770", "₹69.62"), as the billing
 * emails print them. A sentence quotes the figures it is given (a quote, an
 * invoice row); only places that start from a list price (the price cards on
 * storemink.com and in the checkout, the pack prices, the signup yearly line,
 * the console's examples) work the GST out, with `amountFor`, which is the
 * invoice builder's own arithmetic.
 */

import type { BillingPeriod } from "@/lib/plans/location-billing";
import type { CollectionRoute } from "./cycle";
import {
  gstStateName,
  placeOfSupplyLabel,
  type PlaceOfSupply,
  type PlaceOfSupplyBasis,
} from "./gst";
import { taxOnPaise, taxWithinPaise } from "./invoice";
import { AFA_EXEMPT_PAISE } from "./mandate-types";
import {
  raisesPayable,
  type NoticeCheck,
  type NoticeFailure,
  type TaxTerms,
  type TaxValues,
} from "./tax-terms";

// ── Names and formats ───────────────────────────────────────────────────────

/** The billing page, by its one name (owner decision 11). */
export const BILLING_PAGE = "Plans & Billing";

/** Where a merchant writes to us about a payment we can't take yet. */
export const SUPPORT_EMAIL = "support@storemink.com";

const IST = "Asia/Kolkata";

/**
 * An amount held in paise: whole rupees without decimals ("₹1,770"),
 * anything else to the paisa ("₹69.62"). Exactly the output of the billing
 * emails' `moneyPaise` (lib/email/billing-emails.ts), which GST Stage 6
 * points here.
 */
export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  const whole = Number.isInteger(rupees);
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

function asDate(iso: string | Date): Date {
  return iso instanceof Date ? iso : new Date(iso);
}

/** What a date that does not parse prints: the text given, as `istDate` does. */
function unparsed(iso: string | Date): string {
  return typeof iso === "string" ? iso : "";
}

function istDay(iso: string | Date, month: "short" | "long"): string {
  const date = asDate(iso);
  if (Number.isNaN(date.getTime())) return unparsed(iso);
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month,
    year: "numeric",
    timeZone: IST,
  });
}

/**
 * "1 Dec 2026": the billing emails' `istDate` without the time, so emails,
 * Plans & Billing and the GST copy share one date style (no leading zero).
 */
export function istShortDate(iso: string | Date): string {
  return istDay(iso, "short");
}

/** "1 December 2026", in India time. */
export function istLongDate(iso: string | Date): string {
  return istDay(iso, "long");
}

/** "00:00": the hour and minute in India time, 24-hour clock. */
export function istTime(iso: string | Date): string {
  const date = asDate(iso);
  if (Number.isNaN(date.getTime())) return unparsed(iso);
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: IST,
  });
}

/** "1 December 2026, 00:00 IST": the console's GST cards (design 6.2). */
export function istLongDateTime(iso: string | Date): string {
  const date = asDate(iso);
  if (Number.isNaN(date.getTime())) return unparsed(iso);
  return `${istLongDate(date)}, ${istTime(date)} IST`;
}

/** "18%" for 1800 basis points; "12.5%" for 1250. */
export function gstRateLabel(rateBps: number): string {
  const pct = Number.isFinite(rateBps) ? Number((rateBps / 100).toFixed(2)) : 0;
  return `${pct}%`;
}

const R = formatRupees;
const rate = gstRateLabel;

/**
 * A state's name for a GST state code, or null when the code names none
 * (`gstStateName` falls back to the bare code, and 96 is no state).
 */
function stateNameOf(code: string | null): string | null {
  const name = code ? gstStateName(code) : null;
  return name && !/^\d+$/.test(name) ? name : null;
}

function unitOf(period: BillingPeriod): "month" | "year" {
  return period === "yearly" ? "year" : "month";
}

/** "1 renewal" / "3 renewals". */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── The state the copy is chosen by ────────────────────────────────────────

export type TaxCopyState = "off" | "sched_ex" | "on_in" | "on_ex";

/** Which of design 7's states these terms read as (see the header). */
export function taxCopyState(terms: TaxTerms): TaxCopyState {
  if (terms.active) return terms.inclusive ? "on_in" : "on_ex";
  const up = terms.upcoming;
  return up && up.enabled && !up.inclusive ? "sched_ex" : "off";
}

type Upcoming = TaxValues & { startsAt: string };

/**
 * A scheduled move to GST ADDED ON TOP of prices, from a state where it is
 * not (off, or prices that include GST), or null. The sentences that warn a
 * merchant their renewals will cost more read it.
 */
export function upcomingAddedGst(terms: TaxTerms): Upcoming | null {
  const up = terms.upcoming;
  if (!up || !up.enabled || up.inclusive) return null;
  if (terms.active && !terms.inclusive) return null;
  return up;
}

/** A scheduled change that raises what merchants pay (`raisesPayable`), or null. */
export function upcomingRise(terms: TaxTerms): Upcoming | null {
  const up = terms.upcoming;
  if (!up) return null;
  const now: TaxValues = {
    enabled: terms.active,
    inclusive: terms.inclusive,
    rateBps: terms.rateBps,
  };
  return raisesPayable(now, up) ? up : null;
}

/**
 * Do the screens ask for the merchant's state? While GST is charged, and as
 * soon as any switch-on is scheduled (included or added), because the
 * invoices will need it either way (design 7 intro, 7.2, 7.3).
 */
export function asksForState(terms: TaxTerms): boolean {
  return terms.active || terms.upcoming?.enabled === true;
}

// ── Amounts ─────────────────────────────────────────────────────────────────

/**
 * The figures a sentence quotes. GST Stage 12's `AmountQuote` and an invoice
 * row's money columns both fit it.
 */
export interface CopyAmount {
  /** What is charged. */
  totalPaise: number;
  /** The GST in it, added on top or carved out of it; 0 when none. */
  taxPaise: number;
  /** 0 when no GST. */
  rateBps: number;
  /** The GST is inside the total (prices include GST). */
  inclusive: boolean;
}

/**
 * One list price under these terms, with no discount: the invoice builder's
 * own arithmetic (`taxOnPaise`, `taxWithinPaise`, as `assemble` uses them), so
 * a card can never show a total the charge then disagrees with.
 */
export function amountFor(
  listPaise: number,
  terms: Pick<TaxTerms, "active" | "inclusive" | "rateBps">,
): CopyAmount {
  const list = Number.isFinite(listPaise)
    ? Math.max(0, Math.round(listPaise))
    : 0;
  if (!terms.active) {
    return { totalPaise: list, taxPaise: 0, rateBps: 0, inclusive: false };
  }
  if (terms.inclusive) {
    return {
      totalPaise: list,
      taxPaise: taxWithinPaise(list, terms.rateBps),
      rateBps: terms.rateBps,
      inclusive: true,
    };
  }
  const taxPaise = taxOnPaise(list, terms.rateBps);
  return {
    totalPaise: list + taxPaise,
    taxPaise,
    rateBps: terms.rateBps,
    inclusive: false,
  };
}

/** The price before any GST added on top (the total itself when included). */
function beforeGst(a: CopyAmount): number {
  return a.inclusive || a.taxPaise <= 0
    ? a.totalPaise
    : a.totalPaise - a.taxPaise;
}

function addedOnTop(a: CopyAmount): boolean {
  return a.taxPaise > 0 && !a.inclusive;
}

// ── Refusals when a payment starts (design 5.2, 5.5) ───────────────────────

/** What a merchant is told when an on-session payment cannot start. */
export const PAYMENT_REFUSAL = {
  /** The tax reading failed (or a credit pack's invoice could not be drafted). */
  invoiceFailed: "Couldn't prepare your invoice. Please try again.",
  /** GST is charged but StoreMink's tax identity is incomplete. */
  settingsIncomplete:
    "Payments are paused while we update our tax details. Please try again later.",
  /** GST is charged and no state of the merchant exists anywhere. */
  needsState:
    "Add your state under Billing details before you pay. It goes on your GST invoice.",
  /** GST is charged and the business is outside India (owner decision 5). */
  outsideIndia: `We can't take payments from businesses outside India yet. Write to ${SUPPORT_EMAIL} and we'll help.`,
} as const;

/**
 * The button the amount guard asks the merchant to press again, by the label
 * it carries on screen: the checkout dialog's "Continue to payment" (a new
 * plan, or the credits alone) and "Pay prorated change" (a dearer plan
 * change), signup's "Continue", the Locations card's "Pay ₹472", the invoice
 * panel's "Pay now" and the Mink credit packs panel's "Buy now".
 */
const PRESS_AGAIN = {
  continue_to_payment: "Continue to payment",
  pay_prorated_change: "Pay prorated change",
  continue: "Continue",
  pay: "Pay",
  pay_now: "Pay now",
  buy_now: "Buy now",
} as const;

/** "The amount to pay is now ..." (the amount guard, design 7.4). */
export function amountChanged(
  totalPaise: number,
  press: keyof typeof PRESS_AGAIN,
): string {
  return `The amount to pay is now ${R(totalPaise)}. Check it and press ${PRESS_AGAIN[press]} again.`;
}

// ── storemink.com: pricing page, homepage, POS page, metadata (design 7.1) ──

function startOf(terms: TaxTerms): string {
  return terms.upcoming?.startsAt ?? "";
}

/** The line under a plan card's price. */
export function pricingCardNote(
  terms: TaxTerms,
  period: BillingPeriod,
  listPaise: number,
): string {
  if (listPaise <= 0) return "No card needed";
  const billed =
    period === "yearly" ? "billed once a year" : "billed every month";
  switch (taxCopyState(terms)) {
    case "on_ex":
      return `${R(amountFor(listPaise, terms).totalPaise)} ${billed}, including GST`;
    case "on_in":
      return `${R(listPaise)} ${billed}, GST included`;
    case "sched_ex":
      return `${R(listPaise)} ${billed}, plus GST from ${istShortDate(startOf(terms))}`;
    case "off":
      return `${R(listPaise)} ${billed}`;
  }
}

/**
 * The small words after a headline price ("/mo" on the cards, the signup
 * plan card): "plus GST" while GST is added on top, otherwise nothing.
 */
export function pricingPriceSuffix(terms: TaxTerms): string | null {
  return taxCopyState(terms) === "on_ex" ? "plus GST" : null;
}

/**
 * What follows "per month" or "/month" in a sentence that quotes a list
 * price: the pricing and homepage leads, the metadata description, the
 * location limit refusal. Starts with its space; empty when nothing is said.
 */
export function priceGstSuffix(terms: TaxTerms): string {
  switch (taxCopyState(terms)) {
    case "on_ex":
      return " plus GST";
    case "on_in":
      return " including GST";
    default:
      return "";
  }
}

/** The second footnote line under the price cards, or null for none. */
export function pricingFootnote(terms: TaxTerms): string | null {
  const ahead = upcomingAddedGst(terms);
  switch (taxCopyState(terms)) {
    case "sched_ex":
      return ahead
        ? `Prices exclude GST. From ${istLongDate(ahead.startsAt)}, GST at ${rate(ahead.rateBps)} is added when you pay.`
        : null;
    case "on_in":
      return ahead
        ? `Prices include GST at ${rate(terms.rateBps)}. From ${istLongDate(ahead.startsAt)}, prices exclude GST and GST at ${rate(ahead.rateBps)} is added when you pay.`
        : `Prices include GST at ${rate(terms.rateBps)}.`;
    case "on_ex":
      return `Prices exclude GST. GST at ${rate(terms.rateBps)} is added when you pay, and you see the total before you pay.`;
    case "off":
      return null;
  }
}

/** The POS page's price box, under the yearly figure. */
export function posPriceBoxNote(terms: TaxTerms): string {
  switch (taxCopyState(terms)) {
    case "on_in":
      return "billed yearly, GST included";
    case "on_ex":
      return "billed yearly, plus GST";
    default:
      return "billed yearly";
  }
}

/**
 * JSON-LD `priceSpecification.valueAddedTaxIncluded`: true or false while GST
 * is charged, and undefined (omitted) otherwise.
 */
export function valueAddedTaxIncluded(terms: TaxTerms): boolean | undefined {
  if (!terms.active) return undefined;
  return terms.inclusive;
}

export const GST_FAQ_QUESTION = "Do your prices include GST?";

const FAQ_CREDIT = `if you add your GSTIN in ${BILLING_PAGE} you can claim it as input tax credit.`;

/**
 * The pricing FAQ entry, shown after "Does StoreMink charge a transaction
 * fee?" only while GST is charged or a switch to prices that exclude it is
 * scheduled; null otherwise.
 */
export function gstFaq(
  terms: TaxTerms,
): { question: string; answer: string } | null {
  const ahead = upcomingAddedGst(terms);
  let answer: string;
  switch (taxCopyState(terms)) {
    case "on_in":
      answer = `Yes. Every price on this page includes GST at ${rate(terms.rateBps)}. Your invoice shows the GST in it, and ${FAQ_CREDIT}`;
      if (ahead) {
        answer += ` From ${istLongDate(ahead.startsAt)}, prices exclude GST and GST at ${rate(ahead.rateBps)} is added when you pay.`;
      }
      break;
    case "on_ex":
      answer = `No. GST at ${rate(terms.rateBps)} is added to every plan, extra location and Mink credit pack when you pay, and you see the total with GST before you pay. Your invoice shows the GST charged, and ${FAQ_CREDIT}`;
      break;
    case "sched_ex":
      if (!ahead) return null;
      answer = `Today no GST is charged. From ${istLongDate(ahead.startsAt)}, GST at ${rate(ahead.rateBps)} is added to every plan, extra location and Mink credit pack when you pay, and you see the total with GST before you pay. Your invoice shows the GST charged, and ${FAQ_CREDIT}`;
      break;
    case "off":
      return null;
  }
  return { question: GST_FAQ_QUESTION, answer };
}

// ── Signup plan step (design 7.2) ──────────────────────────────────────────
// `terms` is null when the pricing API answered without `tax` (an older
// revision during a rollout): every line then reads as OFF, and the pay-now
// line promises the exact amount before payment instead.

/** Whole rupees a month from a yearly amount ("₹1,250 a month"). */
function perMonth(yearlyPaise: number): string {
  return R(Math.round(yearlyPaise / 1200) * 100);
}

/** The line under a yearly plan card's price. */
export function signupYearlyLine(
  terms: TaxTerms | null,
  yearlyListPaise: number,
): string {
  const st = terms ? taxCopyState(terms) : "off";
  if (terms && st === "on_ex") {
    const total = amountFor(yearlyListPaise, terms).totalPaise;
    return `${perMonth(total)} a month with GST, billed yearly`;
  }
  const line = `${perMonth(yearlyListPaise)} a month, billed yearly`;
  return st === "on_in" ? `${line}, GST included` : line;
}

/**
 * What the merchant pays now, replacing "You'll see the exact amount,
 * including any GST, before you pay." `amount` is the pay-now total the step
 * computed with the invoice builder.
 */
export function signupPayNowLine(
  terms: TaxTerms | null,
  period: BillingPeriod,
  amount: CopyAmount,
): string {
  if (!terms) return "You'll see the exact amount before you pay.";
  const now = period === "yearly" ? "now for the first year" : "now";
  const total = R(amount.totalPaise);
  let line: string;
  if (amount.taxPaise > 0 && amount.inclusive) {
    line = `You pay ${total} ${now}, including ${R(amount.taxPaise)} GST.`;
  } else if (amount.taxPaise > 0) {
    line = `You pay ${total} ${now}: ${R(beforeGst(amount))} plus ${R(amount.taxPaise)} GST.`;
  } else {
    line = `You pay ${total} ${now}.`;
  }
  const ahead = upcomingAddedGst(terms);
  if (ahead) {
    line += ` From ${istShortDate(ahead.startsAt)}, GST at ${rate(ahead.rateBps)} is added to your renewals.`;
  }
  return line;
}

/** "Continue with Basic · ₹1,500/month", or "... ₹1,770/month with GST". */
export function signupContinueLabel(
  terms: TaxTerms | null,
  planName: string,
  period: BillingPeriod,
  totalPaise: number,
): string {
  const withGst = terms && taxCopyState(terms) === "on_ex" ? " with GST" : "";
  return `Continue with ${planName} · ${R(totalPaise)}/${unitOf(period)}${withGst}`;
}

/** Shared by signup and the Billing details card. */
export const INVALID_GSTIN =
  "That doesn't look like a valid 15-character GSTIN.";

/** The state step on signup, while GST is charged or a switch-on is scheduled. */
export const SIGNUP_STATE = {
  stateLabel: "Your business's state",
  stateHint: "It goes on your invoices, as the GST rules require.",
  gstinLabel: "GSTIN (optional)",
  gstinHint:
    "Add it to claim the GST as input tax credit. Your state is then taken from it.",
  invalidGstin: INVALID_GSTIN,
  /** A country other than India while GST is charged now: only Free is offered. */
  outsideIndia: `We can't take payments from businesses outside India yet. Start on Free, and write to ${SUPPORT_EMAIL} if you'd like a paid plan.`,
  saveFailed: "Couldn't save your state. Please try again.",
} as const;

// ── Plans & Billing (design 7.3) ───────────────────────────────────────────

/** The current plan's "Price", for the subscription's own period. */
export function currentPlanPrice(
  terms: TaxTerms,
  period: BillingPeriod,
  listPaise: number,
): string {
  if (listPaise <= 0) return "Free";
  const price = `${R(listPaise)} a ${unitOf(period)}`;
  switch (taxCopyState(terms)) {
    case "on_in":
      return `${price}, including GST`;
    case "on_ex":
      return `${price} plus GST`;
    default:
      return price;
  }
}

export const NEXT_RENEWAL_LABEL = "Next renewal";

/** "₹1,770 on 14 Nov 2026". */
export function nextRenewalValue(amount: CopyAmount, renewsOn: string): string {
  return `${R(amount.totalPaise)} on ${istShortDate(renewsOn)}`;
}

/** "Including ₹270 GST" under the next renewal, in both modes; null without GST. */
export function nextRenewalGstLine(amount: CopyAmount): string | null {
  return amount.taxPaise > 0 ? `Including ${R(amount.taxPaise)} GST` : null;
}

/**
 * The amber line under the plan card when the next renewal will not be
 * collected automatically (`collectionRoute`); null when it will be.
 */
export function renewalByHandLine(input: {
  route: CollectionRoute;
  totalPaise: number;
  /** The renewal date: the invoice is to be paid by then. */
  dueOn: string;
  mandateMaxPaise: number | null;
}): string | null {
  if (input.route.auto) return null;
  const total = R(input.totalPaise);
  const due = istShortDate(input.dueOn);
  if (input.route.reason === "over_afa_limit") {
    return `Your next renewal of ${total} is above ${R(AFA_EXEMPT_PAISE)}, the most that can be charged automatically, so we'll email you an invoice to pay by ${due}.`;
  }
  if (input.route.reason === "over_mandate" && input.mandateMaxPaise != null) {
    return `Your next renewal of ${total} is above the ${R(input.mandateMaxPaise)} autopay limit you approved, so we'll email you an invoice to pay by ${due}.`;
  }
  return `We'll email you an invoice for your next renewal of ${total} to pay by ${due}.`;
}

/** The merchant's next renewal as the GST notice banner reads it. */
export interface NoticeRenewal {
  /** The renewal date. */
  renewsOn: string;
  /** The renewal under the terms at its issue time (GST Stage 12's quote). */
  amount: CopyAmount;
  route: CollectionRoute;
  mandateMaxPaise: number | null;
}

/**
 * The GST notice banner at the top of Plans & Billing, while a change that
 * raises this merchant's bills is scheduled; null otherwise. The renewal line
 * appears only when the renewal is invoiced under the new terms (GST added at
 * the new rate), and the by-hand line only when that renewal no longer fits
 * automatic collection.
 */
export function gstNoticeBanner(
  terms: TaxTerms,
  renewal: NoticeRenewal | null,
): { title: string; lines: string[] } | null {
  const rise = upcomingRise(terms);
  if (!rise) return null;
  const when = istLongDate(rise.startsAt);
  const title = upcomingAddedGst(terms)
    ? `GST will be added to our prices from ${when}`
    : `The GST on our prices goes up from ${when}`;
  const lines = [
    `From then, GST at ${rate(rise.rateBps)} is added to every plan, extra location and Mink credit pack.`,
  ];
  const a = renewal?.amount;
  if (renewal && a && addedOnTop(a) && a.rateBps === rise.rateBps) {
    lines.push(
      `Your renewal on ${istShortDate(renewal.renewsOn)} will be ${R(a.totalPaise)}: ${R(beforeGst(a))} plus ${R(a.taxPaise)} GST.`,
    );
    const route = renewal.route;
    if (!route.auto && route.reason === "over_afa_limit") {
      lines.push(
        `That's above ${R(AFA_EXEMPT_PAISE)}, the most that can be charged automatically, so we'll email you an invoice to pay instead.`,
      );
    } else if (
      !route.auto &&
      route.reason === "over_mandate" &&
      renewal.mandateMaxPaise != null
    ) {
      lines.push(
        `That's above the ${R(renewal.mandateMaxPaise)} autopay limit you approved, so we'll email you an invoice to pay instead.`,
      );
    }
  }
  lines.push(
    "Add your GSTIN under Billing details to claim the GST as input tax credit.",
  );
  return { title, lines };
}

/**
 * The "add your state" banner for a store with a live paid plan, from the
 * place-of-supply basis of its next renewal; null when it has nothing to say.
 * No state of the merchant's own (`supplier_state`, or `unknown` while the
 * renewal falls before the start) asks for one while GST is charged or any
 * switch-on is scheduled. A business outside India sees its own sentence
 * while GST is charged, with no title and no button.
 */
export function stateBanner(
  terms: TaxTerms,
  basis: PlaceOfSupplyBasis,
): { title: string | null; body: string; action: string | null } | null {
  if (basis === "outside_india") {
    return terms.active
      ? {
          title: null,
          body: `Your business is outside India. Your renewals are charged IGST. New payments can't be made from outside India yet; write to ${SUPPORT_EMAIL} if you need one.`,
          action: null,
        }
      : null;
  }
  if (basis !== "supplier_state" && basis !== "unknown") return null;
  if (!asksForState(terms)) return null;
  const why =
    "the GST rules ask us to show your state on them. We couldn't find it in your details. Add it under Billing details below.";
  return {
    title: "Add your state for your invoices",
    body: terms.active
      ? `StoreMink's invoices show GST, and ${why}`
      : `From ${istShortDate(startOf(terms))} StoreMink's invoices show GST, and ${why}`,
    action: "Add your state",
  };
}

/** Under the "/month" figure of the available plans grid, or null. */
export function plansGridSuffix(terms: TaxTerms): string | null {
  switch (taxCopyState(terms)) {
    case "on_ex":
      return "plus GST";
    case "on_in":
      return "including GST";
    default:
      return null;
  }
}

/**
 * A Mink credit pack's price in the packs panel: the amount payable now, and
 * never a price per credit (owner decision 10).
 */
export function packPrice(terms: TaxTerms, listPaise: number): string {
  return packTotalPrice(terms, amountFor(listPaise, terms).totalPaise);
}

/**
 * The same, from an amount that already includes any GST: what a pack's
 * payment start asked for after the amount guard stopped it ("₹69.62
 * including GST" while GST is charged, "₹59" otherwise).
 */
export function packTotalPrice(terms: TaxTerms, totalPaise: number): string {
  const total = R(totalPaise);
  return terms.active ? `${total} including GST` : total;
}

/** "Tax invoice SM/2026-27/00001" when GST was charged, else "Invoice ...". */
export function invoiceListName(ref: string, taxPaise: number): string {
  return taxPaise > 0 ? `Tax invoice ${ref}` : `Invoice ${ref}`;
}

/** Under the amount on "You have an invoice to pay": "Including ₹2,700 GST (18%)". */
export function invoiceGstLine(
  taxPaise: number,
  rateBps: number | null,
): string | null {
  if (!(taxPaise > 0)) return null;
  const pct = rateBps ? ` (${rate(rateBps)})` : "";
  return `Including ${R(taxPaise)} GST${pct}`;
}

/** Where the Billing details card's prefill came from. */
export type BillingDetailsPrefill =
  | "taxes_and_invoices"
  | "location"
  | "signup";

export const BILLING_DETAILS = {
  title: "Billing details",
  description:
    "These go on the invoices StoreMink sends you. Add your GSTIN to claim the GST on them as input tax credit.",
  fields: {
    country: { label: "Country" },
    countryName: { label: "Country name" },
    businessName: {
      label: "Business name",
      hint: "As it should appear on your invoices. Leave blank to use your store's name.",
    },
    gstin: {
      label: "GSTIN (optional)",
      hint: "15 characters. Your state is taken from it.",
    },
    state: {
      label: "State",
      hint: "Decides whether your invoice shows CGST and SGST or IGST.",
      /** The empty first option of every state select (the card, the state prompt). */
      placeholder: "Choose your state",
    },
    address: { label: "Address" },
    address2: { label: "Address line 2 (optional)" },
    city: { label: "City" },
    pin: { label: "PIN code" },
    /** Replaces "PIN code" for a country outside India. */
    postalCode: { label: "Postal code (optional)" },
  },
  save: "Save billing details",
  saving: "Saving…",
  saved: "Billing details saved. They apply to invoices issued from now on.",
  errors: {
    gstin: INVALID_GSTIN,
    state: "Choose your state.",
    pin: "Enter a 6-digit PIN code.",
    countryName: "Enter your country's name.",
    failed: "Couldn't save your billing details. Please try again.",
  },
  footnote: "An invoice that has already been issued can't be changed.",
  staffOnly: "Only someone who manages billing can change these.",
  /** In place of the form when the details could not be read. */
  loadFailed:
    "Couldn't load your billing details. Refresh the page to try again.",
} as const;

const PREFILL_SOURCE: Record<BillingDetailsPrefill, string> = {
  taxes_and_invoices: "Settings → Taxes & invoices",
  location: "your main location",
  signup: "the details you gave when you signed up",
};

/** "Filled in from ... Check them and save.", or null when nothing was prefilled. */
export function billingDetailsPrefilled(
  from: BillingDetailsPrefill | null,
): string | null {
  return from
    ? `Filled in from ${PREFILL_SOURCE[from]}. Check them and save.`
    : null;
}

const USES_SOURCE: Partial<Record<PlaceOfSupplyBasis, string>> = {
  gstin: "your GSTIN",
  billing_state: "these billing details",
  store_gstin: "Taxes & invoices",
  store_tax_state: "Taxes & invoices",
  location_gstin: "your main location",
  location_state: "your main location",
  store_address: "the address you typed in Taxes & invoices",
  signup_address: "your signup details",
};

/**
 * The line above "Save billing details": which state StoreMink's invoices
 * use and where it came from. `countryName` names a country outside India.
 */
export function billingDetailsUses(
  placeOfSupply: PlaceOfSupply,
  countryName: string | null,
): string {
  const { code, basis } = placeOfSupply;
  if (basis === "outside_india") {
    const name = countryName?.trim();
    return name
      ? `Your invoices use: outside India (${name}).`
      : "Your invoices use: outside India.";
  }
  const source = USES_SOURCE[basis];
  const label = stateNameOf(code) ? placeOfSupplyLabel(code) : null;
  if (!source || !label) {
    return "We couldn't find your state. Choose it above so your invoices show it.";
  }
  return `Your invoices use: ${label}, from ${source}.`;
}

/** The checkout dialog's stage 1 plan card: the amount and the line under it. */
export function checkoutPlanCard(
  terms: TaxTerms,
  period: BillingPeriod,
  listPaise: number,
): { amount: string; line: string } {
  if (listPaise <= 0) return { amount: "Free", line: "No recurring charge" };
  const unit = unitOf(period);
  const list = R(listPaise);
  switch (taxCopyState(terms)) {
    case "on_ex":
      return {
        amount: `${list} plus GST`,
        line: `${R(amountFor(listPaise, terms).totalPaise)} billed every ${unit}`,
      };
    case "on_in":
      return { amount: list, line: `Billed every ${unit}, GST included` };
    case "sched_ex":
      return {
        amount: list,
        line: `Billed every ${unit}, plus GST from ${istShortDate(startOf(terms))}`,
      };
    case "off":
      return { amount: list, line: `Billed every ${unit}` };
  }
}

/** The checkout dialog's stage 2 pack price: "₹69.62 once, including GST". */
export function checkoutPackPrice(terms: TaxTerms, listPaise: number): string {
  const once = `${R(amountFor(listPaise, terms).totalPaise)} once`;
  return terms.active ? `${once}, including GST` : once;
}

/** The checkout dialog's stage 3 credits row: "60 credits · ₹129 once". */
export function checkoutCreditsRow(
  terms: TaxTerms,
  credits: number,
  listPaise: number,
): string {
  return `${credits} credits · ${checkoutPackPrice(terms, listPaise)}`;
}

/** The checkout dialog's fixed lines. */
export const CHECKOUT = {
  exactAmount: "The payment window asks for exactly this amount.",
  nothingChargedNow: "Nothing is charged now.",
  working: "Working out the total…",
  failed: "We couldn't work out the total. Please try again.",
  tryAgain: "Try again",
  /** In place of the rows when `needsState`, beside a state select. */
  needsState: "Add your state before you pay. It goes on your GST invoice.",
  save: "Save",
  /** In place of the rows when `outsideIndia`; the payment buttons stay off. */
  outsideIndia: PAYMENT_REFUSAL.outsideIndia,
} as const;

export interface SummaryRow {
  label: string;
  /** Null for a row that is only a label ("Nothing to pay now"). */
  value: string | null;
  /** A second line under the value, or null. */
  note: string | null;
}

/**
 * The checkout dialog's summary, rebuilt from `quoteCheckout` (design 7.3).
 *
 * `payNow` is null for a cheaper or equal plan change, which is scheduled:
 * nothing is charged, and the renewal row is dated `effectiveAt`. `renewal`
 * is the first (or next) renewal under the terms at its issue time, so a
 * renewal after a scheduled start shows its GST and the date it starts.
 */
export function checkoutSummary(input: {
  terms: TaxTerms;
  period: BillingPeriod;
  kind: "subscribe" | "dearer_change" | "scheduled_change";
  payNow: CopyAmount | null;
  renewal: CopyAmount;
  /** A scheduled change: when it takes effect. */
  effectiveAt?: string | null;
  /** A Mink credit pack bought with it, as a separate payment. */
  pack?: CopyAmount | null;
}): { rows: SummaryRow[]; note: string } {
  const rows: SummaryRow[] = [];
  const pay = input.kind === "scheduled_change" ? null : input.payNow;

  if (!pay) {
    rows.push({ label: "Nothing to pay now", value: null, note: null });
  } else {
    const label =
      input.kind === "dearer_change"
        ? "Pay now for the rest of this cycle"
        : "Pay now";
    if (addedOnTop(pay)) {
      rows.push(
        { label: "Plan", value: R(beforeGst(pay)), note: null },
        {
          label: `GST (${rate(pay.rateBps)})`,
          value: R(pay.taxPaise),
          note: null,
        },
        { label, value: R(pay.totalPaise), note: null },
      );
    } else if (pay.taxPaise > 0) {
      rows.push({
        label,
        value: R(pay.totalPaise),
        note: `Includes ${R(pay.taxPaise)} GST (${rate(pay.rateBps)})`,
      });
    } else {
      rows.push({ label, value: R(pay.totalPaise), note: null });
    }
  }

  const then =
    input.kind === "subscribe"
      ? "Then"
      : input.kind === "dearer_change"
        ? "From your next renewal"
        : `From ${istShortDate(input.effectiveAt ?? "")}`;
  let every = `${R(input.renewal.totalPaise)} every ${unitOf(input.period)}`;
  const ahead = upcomingAddedGst(input.terms);
  if (input.renewal.taxPaise > 0) {
    every += ", including GST";
    // Dated when the renewal adds GST that today's payment does not (a
    // scheduled start); a scheduled change's label already carries its date.
    if (
      ahead &&
      addedOnTop(input.renewal) &&
      input.kind !== "scheduled_change" &&
      !(pay && addedOnTop(pay))
    ) {
      every += ` from ${istShortDate(ahead.startsAt)}`;
    }
  }
  // A renewal invoiced before a scheduled added-GST start: its figure holds
  // for that renewal only, so say when GST joins it (the Locations confirm's
  // words), or the last screen before paying states a price that lasts one
  // cycle as the recurring one.
  if (ahead && !addedOnTop(input.renewal)) {
    every += `. GST at ${rate(ahead.rateBps)} is added to renewals invoiced from ${istShortDate(ahead.startsAt)}.`;
  }
  rows.push({ label: then, value: every, note: null });

  if (input.pack) {
    const value = R(input.pack.totalPaise);
    rows.push({
      label: "Mink credits, separate payment",
      value: input.pack.taxPaise > 0 ? `${value} including GST` : value,
      note: null,
    });
  }

  return {
    rows,
    note: pay ? CHECKOUT.exactAmount : CHECKOUT.nothingChargedNow,
  };
}

// ── Locations (design 7.5) ─────────────────────────────────────────────────

/** "2 extra at ₹1,000/month each", with the GST words while GST is charged. */
export function locationsExtraSummary(
  terms: TaxTerms,
  extra: number,
  listPaise: number,
  period: BillingPeriod,
): string {
  const line = `${extra} extra at ${R(listPaise)}/${unitOf(period)} each`;
  switch (taxCopyState(terms)) {
    case "on_in":
      return `${line}, including GST`;
    case "on_ex":
      return `${line}, plus GST`;
    default:
      return line;
  }
}

/** "Add a location · ₹1,000/month", with "plus GST" while GST is added on top. */
export function addLocationButton(
  terms: TaxTerms,
  listPaise: number,
  period: BillingPeriod,
): string {
  const label = `Add a location · ${R(listPaise)}/${unitOf(period)}`;
  return taxCopyState(terms) === "on_ex" ? `${label} plus GST` : label;
}

/**
 * The confirmation for adding a location, and its button.
 *
 * `perLocation` is one location for one cycle now; `nextPurchase` what is
 * paid now for the rest of this cycle (null or 0 when nothing is due);
 * `nextRenewal` one location under the terms at the next renewal's issue
 * time. ★ Every "from your next renewal" figure is `nextRenewal`'s own total,
 * never chosen by the state alone: a renewal invoiced 4 days before its cycle
 * can fall before a scheduled start even when the cycle begins after it.
 * ★ With no `nextRenewal` nothing is said about a renewal at all: a figure
 * there would promise a charge that will not happen.
 */
export function addLocationConfirm(input: {
  terms: TaxTerms;
  period: BillingPeriod;
  perLocation: CopyAmount;
  nextPurchase: CopyAmount | null;
  /**
   * null when no renewal will bill the location: the plan is cancelling, the
   * next plan has no POS, or the renewal could not be read.
   */
  nextRenewal: CopyAmount | null;
}): { text: string; confirmLabel: string } {
  const { terms, nextPurchase: now, nextRenewal: next } = input;
  const unit = unitOf(input.period);
  const st = taxCopyState(terms);
  const price = `${R(beforeGst(input.perLocation))}/${unit}`;

  if (!now || now.totalPaise <= 0) {
    const what =
      st === "on_in"
        ? `${price}, including GST`
        : st === "on_ex"
          ? `${price} plus GST`
          : price;
    return {
      text: next
        ? `Add a location for ${what}, billed from your next renewal.`
        : `Add a location for ${what}.`,
      confirmLabel: "Add location",
    };
  }

  const opening =
    st === "on_in"
      ? `Add a location for ${price}, including GST.`
      : st === "on_ex"
        ? `Add a location for ${price} plus GST, ${R(input.perLocation.totalPaise)}/${unit} in all.`
        : `Add a location for ${price}.`;
  const paying = addedOnTop(now)
    ? `You'll pay ${R(now.totalPaise)} now for the rest of this cycle (${R(beforeGst(now))} plus ${R(now.taxPaise)} GST),`
    : now.taxPaise > 0
      ? `You'll pay ${R(now.totalPaise)} now for the rest of this cycle, including ${R(now.taxPaise)} GST,`
      : `You'll pay ${R(now.totalPaise)} now for the rest of this cycle,`;
  if (!next) {
    // No renewal bills it: the payment now is the whole of what is said.
    return {
      text: `${opening} ${paying.slice(0, -1)}.`,
      confirmLabel: `Pay ${R(now.totalPaise)}`,
    };
  }
  // "including GST" only where nothing said so yet: GST added on top at the
  // renewal while prices do not add it now (a scheduled start).
  const renewalWithGst = addedOnTop(next) && st !== "on_ex";
  let text = `${opening} ${paying} then ${R(next.totalPaise)}/${unit}${renewalWithGst ? " including GST" : ""} from your next renewal.`;
  const ahead = upcomingAddedGst(terms);
  if (ahead && !addedOnTop(next)) {
    text += ` GST at ${rate(ahead.rateBps)} is added to renewals invoiced from ${istShortDate(ahead.startsAt)}.`;
  }
  return { text, confirmLabel: `Pay ${R(now.totalPaise)}` };
}

// ── The invoice (design 7.6) ───────────────────────────────────────────────

export const INVOICE_SHEET = {
  taxTitle: "Tax Invoice",
  plainTitle: "Invoice",
  /** Under "Tax Invoice" (CGST rule 48). */
  original: "Original for recipient",
  placeOfSupply: "Place of supply",
  reverseCharge: "Tax payable on reverse charge",
  reverseChargeValue: "No",
  columns: {
    description: "Description",
    sac: "SAC",
    qty: "Qty",
    rate: "Rate",
    amount: "Amount",
    /** When the invoice's `tax_inclusive` is true. */
    amountInclusive: "Amount (GST included)",
  },
  totals: {
    taxableValue: "Taxable value",
    subtotal: "Subtotal",
    discount: "Discount",
    total: "Total",
  },
  taxFooter:
    "This is a computer-generated tax invoice and does not require a signature.",
  plainFooter:
    "No GST has been charged on this invoice. This is a computer-generated document and does not require a signature.",
} as const;

/** "GSTIN: 03ABCDE1234F1Z5". */
export function invoiceGstinLine(gstin: string): string {
  return `GSTIN: ${gstin}`;
}

/** "State: Punjab (03)", or null for a code that names no state. */
export function invoiceStateLine(code: string | null): string | null {
  return stateNameOf(code) ? `State: ${placeOfSupplyLabel(code)}` : null;
}

/** "Country: United States". */
export function invoiceCountryLine(countryName: string): string {
  return `Country: ${countryName}`;
}

/** The totals' GST labels: "CGST 9%", "SGST 9%", "IGST 18%". */
export function gstSplitLabels(rateBps: number): {
  cgst: string;
  sgst: string;
  igst: string;
} {
  const half = rate(rateBps / 2);
  return {
    cgst: `CGST ${half}`,
    sgst: `SGST ${half}`,
    igst: `IGST ${rate(rateBps)}`,
  };
}

/**
 * The LLP line printed on every invoice once an LLPIN is recorded (LLP Act
 * section 21; owner decisions 7 and 8): "STOREMINK LLP is registered with
 * limited liability. LLPIN ADC-5432. Registered office: {as typed}." Null
 * without an LLPIN. A trailing full stop typed into the office is not doubled.
 */
export function llpLine(p: {
  legalName: string;
  llpin: string | null;
  registeredOffice: string | null;
}): string | null {
  const llpin = p.llpin?.trim();
  if (!llpin) return null;
  const office = p.registeredOffice?.trim().replace(/\.+$/, "");
  const line = `${p.legalName.trim()} is registered with limited liability. LLPIN ${llpin}.`;
  return office ? `${line} Registered office: ${office}.` : line;
}

// ── Billing emails (design 7.7) ────────────────────────────────────────────

export interface EmailRow {
  label: string;
  value: string;
}

/**
 * The amount rows of the renewal-due email, from the invoice: with GST added,
 * "Price", "GST (18%)" and the amount; with GST included, the amount and
 * "Includes GST (18%)"; without GST, the amount alone. The amount row is
 * "Amount" for autopay and "Amount due" for an invoice to pay.
 */
export function renewalAmountRows(
  amount: CopyAmount,
  autopay: boolean,
): EmailRow[] {
  const due = {
    label: autopay ? "Amount" : "Amount due",
    value: R(amount.totalPaise),
  };
  if (addedOnTop(amount)) {
    return [
      { label: "Price", value: R(beforeGst(amount)) },
      { label: `GST (${rate(amount.rateBps)})`, value: R(amount.taxPaise) },
      due,
    ];
  }
  if (amount.taxPaise > 0) {
    return [
      due,
      {
        label: `Includes GST (${rate(amount.rateBps)})`,
        value: R(amount.taxPaise),
      },
    ];
  }
  return [due];
}

/** The payment-received email's rows: "Amount paid", and its GST when charged. */
export function receiptAmountRows(amount: CopyAmount): EmailRow[] {
  const rows = [{ label: "Amount paid", value: R(amount.totalPaise) }];
  if (amount.taxPaise > 0) {
    rows.push({
      label: `Includes GST (${rate(amount.rateBps)})`,
      value: R(amount.taxPaise),
    });
  }
  return rows;
}

/**
 * The payment-received email's closing line when GST was charged; null when
 * it was not, and the existing line stays. For a receipt whose plan is live
 * (not one being cancelled).
 */
export function receiptClosingLine(taxPaise: number): string | null {
  return taxPaise > 0
    ? `Your plan is active. Your tax invoice is in ${BILLING_PAGE} whenever you need it.`
    : null;
}

/** The plan-activated email's "Price": "₹1,770/month, including GST". */
export function planActivatedPrice(
  amount: CopyAmount,
  period: BillingPeriod,
): string {
  const price = `${R(amount.totalPaise)}/${unitOf(period)}`;
  return amount.taxPaise > 0 ? `${price}, including GST` : price;
}

/**
 * The plan-activated paragraph while a switch to prices that exclude GST is
 * scheduled, so a merchant who signs up after the notice went out still
 * hears of it; null otherwise. `renewal` is a renewal invoiced after the
 * start.
 */
export function planActivatedGstParagraph(
  terms: TaxTerms,
  renewal: CopyAmount,
  period: BillingPeriod,
): string | null {
  const ahead = upcomingAddedGst(terms);
  if (!ahead) return null;
  return `From ${istShortDate(ahead.startsAt)}, GST at ${rate(ahead.rateBps)} is added to our prices, so renewals invoiced from then cost ${R(renewal.totalPaise)} a ${unitOf(period)} including GST.`;
}

export type RenewalChange = "gst_started" | "price_changed" | "both" | "lower";

/**
 * Why a renewal costs something other than last time, or null when it does
 * not. "lower": it costs less. Otherwise, the price before GST unchanged
 * means GST is the cause ("gst_started": GST now added on top, or at a
 * higher rate); a new price with GST newly added on top is "both"; any other
 * rise is "price_changed".
 */
export function renewalChange(
  prev: CopyAmount | null,
  cur: CopyAmount,
): RenewalChange | null {
  if (!prev || prev.totalPaise === cur.totalPaise) return null;
  if (cur.totalPaise < prev.totalPaise) return "lower";
  if (beforeGst(prev) === beforeGst(cur)) return "gst_started";
  return addedOnTop(cur) && !addedOnTop(prev) ? "both" : "price_changed";
}

/**
 * The renewal-due email's change paragraph (plain text), or null. The GST
 * sentence is design 7.7's. ★ "both", "price_changed" and "lower" name no
 * cause beyond GST: the previous invoice is compared whatever the plan,
 * period or location count (an invoice records none of them), so a scheduled
 * upgrade, a period switch or an added location reaches these too, and "our
 * plan prices changed" would be false for them.
 */
export function renewalChangeSentence(
  prev: CopyAmount | null,
  cur: CopyAmount,
): string | null {
  const change = renewalChange(prev, cur);
  if (!change || !prev) return null;
  const last = R(prev.totalPaise);
  switch (change) {
    case "gst_started":
      return `This is more than last time because GST at ${rate(cur.rateBps)} is now added to our prices. Nothing about your plan changed.`;
    case "both":
      return `This is an increase from ${last} last time, and GST at ${rate(cur.rateBps)} is now added to our prices.`;
    case "price_changed":
      return `This is an increase from ${last} last time.`;
    case "lower":
      return `This is a reduction from ${last} last time.`;
  }
}

// ── Operator console: Billing & tax (design 6, 5.8) ────────────────────────

export const TAX_CONSOLE = {
  intro:
    "What StoreMink's own invoices say (plans, extra locations and Mink credit packs) and whether they charge GST. This is StoreMink's tax identity, not a merchant's. A merchant's own tax settings live in their dashboard.",
  statusTitle: "GST status",
  identityTitle: "StoreMink's tax identity",
  changeTitle: "Charging GST",
  /** The settings could not be read, so the cards below show nothing real and save nothing. */
  readFailed:
    "Couldn't read the billing and tax settings, so nothing on this page can be saved. Refresh the page to try again.",
} as const;

function chargedEveryPrice(v: TaxValues): string {
  return v.enabled
    ? `GST at ${rate(v.rateBps)} is ${v.inclusive ? "included in" : "added to"} every price.`
    : "No GST is charged.";
}

/**
 * Card 1's sentence, from `termsAt(settings, now)` (design 6.2). Times are
 * IST ("1 December 2026, 00:00 IST").
 */
export function taxStatusSentence(terms: TaxTerms): string {
  const up = terms.upcoming;
  if (!terms.active) {
    if (!up || !up.enabled) {
      return "No GST is being charged. Invoices show no GST.";
    }
    return `No GST is being charged yet. From ${istLongDateTime(up.startsAt)}, ${chargedEveryPrice(up)}`;
  }
  const on = `GST is being charged at ${rate(terms.rateBps)}, ${terms.inclusive ? "included in" : "added to"} every price: plans, extra locations and Mink credit packs.`;
  return up
    ? `${on} From ${istLongDateTime(up.startsAt)}: ${chargedEveryPrice(up)}`
    : on;
}

export const TAX_STATUS = {
  cancel: "Cancel this change",
  confirmCancel: "Cancel the change",
  keep: "Keep it",
  cancelled: "Scheduled change cancelled.",
  /** Under the sentence, whatever the GST state, while the LLPIN or the
   *  registered office is blank. */
  llpMissing:
    "Invoices don't show the LLP's particulars yet. The LLP Act asks for the LLPIN and the registered office on every invoice. Add them under StoreMink's tax identity.",
} as const;

/** The confirmation behind "Cancel this change". */
export function cancelChangeConfirm(startsAt: string): string {
  return `Cancel the change scheduled for ${istLongDateTime(startsAt)}? If you sent merchants a notice, tell them it won't happen.`;
}

/** Card 2, StoreMink's tax identity (design 6.3). */
export const TAX_IDENTITY = {
  legalName: {
    label: "Registered legal name",
    hint: "The entity issuing the invoice, exactly as on the GST registration.",
    placeholder: "STOREMINK LLP",
  },
  gstin: {
    label: "GSTIN",
    hint: "15 characters. Its first two digits are the state, and they must match the state below.",
    placeholder: "03ABCDE1234F1Z5",
  },
  state: {
    label: "State",
    hint: "Decides CGST and SGST for merchants in the same state, IGST for everyone else.",
  },
  address: {
    label: "Address printed on invoices",
    hint: "Your principal place of business as on the GST registration. Printed on every invoice.",
    line1: "Address line 1",
    line2: "Address line 2",
    city: "City",
    pin: "PIN",
  },
  sacCode: {
    label: "SAC code",
    hint: "The 6-digit service code printed on every tax invoice. Choose it with your accountant.",
    placeholder: "6 digits",
  },
  llpin: {
    label: "LLPIN",
    hint: "Printed on every invoice with the statement that the LLP is registered with limited liability (LLP Act section 21). Needed before GST can start.",
    placeholder: "AAA-0000",
  },
  registeredOffice: {
    label: "Registered office",
    hint: "Printed with the LLPIN on every invoice. Needed before GST can start.",
    /** Copies the address lines, city and PIN into it as one line. */
    useAddress: "Use the address above",
  },
  prefix: {
    label: "Invoice number prefix",
    hint: "1 or 2 letters or digits. Invoice numbers look like SM/2026-27/00001, the 16 characters GST allows. Changing it does not renumber existing invoices.",
    maxLength: 2,
  },
  save: "Save tax identity",
  saved: "Tax identity saved.",
} as const;

/** Card 3, Charging GST: the fixed labels (design 6.4). */
export const TAX_CHANGE = {
  dontCharge: "Don't charge GST",
  charge: "Charge GST",
  rateLabel: "GST rate",
  rateHint:
    "18% for StoreMink's services. Change it only when the law changes it.",
  now: "Now",
  scheduled: "From a date and time",
  whenHint:
    "Invoices built from this moment use the new setting. Invoices already issued never change. Pick a time on or after the date your GST registration takes effect.",
  noticeLabel: "Notice email",
  noticeHint:
    "The Operational notice you emailed all store owners about this change. GST can start 1 month after it at the earliest.",
  noticeLink: "Write the notice in Announcements",
  /** Shown only once LAW_SET_RATE_RISE_WITHOUT_NOTICE is true. */
  lawChanged: "The law changed the GST rate on these services.",
  impactTitle: "What this changes for merchants with a plan",
  impactColumns: [
    "Store",
    "Plan",
    "Next renewal",
    "Today",
    "After the change",
    "Paid how",
    "State on invoices",
  ],
  scheduleAnyway: "Schedule anyway",
  goBack: "Go back",
  switchOn: "Switch GST on",
  notYet: "Not yet",
  saved: "GST settings saved.",
  /** The impact panel when its read failed (`getGstChangeImpact` answered
   *  `read_failed`): never an empty table that reads as "nothing changes". */
  impactFailed: "Couldn't work out what this changes. Please try again.",
  amberNote:
    "The pricing page, signup and every price in merchants' dashboards read this setting, so they change with it. Prices that exclude GST raise every bill: send the notice first.",
} as const;

/**
 * The two price-mode radios, with examples from the live Basic monthly price
 * (`listPaise`) at the chosen rate.
 */
export function priceModeOptions(
  listPaise: number,
  rateBps: number,
): {
  inclusive: { title: string; body: string };
  exclusive: { title: string; body: string };
} {
  const list = R(listPaise);
  const inside = amountFor(listPaise, {
    active: true,
    inclusive: true,
    rateBps,
  });
  const onTop = amountFor(listPaise, {
    active: true,
    inclusive: false,
    rateBps,
  });
  return {
    inclusive: {
      title: "Prices include GST",
      body: `A ${list} plan is still billed ${list}, of which ${R(inside.taxPaise)} is GST. Nobody's bill changes; StoreMink keeps less of each payment.`,
    },
    exclusive: {
      title: "Prices exclude GST",
      body: `A ${list} plan is billed ${R(onTop.totalPaise)}. Every merchant's bill goes up, so this needs 1 month's notice.`,
    },
  };
}

/** The button under Card 3; the label follows the choice. */
export function changeButtonLabel(choice: {
  when: "now" | "scheduled";
  /** The change switches GST on from off. */
  switchesOn: boolean;
}): string {
  if (choice.when === "scheduled") return "Schedule this change";
  return choice.switchesOn ? "Switch GST on now" : "Save";
}

/** The confirmation before switching GST on now. */
export function switchOnNowConfirm(
  rateBps: number,
  inclusive: boolean,
): string {
  return `Switch GST on now? Invoices built from now charge GST at ${rate(rateBps)}, ${inclusive ? "included in" : "added to"} every price.`;
}

/** "GST change scheduled for 1 December 2026, 00:00 IST." */
export function changeScheduledToast(startsAt: string): string {
  return `GST change scheduled for ${istLongDateTime(startsAt)}.`;
}

/** Why a notice is listed but disabled, in brackets after its option. */
const NOTICE_OPTION_REASON: Record<NoticeFailure, string> = {
  not_operational: "product news",
  not_sent: "not sent",
  nothing_delivered: "nothing delivered",
  not_email: "not by email",
  audience: "only some store owners",
};

/**
 * One option of the notice select: "{title}, sent {date}: {sent} delivered,
 * {failed} failed", and its reason in brackets when it does not count.
 */
export function noticeOptionLabel(n: {
  title: string;
  sentAt: string | null;
  sent: number;
  failed: number;
  check: NoticeCheck;
}): string {
  const sent = n.sentAt ? `, sent ${istShortDate(n.sentAt)}` : "";
  const label = `${n.title}${sent}: ${n.sent} delivered, ${n.failed} failed`;
  return n.check.ok
    ? label
    : `${label} (${NOTICE_OPTION_REASON[n.check.reason]})`;
}

/** The save's refusal when the chosen notice does not count (`noticeQualifies`). */
export function noticeRefusal(reason: NoticeFailure): string {
  switch (reason) {
    case "not_operational":
      return "That announcement is product news. Only an Operational notice reaches every store owner.";
    case "not_sent":
    case "nothing_delivered":
      return "That notice hasn't reached anyone yet. Wait until it has been sent, or send it again.";
    case "not_email":
      return "That notice wasn't sent by email. Merchants are promised an email.";
    case "audience":
      return "That notice went to only some store owners. Send one to all store owners, with no plan, status, age or launch filter.";
  }
}

/** The impact panel's counts (GST Stage 10's `getGstChangeImpact`). */
export interface ImpactCounts {
  /** Renewals that cost more. */
  rise: number;
  /** Of those, renewals charged automatically today that will need paying by hand. */
  byHand: number;
  aboveMandate: number;
  aboveAfaLimit: number;
  /** Stores with no state on record (StoreMink's state used). */
  noState: number;
  /** Stores whose state is read from the address they typed. */
  fromAddress: number;
  outsideIndia: number;
  /** StoreMink's own state code, named for the stores with none. */
  supplierStateCode: string | null;
}

function supplierStateName(code: string | null): string {
  return stateNameOf(code) ?? "StoreMink's state";
}

/** The impact panel's lines, each only when its number is above 0. */
export function impactLines(c: ImpactCounts): string[] {
  const lines: string[] = [];
  if (c.rise > 0) {
    lines.push(`${count(c.rise, "renewal", "renewals")} will cost more.`);
  }
  if (c.byHand > 0) {
    const parts: string[] = [];
    if (c.aboveMandate > 0) {
      parts.push(
        `${c.aboveMandate} ${c.aboveMandate === 1 ? "is" : "are"} above the merchant's autopay limit`,
      );
    }
    if (c.aboveAfaLimit > 0) {
      parts.push(
        `${c.aboveAfaLimit} ${c.aboveAfaLimit === 1 ? "is" : "are"} above ${R(AFA_EXEMPT_PAISE)}, the most that can be charged automatically`,
      );
    }
    const head = `${c.byHand} of them ${c.byHand === 1 ? "is" : "are"} charged automatically today and will need paying by hand`;
    lines.push(parts.length ? `${head}: ${parts.join(" and ")}.` : `${head}.`);
  }
  if (c.noState > 0) {
    const state = supplierStateName(c.supplierStateCode);
    const used =
      state === "StoreMink's state" ? state : `${state}, StoreMink's state`;
    lines.push(
      c.noState === 1
        ? `1 store has no state on record, so its invoices would use ${used}, and name no state for it. The notice asks it to add one; you can also contact it.`
        : `${c.noState} stores have no state on record, so their invoices would use ${used}, and name no state for them. The notice asks them to add one; you can also contact them.`,
    );
  }
  if (c.fromAddress > 0) {
    lines.push(
      c.fromAddress === 1
        ? "1 store's state is read from the address it typed. It can check it under Billing details."
        : `${c.fromAddress} stores' states are read from the address they typed. Each can check it under Billing details.`,
    );
  }
  if (c.outsideIndia > 0) {
    lines.push(
      c.outsideIndia === 1
        ? "1 store is outside India. While GST is charged it can't make new payments, and its renewals are charged IGST."
        : `${c.outsideIndia} stores are outside India. While GST is charged they can't make new payments, and their renewals are charged IGST.`,
    );
  }
  return lines;
}

/** The impact table's "Paid how" for one renewal. */
export function impactPaidHow(route: CollectionRoute): string {
  if (route.auto) return "Automatically";
  switch (route.reason) {
    case "over_mandate":
      return "By hand: above autopay limit";
    case "over_afa_limit":
      return `By hand: above ${R(AFA_EXEMPT_PAISE)}`;
    case "no_mandate":
      return "By hand: no autopay";
  }
}

/** The impact table's "State on invoices" for one store. */
export function impactStateOnInvoices(
  placeOfSupply: PlaceOfSupply,
  countryName: string | null,
): string {
  const { code, basis } = placeOfSupply;
  const name = stateNameOf(code);
  const from = (source: string) => (name ? `${name} (${source})` : "None");
  switch (basis) {
    case "gstin":
      return from("GSTIN");
    case "billing_state":
      return from("Billing details");
    case "store_gstin":
    case "store_tax_state":
      return from("Taxes & invoices");
    case "location_gstin":
    case "location_state":
      return from("location");
    case "store_address":
      return from("from typed address");
    case "signup_address":
      return from("older signup");
    case "supplier_state":
      return name ? `None: ${name} used` : "None";
    case "outside_india": {
      const country = countryName?.trim();
      return country ? `Outside India: ${country}` : "Outside India";
    }
    case "unknown":
      return "None";
  }
}

/**
 * Under the impact table when more renewals were read than it shows
 * (`truncated`): `shown` is the number of rows in the table, which lists the
 * renewals needing a person first.
 */
export function impactTruncatedNote(shown: number): string {
  return shown === 1
    ? "Showing the 1 renewal that needs a look first."
    : `Showing the ${shown} renewals that need a look first.`;
}

/**
 * The warning before saving a change while stores have no state or are
 * outside India; null when neither.
 */
export function impactWarning(
  noState: number,
  outsideIndia: number,
): string | null {
  const wait =
    "You can still schedule this; consider waiting until more of them have added a state.";
  if (noState > 0 && outsideIndia > 0) {
    return `${count(noState, "store has", "stores have")} no state on record and ${outsideIndia} ${outsideIndia === 1 ? "is" : "are"} outside India. ${wait}`;
  }
  if (noState > 0) {
    return `${count(noState, "store has", "stores have")} no state on record. ${wait}`;
  }
  if (outsideIndia > 0) {
    return `${count(outsideIndia, "store is", "stores are")} outside India. You can still schedule this.`;
  }
  return null;
}

/** What the three tax saves refuse, word for word (design 5.8). */
export const TAX_SETTINGS_REFUSAL = {
  sacShape: "The SAC code is 6 digits starting with 99, for example 998314.",
  llpinShape:
    "An LLPIN looks like ADC-5432: three letters, a hyphen and four digits.",
  prefix:
    "Use 1 or 2 letters or digits, so invoice numbers stay within the 16 characters GST allows.",
  enableWithoutSac:
    "Add the SAC code before switching GST on. It is printed on every tax invoice.",
  enableWithoutAddress:
    "Add the registered address and PIN before switching GST on. They are printed on every tax invoice.",
  enableWithoutLlp:
    "Add the LLPIN and the registered office before switching GST on. The law asks for them on every invoice.",
  clearIdentityWhileOn:
    "GST is on or scheduled, so the GSTIN, state, legal name, SAC code, address, PIN, LLPIN and registered office can't be removed. Switch GST off first.",
  startTooClose:
    "Pick a start at least 5 minutes from now. Invoices already issued never change.",
  /** `scheduleTaxChange` with a start more than 400 days ahead (usually a typo in the year). */
  startTooFar:
    "Pick a start within 400 days of now. A date further out is usually a typo in the year.",
  /** `saveTaxIdentity` with an LLPIN but no registered legal name. */
  llpinWithoutLegalName:
    "Add the registered legal name with the LLPIN. The invoice's LLP line names it.",
  riseNow:
    "This raises what merchants pay, so it can't start now. Schedule it at least 1 month after you email them.",
  riseWithoutNotice:
    "This raises what merchants pay, so it needs at least 1 month's notice. Send an Operational notice by email to all store owners from Announcements, then choose it here.",
  /** Only once the Terms cover a law-set rate rise. */
  rateRiseNotConfirmed:
    "A higher rate raises bills when prices exclude GST. Tick that the law changed the rate, or schedule it with notice.",
  cancelAfterStart:
    "This change has already started. To stop charging GST, choose Don't charge GST under Charging GST.",
  /** `scheduleTaxChange` switching GST on with no GSTIN saved. */
  enableWithoutGstin:
    "Add the GSTIN before switching GST on. An invoice that charges GST without one isn't a valid tax invoice.",
  /** `scheduleTaxChange` switching GST on with no state saved. */
  enableWithoutState:
    "Add the state before switching GST on. It decides whether invoices show CGST and SGST, or IGST.",
  /** `scheduleTaxChange` switching GST on with no legal name saved. */
  enableWithoutLegalName:
    "Add the registered legal name before switching GST on. It is the name the invoice is issued by.",
  /** `scheduleTaxChange` with neither "Now" nor "From a date and time". */
  whenMissing: "Choose when the change starts.",
  /** A GST rate outside 0 to 100. */
  rateRange: "Enter a tax rate between 0 and 100.",
} as const;

/** "This can start on {date} at the earliest: 1 month after the notice went out on {sent date}." */
export function tooSoonAfterNotice(earliest: string, sentAt: string): string {
  return `This can start on ${istLongDateTime(earliest)} at the earliest: 1 month after the notice went out on ${istLongDateTime(sentAt)}.`;
}

/**
 * Card 4, the monthly list of every invoice for the GST returns (design 6.6,
 * superadmin only). The design's card title used the old POS word, which the
 * POS wording rule keeps out of product text, so it is "Monthly invoice list".
 */
export const INVOICE_LIST_CARD = {
  title: "Monthly invoice list",
  body: "Every invoice StoreMink issued in a month, with GSTINs, place of supply, SAC and the GST split, for your accountant's GST returns.",
  download: "Download CSV",
  preparing: "Preparing…",
  failed: "Couldn't prepare the invoice list. Please try again.",
  /** The month holds more rows than one download may carry (a cap against memory, not a GST rule). */
  tooMany:
    "This month has more invoices than one download can hold. Ask an engineer to export it in parts.",
} as const;

/** The CSV's header row and fixed values (design 5.13). */
export const INVOICE_LIST_CSV = {
  columns: [
    "Invoice number",
    "Date",
    "Type",
    "Customer name",
    "Customer GSTIN",
    "Place of supply",
    "Place of supply basis",
    "SAC",
    "Taxable value",
    "CGST",
    "SGST",
    "IGST",
    "Total",
    "Status",
    "Store",
  ],
  taxInvoice: "Tax invoice",
  invoice: "Invoice",
  creditNote: "Credit note",
  deletedStore: "deleted store",
} as const;

/** "storemink-invoices-2026-12.csv". */
export function invoiceListFileName(month: string): string {
  return `storemink-invoices-${month}.csv`;
}

/** "December 2026" for "2026-12"; anything else is returned as given. */
export function istMonthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return month;
  // Mid-month, midday: the same month in every zone.
  return new Date(
    Date.UTC(Number(m[1]), monthIndex, 15, 12),
  ).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: IST,
  });
}

/**
 * The month select: the current month in India time and the `previous`
 * months before it, newest first, as `{ value: "2026-12", label: "December
 * 2026" }`.
 */
export function recentIstMonths(
  now: Date,
  previous: number,
): { value: string; label: string }[] {
  if (Number.isNaN(now.getTime())) return [];
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    timeZone: IST,
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i <= Math.max(0, previous); i++) {
    const index = year * 12 + (month - 1) - i;
    const value = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
    out.push({ value, label: istMonthLabel(value) });
  }
  return out;
}

// ── Renewal-cancel's refund switch and the repair queue (plan A2, A4.6) ────

/**
 * `savePlatformAutoRefunds` when the settings row fails a CHECK (SQLSTATE
 * 23514): the GST identity CHECKs judge the whole row on every update.
 */
export const AUTO_REFUNDS_IDENTITY_INCOMPLETE =
  "Couldn't save this switch: StoreMink's tax identity is incomplete. Save StoreMink's tax identity first, then try again.";

/**
 * The reconciliation item the repair pass files for a payment captured
 * behind an invoice that was still a draft (`detail.repair_key` prefix
 * `captured_draft`): the queue's title and hint, and the item's detail.
 */
export const CAPTURED_DRAFT_REPAIR = {
  title: "Payment captured before its invoice was issued",
  hint: "The invoice is now issued and paid. Check that the plan, plan change or location the merchant paid for was applied, then close this with what you did.",
  detail:
    "Payment captured against an invoice that was still a draft. The invoice is now issued. Check that the plan, plan change or location the merchant paid for was applied.",
} as const;

/**
 * The reconciliation item `issueInvoice` files when a draft whose total a
 * payment had already fixed is issued with the GST it was priced with, not the
 * GST in force (`detail.repair_key` prefix `kept_draft`, R1-03). The item's
 * own note names both; the queue shows it under this hint.
 */
export const KEPT_DRAFT_REPAIR = {
  title: "Invoice issued with the GST it was priced with",
  hint: "A payment had already fixed this invoice's total, so it kept the GST it was priced with. The note gives that GST and the GST in force. If the merchant paid more than they owe, refund the difference with Issue a refund, which issues its credit note. Then close this with what you did.",
} as const;
