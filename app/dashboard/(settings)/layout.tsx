import type { ReactNode } from "react";
import { SettingsShell } from "./settings/settings-shell";

// ★ ONE LAYOUT FOR EVERY SETTINGS PAGE. The route group (no URL segment) puts
// the pages the settings menu lists as `wrapped` under one SettingsShell, so
// the frame mounts once and keeps the menu's search and scroll position while
// moving between pages. Before it, each folder had its own copy of this layout
// and the frame remounted whenever navigation crossed folders.
//
// The printable invoice and credit note pages (app/dashboard/plans/invoices/
// [id], app/dashboard/plans/credit-notes/[id]) stay outside the group, so
// they print with no menu. The Plans & Billing pages' components stay in
// app/dashboard/plans, where the console, signup and the Locations card import
// them; only the two page files live here.
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>;
}
