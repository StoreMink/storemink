import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { logWarn } from "@/lib/observability/logger";
import {
  blogs,
  customerAdmin,
  customerCreditBalances,
  orders,
  productReviews,
  products,
  users,
} from "@/drizzle/schema";
import { getActingStoreId } from "@/app/dashboard/lib/access";
import { blockedItemIds } from "@/lib/moderation/merchant";
import type {
  Customer,
  CustomerBlog,
  CustomerDetail,
  CustomerReview,
} from "./shared";

// The `users` table is own-row-only under RLS, so every cross-customer read
// here goes through the service scope. Listing is paginated and filtered/sorted
// in SQL via the `customer_admin` view
// so we never pull every user — or every review and blog — into memory.

export const CUSTOMERS_PAGE_SIZE = 50;

// Aliased view projection preserving the snake_case Customer shape.
const VIEW_COLUMNS = {
  id: customerAdmin.id,
  phone: customerAdmin.phone,
  email: customerAdmin.email,
  first_name: customerAdmin.firstName,
  last_name: customerAdmin.lastName,
  created_at: customerAdmin.createdAt,
  updated_at: customerAdmin.updatedAt,
  review_count: customerAdmin.reviewCount,
  blog_count: customerAdmin.blogCount,
  activity_count: customerAdmin.activityCount,
};

const DETAIL_COLUMNS = {
  id: users.id,
  phone: users.phone,
  email: users.email,
  first_name: users.firstName,
  last_name: users.lastName,
  created_at: users.createdAt,
  updated_at: users.updatedAt,
};

export type CustomerSort = "newest" | "oldest" | "name" | "active";
export type CustomerFilter = "all" | "recent" | "reviewers" | "with_email";

export interface CustomerQuery {
  page?: number;
  q?: string;
  filter?: CustomerFilter;
  sort?: CustomerSort;
}

// Computed in this plain server module (never in a component render) so the
// "new in last 30 days" cut-off stays out of the impure-call lint surface.
function recentCutoffIso(): string {
  return new Date(Date.now() - 30 * 86400000).toISOString();
}

export interface CustomersResult {
  data: Customer[];
  error: boolean;
  /** Total rows in the *filtered* set (for pagination), not just this page. */
  total: number;
  page: number;
  pageSize: number;
}

export interface CustomerStats {
  total: number;
  recent: number;
  withEmail: number;
  reviewers: number;
}

/** Trim the search term to a sane length (parameterised, so no escaping). */
function sanitizeSearch(q: string): string {
  return q.trim().slice(0, 100);
}

type OrderCounts = Map<string, { here: number; total: number }>;

/**
 * Orders per customer id: `here` is this store's, `total` every store's.
 * The delete refusal is decided on `total` because the cascade is not
 * store-scoped; screens show `here`. One grouped read for the whole page.
 */
