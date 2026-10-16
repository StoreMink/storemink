import "server-only";

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
  getSalesTotals,
  locationCondition,
} from "@/app/dashboard/analytics/data";
import { getNewEnquiriesCount } from "@/app/dashboard/enquiries/data";
import { can, type RolePermissions } from "@/app/dashboard/lib/permissions";
import { orders, products, whatsappConversations } from "@/drizzle/schema";
import { getAiUsage } from "@/lib/ai/quota";
import type { AnalyticsLocationSelection } from "@/lib/analytics/location";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { withService, type UserIdentity } from "@/lib/db/client";
import { logWarn } from "@/lib/observability/logger";
import type { Plan } from "@/lib/plans";
import { loadInboxChannelState } from "@/lib/whatsapp/inbox-read";
import { readMinkCatalogHealth } from "./catalog-health-read";
import {
  OFFER_ENDING_SOON_DAYS,
  STALE_ORDER_HOURS,
  rankMinkHomeSuggestions,
  type MinkHomeSignals,
  type MinkHomeSuggestion,
} from "./home-suggestion-rules";
import { readMinkCurrentOffers } from "./offers-read";

// ---------------------------------------------------------------------------
// The server side of "Mink suggests" (dashboard Home). Gathers the signals
// the pure rules in home-suggestion-rules.ts need, then ranks them.
//
// ★ DETERMINISTIC AND FREE: no model call, no credit, no migration. Every
// signal is a count the dashboard already shows somewhere, read through the
// same reader that page uses, so the card never disagrees with the page it
// links to.
//
// ★ EVERY SIGNAL IS GATED ON THE SECTION IT WOULD REVEAL. A Staff role without
// Analytics must not learn the week's takings from a Home card, so each reader
// runs only when `can(permissions, section, "view")` says the viewer may open
// that page, and location-scoped readers take the viewer's binding.
//
// ★ EVERY SIGNAL IS FAIL-SOFT. The readers run in parallel under
// Promise.allSettled; one that throws is logged with logWarn and contributes
// nothing, so a cold enquiries table or an unreachable WhatsApp read can never
// blank the Home page. The whole loader also catches, so the page's worst
// case is "no card".
// ---------------------------------------------------------------------------

export interface MinkHomeSuggestionsInput {
  storeId: string;
  /** The viewer, for the RLS-scoped catalogue read (withUser). */
  identity: UserIdentity;
  permissions: RolePermissions;
  isSuperadmin: boolean;
  /** The viewer's location bindings; null is every location. */
  locationIds: string[] | null;
  /** The store's analytics time zone (settings.business.timeZone). */
  timeZone: string;
  /** ISO 4217 code for the wording ("INR"). */
  currency: string;
  plan: Plan;
  /** settings["inventory.lowStockThreshold"], already resolved. */
  defaultLowStockThreshold: number;
  now?: Date;
}

const OFFERS_READ_LIMIT = 50;
/** The launch checklist's rule: every bundled preset names samples "… (Sample)". */
const SAMPLE_MARK = "%(Sample)%";
const DAY_MS = 24 * 60 * 60 * 1000;

export async function loadMinkHomeSuggestions(
  input: MinkHomeSuggestionsInput,
): Promise<MinkHomeSuggestion[]> {
  try {
    const signals = await readMinkHomeSignals(input);
    return rankMinkHomeSuggestions(signals);
  } catch (error) {
    logWarn("mink.home-suggestions: unavailable", {
      storeId: input.storeId,
      error: errorMessage(error),
    });
    return [];
  }
}

