import "server-only";

import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  categories,
  offerProducts,
  offers,
  products,
  productVariants,
  stores,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import {
  describeReward,
  describeTrigger,
  rewardDescriptor,
} from "@/lib/offers/describe";
import {
  decodeConditions,
  decodeReward,
  decodeTrigger,
  isContentsTrigger,
  rewardLevel,
  type OfferCondition,
  type OfferFulfilmentType,
  type OfferPaymentMethod,
} from "@/lib/offers/types";
import { resolveStoreSettings } from "@/lib/settings/registry";
import type { MinkActorContext } from "./types";

const MAX_SCOPE_ROWS = 400;

export type MinkOfferAvailability =
  | "running"
  | "disabled"
  | "scheduled"
  | "ended"
  | "redemption_limit_reached"
  | "budget_exhausted"
  | "automatic_offers_disabled";

export async function readMinkCurrentOffers(
  // Only the store and its plan: customer-facing Mink (lib/whatsapp/
  // mink-answer.ts) reads this with no admin behind it.
  actor: Pick<MinkActorContext, "storeId" | "effectivePlan">,
  input: { limit: number; now?: Date },
) {
  const now = input.now ?? new Date();
  const result = await withService(async (db) => {
    const [rows, storeRows] = await Promise.all([
      db
        .select({
          id: offers.id,
          name: offers.name,
          status: offers.status,
          delivery: offers.delivery,
          code: offers.code,
          priority: offers.priority,
          triggerType: offers.triggerType,
          triggerConfig: offers.triggerConfig,
          rewardType: offers.rewardType,
          rewardConfig: offers.rewardConfig,
          channels: offers.channels,
          validFrom: offers.validFrom,
          validUntil: offers.validUntil,
          maxRedemptions: offers.maxRedemptions,
          redemptionCount: offers.redemptionCount,
          budgetPaise: offers.budgetPaise,
          spentPaise: offers.spentPaise,
        })
        .from(offers)
        .where(eq(offers.storeId, actor.storeId))
        .orderBy(
          sql`case when ${offers.status} = 'active' then 0 else 1 end`,
          desc(offers.priority),
          desc(offers.createdAt),
          desc(offers.id),
        )
        .limit(input.limit + 1),
      db
        .select({ settings: stores.settings })
        .from(stores)
        .where(eq(stores.id, actor.storeId))
        .limit(1),
    ]);
    const offerIds = rows.slice(0, input.limit).map((row) => row.id);
    const scopeRows = offerIds.length
      ? await db
          .select({
            offerId: offerProducts.offerId,
            productId: offerProducts.productId,
            productName: products.name,
            variantId: offerProducts.variantId,
            variantName: productVariants.name,
            variantSku: productVariants.sku,
            categoryId: offerProducts.categoryId,
            categoryName: categories.name,
          })
          .from(offerProducts)
          .leftJoin(
            products,
            and(
              eq(offerProducts.productId, products.id),
              eq(products.storeId, actor.storeId),
            ),
          )
          .leftJoin(
            productVariants,
            and(
              eq(offerProducts.variantId, productVariants.id),
              eq(productVariants.storeId, actor.storeId),
            ),
          )
          .leftJoin(
            categories,
            and(
              eq(offerProducts.categoryId, categories.id),
              eq(categories.storeId, actor.storeId),
            ),
          )
          .where(
            and(
              eq(offerProducts.storeId, actor.storeId),
              inArray(offerProducts.offerId, offerIds),
            ),
          )
          .limit(MAX_SCOPE_ROWS + 1)
      : [];
    return { rows, scopeRows, settings: storeRows[0]?.settings };
  });

  const settings = resolveStoreSettings(
    (result.settings as Record<string, unknown> | null) ?? {},
    actor.effectivePlan,
  );
  const automaticOffersEnabled = settings["offers.autoApply"] === true;
  const bounded = result.rows.slice(0, input.limit);
  const scopeDataTruncated = result.scopeRows.length > MAX_SCOPE_ROWS;
  const scopes = offerScopes(
    result.scopeRows.slice(0, MAX_SCOPE_ROWS),
    scopeDataTruncated,
  );
  const current = bounded.map((row) => {
    const trigger = decodeTrigger(row.triggerType, row.triggerConfig);
    const reward = decodeReward(row.rewardType, row.rewardConfig);
    const availability = offerAvailability({
      status: row.status,
      delivery: row.delivery,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      maxRedemptions: row.maxRedemptions,
      redemptionCount: row.redemptionCount,
      budgetPaise: row.budgetPaise,
      spentPaise: row.spentPaise,
      automaticOffersEnabled,
      now: now.getTime(),
    });
    const appliesTo =
      scopes.get(row.id) ??
      (scopeDataTruncated ? incompleteScope() : allProductsScope());
    const scopeCount =
      appliesTo.products.length +
      appliesTo.variants.length +
      appliesTo.categories.length;
    return {
      name: row.name,
      availability,
      delivery:
        row.delivery === "code" || row.delivery === "link"
          ? row.delivery
          : "automatic",
      ...(row.delivery === "code" && row.code ? { code: row.code } : {}),
      reward: describeReward(rewardDescriptor(reward), { scopeCount }),
      trigger: describeTrigger(trigger.type, trigger.minSubtotal),
      // The order trigger and the discounted-item scope are independent. Keep
      // both in the model payload so "on any order" can never be mistaken for
      // "all products" when the reward is scoped to Almond shake.
      appliesTo,
      channels:
        Array.isArray(row.channels) && row.channels.length
          ? row.channels.slice(0, 2)
          : ["storefront", "pos"],
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      redemptions: row.redemptionCount,
      maxRedemptions: row.maxRedemptions,
      remainingBudget:
        row.budgetPaise === null
          ? null
          : Math.max(0, (row.budgetPaise - (row.spentPaise ?? 0)) / 100),
    };
  });

  return {
    runningCount: current.filter((offer) => offer.availability === "running")
      .length,
    automaticOffersEnabled,
    offers: current,
    truncated: result.rows.length > input.limit,
    dataAsOf: now.toISOString(),
    dashboardPath: "/dashboard/offers",
  };
}

