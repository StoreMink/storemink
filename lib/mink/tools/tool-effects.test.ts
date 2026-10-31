import { describe, expect, it } from "vitest";
import { minkReadToolRegistry } from "./read-tools";

// ---------------------------------------------------------------------------
// ★★ EVERY TOOL'S EFFECT IS CHOSEN ON PURPOSE (the stop handshake,
// lib/mink/run-stop.ts, 25 Oct 2026). A stop the merchant asks for wins only
// while the run has not acted, and a tool claims that it has acted before its
// first write: before it starts (`write`) or inside `commit` (`commit`). A
// tool read as `read` claims nothing, so one that writes and is wrongly read
// as a read lets a stopped run write, charge or start something, which is the
// incident this exists for. So the writers are pinned here by name: a new
// tool that writes fails this file until somebody decides its class.
// ---------------------------------------------------------------------------

/**
 * Long paid work first (an image draw, a redesign's budget read), or every
 * argument checked first (the proposals in draft-tools.ts), then the claim
 * inside `commit`, then the write.
 */
const COMMIT = [
  "generate_storefront_image",
  "propose_blog_draft",
  "propose_bulk_inventory_adjustment",
  "propose_bulk_price_update",
  "propose_category_create",
  "propose_category_update",
  "propose_coupon_create",
  "propose_coupon_email",
  "propose_coupon_update",
  "propose_current_product_description",
  "propose_current_product_seo",
  "propose_customer_group_create",
  "propose_customer_group_update",
  "propose_customer_message",
  "propose_inventory_adjustment",
  "propose_order_status_transition",
  "propose_product_create",
  "propose_product_images",
  "propose_social_posts",
  "refine_storefront_revamp",
  "start_storefront_revamp",
];

/** A few database statements: the claim comes before the tool starts. */
const WRITE = [
  "correct_product_csv",
  "propose_storefront_custom_code",
  "propose_storefront_design",
  "propose_storefront_layout",
  "propose_website_builder_change",
  "start_business_brief",
  "start_delayed_pickup_review",
  "start_product_launch_preparation",
  "start_revenue_decline_investigation",
  "start_slow_inventory_promotion",
  "start_weekly_trading_report",
];

/**
 * ★ Every read, pinned as well: a tool that writes but is marked
 *   `repeatSafe`, `restartSafe` or `effect: "read"` would otherwise pass this
 *   file under a name the pattern below does not catch, and claim nothing.
 */
const READ = [
  "get_catalog_summary",
  "get_category_for_draft",
  "get_coupon_for_draft",
  "get_current_order",
  "get_current_product",
  "get_customer_group_for_draft",
  "get_inventory_item_for_adjustment",
  "get_inventory_items_for_bulk_adjustment",
  "get_marketing_channels",
  "get_mink_watch_responses",
  "get_mink_watches",
  "get_order_for_status_transition",
  "get_products_for_bulk_price_update",
  "get_sales_summary",
  "get_shipping_settings",
  "get_store_profile",
  "get_storefront_design_context",
  "get_storefront_page_context",
  "get_storefront_revamp_context",
  "get_storefront_section_context",
  "get_website_builder_context",
  "inspect_product_csv",
  "list_blogs",
  "list_current_offers",
  "list_low_stock",
  "list_orders",
  "list_storefront_media",
  "list_storefront_pages",
  "open_dashboard_page",
  "query_analytics",
  "search_help_centre",
  "search_products",
  "search_storefront_categories",
];

/** The checkpoint reads a proposal needs: not repeat-safe, and they write nothing. */
const MARKED_READS = [
  "get_category_for_draft",
  "get_coupon_for_draft",
  "get_customer_group_for_draft",
  "get_inventory_item_for_adjustment",
  "get_inventory_items_for_bulk_adjustment",
  "get_order_for_status_transition",
  "get_products_for_bulk_price_update",
  "inspect_product_csv",
];

const names = minkReadToolRegistry.names();
const effectOf = (name: string) => minkReadToolRegistry.effectOf(name);
const withEffect = (effect: string) =>
  names.filter((name) => effectOf(name) === effect).sort();

