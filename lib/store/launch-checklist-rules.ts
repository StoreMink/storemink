// ---------------------------------------------------------------------------
// The go-live checklist — the RULES, pure and client-safe.
//
// A store opens to the public (lib/store/launch-state.ts) only once every
// REQUIRED item here is done. The facts are gathered by the server half
// (lib/store/launch-checklist.ts) and the decision is made here, so the
// dashboard card, the Go live action and the tests all judge the same store
// the same way.
//
// ★★ EVERY ITEM IS A PREDICATE OVER REAL ROWS, NEVER A TICK BOX. A checkbox a
// merchant can tick is a control that lies: "I have a refund policy" is only
// true when /refund-policy renders one. So nothing here is stored; it is
// recomputed from the store's own data every time it is asked.
//
// ★ REQUIRED means a shop that goes public without it will hurt either the
// merchant or a shopper on the first order — nothing to buy, no address on the
// invoice, no refund terms to point at. RECOMMENDED is everything that makes
// the shop better and nothing a shopper is harmed by the absence of. The split
// is deliberate: a Free store must be able to go live, and Free has no online
// payments, so "connect Razorpay" cannot be required or no Free store ever
// opens.
// ---------------------------------------------------------------------------

import type { Plan } from "@/lib/plans";
import { PLAN_LIMITS } from "@/lib/plans";

export interface LaunchFacts {
  plan: Plan;
  /** Published products that are not theme samples. */
  publishedProducts: number;
  /** Theme sample products still in the catalogue (drafts or published). */
  sampleProducts: number;
  business: {
    name: boolean;
    address: boolean;
    email: boolean;
    phone: boolean;
  };
  /** Policy slug → a non-empty body is published at that URL. */
  policies: Record<string, boolean>;
  /** The merchant has saved Shipping & delivery at least once. */
  shippingSaved: boolean;
  /** The homepage has been edited since the theme seeded it. */
  homepageEdited: boolean;
  logo: boolean;
  /** A payment gateway is connected and switched on. */
  paymentsConnected: boolean;
  gstin: boolean;
  customDomainLive: boolean;
}

export interface LaunchChecklistItem {
  key: string;
  title: string;
  /** One sentence: what to do, and why it matters, in the merchant's words. */
  description: string;
  /** Where to do it. */
  href: string;
  required: boolean;
  done: boolean;
}

export interface LaunchChecklist {
  items: LaunchChecklistItem[];
  requiredDone: number;
  requiredTotal: number;
  /** Every required item is done, so Go live may be pressed. */
  ready: boolean;
  /** Titles of the required items still outstanding, for the refusal. */
  missing: string[];
}

/** The four policies the storefront footer links and checkout names. Kept in
 *  step with lib/legal/store-policies.ts by `launch-checklist-rules.test.ts`;
 *  the registry itself is not imported here so this module stays free of
 *  everything but lib/plans. */
export const LAUNCH_POLICY_SLUGS = [
  "terms",
  "refund-policy",
  "shipping-policy",
  "privacy-policy",
] as const;

const POLICY_TITLES: Record<(typeof LAUNCH_POLICY_SLUGS)[number], string> = {
  terms: "Publish your Terms & Conditions",
  "refund-policy": "Publish your Refund & Cancellation Policy",
  "shipping-policy": "Publish your Shipping Policy",
  "privacy-policy": "Publish your Privacy Policy",
};

const POLICY_WHY: Record<(typeof LAUNCH_POLICY_SLUGS)[number], string> = {
  terms:
    "Checkout asks every shopper to accept these before paying, so there has to be something to accept.",
  "refund-policy":
    "Shoppers see this before they pay and whenever they ask for a return. Indian e-commerce rules require it.",
  "shipping-policy":
    "Where you deliver or how customers collect, how long it takes and what it costs.",
  "privacy-policy":
    "You collect names, phone numbers and addresses the moment the first order arrives.",
};

export function evaluateLaunchChecklist(facts: LaunchFacts): LaunchChecklist {
  const limits = PLAN_LIMITS[facts.plan];
  const businessDone =
    facts.business.name &&
    facts.business.address &&
    facts.business.email &&
    facts.business.phone;

  const items: LaunchChecklistItem[] = [
    {
      key: "products",
      title: "Add your first product",
      description:
        "Publish at least one product of your own. Theme samples don't count — they're drafts your customers never see.",
      href: "/dashboard/products",
      required: true,
      done: facts.publishedProducts > 0,
    },
    {
      key: "business",
      title: "Complete your business details",
      description:
        "Your trading name, address, email and mobile print on every invoice and decide how tax is applied.",
      href: "/dashboard/billing",
      required: true,
      done: businessDone,
    },
    ...LAUNCH_POLICY_SLUGS.map((slug) => ({
      key: `policy:${slug}`,
      title: POLICY_TITLES[slug],
      description: POLICY_WHY[slug],
      href: "/dashboard/settings/policies",
      required: true,
      done: facts.policies[slug] === true,
    })),
    {
      key: "shipping",
      title: "Set your delivery charges",
      description:
        "Decide what customers pay for delivery and how long it takes. Until you save this, checkout shows a default nobody chose.",
      href: "/dashboard/settings/shipping",
      required: true,
      done: facts.shippingSaved,
    },
    {
      key: "homepage",
      title: "Personalise your homepage",
      description:
        "Your homepage still shows the theme's starting copy and pictures. Make it yours in the Website Builder.",
      href: "/dashboard/builder",
      required: false,
      done: facts.homepageEdited,
    },
    {
      key: "logo",
      title: "Upload your logo",
      description:
        "It shows in your header, on invoices and in every email your store sends.",
      href: "/dashboard/branding",
      required: false,
      done: facts.logo,
    },
    {
      key: "samples",
      title: "Remove the sample products",
      description:
        "The theme's example products are still in your catalogue as drafts. Delete them so they can't be published by mistake.",
      href: "/dashboard/products",
      required: false,
      done: facts.sampleProducts === 0,
    },
    {
      key: "payments",
      title: limits.onlinePayments
        ? "Accept online payments"
        : "Accept online payments (Basic plan and above)",
      description: limits.onlinePayments
        ? "Cash on Delivery already works. Connect your own Razorpay account to take cards and UPI too."
        : "Cash on Delivery already works. Upgrade to take cards and UPI through your own Razorpay account.",
      href: limits.onlinePayments ? "/dashboard/channels" : "/dashboard/plans",
      required: false,
      done: facts.paymentsConnected,
    },
    {
      key: "gst",
      title: "Add your GSTIN",
      description:
        "Only if you're registered. It prints on invoices and lets business customers claim input credit.",
      href: "/dashboard/billing",
      required: false,
      done: facts.gstin,
    },
    {
      key: "domain",
      title: limits.customDomain
        ? "Connect your own domain"
        : "Connect your own domain (Pro plan)",
      description: limits.customDomain
        ? "Serve your shop on a domain you own instead of your StoreMink address."
        : "Serve your shop on a domain you own. Available on Pro.",
      href: limits.customDomain
        ? "/dashboard/settings/domain"
        : "/dashboard/plans",
      required: false,
      done: facts.customDomainLive,
    },
  ];

  const required = items.filter((i) => i.required);
  const missing = required.filter((i) => !i.done).map((i) => i.title);
  return {
    items,
    requiredDone: required.length - missing.length,
    requiredTotal: required.length,
    ready: missing.length === 0,
    missing,
  };
}
