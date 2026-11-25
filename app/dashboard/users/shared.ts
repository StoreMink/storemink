// Shared types + display helpers for the Users (storefront customers) section.
// "Users" here are end-customers from the storefront `customers` table —
// distinct from dashboard staff (see /dashboard/admins). Pure module so it can
// be imported by both server components and the client views.

export type Customer = {
  id: string;
  phone: string;
  email: string | null;
  first_name: string;
  last_name: string | null;
  created_at: string;
  updated_at: string;
  /** Activity rollups, joined in by the data layer. */
  review_count: number;
  blog_count: number;
  /**
   * This store's orders for the customer, or null when the count could not
   * be read. A number only, never order data: the Customers section is
   * store-wide, so a location-bound admin sees it too.
   */
  order_count?: number | null;
  /**
   * Whether any order anywhere carries this customer id (the delete cascade
   * is not store-scoped), or null when unknown.
   */
  has_orders?: boolean | null;
};

export type CustomerReview = {
  id: string;
  rating: number;
  comment: string | null;
  created_at: string;
  product_id: string;
  product_name: string | null;
  /**
   * The block id when StoreMink removed this review and told the store
   * (takedown design 7.3), else null or absent.
   */
  storemink_block_id?: string | null;
};

export type CustomerBlog = {
  id: string;
  title: string;
  slug: string;
  status: string;
  created_at: string;
};

/** A single customer plus their authored content, for the detail view. */
export type CustomerDetail = Customer & {
  reviews: CustomerReview[];
  blogs: CustomerBlog[];
  /** Store credit the store owes this customer, or null when unknown. */
  store_credit?: number | null;
};

// ---------------------------------------------------------------------------
// Deleting a customer. The server (deleteCustomer) refuses when the customer
// has orders or store credit; these are its words, shared with the screens so
// the dialog says exactly what the server would answer.
// ---------------------------------------------------------------------------

const RUPEES = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
});

export function customerHasOrdersMessage(count: number): string {
  const orders = count === 1 ? "1 order" : `${count} orders`;
  return `This customer has ${orders}, so they can't be deleted. Their order history is part of your records.`;
}

/** Orders exist under this customer id, but none in this store. */
export const CUSTOMER_LINKED_TO_ORDERS_MESSAGE =
  "This customer is linked to orders, so they can't be deleted. Their order history is part of your records.";

export function formatRupees(amount: number): string {
  return RUPEES.format(amount);
}

export function customerHasCreditMessage(amount: number): string {
  return `This customer has ${formatRupees(amount)} of store credit, so they can't be deleted.`;
}

export const CUSTOMER_DELETE_CHECK_FAILED_MESSAGE =
  "We couldn't check this customer's orders, so nothing was deleted. Please try again.";

export const CUSTOMER_DELETE_CONSEQUENCES =
  "Their saved addresses, reviews, comments and group memberships are removed. Blog posts they submitted stay, without an author. This can't be undone.";

/**
 * Why this customer can't be deleted, in the server's words, or null when the
 * screen knows of no reason. Unknown counts (null) give null: the delete stays
 * available and the server decides, so the screen can only ever be wrong
 * toward a button that then refuses, never toward allowing a delete.
 */
export function customerDeleteBlocker(c: {
  order_count?: number | null;
  has_orders?: boolean | null;
  store_credit?: number | null;
}): string | null {
  if (c.has_orders) {
    return c.order_count && c.order_count > 0
      ? customerHasOrdersMessage(c.order_count)
      : CUSTOMER_LINKED_TO_ORDERS_MESSAGE;
  }
  if (c.store_credit != null && c.store_credit > 0) {
    return customerHasCreditMessage(c.store_credit);
  }
  return null;
}

/** Full name, falling back to the email local-part, then "Customer". */
export function customerName(c: {
  first_name: string;
  last_name: string | null;
  email: string | null;
}): string {
  const full = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  if (c.email) return c.email.split("@")[0];
  return "Customer";
}

export function initials(c: {
  first_name: string;
  last_name: string | null;
  email: string | null;
}): string {
  const name = customerName(c);
  return (
    name
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

/** Deterministic avatar gradient seeded by the customer id. */
const AVATAR_BACKGROUNDS = [
  "linear-gradient(135deg, var(--dash-accent), var(--dash-accent-2))",
  "var(--dash-green)",
  "var(--dash-amber)",
  "#6366f1",
  "#0ea5e9",
  "#e11d48",
];

export function avatarBackground(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_BACKGROUNDS[Math.abs(hash) % AVATAR_BACKGROUNDS.length];
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
