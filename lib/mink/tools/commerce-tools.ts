import "server-only";

import { and, count, eq, gte, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { runExploration } from "@/app/dashboard/analytics/reports/explore-data";
import {
  emailCampaigns,
  newsletterSubscribers,
  products,
  storeLocations,
  storeLogisticsProviders,
  storePaymentProviders,
  storeSmsProviders,
  storeWhatsappAccounts,
  stores,
} from "@/drizzle/schema";
import { normalizeExploreConfig } from "@/lib/analytics/explore";
import { resolveMerchantPixelSettings } from "@/lib/analytics/merchant-pixels";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { storeHasAnalyticsFeature } from "@/lib/analytics/store-entitlement";
import { withService, withUser } from "@/lib/db/client";
import {
  locationCan,
  normalizeCapabilities,
  type LocationType,
} from "@/lib/locations/capabilities";
import { readShippingSettings } from "@/lib/shipping/quote";
import { readMinkCurrentOffers } from "../offers-read";
import type { MinkArtifact } from "../types";
import type { MinkTool } from "./registry";

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

type Finding = {
  id: string;
  severity: "blocker" | "warning" | "ok";
  title: string;
  detail: string;
};

/**
 * `get_shipping_settings`: what a shopper is charged for delivery and what
 * could stop them checking out, read from the same rows Settings uses.
 *
 * ★ FINDINGS ARE DETERMINISTIC. The audit the Sidekick "/shipping-audit"
 * skill performs is a fixed list of checks (a live-rate mode with no carrier
 * connected, no location that fulfils online orders, shippable products with
 * no weight, a flat rate of zero), each named with the page that fixes it.
 * The model explains them; it does not decide them.
 */
export const getShippingSettings: MinkTool = {
  declaration: {
    name: "get_shipping_settings",
    description:
      "Read the store's delivery settings and audit them: the rate mode (free, one flat rate, or live Shiprocket rates), the free-delivery threshold, the delivery-day promise and handling time, the carrier connection state, which locations fulfil online orders or offer pickup, and how many shippable products have no weight. Returns a fixed list of findings (blocker, warning or ok) with the settings page that fixes each one. Use it for 'audit my shipping', 'why is delivery expensive' or 'can customers check out'. It cannot change any setting.",
    parametersJsonSchema: EMPTY_OBJECT_SCHEMA,
  },
  permission: { section: "settings", action: "view" },
  timeoutMs: 8_000,
  artifact: findingsArtifact("Shipping audit", "/dashboard/settings/shipping"),
  async execute(actor) {
    const [settings, locations, carrier, products_] = await Promise.all([
      readShippingSettings(actor.storeId),
      withUser({ uid: actor.adminId, email: actor.email }, (db) =>
        db
          .select({
            id: storeLocations.id,
            name: storeLocations.name,
            type: storeLocations.type,
            active: storeLocations.active,
            capabilities: storeLocations.capabilities,
          })
          .from(storeLocations)
          .where(eq(storeLocations.storeId, actor.storeId))
          .limit(50),
      ),
      withService((db) =>
        db
          .select({ enabled: storeLogisticsProviders.enabled })
          .from(storeLogisticsProviders)
          .where(
            and(
              eq(storeLogisticsProviders.storeId, actor.storeId),
              eq(storeLogisticsProviders.provider, "shiprocket"),
            ),
          )
          .limit(1),
      ),
      withUser({ uid: actor.adminId, email: actor.email }, (db) =>
        db
          .select({
            shippable: count(),
            missingWeight: sql<number>`count(*) filter (where ${products.weightGrams} is null)`,
          })
          .from(products)
          .where(
            and(
              eq(products.storeId, actor.storeId),
              eq(products.status, "published"),
              eq(products.requiresShipping, true),
            ),
          ),
      ),
    ]);
    const plan = actor.effectivePlan;
    const fulfilling = locations.filter(
      (location) =>
        location.active &&
        locationCan(capabilitiesOf(location), "online_fulfil", {
          plan,
        }),
    );
    const pickup = locations.filter(
      (location) =>
        location.active &&
        locationCan(capabilitiesOf(location), "pickup", {
          plan,
        }),
    );
    const carrierConnected = carrier[0]?.enabled === true;
    const shippable = Number(products_[0]?.shippable ?? 0);
    const missingWeight = Number(products_[0]?.missingWeight ?? 0);

    const findings: Finding[] = [];
    if (settings.mode === "shiprocket" && !carrierConnected) {
      findings.push({
        id: "carrier",
        severity: "blocker",
        title: "Live rates are on but Shiprocket is not connected",
        detail:
          "Checkout cannot quote delivery, so shoppers see the fallback option. Connect Shiprocket under Channels or switch to a flat or free rate.",
      });
    }
    if (fulfilling.length === 0) {
      findings.push({
        id: "fulfil",
        severity: "blocker",
        title: "No location fulfils online orders",
        detail:
          "Every online order needs a location with online fulfilment switched on. Turn it on under Locations.",
      });
    }
    if (settings.mode === "flat" && settings.flatRate <= 0) {
      findings.push({
        id: "flat_zero",
        severity: "warning",
        title: "The flat delivery rate is zero",
        detail:
          "Delivery is effectively free. If that is not intended, set the rate under Shipping & delivery.",
      });
    }
    if (settings.mode === "shiprocket" && missingWeight > 0) {
      findings.push({
        id: "weights",
        severity: "warning",
        title: `${missingWeight} shippable product${missingWeight === 1 ? " has" : "s have"} no weight`,
        detail:
          "Live rates fall back to a 500 g parcel for these, which can under- or over-charge. Add weights in the product editor.",
      });
    }
    if (settings.mode !== "free" && settings.freeAbove === null) {
      findings.push({
        id: "free_above",
        severity: "ok",
        title: "No free-delivery threshold",
        detail:
          "A threshold such as free delivery above a basket value is a common way to lift order size. Optional.",
      });
    }
    if (settings.mode !== "shiprocket" && settings.manualMaxDays > 10) {
      findings.push({
        id: "slow_promise",
        severity: "warning",
        title: `Delivery promise is up to ${settings.manualMaxDays} days`,
        detail: "A long promise on the product page can cost conversions.",
      });
    }
    if (findings.length === 0 || findings.every((f) => f.severity === "ok")) {
      findings.unshift({
        id: "healthy",
        severity: "ok",
        title: "Delivery settings look complete",
        detail: "Shoppers can check out with the current settings.",
      });
    }

    return {
      settings: {
        mode: settings.mode,
        flatRate: settings.flatRate,
        freeAbove: settings.freeAbove,
        deliveryDays:
          settings.mode === "shiprocket"
            ? null
            : { min: settings.manualMinDays, max: settings.manualMaxDays },
        handlingDays: settings.handlingDays,
        carrierAdjustment:
          settings.carrierAdjustmentType === "none"
            ? null
            : {
                type: settings.carrierAdjustmentType,
                value: settings.carrierAdjustmentValue,
              },
        showAllCouriers: settings.showAllCouriers,
      },
      carrier: { provider: "shiprocket", connected: carrierConnected },
      locations: {
        fulfillingOnline: fulfilling.map((l) => ({
          name: l.name,
          type: l.type,
        })),
        offeringPickup: pickup.map((l) => ({ name: l.name, type: l.type })),
      },
      products: { shippable, missingWeight },
      findings,
      dashboardPath: "/dashboard/settings/shipping",
      dataAsOf: new Date().toISOString(),
    };
  },
};

/**
 * `get_marketing_channels`: where the store can reach customers and how
 * each channel is doing, in one read.
 *
 * ★ CONNECTION STATE ONLY, NEVER A CREDENTIAL, and only for an admin who
 * can see Channels; the marketing counts need the Marketing section. Pixels
 * are read from the store's public settings the way the storefront reads
 * them. Traffic sources come from the Reports builder on Pro and are simply
 * absent below it.
 */
export const getMarketingChannels: MinkTool = {
  declaration: {
    name: "get_marketing_channels",
    description:
      "Read the store's marketing picture in one call: which channels are connected (online payments, Shiprocket, SMS, WhatsApp), how many offers are running, coupon email campaigns in the last 90 days by status, newsletter subscribers, whether GA4 and Meta Pixel are set up, and on Pro the top storefront traffic sources for the last 30 days. Use it for 'how is my marketing', 'which channels do I have', 'where do my visitors come from' or before suggesting a campaign. Connection state only: it never reveals keys or tokens, and it changes nothing.",
    parametersJsonSchema: EMPTY_OBJECT_SCHEMA,
  },
  permission: { section: "marketing", action: "view" },
  timeoutMs: 12_000,
  artifact: marketingArtifact,
  async execute(actor) {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const canSeeChannels = can(
      actor.permissions,
      "channels",
      "view",
      actor.isSuperadmin,
    );
    const [channels, campaigns, subscribers, offers, storeRow, trafficAllowed] =
      await Promise.all([
        canSeeChannels
          ? withService(async (db) => {
              const [payments, logistics, sms, whatsapp] = await Promise.all([
                db
                  .select({ enabled: storePaymentProviders.enabled })
                  .from(storePaymentProviders)
                  .where(eq(storePaymentProviders.storeId, actor.storeId))
                  .limit(1),
                db
                  .select({ enabled: storeLogisticsProviders.enabled })
                  .from(storeLogisticsProviders)
                  .where(
                    and(
                      eq(storeLogisticsProviders.storeId, actor.storeId),
                      eq(storeLogisticsProviders.provider, "shiprocket"),
                    ),
                  )
                  .limit(1),
                db
                  .select({ enabled: storeSmsProviders.enabled })
                  .from(storeSmsProviders)
                  .where(eq(storeSmsProviders.storeId, actor.storeId))
                  .limit(1),
                db
                  .select({
                    status: storeWhatsappAccounts.status,
                    enabled: storeWhatsappAccounts.enabled,
                  })
                  .from(storeWhatsappAccounts)
                  .where(eq(storeWhatsappAccounts.storeId, actor.storeId))
                  .limit(1),
              ]);
              const state = (row?: { enabled: boolean }) =>
                !row ? "not_connected" : row.enabled ? "connected" : "paused";
              return {
                onlinePayments: state(payments[0]),
                shiprocket: state(logistics[0]),
                sms: state(sms[0]),
                whatsapp: !whatsapp[0]
                  ? "not_connected"
                  : whatsapp[0].status !== "connected"
                    ? whatsapp[0].status
                    : whatsapp[0].enabled
                      ? "connected"
                      : "paused",
              };
            })
          : Promise.resolve(null),
        withUser({ uid: actor.adminId, email: actor.email }, (db) =>
          db
            .select({ status: emailCampaigns.status, total: count() })
            .from(emailCampaigns)
            .where(
              and(
                eq(emailCampaigns.storeId, actor.storeId),
                gte(emailCampaigns.createdAt, since),
              ),
            )
            .groupBy(emailCampaigns.status),
        ),
        withUser({ uid: actor.adminId, email: actor.email }, (db) =>
          db
            .select({ total: count() })
            .from(newsletterSubscribers)
            .where(
              and(
                eq(newsletterSubscribers.storeId, actor.storeId),
                eq(newsletterSubscribers.status, "active"),
              ),
            ),
        ).catch(() => [{ total: 0 }]),
        readMinkCurrentOffers(actor, { limit: 20 }),
        withService((db) =>
          db
            .select({ settings: stores.settings })
            .from(stores)
            .where(eq(stores.id, actor.storeId))
            .limit(1),
        ),
        storeHasAnalyticsFeature(actor.storeId, "storefrontConversion"),
      ]);

    const settings = (storeRow[0]?.settings ?? {}) as Record<string, unknown>;
    const pixels = resolveMerchantPixelSettings(settings);
    const runningOffers = offers.runningCount;
    const listedOffers = offers.offers.length;

    let trafficSources: Array<{ source: string; sessions: number }> = [];
    if (trafficAllowed) {
      try {
        const range = parseAnalyticsRange(
          { range: "30d", compare: "none" },
          actor.analyticsTimeZone,
        );
        const result = await runExploration({
          storeId: actor.storeId,
          location: {
            locationIds: actor.locationIds,
            selectedId: null,
            includeUnassigned: true,
          },
          range,
          config: normalizeExploreConfig(
            {
              dataset: "traffic",
              metrics: ["sessions"],
              dimension: "source",
              chart: "bar",
            },
            { trafficAllowed: true },
          ),
        });
        trafficSources = result.rows.slice(0, 5).map((row) => ({
          source: row.label,
          sessions: Math.round(row.values[0] ?? 0),
        }));
      } catch {
        trafficSources = [];
      }
    }

    const campaignCounts = Object.fromEntries(
      campaigns.map((row) => [row.status, Number(row.total)]),
    );
    return {
      channels: channels ?? {
        note: "Channel connection state needs the Channels permission.",
      },
      offers: {
        running: runningOffers,
        listed: listedOffers,
        automaticOffersEnabled: offers.automaticOffersEnabled,
      },
      campaignsLast90Days: campaignCounts,
      newsletterSubscribers: Number(subscribers[0]?.total ?? 0),
      pixels: {
        ga4:
          pixels.ga4Enabled && pixels.ga4MeasurementId
            ? "configured"
            : "not_set",
        metaPixel:
          pixels.metaPixelEnabled && pixels.metaPixelId
            ? "configured"
            : "not_set",
      },
      trafficSourcesLast30Days: trafficAllowed
        ? trafficSources
        : {
            note: "Storefront traffic needs the Pro plan with storefront analytics.",
          },
      dashboardPaths: {
        offers: "/dashboard/offers",
        channels: "/dashboard/channels",
        analyticsSettings: "/dashboard/settings/analytics",
      },
      dataAsOf: new Date().toISOString(),
    };
  },
};

function capabilitiesOf(location: { type: string; capabilities: unknown }) {
  return normalizeCapabilities(
    location.capabilities,
    location.type as LocationType,
  );
}

function findingsArtifact(title: string, dashboardPath: string) {
  return (output: Record<string, unknown>): MinkArtifact | undefined => {
    const findings = output.findings as Finding[] | undefined;
    if (!Array.isArray(findings) || findings.length === 0) return undefined;
    return {
      type: "records",
      title,
      recordType: "storefront",
      records: findings.slice(0, 10).map((finding) => ({
        id: finding.id,
        title: finding.title,
        subtitle: finding.detail,
        status:
          finding.severity === "blocker"
            ? "Needs attention"
            : finding.severity === "warning"
              ? "Worth a look"
              : "OK",
        dashboardPath,
      })),
      filters: [],
      dashboardPath,
      ...(typeof output.dataAsOf === "string"
        ? { dataAsOf: output.dataAsOf }
        : {}),
    };
  };
}

function marketingArtifact(
  output: Record<string, unknown>,
): MinkArtifact | undefined {
  const offers = output.offers as { running: number } | undefined;
  const campaigns = output.campaignsLast90Days as
    | Record<string, number>
    | undefined;
  if (!offers || !campaigns) return undefined;
  const sent = Object.entries(campaigns)
    .filter(([status]) => status === "sent" || status === "completed")
    .reduce((sum, [, total]) => sum + total, 0);
  return {
    type: "metrics",
    title: "Marketing at a glance",
    metrics: [
      { label: "Running offers", value: offers.running, format: "number" },
      { label: "Campaigns sent (90 days)", value: sent, format: "number" },
      {
        label: "Newsletter subscribers",
        value: Number(output.newsletterSubscribers ?? 0),
        format: "number",
      },
    ],
    filters: [],
    dashboardPath: "/dashboard/offers",
    ...(typeof output.dataAsOf === "string"
      ? { dataAsOf: output.dataAsOf }
      : {}),
  };
}
