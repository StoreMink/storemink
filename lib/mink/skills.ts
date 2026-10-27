/**
 * Mink's built-in skills: the saved prompts behind the composer's "/" menu
 * and the starter chips on an empty conversation.
 *
 * ★ PURE AND CLIENT-SAFE. The dashboard layout filters this list by the
 * viewer's permissions on the server and hands the result to the chat
 * provider, so the browser never holds a permission map; the composer only
 * ever sees the skills this admin may run. A skill is a prompt, never an
 * action: sending one goes through the ordinary run, where every tool is
 * permission-checked again.
 *
 * ★ EACH SKILL NAMES THE SECTION IT NEEDS, using the same keys the dashboard
 * navigation is gated on (app/dashboard/lib/permissions.ts), so a merchant is
 * never offered "/low-stock" on a role that cannot open Inventory.
 */
export interface MinkSkill {
  id: string;
  /** The word typed after "/", without the slash. */
  slash: string;
  label: string;
  description: string;
  /** What is placed in the composer when the skill is chosen. */
  prompt: string;
  section: string;
  action: "view" | "manage";
  /** Dashboard path prefixes where this skill is a starter chip. */
  starterOn?: string[];
}

export const MINK_SKILLS: readonly MinkSkill[] = [
  {
    id: "whats-new",
    slash: "whats-new",
    label: "What's new?",
    description: "Sales, orders and anything that needs attention",
    prompt:
      "What's new in my store? Summarise recent sales and orders, and anything that needs my attention.",
    section: "dashboard",
    action: "view",
    starterOn: ["/dashboard"],
  },
  {
    id: "sales-today",
    slash: "sales-today",
    label: "Sales today",
    description: "Today against the same day last week",
    prompt:
      "How are sales today compared with the same day last week? Include orders and average order value.",
    section: "analytics",
    action: "view",
    starterOn: ["/dashboard", "/dashboard/analytics", "/dashboard/orders"],
  },
  {
    id: "weekly-summary",
    slash: "weekly-summary",
    label: "Weekly summary",
    description: "Last 7 days against the previous 7",
    prompt:
      "Give me a weekly performance summary: sales, orders, average order value and top products for the last 7 days compared with the previous 7 days.",
    section: "analytics",
    action: "view",
    starterOn: ["/dashboard/analytics"],
  },
  {
    id: "low-stock",
    slash: "low-stock",
    label: "Low stock",
    description: "What is running out, by location",
    prompt:
      "Which products are low on stock or out of stock right now? Show it by location where I have more than one.",
    section: "inventory",
    action: "view",
    starterOn: ["/dashboard/inventory", "/dashboard/products", "/dashboard"],
  },
  {
    id: "pending-orders",
    slash: "pending-orders",
    label: "Pending orders",
    description: "Orders still waiting, oldest first",
    prompt:
      "Which orders are still pending or processing, and which have been waiting longest?",
    section: "orders",
    action: "view",
    starterOn: ["/dashboard/orders", "/dashboard"],
  },
  {
    // ★ THE PRODUCT EDITOR HAS NO SCENE FORM (owner, 2026-10-18): a product in
    //   a setting is asked for here, the way Sidekick does it. The chip lets
    //   Mink pick a scene that suits the item; the merchant can then say what
    //   to change ("now on a model", "make it a close-up") in the same chat.
    id: "product-photo",
    slash: "product-photo",
    label: "Photo in a scene",
    description: "A new photo of the product you have open, in a setting",
    prompt:
      "Make a new photo of this product in a lifestyle scene that suits it, keeping the product exactly as it is. If no product is open, ask me which one.",
    section: "media",
    action: "manage",
    starterOn: ["/dashboard/products/"],
  },
  {
    id: "product-description",
    slash: "product-description",
    label: "Product description",
    description: "Write copy for the product you have open",
    prompt:
      "Write a product description for this product in my brand voice. If no product is open, ask me which one.",
    section: "products",
    action: "manage",
    starterOn: ["/dashboard/products/"],
  },
  {
    id: "seo",
    slash: "seo",
    label: "SEO title and description",
    description: "Search-friendly metadata for a product",
    prompt:
      "Draft an SEO title and meta description for this product. If no product is open, ask me which one.",
    section: "products",
    action: "manage",
    starterOn: ["/dashboard/products/"],
  },
  {
    id: "discount",
    slash: "discount",
    label: "Set up a discount",
    description: "Draft a coupon for an offer you describe",
    prompt:
      "Help me set up a discount. Ask me what the offer should be, then draft the coupon for my review.",
    section: "marketing",
    action: "manage",
    starterOn: ["/dashboard/offers"],
  },
  {
    id: "email-campaign",
    slash: "email-campaign",
    label: "Email campaign",
    description: "A coupon email to your customers",
    prompt:
      "Draft a coupon email campaign for my customers. Ask me which coupon to use if there are several.",
    section: "marketing",
    action: "manage",
    starterOn: ["/dashboard/offers"],
  },
  {
    id: "blog-post",
    slash: "blog-post",
    label: "Blog post",
    description: "A draft article in your brand voice",
    prompt:
      "Draft a blog post for my store. Check my existing posts first and ask me for the topic if you need it.",
    section: "blogs",
    action: "manage",
    starterOn: ["/dashboard/blogs"],
  },
  {
    id: "launch-check",
    slash: "launch-check",
    label: "Launch check",
    description: "Is a product ready to sell?",
    prompt:
      "Run a product launch readiness check. Ask me which SKU if I have not named one.",
    section: "products",
    action: "view",
    starterOn: ["/dashboard/products"],
  },
  {
    id: "pricing-review",
    slash: "pricing-review",
    label: "Pricing review",
    description: "Prices that could be working harder",
    prompt:
      "Review my product prices and suggest changes that could boost sales. Explain each suggestion before proposing any update.",
    section: "products",
    action: "view",
  },
  {
    id: "shipping-audit",
    slash: "shipping-audit",
    label: "Shipping audit",
    description: "Anything that could block a checkout",
    prompt:
      "Audit my shipping settings and tell me anything that could stop a customer completing checkout or surprise them with the delivery charge.",
    section: "settings",
    action: "view",
    starterOn: ["/dashboard/settings/shipping"],
  },
  {
    id: "social-posts",
    slash: "social-posts",
    label: "Social posts",
    description: "Captions for a product or offer",
    prompt:
      "Create social media posts for my products. Ask me which product or offer to feature if I have not said.",
    section: "marketing",
    action: "manage",
  },
  {
    id: "personalise-store",
    slash: "personalise",
    label: "Customise my store",
    description: "Redesign the pages, photos and products shoppers see",
    prompt: "Customise my store for my business",
    section: "builder",
    action: "manage",
    starterOn: ["/dashboard/storefront", "/dashboard/builder"],
  },
  {
    id: "homepage-review",
    slash: "homepage",
    label: "Homepage review",
    description: "What to improve on your homepage",
    prompt:
      "Review my homepage and suggest improvements I can apply in the Website Builder.",
    section: "builder",
    action: "manage",
    starterOn: ["/dashboard/builder", "/dashboard/storefront"],
  },
];