type ScopeRow = {
  offerId: string;
  productId: string | null;
  productName: string | null;
  variantId: string | null;
  variantName: string | null;
  variantSku: string | null;
  categoryId: string | null;
  categoryName: string | null;
};

type NamedOfferScope = {
  allProducts: boolean;
  products: string[];
  variants: string[];
  categories: string[];
  summary: string;
  truncated: boolean;
};

function allProductsScope(): NamedOfferScope {
  return {
    allProducts: true,
    products: [],
    variants: [],
    categories: [],
    summary: "all products",
    truncated: false,
  };
}

function incompleteScope(): NamedOfferScope {
  return {
    allProducts: false,
    products: [],
    variants: [],
    categories: [],
    summary: "scope incomplete in this bounded read",
    truncated: true,
  };
}

function offerScopes(
  rows: ScopeRow[],
  truncated: boolean,
): Map<string, NamedOfferScope> {
  const grouped = new Map<
    string,
    {
      products: Map<string, string>;
      variants: Map<string, string>;
      categories: Map<string, string>;
    }
  >();
  for (const row of rows) {
    const group = grouped.get(row.offerId) ?? {
      products: new Map(),
      variants: new Map(),
      categories: new Map(),
    };
    if (row.productId) {
      group.products.set(row.productId, row.productName ?? "Unnamed product");
    }
    if (row.variantId) {
      const suffix = row.variantSku ? ` (SKU ${row.variantSku})` : "";
      group.variants.set(
        row.variantId,
        `${row.variantName ?? "Unnamed variant"}${suffix}`,
      );
    }
    if (row.categoryId) {
      group.categories.set(
        row.categoryId,
        row.categoryName ?? "Unnamed category",
      );
    }
    grouped.set(row.offerId, group);
  }

  return new Map(
    [...grouped].map(([offerId, group]) => {
      const productNames = [...group.products.values()];
      const variantNames = [...group.variants.values()];
      const categoryNames = [...group.categories.values()];
      const parts = [
        ...productNames,
        ...variantNames.map((name) => `variant ${name}`),
        ...categoryNames.map((name) => `all products in ${name}`),
      ];
      return [
        offerId,
        {
          allProducts: false,
          products: productNames,
          variants: variantNames,
          categories: categoryNames,
          summary: parts.join("; ") || "selected products",
          truncated,
        },
      ];
    }),
  );
}

