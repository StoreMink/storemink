/**
 * The dashboard controls Mink can point at: "show me where I change the
 * delivery rate" opens the page and draws a ring around the control.
 *
 * ★ A CLOSED REGISTRY, CLIENT-SAFE AND PURE. The model names a key, never a
 * selector; the page each key lives on is a navigation destination the tool
 * permission-checks like any other; and the control is found at runtime by
 * a `data-mink-target` hook first, then by its visible label, so a label
 * change here is a one-line fix rather than a silent miss.
 */
export interface MinkGuideTarget {
  /** The navigation destination (lib/mink/tools/navigation-tools.ts) the control lives on. */
  destination: string;
  /** What the control is, in merchant words. */
  label: string;
  /** What pressing it does, shown beside the ring. */
  hint: string;
  /** Case-insensitive pattern for the control's visible text or label. */
  text: string;
  /** Narrow the candidates: a button or link, or a form control by its label. */
  role: "button" | "control";
}

export const MINK_GUIDE_TARGETS = {
  add_product: {
    destination: "products",
    label: "New product",
    hint: "Opens the product form.",
    text: "^new product$",
    role: "button",
  },
  create_offer: {
    destination: "offers",
    label: "New offer",
    hint: "Starts a discount, coupon or automatic offer.",
    text: "^new offer$",
    role: "button",
  },
  add_category: {
    destination: "categories",
    label: "New category",
    hint: "Adds a storefront collection.",
    text: "^new category$",
    role: "button",
  },
  write_blog_post: {
    destination: "blogs",
    label: "New blog",
    hint: "Opens the blog editor.",
    text: "^new blog",
    role: "button",
  },
  invite_staff: {
    destination: "staff",
    label: "Invite user",
    hint: "Sends a dashboard or POS invitation by email.",
    text: "^invite",
    role: "button",
  },
  go_live: {
    destination: "home",
    label: "Go live",
    hint: "Opens the store to shoppers once every required task is done.",
    text: "^go live$",
    role: "button",
  },
  edit_dashboard: {
    destination: "analytics",
    label: "Edit dashboard",
    hint: "Add, remove and reorder analytics cards.",
    text: "^edit dashboard",
    role: "button",
  },
  upload_media: {
    destination: "media",
    label: "Upload",
    hint: "Adds images to the Media Library.",
    text: "upload",
    role: "button",
  },
  connect_payments: {
    destination: "channels",
    label: "Connect Razorpay",
    hint: "Connects the store's own Razorpay account for online payments.",
    text: "^(connect|verify|set up)",
    role: "button",
  },
  use_theme: {
    destination: "storefront",
    label: "Use this theme",
    hint: "Installs a theme from the library.",
    text: "^use this theme$",
    role: "button",
  },
  customize_storefront: {
    destination: "storefront",
    label: "Customise storefront",
    hint: "Asks a few questions, then Mink AI redesigns the storefront in a new chat.",
    text: "^customi[sz]e storefront$",
    role: "button",
  },
  add_location: {
    destination: "locations",
    label: "Add location",
    hint: "Adds a shop or warehouse.",
    text: "^add location$",
    role: "button",
  },
  shipping_rate_mode: {
    destination: "shipping_settings",
    label: "Delivery rate",
    hint: "Pick free shipping, one fixed rate, or live Shiprocket rates.",
    text: "^(free shipping|fixed rate|live|shiprocket)",
    role: "button",
  },
  write_policy: {
    destination: "policies",
    label: "Save and publish",
    hint: "Saves the policy text and publishes its page.",
    text: "^save and publish$",
    role: "button",
  },
  generate_brand_voice: {
    destination: "branding",
    label: "Generate with AI",
    hint: "Writes the brand voice from your answers; review before saving.",
    text: "^generate with ai$",
    role: "button",
  },
} as const satisfies Record<string, MinkGuideTarget>;

export type MinkGuideTargetKey = keyof typeof MINK_GUIDE_TARGETS;
export const MINK_GUIDE_TARGET_KEYS = Object.keys(
  MINK_GUIDE_TARGETS,
) as MinkGuideTargetKey[];

export function isMinkGuideTarget(value: unknown): value is MinkGuideTargetKey {
  return typeof value === "string" && value in MINK_GUIDE_TARGETS;
}

export function minkGuideTarget(key: MinkGuideTargetKey): MinkGuideTarget {
  return MINK_GUIDE_TARGETS[key];
}

/** The artifact payload the tool returns and the panel acts on. */
export interface MinkHighlight {
  target: MinkGuideTargetKey;
  label: string;
  hint?: string;
}

export function readMinkHighlight(value: unknown): MinkHighlight | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isMinkGuideTarget(row.target)) return null;
  const known = MINK_GUIDE_TARGETS[row.target];
  const label =
    typeof row.label === "string" && row.label.trim() && row.label.length <= 80
      ? row.label.trim()
      : known.label;
  const hint =
    typeof row.hint === "string" && row.hint.trim() && row.hint.length <= 200
      ? row.hint.trim()
      : known.hint;
  return { target: row.target, label, hint };
}
