import Link from "next/link";
import { Lock } from "lucide-react";
import { AnalyticsCard } from "../../components/analytics-card";
import { formatAnalyticsValue } from "../../components/analytics-format";
import { RankedBars } from "../../components/analytics-lists";
import { RealtimeRefresher } from "../../components/realtime-refresher";
import { getActingStoreId, requireSectionAccess } from "../../lib/access";
import { getAnalyticsLocationOptions, getSalesAnalytics } from "../data";
import { getLiveOrders, getLiveTraffic, type LiveActivity } from "./data";
import { AnalyticsTabs } from "../analytics-tabs";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { getStoreAnalyticsTimeZone } from "@/lib/analytics/settings";
import { resolveAnalyticsLocation } from "@/lib/analytics/location";
import { getViewerLocations } from "@/lib/locations/scope";
import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";
import { analyticsFeatureAllowed } from "@/lib/analytics/features";
import { getStorePlanContext } from "@/lib/plans/entitlements";

export const metadata = { title: "Live View · Analytics" };

// Live View is on every plan; the visitor panels read first-party storefront
// events, which are collected for Pro stores only, so below Pro they show what
// Pro adds instead of empty zeros.

const REFRESH_MS = 15_000;

function ago(iso: string, now: number): string {
  const seconds = Math.max(
    0,
    Math.round((now - new Date(iso).getTime()) / 1000),
  );
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

function describe(event: LiveActivity): string {
  const product = event.product ?? "a product";
  const who = event.where ? `Someone in ${event.where}` : "A visitor";
  if (event.kind === "product_view") return `${who} viewed ${product}`;
  if (event.kind === "add_to_cart") return `${who} added ${product} to cart`;
  if (event.kind === "checkout_start") return `${who} started checkout`;
  return event.amount !== null
    ? `${who} placed an order for ${formatAnalyticsValue(event.amount, "currency")}`
    : `${who} placed an order`;
}

function LiveStat({
  label,
  value,
  hint,
  live = false,
}: {
  label: string;
  value: string;
  hint?: string;
  live?: boolean;
}) {
  return (
    <div className="dash-metric dash-live-stat">
      <div className="dash-metric-top">
        <span className="dash-an-title">{label}</span>
        {live ? <span className="dash-live-dot" aria-hidden /> : null}
      </div>
      <div className="dash-metric-row">
        <span className="dash-metric-val">{value}</span>
      </div>
      {hint ? <p className="dash-metric-note">{hint}</p> : null}
    </div>
  );
}

function ProLocked({
  title,
  text,
  canUpgrade,
}: {
  title: string;
  text: string;
  canUpgrade: boolean;
}) {
  return (
    <AnalyticsCard title={title}>
      <div className="dash-live-locked">
        <span className="dash-an-plan-badge is-pro">
          <Lock aria-hidden /> Pro
        </span>
        <p>{text}</p>
        {canUpgrade ? (
          <Link href="/dashboard/plans" className="dash-an-upsell-cta">
            See Pro
          </Link>
        ) : (
          <span className="dash-an-upsell-note">
            Ask your store owner to upgrade to Pro.
          </span>
        )}
      </div>
    </AnalyticsCard>
  );
}

export default async function LiveViewPage() {
  const access = await requireSectionAccess("analytics", "view");
  const canUpgrade = access.can("ai", "view");
  const [storeId, locationScope, platformFeatures] = await Promise.all([
    getActingStoreId(),
    getViewerLocations(),
    getPlatformAnalyticsFeatures(),
  ]);
  const [{ plan }, timeZone, locationOptions] = await Promise.all([
    getStorePlanContext(storeId),
    getStoreAnalyticsTimeZone(storeId),
    getAnalyticsLocationOptions(storeId, locationScope),
  ]);
  const today = parseAnalyticsRange(
    { range: "today", compare: "none" },
    timeZone,
  );
  const location = resolveAnalyticsLocation(
    undefined,
    locationScope,
    locationOptions,
  );
  const hasVisitors = analyticsFeatureAllowed(
    platformFeatures,
    "storefrontConversion",
    plan,
  );
  const [sales, liveOrders, traffic] = await Promise.all([
    getSalesAnalytics(storeId, location, today),
    getLiveOrders(storeId, today.current.from),
    hasVisitors ? getLiveTraffic(storeId, today.current.from) : null,
  ]);
  // A server render: "now" is this request's time, read once.
  const renderedAt = new Date();
  const now = renderedAt.getTime();
  const updated = new Intl.DateTimeFormat("en-IN", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(renderedAt);

  return (
    <div className="dash-analytics dash-live">
      <RealtimeRefresher
        tables={["storefront_events", "orders"]}
        intervalMs={REFRESH_MS}
      />
      <header className="dash-an-head">
        <div className="dash-live-heading">
          <h1>
            Live View <span className="dash-live-dot is-large" aria-hidden />
          </h1>
        </div>
        <p className="dash-live-updated">
          Updated {updated} · refreshes every {REFRESH_MS / 1000} seconds
        </p>
      </header>
      <AnalyticsTabs active="live" />

      <section className="dash-section">
        <div className="dash-canvas">
          <div className="dash-widget size-compact">
            <LiveStat
              label="Visitors right now"
              value={
                traffic ? traffic.visitorsNow.toLocaleString("en-IN") : "-"
              }
              hint={
                traffic
                  ? "Active in the last 5 minutes"
                  : "Pro shows who is on your store"
              }
              live={Boolean(traffic)}
            />
          </div>
          <div className="dash-widget size-compact">
            <LiveStat
              label="Total sales today"
              value={formatAnalyticsValue(sales.totalSales.value, "currency")}
            />
          </div>
          <div className="dash-widget size-compact">
            <LiveStat
              label="Visitors today"
              value={
                traffic ? traffic.visitorsToday.toLocaleString("en-IN") : "-"
              }
              hint={traffic ? undefined : "Available on Pro"}
            />
          </div>
          <div className="dash-widget size-compact">
            <LiveStat
              label="Orders today"
              value={sales.orders.value.toLocaleString("en-IN")}
            />
          </div>
        </div>
      </section>

      <section className="dash-section">
        <h2>Customer behaviour</h2>
        {traffic ? (
          <div className="dash-canvas">
            <div className="dash-widget size-full">
              <div className="dash-an-card dash-live-behaviour">
                {[
                  [
                    "Active carts",
                    traffic.activeCarts,
                    "Added to cart, not yet at checkout",
                  ],
                  [
                    "Checking out",
                    traffic.checkingOut,
                    "Started checkout, not yet paid",
                  ],
                  ["Purchased", traffic.purchased, "Placed an order"],
                ].map(([label, value, hint]) => (
                  <div
                    key={label as string}
                    className="dash-live-behaviour-step"
                  >
                    <span className="dash-an-title">{label}</span>
                    <strong>{(value as number).toLocaleString("en-IN")}</strong>
                    <span className="dash-live-hint">{hint}</span>
                  </div>
                ))}
                <p className="dash-live-window">In the last 10 minutes</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="dash-canvas">
            <div className="dash-widget size-full">
              <ProLocked
                title="Carts and checkouts, live"
                text="See who has a cart, is checking out or just bought, as it happens."
                canUpgrade={canUpgrade}
              />
            </div>
          </div>
        )}
      </section>

      <section className="dash-section">
        <h2>Right now</h2>
        <div className="dash-canvas">
          {traffic ? (
            <>
              <div className="dash-widget size-half">
                <AnalyticsCard title="Top locations" subtitle="Last 30 minutes">
                  <RankedBars
                    format="number"
                    emptyText="No visitor locations in the last 30 minutes"
                    rows={traffic.topLocations.map((row) => ({
                      key: row.key,
                      label: row.label,
                      value: row.visitors,
                      previous: null,
                    }))}
                  />
                </AnalyticsCard>
              </div>
              <div className="dash-widget size-half">
                <AnalyticsCard
                  title="Top products"
                  subtitle="Viewed or added to cart, last 30 minutes"
                >
                  <RankedBars
                    format="number"
                    emptyText="No product activity in the last 30 minutes"
                    rows={traffic.topProducts.map((row) => ({
                      key: row.key,
                      label: row.name,
                      value: row.visitors,
                      previous: null,
                    }))}
                  />
                </AnalyticsCard>
              </div>
              <div className="dash-widget size-half">
                <AnalyticsCard title="Live activity" subtitle="Last 30 minutes">
                  {traffic.activity.length === 0 ? (
                    <div className="dash-an-empty">
                      No shopping activity in the last 30 minutes
                    </div>
                  ) : (
                    <ul className="dash-live-feed">
                      {traffic.activity.map((event) => (
                        <li key={event.id} className={`is-${event.kind}`}>
                          <span className="dash-live-feed-dot" aria-hidden />
                          <span className="dash-live-feed-text">
                            {describe(event)}
                          </span>
                          <time dateTime={event.at}>{ago(event.at, now)}</time>
                        </li>
                      ))}
                    </ul>
                  )}
                </AnalyticsCard>
              </div>
            </>
          ) : (
            <div className="dash-widget size-half">
              <ProLocked
                title="Who is shopping right now"
                text="Top locations, products being viewed, and a live feed of shopper activity."
                canUpgrade={canUpgrade}
              />
            </div>
          )}
          <div className="dash-widget size-half">
            <AnalyticsCard title="Latest orders" subtitle="Today">
              {liveOrders.length === 0 ? (
                <div className="dash-an-empty">No orders yet today</div>
              ) : (
                <ul className="dash-live-feed">
                  {liveOrders.map((order) => (
                    <li key={order.id} className="is-purchase">
                      <span className="dash-live-feed-dot" aria-hidden />
                      <Link
                        href={`/dashboard/orders?q=${encodeURIComponent(order.ref)}`}
                        className="dash-live-feed-text"
                      >
                        Order {order.ref || "placed"} ·{" "}
                        {formatAnalyticsValue(order.total, "currency")}
                      </Link>
                      <time dateTime={order.at}>{ago(order.at, now)}</time>
                    </li>
                  ))}
                </ul>
              )}
            </AnalyticsCard>
          </div>
        </div>
      </section>
      <p className="dash-live-footnote">
        Visitors are counted only after they allow analytics on your storefront.
      </p>
    </div>
  );
}