async function readMinkHomeSignals(
  input: MinkHomeSuggestionsInput,
): Promise<MinkHomeSignals> {
  const now = input.now ?? new Date();
  const allowed = (section: string) =>
    can(input.permissions, section, "view", input.isSuperadmin);
  // The aggregate view of the viewer's scope: their locations plus the
  // online/unrouted orders, exactly what the Analytics and Orders pages show
  // them with no location filter chosen (resolveAnalyticsLocation).
  const location: AnalyticsLocationSelection = {
    locationIds: input.locationIds,
    includeUnassigned: true,
    selectedId: null,
  };

  const signal = async <T>(
    name: string,
    enabled: boolean,
    read: () => Promise<T | null>,
  ): Promise<T | null> => {
    if (!enabled) return null;
    try {
      return await read();
    } catch (error) {
      logWarn("mink.home-suggestions: signal unavailable", {
        storeId: input.storeId,
        signal: name,
        error: errorMessage(error),
      });
      return null;
    }
  };

  const [
    sales,
    staleOrders,
    stock,
    inbox,
    enquiries,
    catalogue,
    offers,
    credits,
  ] = await Promise.allSettled([
    signal("sales", allowed("analytics"), () =>
      readSales(input, location, now),
    ),
    signal("stale_orders", allowed("orders"), () =>
      readStaleOrders(input.storeId, location, now),
    ),
    signal("stock", allowed("inventory"), () => readStock(input)),
    signal("inbox", allowed("inbox"), () => readInbox(input.storeId)),
    signal("enquiries", allowed("enquiries"), async () => ({
      unread: await getNewEnquiriesCount(),
    })),
    signal("catalogue", allowed("products"), () =>
      readCatalogue(input.storeId),
    ),
    // `promotions` is the Offers section's live permission key (the label
    // changed, the key never did; see permissions.ts).
    signal("offers", allowed("promotions"), () => readOffers(input, now)),
    signal("credits", allowed("ai"), () => readCredits(input.storeId)),
  ]);

  return {
    currency: input.currency,
    sales: settled(sales, input.storeId, "sales"),
    staleOrders: settled(staleOrders, input.storeId, "stale_orders"),
    stock: settled(stock, input.storeId, "stock"),
    inbox: settled(inbox, input.storeId, "inbox"),
    enquiries: settled(enquiries, input.storeId, "enquiries"),
    catalogue: settled(catalogue, input.storeId, "catalogue"),
    offers: settled(offers, input.storeId, "offers"),
    credits: settled(credits, input.storeId, "credits"),
  };
}

/** Unwrap one allSettled slot; a rejection (already near-impossible) logs. */
function settled<T>(
  result: PromiseSettledResult<T | null>,
  storeId: string,
  name: string,
): T | null {
  if (result.status === "fulfilled") return result.value;
  logWarn("mink.home-suggestions: signal rejected", {
    storeId,
    signal: name,
    error: errorMessage(result.reason),
  });
  return null;
}

/**
 * Net sales over the last 7 COMPLETE local days against the 7 before. A
 * partial today is left out on purpose: at 9am "this week" would always trail
 * "last week" and read as a drop.
 */
async function readSales(
  input: MinkHomeSuggestionsInput,
  location: AnalyticsLocationSelection,
  now: Date,
): Promise<MinkHomeSignals["sales"]> {
  // "yesterday" ends at local midnight today, the instant the complete days
  // end; the same zone handling as the Analytics page.
  const dayStart = parseAnalyticsRange(
    { range: "yesterday", compare: "none" },
    input.timeZone,
    now,
  ).current.to;
  const current = {
    from: new Date(dayStart.getTime() - 7 * DAY_MS),
    to: dayStart,
  };
  const previous = {
    from: new Date(dayStart.getTime() - 14 * DAY_MS),
    to: current.from,
  };
  const [cur, prev] = await getSalesTotals(input.storeId, location, [
    current,
    previous,
  ]);
  if (!cur || !prev) return null;
  return {
    current: cur.sales,
    previous: prev.sales,
    currentOrders: cur.orders,
    previousOrders: prev.orders,
  };
}

