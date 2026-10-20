/**
 * Merchant-facing names for Mink's tools, and the progress line each one
 * shows while it runs.
 *
 * ★ PURE AND CLIENT-SAFE: the chat panel reads it on every progress event,
 * so it imports nothing. It is a complete map rather than a fallback with
 * three entries, because the fallback used to show the raw tool name with
 * its underscores turned into spaces, and "Reading get inventory items for
 * bulk adjustment…" is not a sentence a merchant should ever read.
 * `lib/mink/tool-labels.test.ts` fails when a registered tool has no entry.
 *
 * ★ THE VERB FOLLOWS THE TOOL'S SHAPE. A read is "Reading …", a proposal is
 * "Preparing …" (it changes nothing until approved), a durable workflow is
 * "Queuing …", and the image provider is "Generating …". The label is the
 * object of that verb, so it reads as one sentence in each state.
 */
export type MinkToolState = "running" | "completed" | "failed";

type ToolVerb = "read" | "prepare" | "queue" | "generate" | "correct";

const VERBS: Record<
  ToolVerb,
  { running: string; completed: string; failed: string }
> = {
  read: { running: "Reading", completed: "Read", failed: "Couldn't read" },
  prepare: {
    running: "Preparing",
    completed: "Prepared",
    failed: "Couldn't prepare",
  },
  queue: { running: "Queuing", completed: "Queued", failed: "Couldn't queue" },
  generate: {
    running: "Generating",
    completed: "Generated",
    failed: "Couldn't generate",
  },
  correct: {
    running: "Correcting",
    completed: "Corrected",
    failed: "Couldn't correct",
  },
};

export const MINK_TOOL_LABELS: Record<
  string,
  { verb: ToolVerb; label: string }
> = {
  correct_product_csv: { verb: "correct", label: "the product CSV" },
  generate_storefront_image: { verb: "generate", label: "an image" },
  get_catalog_summary: { verb: "read", label: "the catalogue" },
  get_coupon_for_draft: { verb: "read", label: "coupon details" },
  get_current_order: { verb: "read", label: "this order" },
  get_current_product: { verb: "read", label: "this product" },
  get_customer_group_for_draft: { verb: "read", label: "the customer group" },
  get_category_for_draft: { verb: "read", label: "the category" },
  get_inventory_item_for_adjustment: { verb: "read", label: "stock levels" },
  get_inventory_items_for_bulk_adjustment: {
    verb: "read",
    label: "stock levels",
  },
  get_mink_watch_responses: { verb: "read", label: "watch results" },
  get_mink_watches: { verb: "read", label: "your watches" },
  get_order_for_status_transition: { verb: "read", label: "the order" },
  get_products_for_bulk_price_update: { verb: "read", label: "prices" },
  get_sales_summary: { verb: "read", label: "sales" },
  get_store_profile: { verb: "read", label: "store details" },
  get_storefront_design_context: {
    verb: "read",
    label: "the storefront design",
  },
  get_storefront_page_context: { verb: "read", label: "the page" },
  get_storefront_personalization_context: {
    verb: "read",
    label: "your storefront",
  },
  get_storefront_section_context: { verb: "read", label: "the page section" },
  get_website_builder_context: { verb: "read", label: "Website Builder" },
  inspect_product_csv: { verb: "read", label: "the product CSV" },
  list_blogs: { verb: "read", label: "blog posts" },
  list_current_offers: { verb: "read", label: "offers" },
  list_low_stock: { verb: "read", label: "low stock" },
  list_orders: { verb: "read", label: "orders" },
  list_storefront_media: { verb: "read", label: "the Media Library" },
  list_storefront_pages: { verb: "read", label: "pages" },
  propose_blog_draft: { verb: "prepare", label: "a blog draft" },
  propose_bulk_inventory_adjustment: {
    verb: "prepare",
    label: "a stock adjustment",
  },
  propose_bulk_price_update: { verb: "prepare", label: "a price update" },
  propose_coupon_create: { verb: "prepare", label: "a coupon" },
  propose_coupon_email: { verb: "prepare", label: "a coupon email" },
  propose_coupon_update: { verb: "prepare", label: "a coupon change" },
  propose_current_product_description: {
    verb: "prepare",
    label: "a product description",
  },
  propose_current_product_seo: { verb: "prepare", label: "product SEO" },
  propose_customer_group_create: { verb: "prepare", label: "a customer group" },
  propose_customer_group_update: {
    verb: "prepare",
    label: "a customer group change",
  },
  propose_customer_message: { verb: "prepare", label: "a customer message" },
  propose_inventory_adjustment: {
    verb: "prepare",
    label: "a stock adjustment",
  },
  propose_order_status_transition: {
    verb: "prepare",
    label: "an order status change",
  },
  propose_product_create: { verb: "prepare", label: "a product draft" },
  propose_product_images: { verb: "prepare", label: "product photos" },
  propose_storefront_custom_code: { verb: "prepare", label: "custom code" },
  propose_storefront_design: { verb: "prepare", label: "a design change" },
  propose_storefront_layout: { verb: "prepare", label: "a page layout" },
  propose_storefront_personalization: {
    verb: "prepare",
    label: "your personalised storefront",
  },
  propose_website_builder_change: {
    verb: "prepare",
    label: "a Website Builder change",
  },
  read_products: { verb: "read", label: "products" },
  search_help_centre: { verb: "read", label: "the Help Centre" },
  search_products: { verb: "read", label: "products" },
  search_storefront_categories: { verb: "read", label: "categories" },
  start_business_brief: { verb: "queue", label: "a business brief" },
  start_delayed_pickup_review: { verb: "queue", label: "a pickup review" },
  start_product_launch_preparation: { verb: "queue", label: "a launch check" },
  start_revenue_decline_investigation: {
    verb: "queue",
    label: "a revenue investigation",
  },
  start_slow_inventory_promotion: {
    verb: "queue",
    label: "a slow stock review",
  },
  start_weekly_trading_report: { verb: "queue", label: "a weekly report" },
  query_analytics: { verb: "read", label: "analytics" },
  open_dashboard_page: { verb: "read", label: "the page to open" },
  get_shipping_settings: { verb: "read", label: "shipping settings" },
  get_marketing_channels: { verb: "read", label: "marketing channels" },
  propose_social_posts: { verb: "prepare", label: "social posts" },
  propose_category_create: { verb: "prepare", label: "a category" },
  propose_category_update: { verb: "prepare", label: "a category change" },
};

/** The object a tool reads or prepares, for a sentence such as "Checked sales". */
export function minkToolLabel(name: string): string {
  const known = MINK_TOOL_LABELS[name];
  if (known) return known.label;
  return name
    .replace(
      /^(get|list|search|read|propose|start|inspect|correct|generate)_/,
      "",
    )
    .replaceAll("_", " ")
    .trim();
}

/** One progress line for a tool in a state: "Reading sales…", "Couldn't read sales". */
export function minkToolStatus(name: string, state: MinkToolState): string {
  const known = MINK_TOOL_LABELS[name];
  const verb = VERBS[known?.verb ?? "read"][state];
  const label = minkToolLabel(name);
  return state === "running" ? `${verb} ${label}…` : `${verb} ${label}`;
}