function offerAvailability(input: {
  status: string;
  delivery: string;
  validFrom: string | null;
  validUntil: string | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  budgetPaise: number | null;
  spentPaise: number;
  automaticOffersEnabled: boolean;
  now: number;
}): MinkOfferAvailability {
  if (input.status !== "active") return "disabled";
  if (
    input.maxRedemptions !== null &&
    input.redemptionCount >= input.maxRedemptions
  ) {
    return "redemption_limit_reached";
  }
  if (input.budgetPaise !== null && input.spentPaise >= input.budgetPaise) {
    return "budget_exhausted";
  }
  if (input.validFrom && input.now < Date.parse(input.validFrom)) {
    return "scheduled";
  }
  if (input.validUntil && input.now > Date.parse(input.validUntil)) {
    return "ended";
  }
  if (input.delivery === "automatic" && !input.automaticOffersEnabled) {
    return "automatic_offers_disabled";
  }
  return "running";
}

// ---------------------------------------------------------------------------
// What a SHOPPER may be told: customer-facing Mink on WhatsApp
// (lib/whatsapp/mink-answer.ts) answers anyone who messages the shop.
//
// ★★ A SEPARATE READ, NOT A FLAG ON THE ONE ABOVE. `readMinkCurrentOffers`
// is the merchant's own view (the dashboard agent's list_current_offers tool)
// and must keep listing every offer and every code, blockers included. This
// one answers a different question, "what would a visitor to the storefront
// be offered?", and every filter below is a reason a code or an offer must
// not be repeated to a stranger:
//
//   - a CODE only when the merchant published it on the storefront
//     (`show_on_storefront`, off by default since 0085): an unpublished code is
//     a staff, influencer or emailed code, and most of them redeem online
//     for anyone who has them;
//   - running NOW, filtered in the query, so ended, scheduled, used-up and
//     spent offers (which keep status 'active') cannot fill the slots and
//     leave the sheet saying "none" while one is running;
//   - online: no POS-only offer, nothing limited to one shop's location;
//   - no customer-group restriction: the group is the targeting;
//   - an automatic offer only while the store applies offers automatically;
//   - conditions are SAID, not dropped ("first order only", "only when paying
//     online"), so a first-order offer never reads as "on any order".
//
// Names come only from what the storefront shows: a published product, an
// active category. An item offer whose items are all hidden is left out.
// ---------------------------------------------------------------------------

/** One offer as customer-facing Mink may describe it to anyone who writes. */
export interface MinkShopperOffer {
  name: string;
  /** The code to type, for one the merchant published on the storefront;
   *  null for an offer that applies itself at checkout. */
  code: string | null;
  /** What it gives, in the offers list's words: "10% off the order". */
  reward: string;
  /** What an item reward is on, by name ("Almond Shake and Oat Cookies");
   *  null when the reward is on the order. */
  on: string | null;
  /** When it applies: "on any order", "when the basket includes Almond Shake". */
  when: string;
  /** Every other rule a shopper must meet, in plain words. */
  conditions: string[];
  validUntil: string | null;
}

/** Names listed per offer; past this, "and N more". */
const SHOPPER_NAMES_SHOWN = 4;

const PAYMENT_WORDS: Record<OfferPaymentMethod, string> = {
  cod: "by cash on delivery",
  razorpay: "online",
  pay_at_store: "at the store",
};

