import { getPlanPricingLive } from "@/lib/plans/pricing";
import { getTaxTermsLive } from "@/lib/billing/platform-settings";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import { logError } from "@/lib/observability/logger";
import type { SignupPlanQuote } from "@/lib/plans/signup-quote";

/**
 * The signup wizard's Plan step is a client flow, but a price is server state.
 * Read it through a GET (not a Server Action) so this one-off query does not
 * enter Next's per-client mutation queue and can never delay a signup tap.
 *
 * `paidCheckout` says whether the platform can take a card at all (its own
 * Razorpay keys are configured). Without them the step offers Free only,
 * rather than a Pay button that can only fail.
 *
 * `tax` is the GST terms in force now, read LIVE (`getTaxTermsLive`), never
 * the cached public source the marketing pages read: a payment follows this
 * answer, and a cached "no GST" five minutes after GST started would quote
 * an amount the charge then disagrees with (GST design 7.2). A tax read that
 * fails is a 503 like a price read that fails: a guessed "no GST" is a wrong
 * quote, and the step then offers Free with Try again.
 */
export async function GET() {
  try {
    const [plans, tax] = await Promise.all([
      getPlanPricingLive(),
      getTaxTermsLive(),
    ]);
    const quote: SignupPlanQuote = {
      plans,
      paidCheckout: getPlatformRazorpayCreds() !== null,
      tax,
    };
    return Response.json(quote, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logError("signup pricing: live read failed", error);
    return Response.json(
      { error: "Current plan pricing is temporarily unavailable." },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
