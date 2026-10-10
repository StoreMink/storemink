import { getPlanPricingLive } from "@/lib/plans/pricing";
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
 */
export async function GET() {
  try {
    const plans = await getPlanPricingLive();
    const quote: SignupPlanQuote = {
      plans,
      paidCheckout: getPlatformRazorpayCreds() !== null,
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
