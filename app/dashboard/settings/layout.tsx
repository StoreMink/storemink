import type { ReactNode } from "react";
import { SettingsShell } from "./settings-shell";

// Renders this page inside the Settings frame (the settings menu beside the
// page). The menu lists it in app/dashboard/settings/settings-nav.ts.
export default function Layout({ children }: { children: ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>;
}
