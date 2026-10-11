// What an exchange settles to (docs/returns-exchanges-plan.md §4).
//
// PURE. An exchange is a return plus a new order, and the only genuinely new
// arithmetic is "who owes whom, and how much" — which is worth having in one
// tested place, because getting it backwards means either billing a customer
// for a swap they were told was free or giving stock away.
//
// ── The v1 boundary, stated once ───────────────────────────────────────────
// ★ A REPLACEMENT MAY NOT COST MORE THAN WHAT IS COMING BACK.
//
// "Customer owes the difference" is a payment collection flow, and there isn't
// one outside checkout: it needs either a Razorpay payment link, or an order
// left unpaid that somebody has to chase. Half-building that produces
// replacement orders sitting in `pending` forever, which is worse than not
// offering it — so a dearer swap is REFUSED at request time with a sentence
// telling the shopper to place a new order instead.
//
// This is not a permanent limit, and it is deliberately the arithmetic that
// decides it rather than a flag: the day a payment-link flow exists,
// `customerOwes` already carries the number to charge.
//
// The 80% case is a same-price size or colour swap, which settles to zero and
// needs none of that.

const toPaise = (n: number) => Math.round((Number(n) || 0) * 100);
const toRupees = (p: number) => Math.round(p) / 100;

export interface ExchangeSettlement {
  /** Value of the goods coming back — on the replacement's price basis. */
  returnValue: number;
  /** Value of the replacements, at their listed (snapshotted) price. */
  replacementValue: number;
  /** > 0 when the store must give money back on top of the swap. */
  storeOwes: number;
  /** > 0 when the replacement is dearer. Refused in v1 — see the header. */
  customerOwes: number;
  /** Nothing changes hands. The common case. */
  even: boolean;
  /** Whether this can be processed at all right now. */
  allowed: boolean;
  /** Why not, when it can't. Customer-facing. */
  blockedCopy: string | null;
}

/**
 * Settle a set of returned lines against their replacements.
 *
 * Both values must be on the SAME price basis: excluding tax in a store that
 * prices exclusive of it, including it in a store whose listed prices already
 * contain it (`returnRequestSettlement` picks the basis). Tax is recomputed on
 * the replacement order at its own class and today's rate, and refunded on the
 * returned lines from their stored snapshot — the two are not netted against
 * each other, because they are different transactions with the government
 * (§4.2).
 */
export function exchangeSettlement(input: {
  returnValue: number;
  replacementValue: number;
}): ExchangeSettlement {
  const backP = Math.max(0, toPaise(input.returnValue));
  const outP = Math.max(0, toPaise(input.replacementValue));
  const diff = outP - backP;

  const customerOwes = diff > 0 ? toRupees(diff) : 0;
  const storeOwes = diff < 0 ? toRupees(-diff) : 0;

  return {
    returnValue: toRupees(backP),
    replacementValue: toRupees(outP),
    storeOwes,
    customerOwes,
    even: diff === 0,
    allowed: customerOwes === 0,
    blockedCopy:
      customerOwes > 0
        ? `That costs ₹${customerOwes.toFixed(2)} more than what you're sending back. Place a new order for it instead - we'll refund this one.`
        : null,
  };
}

export interface ExchangeLineRequest {
  orderItemId: string;
  quantity: number;
  /** Omitted = refund this line rather than swap it. */
  exchangeVariantId?: string | null;
  exchangeProductId?: string | null;
}

/** True when any line asks for a swap — the difference between a return and
 *  an exchange, which is otherwise the same object. */
export function isExchange(lines: ExchangeLineRequest[]): boolean {
  return lines.some((l) => Boolean(l.exchangeVariantId || l.exchangeProductId));
}

/** One priced line of a return request — a `refundBreakdown` line. */
export interface SettlementLine {
  id: string;
  /** Goods value, excluding tax. */
  amount: number;
  tax: number;
  /** What going back for this line costs the store: amount + tax. */
  total: number;
}

