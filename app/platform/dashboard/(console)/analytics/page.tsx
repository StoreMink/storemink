import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";
import { AnalyticsSettingsPanel } from "./analytics-settings-panel";
import { canManage, requireOperator } from "../require-operator";

export const metadata = { title: "Analytics · StoreMink Admin" };
export const dynamic = "force-dynamic";

export default async function PlatformAnalyticsPage() {
  const viewer = await requireOperator();
  const settings = await getPlatformAnalyticsFeatures();

  return (
    <div className="w-full max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
          Analytics
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          Choose which Analytics modules StoreMink offers. These switches never
          override a merchant&apos;s plan.
        </p>
      </header>

      <AnalyticsSettingsPanel
        initialSettings={settings}
        canManage={canManage(viewer)}
      />
    </div>
  );
}
