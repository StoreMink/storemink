import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { ChevronRight, Lock, Plus } from "lucide-react";
import { getActingStoreId, requireSectionAccess } from "../../lib/access";
import { AnalyticsTabs } from "../analytics-tabs";
import { analyticsSavedReports } from "@/drizzle/schema";
import {
  REPORT_CATEGORIES,
  REPORT_LIBRARY,
  type LibraryReport,
} from "@/lib/analytics/explore";
import { analyticsFeatureAllowed } from "@/lib/analytics/features";
import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";
import { withService } from "@/lib/db/client";
import { getStorePlanContext } from "@/lib/plans/entitlements";

export const metadata = { title: "Reports · Analytics" };

function reportHref(report: LibraryReport): string {
  return report.fixed
    ? `/dashboard/analytics/reports/${report.fixed}`
    : `/dashboard/analytics/reports/explore?preset=${report.id}`;
}

export default async function ReportsIndexPage() {
  const access = await requireSectionAccess("analytics", "view");
  const [storeId, features] = await Promise.all([
    getActingStoreId(),
    getPlatformAnalyticsFeatures(),
  ]);
  const { plan } = await getStorePlanContext(storeId);
  const canReports =
    features.coreDashboard &&
    analyticsFeatureAllowed(features, "drilldownReports", plan);
  const canSearch = analyticsFeatureAllowed(
    features,
    "googleSearchConsole",
    plan,
  );
  const canTraffic = analyticsFeatureAllowed(
    features,
    "storefrontConversion",
    plan,
  );
  const saved = canReports
    ? await withService((db) =>
        db
          .select({
            id: analyticsSavedReports.id,
            name: analyticsSavedReports.name,
            updatedAt: analyticsSavedReports.updatedAt,
          })
          .from(analyticsSavedReports)
          .where(eq(analyticsSavedReports.storeId, storeId))
          .orderBy(desc(analyticsSavedReports.updatedAt)),
      )
    : [];

  // A report is open when the store has reports at all and, for traffic or
  // Search reports, the module behind it. Operator-disabled modules are left
  // out entirely rather than sold.
  const lockFor = (report: LibraryReport): "basic" | "pro" | null => {
    if (report.traffic && !canTraffic) return "pro";
    if (!canReports) return "basic";
    if (report.search && !canSearch) return "basic";
    return null;
  };
  const visible = REPORT_LIBRARY.filter(
    (report) =>
      (!report.traffic || features.storefrontConversion) &&
      (!report.search || features.googleSearchConsole),
  );

  return (
    <div className="dash-analytics dash-reports">
      <header className="dash-an-head">
        <h1>Analytics</h1>
        <div className="dash-an-actions">
          {canReports ? (
            <Link
              href="/dashboard/analytics/reports/explore"
              className="dash-btn dash-btn-primary"
            >
              <Plus aria-hidden /> New report
            </Link>
          ) : null}
        </div>
      </header>
      <AnalyticsTabs active="reports" />

      {saved.length > 0 ? (
        <section className="dash-section">
          <h2>Saved reports</h2>
          <ul className="dash-report-list">
            {saved.map((report) => (
              <li key={report.id}>
                <Link
                  href={`/dashboard/analytics/reports/explore?report=${report.id}`}
                >
                  <span className="dash-report-name">{report.name}</span>
                  <span className="dash-report-meta">Custom report</span>
                  <ChevronRight aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {REPORT_CATEGORIES.map((category) => {
        const reports = visible.filter(
          (report) => report.category === category,
        );
        if (reports.length === 0) return null;
        return (
          <section key={category} className="dash-section">
            <h2>{category}</h2>
            <ul className="dash-report-list">
              {reports.map((report) => {
                const lock = lockFor(report);
                return (
                  <li key={report.id}>
                    <Link
                      href={
                        lock
                          ? lock === "basic" && !canReports
                            ? "/dashboard/analytics/reports/explore"
                            : "/dashboard/plans"
                          : reportHref(report)
                      }
                      className={lock ? "is-locked" : undefined}
                    >
                      <span className="dash-report-name">
                        {report.title}
                        {lock ? (
                          <span className={`dash-an-plan-badge is-${lock}`}>
                            <Lock aria-hidden />{" "}
                            {lock === "pro" ? "Pro" : "Basic"}
                          </span>
                        ) : null}
                      </span>
                      <span className="dash-report-meta">
                        {report.description}
                      </span>
                      <ChevronRight aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {access.can("analytics", "manage") || !canReports ? null : (
        <p className="dash-live-footnote">
          Ask your store owner for Analytics manage access to save reports.
        </p>
      )}
    </div>
  );
}