describe("★★ Mink tool effects (the stop handshake)", () => {
  it("gives every registered tool one of the three classes", () => {
    expect(names.length).toBeGreaterThan(60);
    for (const name of names) {
      expect(["read", "write", "commit"], name).toContain(effectOf(name));
    }
  });

  it("★ pins the tools that claim inside commit, after their paid work", () => {
    expect(withEffect("commit")).toEqual(COMMIT);
  });

  it("★★ pins the tools that claim before they start", () => {
    expect(withEffect("write")).toEqual(WRITE);
  });

  it("★★ pins the reads too, so every tool's class is chosen on purpose", () => {
    expect(withEffect("read")).toEqual(READ);
    expect([...READ, ...WRITE, ...COMMIT].sort()).toEqual([...names].sort());
  });

  it("★★ never reads a tool named like a change as a read", () => {
    const reads = withEffect("read");
    expect(
      reads.filter((name) =>
        /^(propose|start|generate|refine|correct)_/.test(name),
      ),
    ).toEqual([]);
  });

  it("reads the checkpoint reads as reads, though they are not repeat-safe", () => {
    for (const name of MARKED_READS) {
      expect(names, name).toContain(name);
      expect(effectOf(name), name).toBe("read");
      // ★ Their class is their own marking, never the memo's: a checkpoint
      //   must be read afresh, so it is not served from the per-run memo.
      expect(minkReadToolRegistry.isRepeatSafe(name), name).toBe(false);
    }
  });

  it("knows no class for a tool it does not have", () => {
    expect(effectOf("request_more_tools")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ★★ AN ATTACHED PICTURE REACHES THE STORE ONLY THROUGH THESE ARGUMENTS
// (storage build, 2026-10-28; design 5.7). The registry copies a chat
// attachment into the Media Library only for a tool that names the argument
// it may appear in, and refuses an attachment address anywhere else: a
// customer message, a coupon email, a social post or a workflow must never
// turn a private screenshot into a public link. So the nine are pinned by
// name with their exact arguments, and a new tool that sets `attachmentArgs`
// fails this file until somebody decides. `generate_storefront_image` reads
// its references as private bytes instead, and must be the only tool that
// does. A blog's Markdown body is deliberately NOT one of the arguments: it
// renders no image, so an address there could only be published as text.
// ---------------------------------------------------------------------------

const ATTACHMENT_ARGS: Record<string, readonly string[]> = {
  propose_blog_draft: ["cover_image_url"],
  propose_category_create: ["image_url"],
  propose_category_update: ["image_url"],
  propose_product_create: ["image_url"],
  propose_product_images: ["image_urls"],
  propose_storefront_layout: ["sections"],
  propose_website_builder_change: ["changes_json"],
  refine_storefront_revamp: ["products"],
  start_storefront_revamp: ["products"],
};

describe("★★ Mink tools that may take an attached picture", () => {
  it("★★ exactly these nine carry attachmentArgs, with exactly these arguments", () => {
    const carrying = names
      .filter(
        (name) => minkReadToolRegistry.attachmentArgsOf(name) !== undefined,
      )
      .sort();
    expect(carrying).toEqual(Object.keys(ATTACHMENT_ARGS).sort());
    for (const [name, args] of Object.entries(ATTACHMENT_ARGS)) {
      expect(minkReadToolRegistry.attachmentArgsOf(name), name).toEqual(args);
    }
  });

  it("★ every one of them writes or commits, never reads", () => {
    for (const name of Object.keys(ATTACHMENT_ARGS)) {
      expect(["write", "commit"], name).toContain(effectOf(name));
    }
  });

  it("★★ only generate_storefront_image reads attachments itself, and it copies none", () => {
    expect(
      names.filter((name) => minkReadToolRegistry.readsAttachmentsItself(name)),
    ).toEqual(["generate_storefront_image"]);
    expect(
      minkReadToolRegistry.attachmentArgsOf("generate_storefront_image"),
    ).toBeUndefined();
  });
});
