import type { ReactNode } from "react";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { storeBillingSettings } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { lookupStoreById } from "@/lib/store/resolve";
import { brandFromSettings } from "@/lib/store/brand";
import { storeOrigin } from "@/lib/site";
import { getStoreAnalyticsTimeZone } from "@/lib/analytics/settings";
import { COMMON_ANALYTICS_TIME_ZONES } from "@/lib/analytics/range";
import { getStorePlanContext } from "@/lib/plans/entitlements";
import { PLAN_META } from "@/lib/plans";
import { logWarn } from "@/lib/observability/logger";
import type { ViewerAccess } from "@/app/dashboard/lib/access";
import { BusinessTimeZoneForm } from "./business-time-zone-form";

/**
 * Settings, General: the store at a glance, read from where each fact is
 * edited, with a link to that page. Only the time zone is changed here.
 *
 * Every read fails on its own: a card that cannot load says so, and the rest
 * of the page still shows.
 */
export async function GeneralSettings({
  access,
  storeId,
}: {
  access: ViewerAccess;
  storeId: string;
}) {
  const canBilling = access.can("billing", "view");
  const [store, business, timeZone, plan] = await Promise.all([
    lookupStoreById(storeId).catch(failed("store")),
    canBilling
      ? withService((db) =>
          db
            .select({
              name: storeBillingSettings.businessName,
              legalName: storeBillingSettings.legalName,
              address: storeBillingSettings.businessAddress,
              taxId: storeBillingSettings.taxId,
            })
            .from(storeBillingSettings)
            .where(eq(storeBillingSettings.storeId, storeId))
            .limit(1),
        )
          .then((rows) => rows[0] ?? null)
          .catch(failed("business"))
      : Promise.resolve(null),
    getStoreAnalyticsTimeZone(storeId).catch(failed("time zone")),
    getStorePlanContext(storeId).catch(failed("plan")),
  ]);

  const brand = store
    ? brandFromSettings(store.settings, store.name, "")
    : null;
  const address = store ? storeOrigin(store) : null;
  const canManageSettings = access.can("settings", "manage");

  return (
    <div className="dash-page-enter mx-auto w-full max-w-3xl">
      <header className="dash-page-header">
        <h1>General</h1>
      </header>

      <div className="mt-5 space-y-4">
        <Card
          title="Store details"
          action={
            access.can("branding", "view") ? (
              <EditLink href="/dashboard/branding">Edit</EditLink>
            ) : null
          }
        >
          {brand ? (
            <Rows>
              <Row label="Store name">{brand.name}</Row>
              <Row label="Store address">
                {address ? (
                  <a
                    href={address}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#4338ca] hover:underline"
                  >
                    {address.replace(/^https:\/\//, "")}
                  </a>
                ) : (
                  <Missing />
                )}
              </Row>
              <Row label="Contact email">{brand.email ?? <Missing />}</Row>
              <Row label="Contact phone">{brand.phone ?? <Missing />}</Row>
            </Rows>
          ) : (
            <CouldNotLoad />
          )}
        </Card>

        {canBilling ? (
          <Card
            title="Business details"
            action={<EditLink href="/dashboard/billing">Edit</EditLink>}
          >
            {business === undefined ? (
              <CouldNotLoad />
            ) : (
              <Rows>
                <Row label="Business name">
                  {business?.legalName ?? business?.name ?? <Missing />}
                </Row>
                <Row label="Business address">
                  {business?.address ? (
                    <span className="whitespace-pre-line">
                      {business.address}
                    </span>
                  ) : (
                    <Missing />
                  )}
                </Row>
                <Row label="GSTIN">{business?.taxId ?? <Missing />}</Row>
              </Rows>
            )}
          </Card>
        ) : null}

        {timeZone && canManageSettings ? (
          <BusinessTimeZoneForm timeZone={timeZone} />
        ) : (
          <Card title="Business time zone">
            {timeZone ? (
              <Rows>
                <Row label="Time zone">{timeZoneLabel(timeZone)}</Row>
              </Rows>
            ) : (
              <CouldNotLoad />
            )}
          </Card>
        )}

        <Card
          title="Plan"
          action={
            access.can("ai", "view") ? (
              <EditLink href="/dashboard/plans">Plans &amp; Billing</EditLink>
            ) : null
          }
        >
          {plan ? (
            <Rows>
              <Row label="Current plan">{PLAN_META[plan.plan].name}</Row>
            </Rows>
          ) : (
            <CouldNotLoad />
          )}
        </Card>
      </div>
    </div>
  );
}

function failed(what: string) {
  return (error: unknown) => {
    logWarn("settings.general: read failed", {
      what,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  };
}

function timeZoneLabel(timeZone: string): string {
  return (
    COMMON_ANALYTICS_TIME_ZONES.find(([value]) => value === timeZone)?.[1] ??
    timeZone
  );
}

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[10px] border border-[#e5e5e5] bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-medium text-[#1a1a1a]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function EditLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-8 items-center rounded-md px-2.5 text-[13px] font-medium text-[#4338ca] hover:bg-[#eef2ff]"
    >
      {children}
    </Link>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <dl className="divide-y divide-[#f0f0f0]">{children}</dl>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 text-[13px] first:pt-0 last:pb-0 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-[#5b6472]">{label}</dt>
      <dd className="min-w-0 break-words text-[#1a1a1a]">{children}</dd>
    </div>
  );
}

function Missing() {
  return <span className="text-[#5b6472]">Not added</span>;
}

function CouldNotLoad() {
  return (
    <p className="text-[13px] text-[#5b6472]">
      This couldn&apos;t be loaded. Refresh the page to try again.
    </p>
  );
}
