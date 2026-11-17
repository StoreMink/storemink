import {
  getActingStoreId,
  requireSectionAccess,
} from "@/app/dashboard/lib/access";
import { GeneralSettings } from "../general-settings";

export const metadata = { title: "General" };

// The same General the Settings home shows beside the menu. Its own address is
// for the narrow layout, where the home shows only the menu.
export default async function GeneralSettingsPage() {
  const access = await requireSectionAccess("settings", "view");
  return <GeneralSettings access={access} storeId={await getActingStoreId()} />;
}