/** The skills a viewer may run, in catalogue order. */
export function minkSkillsFor(
  allowed: (section: string, action: "view" | "manage") => boolean,
): MinkSkill[] {
  return MINK_SKILLS.filter((skill) => allowed(skill.section, skill.action));
}

/**
 * The query typed after "/", or null when the composer is not in slash mode.
 * Slash mode is a message that STARTS with "/" and has no line break: a URL
 * path pasted mid-sentence must not open the menu.
 */
export function minkSlashQuery(input: string): string | null {
  if (!input.startsWith("/") || input.includes("\n")) return null;
  const query = input.slice(1);
  if (query.length > 40 || /\s/.test(query)) return null;
  return query.toLowerCase();
}

/** Skills whose slash, label or description matches the typed prefix. */
export function matchMinkSkills(
  skills: readonly MinkSkill[],
  query: string,
): MinkSkill[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...skills];
  const starts = skills.filter((skill) => skill.slash.startsWith(needle));
  const words = skills.filter(
    (skill) =>
      !starts.includes(skill) &&
      (skill.slash.includes(needle) ||
        skill.label.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle)),
  );
  return [...starts, ...words];
}

/**
 * Up to four starter chips for an empty conversation, led by the skills that
 * name the page the merchant is on, then the catalogue's first general ones.
 */
export function minkStarterSkills(
  skills: readonly MinkSkill[],
  currentPath: string | null | undefined,
  limit = 4,
): MinkSkill[] {
  const path = (currentPath ?? "").split("?")[0];
  // The most specific page prefix wins: on a product's own page its copy
  // skills come before the catalogue-wide ones that also match /products.
  const specificity = (skill: MinkSkill) =>
    Math.max(
      0,
      ...(skill.starterOn ?? [])
        .filter(
          (prefix) =>
            prefix !== "/dashboard" &&
            (path === prefix.replace(/\/$/, "") || path.startsWith(prefix)),
        )
        .map((prefix) => prefix.length),
    );
  const scoped = skills
    .map((skill, index) => ({ skill, index, depth: specificity(skill) }))
    .filter((entry) => entry.depth > 0)
    .sort((a, b) => b.depth - a.depth || a.index - b.index)
    .map((entry) => entry.skill);
  const general = skills.filter(
    (skill) =>
      !scoped.includes(skill) && (skill.starterOn ?? []).includes("/dashboard"),
  );
  return [...scoped, ...general].slice(0, limit);
}
