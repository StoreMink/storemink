import Link from "next/link";

// The Analytics sub-navigation (Shopify keeps Reports and Live View as
// sub-items under Analytics). A tab strip rather than sidebar children, so no
// new permission sections are needed: all three share Analytics "view".

const TABS = [
  { id: "overview", label: "Overview", href: "/dashboard/analytics" },
  { id: "reports", label: "Reports", href: "/dashboard/analytics/reports" },
  { id: "live", label: "Live View", href: "/dashboard/analytics/live" },
] as const;

export function AnalyticsTabs({
  active,
}: {
  active: (typeof TABS)[number]["id"];
}) {
  return (
    <nav className="dash-an-tabs" aria-label="Analytics">
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          className={tab.id === active ? "is-active" : undefined}
          aria-current={tab.id === active ? "page" : undefined}
        >
          {tab.id === "live" ? (
            <span className="dash-live-dot" aria-hidden />
          ) : null}
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
