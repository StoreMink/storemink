import "server-only";

import { and, eq, or } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { orders, products } from "@/drizzle/schema";
import { withUser } from "@/lib/db/client";
import { MinkToolInputError } from "../errors";
import {
  minkPrefillPath,
  readMinkFormPrefill,
  readMinkPrefill,
  type MinkFormPrefill,
  type MinkPrefillKind,
} from "../form-prefill";
import {
  MINK_GUIDE_TARGETS,
  MINK_GUIDE_TARGET_KEYS,
  isMinkGuideTarget,
  readMinkHighlight,
  type MinkHighlight,
} from "../guide-targets";
import type { MinkActorContext, MinkArtifact } from "../types";
import type { MinkTool } from "./registry";

/**
 * `open_dashboard_page`: a link to a dashboard page in Mink's answer,
 * optionally to a form filled in from the conversation.
 *
 * ★★ A CLOSED LIST OF DESTINATIONS, NEVER A PATH FROM THE MODEL. Every entry
 * names the permission section that page is gated on, checked here against
 * the trusted actor before the path is returned, so "open the staff page"
 * on a role without that section is refused by this tool rather than by a
 * 403 the merchant lands on. A product or order is resolved by its own
 * identifier inside the trusted store; an unknown one is an error, never a
 * guessed path.
 *
 * ★ IT CHANGES NOTHING, AND IT NAVIGATES NOTHING. The result is a link card
 * the merchant clicks (the page never opens by itself, which on a phone used
 * to sweep them out of the chat mid-answer); a prefilled form is still saved
 * by the merchant, through the ordinary action, with every field validated as
 * if they had typed it (Sidekick's "fills the form, you approve" pattern).
 */
const DESTINATIONS = {
  home: {
    path: "/dashboard",
    label: "Home",
    section: "dashboard",
    action: "view",
  },
  products: {
    path: "/dashboard/products",
    label: "Products",
    section: "products",
    action: "view",
  },
  new_product: {
    path: "/dashboard/products/new",
    label: "New product",
    section: "products",
    action: "manage",
  },
  product: {
    path: "/dashboard/products",
    label: "Product",
    section: "products",
    action: "view",
  },
  orders: {
    path: "/dashboard/orders",
    label: "Orders",
    section: "orders",
    action: "view",
  },
  order: {
    path: "/dashboard/orders",
    label: "Order",
    section: "orders",
    action: "view",
  },
  inventory: {
    path: "/dashboard/inventory",
    label: "Inventory",
    section: "inventory",
    action: "view",
  },
  offers: {
    path: "/dashboard/offers",
    label: "Offers",
    section: "promotions",
    action: "view",
  },
  new_offer: {
    path: "/dashboard/offers/new",
    label: "New offer",
    section: "promotions",
    action: "manage",
  },
  blogs: {
    path: "/dashboard/blogs",
    label: "Blogs",
    section: "blogs",
    action: "view",
  },
  new_blog: {
    path: "/dashboard/blogs",
    label: "New blog post",
    section: "blogs",
    action: "manage",
  },
  categories: {
    path: "/dashboard/categories",
    label: "Categories",
    section: "categories",
    action: "view",
  },
  new_category: {
    path: "/dashboard/categories",
    label: "New category",
    section: "categories",
    action: "manage",
  },
  branding: {
    path: "/dashboard/branding",
    label: "Branding",
    section: "branding",
    action: "view",
  },
  customers: {
    path: "/dashboard/users",
    label: "Customers",
    section: "users",
    action: "view",
  },
  enquiries: {
    path: "/dashboard/enquiries",
    label: "Enquiries",
    section: "enquiries",
    action: "view",
  },
  inbox: {
    path: "/dashboard/inbox",
    label: "Inbox",
    section: "inbox",
    action: "view",
  },
  analytics: {
    path: "/dashboard/analytics",
    label: "Analytics",
    section: "analytics",
    action: "view",
  },
  live_view: {
    path: "/dashboard/analytics/live",
    label: "Live View",
    section: "analytics",
    action: "view",
  },
  reports: {
    path: "/dashboard/analytics/reports",
    label: "Reports",
    section: "analytics",
    action: "view",
  },
  media: {
    path: "/dashboard/media",
    label: "Media Library",
    section: "media",
    action: "view",
  },
  builder: {
    path: "/dashboard/builder",
    label: "Website Builder",
    section: "builder",
    action: "view",
  },
  storefront: {
    path: "/dashboard/storefront",
    label: "Storefront",
    section: "themes",
    action: "view",
  },
  shipping_settings: {
    path: "/dashboard/settings/shipping",
    label: "Shipping & delivery",
    section: "settings",
    action: "view",
  },
  domain_settings: {
    path: "/dashboard/settings/domain",
    label: "Domain",
    section: "settings",
    action: "view",
  },
  policies: {
    path: "/dashboard/settings/policies",
    label: "Policies",
    section: "settings",
    action: "view",
  },
  notifications_settings: {
    path: "/dashboard/settings/notifications",
    label: "Notifications",
    section: "notifications",
    action: "view",
  },
  taxes_and_invoices: {
    path: "/dashboard/billing",
    label: "Taxes & invoices",
    section: "billing",
    action: "view",
  },
  plans: {
    path: "/dashboard/plans",
    label: "Plans & Billing",
    section: "ai",
    action: "view",
  },
  channels: {
    path: "/dashboard/channels",
    label: "Channels",
    section: "channels",
    action: "view",
  },
  locations: {
    path: "/dashboard/locations",
    label: "Locations",
    section: "locations",
    action: "view",
  },
  staff: {
    path: "/dashboard/admins",
    label: "Staff",
    section: "admins",
    action: "view",
  },
  logs: {
    path: "/dashboard/logs",
    label: "Logs",
    section: "activity",
    action: "view",
  },
  memories: {
    path: "/dashboard/mink-memories",
    label: "Mink memories",
    section: "dashboard",
    action: "view",
  },
  watches: {
    path: "/dashboard/mink-watches",
    label: "Mink watches",
    section: "dashboard",
    action: "view",
  },
} as const;