export interface ReturnRequestSettlement {
  /** The swap half, settled by `exchangeSettlement` over SWAPPED lines only. */
  settlement: ExchangeSettlement;
  /** True when at least one line is being swapped rather than refunded. */
  swapping: boolean;
  /** Σ total (tax included) of the lines being REFUNDED. */
  refundedTotal: number;
  /** What the swapped lines are worth, on the same price basis as the
   *  replacement (see the `taxInclusive` note on `returnRequestSettlement`). */
  swappedValue: number;
  /** What the store owes after fees — what the queue prints and the email
   *  quotes. Never negative. */
  owed: number;
}

/**
 * What a return request — possibly MIXED, some lines swapped and some
 * refunded — leaves the store owing.
 *
 * ★★ THE TWO HALVES SETTLE DIFFERENTLY, AND ONE FORMULA FOR BOTH WAS WRONG.
 * `requestReturn` used to compare the goods value of EVERY line against the
 * replacements, so a refunded line contributed its goods but never its tax: a
 * ₹1,000 + ₹180 tax line sent back for a refund beside an even swap of another
 * line stored ₹1,000 owed instead of ₹1,180. So:
 *
 *   • a REFUNDED line owes everything that was paid for it, tax included —
 *     exactly what a plain return of that line would owe;
 *   • a SWAPPED line owes only what its replacement costs LESS than it — the
 *     tax on it is not handed back, because it pays the replacement's.
 *
 *   owed = refundedTotal + max(0, swappedValue − replacementValue) − fees
 *
 * ★ "A REPLACEMENT MAY NOT COST MORE" IS JUDGED AGAINST THE SWAPPED LINES
 * ALONE. Comparing a dearer replacement against the refunded lines too would
 * let a refund silently pay for an upgrade that nobody priced, and the
 * `max(0, …)` above would then give the difference away. Refused instead, with
 * `exchangeSettlement`'s own sentence.
 *
 * ★ `taxInclusive` decides the swap's price basis. A variant's listed price is
 * tax-INCLUSIVE in an inclusive store and tax-EXCLUSIVE otherwise, so the
 * swapped line is valued the same way — its paid total (inclusive) or its
 * goods value (exclusive). Comparing an inclusive shelf price against a
 * net-of-tax goods value would refuse every like-for-like swap in an inclusive
 * store for "costing more" by exactly the tax.
 *
 * PURE: the server settles with it and a client estimate can call it too, so
 * the two cannot disagree.
 */
export function returnRequestSettlement(input: {
  lines: SettlementLine[];
  /** Per line id: the replacement's value (unit price × quantity) when that
   *  line is swapped. Absent or null = the line is refunded. */
  replacementValueByLine: ReadonlyMap<string, number | null | undefined>;
  taxInclusive?: boolean;
  /** Policy deductions (restocking fee, return postage) — already capped at
   *  the goods value by `feesFor`. */
  deduction?: number;
}): ReturnRequestSettlement {
  const taxInclusive = input.taxInclusive === true;
  let refundedP = 0;
  let swappedP = 0;
  let replacementP = 0;
  let swapping = false;

  for (const line of input.lines) {
    const replacement = input.replacementValueByLine.get(line.id);
    if (replacement === null || replacement === undefined) {
      refundedP += Math.max(0, toPaise(line.total));
      continue;
    }
    swapping = true;
    swappedP += Math.max(0, toPaise(taxInclusive ? line.total : line.amount));
    replacementP += Math.max(0, toPaise(replacement));
  }

  const settlement = exchangeSettlement({
    returnValue: toRupees(swappedP),
    replacementValue: toRupees(replacementP),
  });
  const owedP = Math.max(
    0,
    refundedP +
      toPaise(settlement.storeOwes) -
      Math.max(0, toPaise(input.deduction ?? 0)),
  );

  return {
    settlement,
    swapping,
    refundedTotal: toRupees(refundedP),
    swappedValue: toRupees(swappedP),
    owed: toRupees(owedP),
  };
}