const FULFILMENT_WORDS: Record<OfferFulfilmentType, string> = {
  delivery: "home delivery",
  pickup: "store pickup",
};

const DAY_WORDS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "A", "A and B", "A, B and C", "A, B, C, D and 2 more" (or "… or 2 other
 *  items"). Pure. */
function listWords(words: string[], joiner: "and" | "or"): string {
  const unique = [...new Set(words)];
  if (unique.length <= 1) return unique[0] ?? "";
  if (unique.length > SHOPPER_NAMES_SHOWN) {
    const rest = unique.length - SHOPPER_NAMES_SHOWN;
    const tail =
      joiner === "and"
        ? `and ${rest} more`
        : `or ${rest} other ${rest === 1 ? "item" : "items"}`;
    return `${unique.slice(0, SHOPPER_NAMES_SHOWN).join(", ")} ${tail}`;
  }
  return `${unique.slice(0, -1).join(", ")} ${joiner} ${unique[unique.length - 1]}`;
}

function clock(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** An offer's extra rules in a shopper's words. Pure. */
export function describeShopperConditions(
  conditions: readonly OfferCondition[],
): string[] {
  return conditions.map((c): string => {
    switch (c.type) {
      case "first_order":
        return "first order only";
      case "payment_method":
        return `only when paying ${listWords(
          c.methods.map((m) => PAYMENT_WORDS[m]),
          "or",
        )}`;
      case "fulfilment_type":
        return `only for ${listWords(
          c.fulfilment.map((f) => FULFILMENT_WORDS[f]),
          "or",
        )} orders`;
      case "time_window": {
        const days =
          c.days.length >= 7
            ? "every day"
            : `on ${c.days.map((d) => DAY_WORDS[d] ?? "").join(", ")}`;
        return `only ${days} from ${clock(c.startMinute)} to ${clock(c.endMinute)} shop time`;
      }
      default: {
        const exhaustive: never = c;
        return exhaustive;
      }
    }
  });
}

/**
 * The offers a shopper could see on the storefront right now, best first,
 * at most `limit`. Throws on a failed read: the caller says the offers could
 * not be checked, never "none".
 */
export async function readMinkShopperOffers(
  actor: Pick<MinkActorContext, "storeId" | "effectivePlan">,
  input: { limit: number; now?: Date },
): Promise<{ offers: MinkShopperOffer[]; truncated: boolean }> {
  const at = (input.now ?? new Date()).toISOString();
  // Read past the limit: an offer whose conditions cannot be read, or whose
  // items are all hidden, is dropped below and must not leave a gap.
  const fetchLimit = Math.max(1, input.limit) * 2 + 1;
  const variantProduct = alias(products, "variant_product");

  const result = await withService(async (db) => {
    const storeRows = await db
      .select({ settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, actor.storeId))
      .limit(1);
    const stored = storeRows[0]?.settings;
    const settings = resolveStoreSettings(
      isRecord(stored) ? stored : {},
      actor.effectivePlan,
    );
    const autoApply = settings["offers.autoApply"] === true;

    const rows = await db
      .select({
        id: offers.id,
        name: offers.name,
        delivery: offers.delivery,
        code: offers.code,
        triggerType: offers.triggerType,
        triggerConfig: offers.triggerConfig,
        rewardType: offers.rewardType,
        rewardConfig: offers.rewardConfig,
        conditions: offers.conditions,
        channels: offers.channels,
        validUntil: offers.validUntil,
        maxPerCustomer: offers.maxPerCustomer,
      })
      .from(offers)
      .where(
        and(
          eq(offers.storeId, actor.storeId),
          eq(offers.status, "active"),
          // Running now: every blocker `offerAvailability` names, in SQL.
          or(isNull(offers.validFrom), lte(offers.validFrom, at)),
          or(isNull(offers.validUntil), gte(offers.validUntil, at)),
          or(
            isNull(offers.maxRedemptions),
            lt(offers.redemptionCount, offers.maxRedemptions),
          ),
          or(
            isNull(offers.budgetPaise),
            lt(offers.spentPaise, offers.budgetPaise),
          ),
          // Online: no channels means every channel.
          sql`(cardinality(${offers.channels}) = 0 or ${offers.channels} @> array['storefront']::text[])`,
          // ★ A code only when the merchant published it; an automatic offer
          // only while the store applies offers automatically.
          autoApply
            ? or(
                eq(offers.delivery, "automatic"),
                eq(offers.showOnStorefront, true),
              )
            : and(
                ne(offers.delivery, "automatic"),
                eq(offers.showOnStorefront, true),
              ),
          sql`not exists (select 1 from public.offer_user_groups g where g.offer_id = ${offers.id} and g.store_id = ${offers.storeId})`,
          sql`not exists (select 1 from public.offer_locations l where l.offer_id = ${offers.id} and l.store_id = ${offers.storeId})`,
        ),
      )
      .orderBy(desc(offers.priority), desc(offers.createdAt), desc(offers.id))
      .limit(fetchLimit);

    const offerIds = rows.map((row) => row.id);
    const scopeRows = offerIds.length
      ? await db
          .select({
            offerId: offerProducts.offerId,
            productName: products.name,
            variantName: productVariants.name,
            variantProductName: variantProduct.name,
            categoryName: categories.name,
          })
          .from(offerProducts)
          // ★ Joined only to what the storefront shows, so a draft product's
          // name never reaches a stranger; a hidden item reads as no name.
          // An item StoreMink has blocked is hidden too (takedown design 5.7,
          // review finding F6): the flag is in each join, because this read is
          // service-scope and the read policies that hide it never run.
          .leftJoin(
            products,
            and(
              eq(offerProducts.productId, products.id),
              eq(products.storeId, actor.storeId),
              eq(products.status, "published"),
              isNull(products.moderationBlockedAt),
            ),
          )
          .leftJoin(
            productVariants,
            and(
              eq(offerProducts.variantId, productVariants.id),
              eq(productVariants.storeId, actor.storeId),
            ),
          )
          .leftJoin(
            variantProduct,
            and(
              eq(productVariants.productId, variantProduct.id),
              eq(variantProduct.storeId, actor.storeId),
              eq(variantProduct.status, "published"),
              isNull(variantProduct.moderationBlockedAt),
            ),
          )
          .leftJoin(
            categories,
            and(
              eq(offerProducts.categoryId, categories.id),
              eq(categories.storeId, actor.storeId),
              eq(categories.status, "active"),
              isNull(categories.moderationBlockedAt),
            ),
          )
          .where(
            and(
              eq(offerProducts.storeId, actor.storeId),
              inArray(offerProducts.offerId, offerIds),
            ),
          )
          .limit(MAX_SCOPE_ROWS + 1)
      : [];

    const giftIds = [
      ...new Set(
        rows
          .map((row) => decodeReward(row.rewardType, row.rewardConfig))
          .flatMap((reward) =>
            reward.type === "free_item" && reward.giftProductId
              ? [reward.giftProductId]
              : [],
          ),
      ),
    ];
    // A gift is named only when the storefront shows it. A gift StoreMink
    // has blocked is read whatever its status, with the flag, so its offer is
    // left out below rather than told as a nameless "gift".
    const giftRows = giftIds.length
      ? await db
          .select({
            productId: products.id,
            productName: products.name,
            blockedAt: products.moderationBlockedAt,
          })
          .from(products)
          .where(
            and(
              eq(products.storeId, actor.storeId),
              or(
                eq(products.status, "published"),
                isNotNull(products.moderationBlockedAt),
              ),
              inArray(products.id, giftIds),
            ),
          )
      : [];
    return { rows, scopeRows, giftRows };
  });

  const scopeTruncated = result.scopeRows.length > MAX_SCOPE_ROWS;
  // Per offer: the scoped items a shopper can see, worded for what a reward
  // is ON ("everything in Snacks") and for what a basket must INCLUDE
  // ("anything from Snacks"). An offer with scope rows but no visible name is
  // scoped only to hidden items.
  const scopes = new Map<string, { on: string[]; includes: string[] }>();
  for (const row of result.scopeRows.slice(0, MAX_SCOPE_ROWS)) {
    const entry = scopes.get(row.offerId) ?? { on: [], includes: [] };
    const item =
      row.productName ??
      (row.variantName && row.variantProductName
        ? `${row.variantProductName} (${row.variantName})`
        : null);
    if (item) {
      entry.on.push(item);
      entry.includes.push(item);
    } else if (row.categoryName) {
      entry.on.push(`everything in ${row.categoryName}`);
      entry.includes.push(`anything from ${row.categoryName}`);
    }
    scopes.set(row.offerId, entry);
  }
  const blockedGifts = new Set(
    result.giftRows
      .filter((row) => row.blockedAt != null)
      .map((row) => row.productId),
  );
  const giftNames = new Map(
    result.giftRows
      .filter((row) => row.blockedAt == null)
      .map((row) => [row.productId, row.productName]),
  );

  const shown: MinkShopperOffer[] = [];
  for (const row of result.rows) {
    const decoded = decodeConditions(row.conditions);
    // The engine refuses an offer whose conditions it cannot read, so a
    // shopper is never told about it either.
    if (decoded.dropped) continue;
    // A code offer with no code has nothing to tell anyone.
    if (row.delivery !== "automatic" && !row.code) continue;
    const scope = scopes.get(row.id);
    // Scoped past the read's cap: its items are unknown, so it is not
    // described rather than described as "everything".
    if (!scope && scopeTruncated) continue;
    // Scoped only to items a shopper cannot see: nothing they could buy.
    if (scope && scope.on.length === 0) continue;

    const reward = decodeReward(row.rewardType, row.rewardConfig);
    // ★ A gift StoreMink has blocked is never given (the offer engine treats
    // it as unavailable), so the offer is not told at all.
    if (reward.giftProductId && blockedGifts.has(reward.giftProductId)) {
      continue;
    }
    const trigger = decodeTrigger(row.triggerType, row.triggerConfig);
    const names = scope ? listWords(scope.on, "and") : null;
    const anyOf = scope ? listWords(scope.includes, "or") : null;
    const onItems = rewardLevel(reward.type) === "line";
    const gift = reward.giftProductId
      ? giftNames.get(reward.giftProductId)
      : undefined;

    // ★ Scope means two things: what an item reward is ON, and for an order
    // reward what the basket must INCLUDE. Saying "10% off the order on
    // Almond Shake" would read as a discount on the shake.
    let when: string;
    if (isContentsTrigger(trigger.type)) {
      when = onItems
        ? "when the basket includes them"
        : `when the basket includes ${anyOf ?? "selected items"}`;
    } else {
      when = describeTrigger(trigger.type, trigger.minSubtotal);
      if (!onItems && anyOf) when += `, when the basket includes ${anyOf}`;
    }

    const rules = describeShopperConditions(decoded.conditions);
    const channels = Array.isArray(row.channels) ? row.channels : [];
    if (channels.length > 0 && !channels.includes("pos")) {
      rules.push("online orders only");
    }
    if (row.maxPerCustomer !== null && row.maxPerCustomer > 0) {
      rules.push(
        row.maxPerCustomer === 1
          ? "once per customer"
          : `up to ${row.maxPerCustomer} times per customer`,
      );
    }

    shown.push({
      name: row.name,
      code: row.delivery === "automatic" ? null : row.code,
      reward: describeReward(rewardDescriptor(reward), {
        giftName: gift ?? "gift",
      }),
      on: onItems ? names : null,
      when,
      conditions: rules,
      validUntil: row.validUntil,
    });
  }

  return {
    offers: shown.slice(0, input.limit),
    truncated: shown.length > input.limit || result.rows.length === fetchLimit,
  };
}
