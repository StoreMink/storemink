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
//
// ★ FIVE REQUIRED TASKS, NOT NINE (owner, 2026-10-11). Nine rows read as a
// wall, so related requirements are GROUPED into one task with STEPS:
// business details + delivery charges are one task, the four policies are
// another. Grouping changes how the list reads and nothing about what it
// demands: each step is still its own predicate, a grouped task is done only
// when every step is, and the go-live refusal names the outstanding steps.
// ---------------------------------------------------------------------------

import type { Plan } from "@/lib/plans";
import { PLAN_LIMITS } from "@/lib/plans";

export interface LaunchFacts {
  plan: Plan;
  /** A store owner (superadmin) has proven their mobile with a texted code
   *  (admins.phone_verified_at). Signup no longer asks for it. */
  ownerPhoneVerified: boolean;
  /** The store has a storefront theme: `!isThemePending(store)`
   *  (lib/store/launch-state.ts). Signup installs none, and until one is
   *  chosen the storefront shows a "store in progress" page. */
  themeChosen: boolean;
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

/** One requirement inside a grouped task, judged on its own. */
export interface LaunchChecklistStep {
  key: string;
  /** Short, because the refusal lists it in brackets ("Privacy"). */
  title: string;
  done: boolean;
  href: string;
  action: string;
}

export interface LaunchChecklistItem {
  key: string;
  title: string;
  /** One sentence: what to do, and why it matters, in the merchant's words. */
  description: string;
  /** Where to do it. For a grouped task, the first unfinished step's page. */
  href: string;
  /** The button that goes there, in two or three words ("Add product"). */
  action: string;
  required: boolean;
  /** For a grouped task: true only when every step is. */
  done: boolean;
  /** Present on a grouped task: the requirements it is made of, in order. */
  steps?: LaunchChecklistStep[];
}

export interface LaunchChecklist {
  items: LaunchChecklistItem[];
  requiredDone: number;
  requiredTotal: number;
  /** Every required item is done, so Go live may be pressed. */
  ready: boolean;
  /** The required tasks still outstanding, for the refusal. A grouped task
   *  names its outstanding steps: "Publish your store policies (Privacy)". */
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

const POLICY_STEP_TITLES: Record<(typeof LAUNCH_POLICY_SLUGS)[number], string> =
  {
    terms: "Terms & Conditions",
    "refund-policy": "Refund & Cancellation",
    "shipping-policy": "Shipping",
    "privacy-policy": "Privacy",
  };

/** A grouped task, built from its steps so its tick, its link and its
 *  refusal can never disagree with them. */
function groupedTask(
  task: { key: string; title: string; description: string; action: string },
  steps: LaunchChecklistStep[],
): LaunchChecklistItem {
  const next = steps.find((s) => !s.done) ?? steps[0];
  // ★ Steps that share one page share one button ("Write policies"), so the
  // task's own action is kept; separate pages send the task button to the
  // first step still to do.
  const oneDestination = steps.every((s) => s.href === steps[0].href);
  return {
    ...task,
    href: next.href,
    action: oneDestination ? task.action : next.action,
    required: true,
    done: steps.every((s) => s.done),
    steps,
  };
}

/** How a required task is named when Go live is refused. */
function missingLabel(item: LaunchChecklistItem): string {
  const open = item.steps?.filter((s) => !s.done) ?? [];
  return open.length
    ? `${item.title} (${open.map((s) => s.title).join(", ")})`
    : item.title;
}

export function evaluateLaunchChecklist(facts: LaunchFacts): LaunchChecklist {
  const limits = PLAN_LIMITS[facts.plan];
  const businessDone =
    facts.business.name &&
    facts.business.address &&
    facts.business.email &&
    facts.business.phone;

  const items: LaunchChecklistItem[] = [
    {
      key: "phone",
      title: "Verify your mobile number",
      description:
        "We text a six-digit code to confirm a real person runs this store and that we can reach you about it. It takes a few seconds.",
      href: "/dashboard/settings/account?focus=phone",
      action: "Verify mobile",
      required: true,
      done: facts.ownerPhoneVerified,
    },
    {
      key: "theme",
      title: "Choose your storefront theme",
      description:
        "Until you pick one, your storefront shows a “store in progress” page. You can change it any time.",
      href: "/dashboard/storefront",
      action: "Choose a theme",
      required: true,
      done: facts.themeChosen,
    },
    {
      key: "products",
      title: "Add your first product",
      description:
        "Publish at least one product of your own. Theme samples don't count — they're drafts your customers never see.",
      href: "/dashboard/products",
      action: "Add product",
      required: true,
      done: facts.publishedProducts > 0,
    },
    groupedTask(
      {
        key: "business",
        title: "Add your business and delivery details",
        description:
          "Your trading name, address, email and mobile print on every invoice. Save your delivery charges once, or checkout shows a default nobody chose.",
        action: "Add business details",
      },
      [
        {
          key: "business:details",
          title: "Business details",
          done: businessDone,
          href: "/dashboard/billing",
          action: "Add business details",
        },
        {
          key: "business:delivery",
          title: "Delivery charges",
          done: facts.shippingSaved,
          href: "/dashboard/settings/shipping",
          action: "Set delivery charges",
        },
      ],
    ),
    groupedTask(
      {
        key: "policies",
        title: "Publish your store policies",
        description:
          "Shoppers can read all four before they pay. Checkout asks them to accept your terms, Indian e-commerce rules require a refund policy, and you hold their details from the first order.",
        action: "Write policies",
      },
      LAUNCH_POLICY_SLUGS.map((slug) => ({
        key: `policy:${slug}`,
        title: POLICY_STEP_TITLES[slug],
        done: facts.policies[slug] === true,
        href: "/dashboard/settings/policies",
        action: "Write policies",
      })),
    ),
    {
      key: "homepage",
      title: "Personalise your homepage",
      description:
        "Your homepage still shows the theme's starting copy and pictures. Pick the look you want under Storefront, then make it yours in the Website Builder.",
      href: "/dashboard/builder",
      action: "Open Website Builder",
      required: false,
      done: facts.homepageEdited,
    },
    {
      key: "logo",
      title: "Upload your logo",
      description:
        "It shows in your header, on invoices and in every email your store sends.",
      href: "/dashboard/branding",
      action: "Upload logo",
      required: false,
      done: facts.logo,
    },
    {
      key: "samples",
      title: "Remove the sample products",
      description:
        "The theme's example products are still in your catalogue as drafts. Delete them so they can't be published by mistake.",
      href: "/dashboard/products",
      action: "Review products",
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
      action: limits.onlinePayments ? "Connect Razorpay" : "See plans",
      required: false,
      done: facts.paymentsConnected,
    },
    {
      key: "gst",
      title: "Add your GSTIN",
      description:
        "Only if you're registered. It prints on invoices and lets business customers claim input credit.",
      href: "/dashboard/billing",
      action: "Add GSTIN",
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
      action: limits.customDomain ? "Connect domain" : "See plans",
      required: false,
      done: facts.customDomainLive,
    },
  ];

  const required = items.filter((i) => i.required);
  const missing = required.filter((i) => !i.done).map(missingLabel);
  return {
    items,
    requiredDone: required.length - missing.length,
    requiredTotal: required.length,
    ready: missing.length === 0,
    missing,
  };
}