export type MinkNavigationDestination = keyof typeof DESTINATIONS;
export const MINK_NAVIGATION_DESTINATIONS = Object.keys(
  DESTINATIONS,
) as MinkNavigationDestination[];

/** Destinations whose form Mink may fill in, and the prefill kind each takes. */
const PREFILL_KINDS: Partial<
  Record<MinkNavigationDestination, MinkPrefillKind>
> = {
  new_product: "product",
  new_offer: "offer",
  new_category: "category",
  new_blog: "blog",
  shipping_settings: "shipping",
};

// ★ Every spotlight target names a destination this file knows, checked at
// module load so a registry entry cannot point at a page the tool cannot
// permission-check.
for (const key of MINK_GUIDE_TARGET_KEYS) {
  const destination = MINK_GUIDE_TARGETS[key].destination;
  if (!(destination in DESTINATIONS)) {
    throw new Error(
      `Mink guide target ${key} names unknown destination ${destination}.`,
    );
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalText(value: unknown, field: string, max: number) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new MinkToolInputError(
      `${field} must be text between 1 and ${max} characters.`,
    );
  }
  return value.trim();
}

export const openDashboardPage: MinkTool = {
  declaration: {
    name: "open_dashboard_page",
    description:
      "Put a link to a dashboard page in your answer; the page opens only when the merchant clicks it. Use it when they ask to go to, open or take them to a page (for example 'open my orders', 'take me to shipping settings'), to link one exact product or order they named, to start a form already filled in from this conversation (new_product, new_offer, new_category, new_blog or shipping_settings with prefill), or, when they ask where a control is or how to find it ('where do I change the delivery rate'), with highlight set to the matching target so that control is pointed out once they open the page. Each destination needs the merchant's own permission for that page; a page they cannot open is refused. Never use it instead of answering a question, and never claim the page is open or that a form was changed: it only links the page, and the merchant reviews and saves any prefilled form themselves.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          enum: MINK_NAVIGATION_DESTINATIONS,
          description:
            "The page to open. 'product' needs product_id or product_sku; 'order' needs order_reference; new_product, new_offer, new_category, new_blog and shipping_settings may carry prefill. May be omitted when highlight is given.",
        },
        highlight: {
          type: "string",
          enum: MINK_GUIDE_TARGET_KEYS,
          description:
            "A control to point out on the page, for 'where is', 'show me how' or 'how do I' questions about that control. The page is opened and the control is ringed with a short note; explain any remaining steps in words.",
        },
        product_id: {
          type: "string",
          description:
            "Exact current-store product id, for destination 'product'.",
          maxLength: 40,
        },
        product_sku: {
          type: "string",
          description:
            "Exact current-store product or variant SKU, for destination 'product'.",
          maxLength: 60,
        },
        order_reference: {
          type: "string",
          description:
            "Exact order reference such as ORD100110006, for destination 'order'.",
          maxLength: 40,
        },
        prefill: {
          type: "object",
          description:
            "Fields to fill into the destination's form; the merchant reviews and saves it themselves, so nothing is created or changed by this tool. new_product: name, description, seo_title, seo_description, base_price, selling_price. new_offer: name, description, reward_type (percent_off | amount_off | free_shipping), reward_value, min_subtotal, delivery (automatic | code), code, budget, valid_until (YYYY-MM-DD). new_category: name, slug, description, status (active | hidden). new_blog: title, excerpt, body (plain text or Markdown), category, tags, seo_title, seo_description. shipping_settings: mode (free | flat | shiprocket), flat_rate, free_above (null clears it), manual_min_days, manual_max_days, handling_days. Only facts the merchant gave or a tool returned; never invent a price, date or claim.",
          properties: {
            name: { type: "string", maxLength: 200 },
            description: { type: "string", maxLength: 3000 },
            seo_title: { type: "string", maxLength: 70 },
            seo_description: { type: "string", maxLength: 180 },
            base_price: { type: "number", minimum: 0 },
            selling_price: { type: "number", minimum: 0 },
            reward_type: {
              type: "string",
              enum: ["percent_off", "amount_off", "free_shipping"],
            },
            reward_value: { type: "number", minimum: 0 },
            min_subtotal: { type: "number", minimum: 0 },
            delivery: { type: "string", enum: ["automatic", "code"] },
            code: { type: "string", maxLength: 100 },
            budget: { type: "number", minimum: 0 },
            valid_until: { type: "string", maxLength: 10 },
            slug: { type: "string", maxLength: 200 },
            status: { type: "string", enum: ["active", "hidden"] },
            title: { type: "string", maxLength: 200 },
            excerpt: { type: "string", maxLength: 500 },
            body: { type: "string", maxLength: 20000 },
            category: { type: "string", maxLength: 60 },
            tags: {
              type: "array",
              maxItems: 10,
              items: { type: "string", maxLength: 40 },
            },
            mode: { type: "string", enum: ["free", "flat", "shiprocket"] },
            flat_rate: { type: "number", minimum: 0 },
            free_above: { type: ["number", "null"], minimum: 0 },
            manual_min_days: { type: "integer", minimum: 0, maximum: 60 },
            manual_max_days: { type: "integer", minimum: 0, maximum: 60 },
            handling_days: { type: "integer", minimum: 0, maximum: 30 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  permission: { section: "dashboard", action: "view" },
  timeoutMs: 5_000,
  async execute(actor, args) {
    let highlight: MinkHighlight | null = null;
    if (args.highlight !== undefined) {
      if (!isMinkGuideTarget(args.highlight)) {
        throw new MinkToolInputError(
          `highlight must be one of: ${MINK_GUIDE_TARGET_KEYS.join(", ")}.`,
        );
      }
      highlight = readMinkHighlight({ target: args.highlight });
    }
    const destination =
      args.destination === undefined && highlight
        ? MINK_GUIDE_TARGETS[highlight.target].destination
        : args.destination;
    if (typeof destination !== "string" || !(destination in DESTINATIONS)) {
      throw new MinkToolInputError(
        `destination must be one of: ${MINK_NAVIGATION_DESTINATIONS.join(", ")}.`,
      );
    }
    if (
      highlight &&
      MINK_GUIDE_TARGETS[highlight.target].destination !== destination
    ) {
      throw new MinkToolInputError(
        `highlight ${highlight.target} lives on destination ${MINK_GUIDE_TARGETS[highlight.target].destination}; omit destination or pass that one.`,
      );
    }
    const entry = DESTINATIONS[destination as MinkNavigationDestination];
    if (
      !can(actor.permissions, entry.section, entry.action, actor.isSuperadmin)
    ) {
      return {
        error: {
          code: "permission_denied",
          message: `The signed-in admin cannot open ${entry.label}. Say so and do not guess another page.`,
        },
      };
    }

    if (destination === "product") {
      const product = await resolveProduct(actor, args);
      return navigation(
        `/dashboard/products/${product.id}`,
        product.name,
        `Open ${product.name}`,
      );
    }
    if (destination === "order") {
      const reference = optionalText(
        args.order_reference,
        "order_reference",
        40,
      );
      if (!reference) {
        throw new MinkToolInputError(
          "order_reference is required for destination 'order'.",
        );
      }
      const found = await resolveOrder(actor, reference);
      return navigation(
        `/dashboard/orders?q=${encodeURIComponent(found.reference)}`,
        `Order ${found.reference}`,
        `Open order ${found.reference}`,
      );
    }
    const prefillKind = PREFILL_KINDS[destination as MinkNavigationDestination];
    if (prefillKind && args.prefill !== undefined) {
      // Filling a form is an edit the merchant then saves, so it needs the
      // page's manage permission even where viewing the page does not.
      if (
        !can(actor.permissions, entry.section, "manage", actor.isSuperadmin)
      ) {
        return {
          error: {
            code: "permission_denied",
            message: `The signed-in admin can view ${entry.label} but cannot change it, so the form cannot be filled in. Say so.`,
          },
        };
      }
      const fields = readMinkPrefill(prefillKind, args.prefill);
      if (!fields) {
        throw new MinkToolInputError(
          `prefill carries no field the ${entry.label} form has.`,
        );
      }
      const prefill = { kind: prefillKind, fields } as MinkFormPrefill;
      return {
        ...navigation(
          minkPrefillPath(prefillKind),
          entry.label,
          `Open ${entry.label} filled in`,
        ),
        prefill,
        ...(highlight ? { highlight } : {}),
      };
    }
    return {
      ...navigation(
        entry.path,
        entry.label,
        highlight ? `Show ${highlight.label}` : `Open ${entry.label}`,
      ),
      ...(highlight ? { highlight } : {}),
    };
  },
  artifact(output) {
    if (typeof output.path !== "string" || typeof output.label !== "string") {
      return undefined;
    }
    const prefill = readMinkFormPrefill(output.prefill);
    const highlight = readMinkHighlight(output.highlight);
    const artifact: MinkArtifact = {
      type: "navigation",
      title: typeof output.title === "string" ? output.title : output.label,
      path: output.path,
      label: output.label,
      ...(prefill ? { prefill } : {}),
      ...(highlight ? { highlight } : {}),
    };
    return artifact;
  },
};

function navigation(path: string, label: string, title: string) {
  return { path, label, title, opened: true };
}

async function resolveProduct(
  actor: MinkActorContext,
  args: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const id = optionalText(args.product_id, "product_id", 40);
  const sku = optionalText(args.product_sku, "product_sku", 60);
  if (!id && !sku) {
    throw new MinkToolInputError(
      "product_id or product_sku is required for destination 'product'.",
    );
  }
  if (id && !UUID.test(id)) {
    throw new MinkToolInputError("product_id must be a product id.");
  }
  const rows = await withUser(
    { uid: actor.adminId, email: actor.email },
    (db) =>
      db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(
          and(
            eq(products.storeId, actor.storeId),
            id
              ? eq(products.id, id)
              : or(
                  eq(products.sku, sku!),
                  eq(products.sku, sku!.toUpperCase()),
                ),
          ),
        )
        .limit(1),
  );
  const product = rows[0];
  if (!product) {
    throw new MinkToolInputError(
      "No product in this store matches that id or SKU. Ask the merchant which product they mean.",
    );
  }
  return product;
}

async function resolveOrder(
  actor: MinkActorContext,
  reference: string,
): Promise<{ reference: string }> {
  const rows = await withUser(
    { uid: actor.adminId, email: actor.email },
    (db) =>
      db
        .select({ reference: orders.orderRef })
        .from(orders)
        .where(
          and(
            eq(orders.storeId, actor.storeId),
            eq(orders.orderRef, reference.toUpperCase()),
          ),
        )
        .limit(1),
  );
  const order = rows[0];
  if (!order?.reference) {
    throw new MinkToolInputError(
      "No order in this store has that reference. Ask the merchant to check it.",
    );
  }
  return { reference: order.reference };
}
