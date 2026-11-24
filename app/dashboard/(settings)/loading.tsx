import { Loader } from "@/components/ui/loader";

// The loading state between settings pages. Every settings page sits in this
// route group, so app/dashboard/loading.tsx never sees a change of segment when
// moving from one to another (Staff to Channels, say) and the old page stayed
// on screen until the server answered. This boundary renders inside the
// group's layout, so the settings menu stays on screen while the page loads.
// The dashboard is auth-gated and noindex, so it cannot cause a soft 404
// (app/loading-boundary-coverage.test.ts).
export default function SettingsLoading() {
  return (
    <div className="flex h-[50vh] w-full items-center justify-center">
      <Loader />
    </div>
  );
}
