import { requireSectionAccess } from "@/app/dashboard/lib/access";
import { GeneralSettings } from "../general-settings";

export const metadata = { title: "General" };

// Settings, General. On a wide frame the Settings home opens it beside the
// menu; on a narrow one the home is the menu and this page has the back link.
export default async function GeneralSettingsPage() {
  const access = await requireSectionAccess("settings", "view");
  return <GeneralSettings access={access} />;
}