/** Pending or processing orders older than STALE_ORDER_HOURS, in scope. */
async function readStaleOrders(
  storeId: string,
  location: AnalyticsLocationSelection,
  now: Date,
): Promise<MinkHomeSignals["staleOrders"]> {
  const cutoff = new Date(
    now.getTime() - STALE_ORDER_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const scoped = locationCondition(location);
  const [row] = await withService((db) =>
    db
      .select({
        pending: sql<number>`count(*) filter (where ${orders.status} = 'pending')::int`,
        processing: sql<number>`count(*) filter (where ${orders.status} = 'processing')::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          inArray(orders.status, ["pending", "processing"]),
          // A failed payment is not an order waiting to ship.
          sql`${orders.paymentStatus} <> 'failed'`,
          lt(orders.createdAt, cutoff),
          ...(scoped ? [scoped] : []),
        ),
      ),
  );
  return {
    pending: Number(row?.pending ?? 0),
    processing: Number(row?.processing ?? 0),
  };
}

/** Out-of-stock and low-stock SKU counts, the Inventory workspace's model. */
async function readStock(
  input: MinkHomeSuggestionsInput,
): Promise<MinkHomeSignals["stock"]> {
  const health = await readMinkCatalogHealth({
    storeId: input.storeId,
    identity: input.identity,
    locationIds: input.locationIds,
    defaultThreshold: input.defaultLowStockThreshold,
    includeInventory: true,
    limit: 0,
  });
  // Null counts mean inventory is not visible to this scope (no locations).
  if (health.outOfStock === null || health.lowStock === null) return null;
  return { out: health.outOfStock, low: health.lowStock };
}

/** WhatsApp conversations waiting on the store, only once a number is connected. */
async function readInbox(storeId: string): Promise<MinkHomeSignals["inbox"]> {
  const channel = await loadInboxChannelState(storeId);
  if (!channel.connected) return null;
  const [row] = await withService((db) =>
    db
      .select({ needsReply: sql<number>`count(*)::int` })
      .from(whatsappConversations)
      .where(
        and(
          eq(whatsappConversations.storeId, storeId),
          eq(whatsappConversations.status, "needs_reply"),
        ),
      ),
  );
  return { needsReply: Number(row?.needsReply ?? 0) };
}

/**
 * One bounded count over the store's products: published listings missing a
 * photo or a description, and theme samples still present (the launch
 * checklist's "(Sample)" name rule, so the two never disagree).
 */
async function readCatalogue(
  storeId: string,
): Promise<MinkHomeSignals["catalogue"]> {
  const noDescription = sql`(${products.description} is null or btrim(${products.description}) = '')`;
  // `images` defaults to '{""}', so an empty string is "no image" too.
  const noImage = sql`(coalesce(${products.imageUrl}, '') = '' and cardinality(array_remove(${products.images}, '')) = 0)`;
  const published = sql`${products.status} = 'published'`;
  const [row] = await withService((db) =>
    db
      .select({
        gaps: sql<number>`count(*) filter (where ${published} and (${noDescription} or ${noImage}))::int`,
        missingDescription: sql<number>`count(*) filter (where ${published} and ${noDescription})::int`,
        missingImage: sql<number>`count(*) filter (where ${published} and ${noImage})::int`,
        samples: sql<number>`count(*) filter (where ${products.name} like ${SAMPLE_MARK})::int`,
      })
      .from(products)
      .where(eq(products.storeId, storeId)),
  );
  return {
    gaps: Number(row?.gaps ?? 0),
    missingDescription: Number(row?.missingDescription ?? 0),
    missingImage: Number(row?.missingImage ?? 0),
    samples: Number(row?.samples ?? 0),
  };
}

/** Offers ending within OFFER_ENDING_SOON_DAYS, or finished but still on. */
async function readOffers(
  input: MinkHomeSuggestionsInput,
  now: Date,
): Promise<MinkHomeSignals["offers"]> {
  const result = await readMinkCurrentOffers(
    { storeId: input.storeId, effectivePlan: input.plan },
    { limit: OFFERS_READ_LIMIT, now },
  );
  const soonCutoff = now.getTime() + OFFER_ENDING_SOON_DAYS * DAY_MS;
  let endingSoon = 0;
  let finished = 0;
  for (const offer of result.offers) {
    if (offer.availability === "running") {
      if (offer.validUntil && Date.parse(offer.validUntil) <= soonCutoff) {
        endingSoon += 1;
      }
    } else if (
      offer.availability === "ended" ||
      offer.availability === "redemption_limit_reached" ||
      offer.availability === "budget_exhausted"
    ) {
      finished += 1;
    }
  }
  return { endingSoon, finished };
}

/** Credits left against the plan's monthly allowance; unmetered plans skip. */
async function readCredits(
  storeId: string,
): Promise<MinkHomeSignals["credits"]> {
  const usage = await getAiUsage(storeId);
  // getAiUsage reports cap: null both for an unmetered plan AND a failed read
  // (its own note); `available` is what tells them apart.
  if (!usage.available || usage.cap === null || usage.cap <= 0) return null;
  return {
    remaining: Math.max(0, usage.cap - usage.used) + usage.creditBalance,
    cap: usage.cap,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
