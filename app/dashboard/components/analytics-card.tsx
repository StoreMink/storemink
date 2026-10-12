"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { Popover } from "@base-ui/react/popover";
import { ArrowUpRight, Lock } from "lucide-react";

// The one card frame every Analytics widget shares, so titles, report links,
// definitions and locked states look and behave the same everywhere.
//
// ★ Popups portal to document.body, OUTSIDE `.dashboard-shell`, so each popup
// carries the scope class itself (same reason as components/ui/dialog.tsx);
// without it every var(--dash-*) inside resolves to nothing.

export type UpgradePlan = "basic" | "pro";

export interface ReportLock {
  plan: UpgradePlan;
  /** Whether this viewer may open Plan & billing; staff without it are told to ask. */
  canUpgrade: boolean;
}

const PLAN_NAME: Record<UpgradePlan, string> = { basic: "Basic", pro: "Pro" };

/** A card title with a dotted underline that explains the metric on hover. */
export function MetricTitle({
  title,
  definition,
  href,
  className = "",
}: {
  title: string;
  definition?: string;
  href?: string;
  className?: string;
}) {
  const classes = `dash-an-title${href ? " is-link" : ""} ${className}`;
  if (!definition) {
    return href ? (
      <Link href={href} className={classes}>
        {title}
      </Link>
    ) : (
      <span className={classes}>{title}</span>
    );
  }
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={250}
        closeOnClick={false}
        render={
          href ? (
            <Link href={href} className={classes} />
          ) : (
            <span className={classes} tabIndex={0} />
          )
        }
      >
        {title}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner
          className="isolate z-50"
          side="top"
          align="start"
          sideOffset={6}
        >
          <Tooltip.Popup className="dashboard-shell dash-an-tip">
            <strong>{title}</strong>
            <span>{definition}</span>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Explains a plan-locked control and links to the plans page. */
export function UpgradePopover({
  lock,
  feature,
  pitch,
  children,
  triggerClassName,
  triggerLabel,
}: {
  lock: ReportLock;
  feature: string;
  pitch: string;
  children: ReactNode;
  triggerClassName: string;
  triggerLabel: string;
}) {
  const plan = PLAN_NAME[lock.plan];
  return (
    <Popover.Root>
      <Popover.Trigger className={triggerClassName} aria-label={triggerLabel}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="isolate z-50"
          side="bottom"
          align="end"
          sideOffset={6}
        >
          <Popover.Popup className="dashboard-shell dash-an-upsell-pop">
            <span className={`dash-an-plan-badge is-${lock.plan}`}>{plan}</span>
            <Popover.Title className="dash-an-upsell-title">
              {feature}
            </Popover.Title>
            <Popover.Description className="dash-an-upsell-text">
              {pitch}
            </Popover.Description>
            {lock.canUpgrade ? (
              <Link href="/dashboard/plans" className="dash-an-upsell-cta">
                See {plan}
              </Link>
            ) : (
              <p className="dash-an-upsell-note">
                Ask your store owner to upgrade to {plan}.
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export interface AnalyticsCardProps {
  title: string;
  definition?: string;
  /** Open the detailed report (title and corner icon both link to it). */
  reportHref?: string;
  /** The report exists but this plan can't open it: show a lock instead. */
  reportLock?: ReportLock;
  /** A muted line under the title, e.g. the date range. */
  subtitle?: ReactNode;
  /** Extra controls at the right of the header (legend, toggles). */
  aside?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function AnalyticsCard({
  title,
  definition,
  reportHref,
  reportLock,
  subtitle,
  aside,
  footer,
  className = "",
  children,
}: AnalyticsCardProps) {
  return (
    <section className={`dash-an-card ${className}`}>
      <header className="dash-an-card-head">
        <div className="dash-an-card-heading">
          <MetricTitle
            title={title}
            definition={definition}
            href={reportHref}
          />
          {subtitle ? <div className="dash-an-card-sub">{subtitle}</div> : null}
        </div>
        <div className="dash-an-card-aside">
          {aside}
          {reportHref ? (
            <Link
              href={reportHref}
              className="dash-an-icon-btn"
              aria-label={`View ${title} report`}
              title="View report"
            >
              <ArrowUpRight aria-hidden />
            </Link>
          ) : reportLock ? (
            <UpgradePopover
              lock={reportLock}
              feature="Detailed reports"
              pitch="Open every card as a full report with row-level detail, and export it to CSV."
              triggerClassName="dash-an-icon-btn is-locked"
              triggerLabel={`${title} report needs the ${PLAN_NAME[reportLock.plan]} plan`}
            >
              <Lock aria-hidden />
            </UpgradePopover>
          ) : null}
        </div>
      </header>
      <div className="dash-an-card-body">{children}</div>
      {footer ? <footer className="dash-an-card-foot">{footer}</footer> : null}
    </section>
  );
}