async function readOrderCounts(
  db: Db,
  storeId: string,
  ids: string[],
): Promise<OrderCounts> {
  const out: OrderCounts = new Map();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      customerId: orders.customerId,
      here: sql<number>`(count(*) filter (where ${orders.storeId} = ${storeId}))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(orders)
    .where(inArray(orders.customerId, ids))
    .groupBy(orders.customerId);
  for (const row of rows) {
    if (row.customerId) {
      out.set(row.customerId, {
        here: Number(row.here),
        total: Number(row.total),
      });
    }
  }
  return out;
}

/**
 * The counts in a scope of their own, after the main read has closed (never
 * nested inside it), so a failure costs only the counts: a failed statement
 * would abort the main read's transaction. Null when it fails.
 */
async function safeOrderCounts(
  storeId: string,
  ids: string[],
): Promise<OrderCounts | null> {
  if (ids.length === 0) return new Map();
  try {
    return await withService((db) => readOrderCounts(db, storeId, ids));
  } catch (err) {
    logWarn("customers.order_counts_failed", {
      storeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Store credit owed to one customer, or null when it can't be read. */
async function safeStoreCredit(
  storeId: string,
  id: string,
): Promise<number | null> {
  try {
    const credit = await withService((db) =>
      db
        .select({ balance: customerCreditBalances.balance })
        .from(customerCreditBalances)
        .where(
          and(
            eq(customerCreditBalances.storeId, storeId),
            eq(customerCreditBalances.customerId, id),
          ),
        )
        .limit(1),
    );
    return Number(credit[0]?.balance ?? 0);
  } catch (err) {
    logWarn("customers.store_credit_failed", {
      storeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** The counts for one customer; unknown (a failed read) is null. */
function orderFields(
  counts: OrderCounts | null,
  id: string,
): Pick<Customer, "order_count" | "has_orders"> {
  if (!counts) return { order_count: null, has_orders: null };
  const c = counts.get(id);
  return { order_count: c?.here ?? 0, has_orders: (c?.total ?? 0) > 0 };
}

/**
 * One page of customers (newest first by default), filtered/sorted in SQL.
 * `error` is true if the view/table hasn't been migrated yet.
 */
export async function getCustomers(
  query: CustomerQuery = {},
): Promise<CustomersResult> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = CUSTOMERS_PAGE_SIZE;
  const from = (page - 1) * pageSize;
  const filter = query.filter ?? "all";
  const sort = query.sort ?? "newest";

  const storeId = await getActingStoreId();
  const conds = [eq(customerAdmin.storeId, storeId)];

  const term = sanitizeSearch(query.q ?? "");
  if (term) {
    const like = `%${term}%`;
    conds.push(
      or(
        ilike(customerAdmin.firstName, like),
        ilike(customerAdmin.lastName, like),
        ilike(customerAdmin.email, like),
        ilike(customerAdmin.phone, like),
      )!,
    );
  }

  if (filter === "recent") {
    conds.push(gte(customerAdmin.createdAt, recentCutoffIso()));
  } else if (filter === "reviewers") {
    conds.push(gt(customerAdmin.reviewCount, 0));
  } else if (filter === "with_email") {
    conds.push(isNotNull(customerAdmin.email));
  }
  const whereExpr = and(...conds);

  const order =
    sort === "oldest"
      ? [asc(customerAdmin.createdAt)]
      : sort === "name"
        ? [asc(customerAdmin.firstName), asc(customerAdmin.lastName)]
        : sort === "active"
          ? [desc(customerAdmin.activityCount)]
          : [desc(customerAdmin.createdAt)];

  try {
    const { rows, total } = await withService(async (db) => {
      const rows = await db
        .select(VIEW_COLUMNS)
        .from(customerAdmin)
        .where(whereExpr)
        .orderBy(...order)
        .limit(pageSize)
        .offset(from);
      const countRows = await db
        .select({ n: count() })
        .from(customerAdmin)
        .where(whereExpr);
      return { rows, total: countRows[0]?.n ?? 0 };
    });
    const counts = await safeOrderCounts(
      storeId,
      rows.flatMap((r) => (r.id ? [r.id] : [])),
    );
    return {
      data: rows.map((r) => ({
        ...r,
        ...orderFields(counts, r.id ?? ""),
      })) as Customer[],
      error: false,
      total,
      page,
      pageSize,
    };
  } catch (err) {
    console.error("Failed to load customers:", err);
    return { data: [], error: true, total: 0, page, pageSize };
  }
}

/**
 * Aggregate counts for the metric cards. Count-only queries so they stay cheap
 * as the table grows.
 */
export async function getCustomerStats(): Promise<CustomerStats> {
  const cutoff = recentCutoffIso();
  const storeId = await getActingStoreId();

  try {
    return await withService(async (db) => {
      const totalRows = await db
        .select({ n: count() })
        .from(users)
        .where(eq(users.storeId, storeId));
      const recentRows = await db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.storeId, storeId), gte(users.createdAt, cutoff)));
      const emailRows = await db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.storeId, storeId), isNotNull(users.email)));
      const reviewerRows = await db
        .select({ n: count() })
        .from(customerAdmin)
        .where(
          and(
            eq(customerAdmin.storeId, storeId),
            gt(customerAdmin.reviewCount, 0),
          ),
        );
      return {
        total: totalRows[0]?.n ?? 0,
        recent: recentRows[0]?.n ?? 0,
        withEmail: emailRows[0]?.n ?? 0,
        reviewers: reviewerRows[0]?.n ?? 0,
      };
    });
  } catch (err) {
    console.error("Failed to load customer stats:", err);
    return { total: 0, recent: 0, withEmail: 0, reviewers: 0 };
  }
}

/** A single customer with their reviews and blog submissions, or null. */
export async function getCustomer(id: string): Promise<CustomerDetail | null> {
  const storeId = await getActingStoreId();

  let detail: CustomerDetail | null;
  try {
    detail = await withService(async (db) => {
      const detailRows = await db
        .select(DETAIL_COLUMNS)
        .from(users)
        .where(and(eq(users.id, id), eq(users.storeId, storeId)))
        .limit(1);
      const data = detailRows[0];
      if (!data) return null;

      const reviewRows = await db
        .select({
          id: productReviews.id,
          rating: productReviews.rating,
          comment: productReviews.comment,
          created_at: productReviews.createdAt,
          product_id: productReviews.productId,
          product_name: products.name,
        })
        .from(productReviews)
        .leftJoin(products, eq(productReviews.productId, products.id))
        .where(eq(productReviews.userId, id))
        .orderBy(desc(productReviews.createdAt));
      const blogRows = await db
        .select({
          id: blogs.id,
          title: blogs.title,
          slug: blogs.slug,
          status: blogs.status,
          created_at: blogs.createdAt,
        })
        .from(blogs)
        .where(eq(blogs.submittedBy, id))
        .orderBy(desc(blogs.createdAt));

      const reviews = reviewRows as CustomerReview[];
      const customerBlogs = blogRows as CustomerBlog[];

      return {
        ...(data as Omit<Customer, "review_count" | "blog_count">),
        review_count: reviews.length,
        blog_count: customerBlogs.length,
        reviews,
        blogs: customerBlogs,
      };
    });
  } catch (err) {
    console.error("Failed to load customer:", err);
    return null;
  }
  if (!detail) return null;

  // Read after the scope above has closed, in scopes of their own, so a
  // failure costs only these figures (null = unknown; the server still
  // decides any delete).
  const [counts, storeCredit] = await Promise.all([
    safeOrderCounts(storeId, [id]),
    safeStoreCredit(storeId, id),
  ]);
  detail = {
    ...detail,
    ...orderFields(counts, id),
    store_credit: storeCredit,
  };
  if (detail.reviews.length === 0) return detail;

  // The reviews StoreMink removed and told the store about (takedown design
  // 7.3): each reads "Removed by StoreMink" with the notice its "See why"
  // opens. Read AFTER the scope above has closed, never inside its callback,
  // and only when there is a review to mark. It never throws, and a failed
  // read marks nothing. A block kept from the store is not in it (D21).
  const removed = await blockedItemIds(storeId, "review").catch(
    () => new Map<string, string>(),
  );
  return {
    ...detail,
    reviews: detail.reviews.map((review) => ({
      ...review,
      storemink_block_id: removed.get(review.id) ?? null,
    })),
  };
}
