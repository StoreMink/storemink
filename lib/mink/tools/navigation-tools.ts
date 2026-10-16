import "server-only";

import { and, eq, or } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { orders, products } from "@/drizzle/schema";
import { withUser } from "@/lib/db/client";
import { MinkToolInputError } from "../errors";
import { readMinkProductPrefill } from "../product-prefill";
import { minkProductPrefillPath } from "../product-prefill";
import type { MinkActorContext, MinkArtifact } from "../types";
import type { MinkTool } from "./registry";

/**
 * `open_dashboard_page`: take the merchant to a dashboard page, optionally
 * with the new-product form filled in.
 *
 * ★★ A CLOSED LIST OF DESTINATIONS, NEVER A PATH FROM THE MODEL. Every entry
 * names the permission section that page is gated on, checked here against
 * the trusted actor before the path is returned, so "open the staff page"
 * on a role without that section is refused by this tool rather than by a
 * 403 the merchant lands on. A product or order is resolved by its own
 * identifier inside the trusted store; an unknown one is an error, never a
 * guessed path.
 *
 * ★ IT CHANGES NOTHING. The result is an artifact the panel turns into a
 * client-side navigation while the chat stays open (Sidekick's "fills the
 * form, you approve" pattern): a prefilled product form is still saved by
 * the merchant, through the ordinary product action, with every field
 * validated as if they had typed it.
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
      "Open a dashboard page for the merchant, keeping this chat open beside it. Use it when they ask to go to, open, show or take them to a page (for example 'open my orders', 'take me to shipping settings'), to open one exact product or order they named, or to start a new product with the form already filled in from this conversation (destination new_product with prefill). Each destination needs the merchant's own permission for that page; a page they cannot open is refused. Never use it instead of answering a question, and never claim the page was changed: it only opens the page.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          enum: MINK_NAVIGATION_DESTINATIONS,
          description:
            "The page to open. 'product' needs product_id or product_sku; 'order' needs order_reference; 'new_product' may carry prefill.",
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
            "For destination 'new_product' only: fields to fill into the new-product form. The merchant reviews and saves the form themselves; nothing is created by this tool.",
          properties: {
            name: { type: "string", maxLength: 200 },
            description: { type: "string", maxLength: 3000 },
            seo_title: { type: "string", maxLength: 70 },
            seo_description: { type: "string", maxLength: 180 },
            base_price: { type: "number", minimum: 0 },
            selling_price: { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      required: ["destination"],
      additionalProperties: false,
    },
  },
  permission: { section: "dashboard", action: "view" },
  timeoutMs: 5_000,
  async execute(actor, args) {
    const destination = args.destination;
    if (typeof destination !== "string" || !(destination in DESTINATIONS)) {
      throw new MinkToolInputError(
        `destination must be one of: ${MINK_NAVIGATION_DESTINATIONS.join(", ")}.`,
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
    if (destination === "new_product") {
      const prefill = readMinkProductPrefill(args.prefill);
      if (prefill) {
        return {
          ...navigation(
            minkProductPrefillPath(),
            entry.label,
            "Open the new product form",
          ),
          prefill: { kind: "product" as const, fields: prefill },
        };
      }
    }
    return navigation(entry.path, entry.label, `Open ${entry.label}`);
  },
  artifact(output) {
    if (typeof output.path !== "string" || typeof output.label !== "string") {
      return undefined;
    }
    const artifact: MinkArtifact = {
      type: "navigation",
      title: typeof output.title === "string" ? output.title : output.label,
      path: output.path,
      label: output.label,
      ...(output.prefill
        ? {
            prefill: output.prefill as Extract<
              MinkArtifact,
              { type: "navigation" }
            >["prefill"],
          }
        : {}),
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
