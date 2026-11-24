import type { ReactNode } from "react";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { storeBillingSettings } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { brandFromSettings } from "@/lib/store/brand";
import { storeOrigin } from "@/lib/site";
import {
  analyticsTimeZoneFromSettings,
  analyticsTimeZoneLabel,
} from "@/lib/analytics/range";
import { PLAN_META, effectivePlan } from "@/lib/plans";
import { logWarn } from "@/lib/observability/logger";
import type { ViewerAccess } from "@/app/dashboard/lib/access";
import { BusinessTimeZoneForm } from "./business-time-zone-form";

/**
 * Settings, General: the store at a glance, read from where each fact is
 * edited, with a link to that page. Only the time zone is changed here.
 *
 * Two reads. The store row (details, time zone and plan all come from it,
 * the plan through effectivePlan as in the dashboard layout) is the
 * request's own host lookup, which the dashboard layout already made, so it
 * costs nothing more. getCurrentStoreOrNull, never getCurrentStore: that one
 * answers a database error with the fallback store, and General would then
 * show another store's details. Then, for someone with Taxes & invoices, the
 * business details. Each fails on its own: a card that cannot load says so,
 * and the rest of the page still shows.
 */
export async function GeneralSettings({ access }: { access: ViewerAccess }) {
  const canBilling = access.can("billing", "view");
  const store = await getCurrentStoreOrNull().catch(failed("store"));
  const business =
    canBilling && store
      ? await withService((db) =>
          db
            .select({
              name: storeBillingSettings.businessName,
              address: storeBillingSettings.businessAddress,
              taxId: storeBillingSettings.taxId,
            })
            .from(storeBillingSettings)
            .where(eq(storeBillingSettings.storeId, store.id))
            .limit(1),
        )
          .then((rows) => rows[0] ?? null)
          .catch(failed("business"))
      : canBilling
        ? undefined
        : null;

  const brand = store
    ? brandFromSettings(store.settings, store.name, "")
    : null;
  const address = store ? storeOrigin(store) : null;
  const timeZone = store ? analyticsTimeZoneFromSettings(store.settings) : null;
  const plan = store ? effectivePlan(store) : null;
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
                    className="text-[var(--dash-accent-hover)] hover:underline"
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
                {/* The business name the Edit page saves, never the legal
                    name: Taxes & invoices cannot change that, so showing it
                    here would make Edit look as if it did nothing. */}
                <Row label="Business name">
                  {business?.name?.trim() || <Missing />}
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
                <Row label="Time zone">{analyticsTimeZoneLabel(timeZone)}</Row>
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
              <Row label="Current plan">{PLAN_META[plan].name}</Row>
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
    <section className="dash-card">
      <header className="dash-card-header">
        <h2 className="dash-card-title">{title}</h2>
        {action}
      </header>
      <div className="dash-card-body">{children}</div>
    </section>
  );
}

function EditLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-8 items-center rounded-md px-2.5 text-[13px] font-medium text-[var(--dash-accent-hover)] hover:bg-[var(--dash-accent-soft)]"
    >
      {children}
    </Link>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <dl className="divide-y divide-[var(--dash-border)]">{children}</dl>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 text-[13px] first:pt-0 last:pb-0 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-[var(--dash-text-2)]">{label}</dt>
      <dd className="min-w-0 break-words text-[var(--dash-text)]">
        {children}
      </dd>
    </div>
  );
}

function Missing() {
  return <span className="text-[var(--dash-text-2)]">Not added</span>;
}

function CouldNotLoad() {
  return (
    <p className="text-[13px] text-[var(--dash-text-2)]">
      This couldn&apos;t be loaded. Refresh the page to try again.
    </p>
  );
}
