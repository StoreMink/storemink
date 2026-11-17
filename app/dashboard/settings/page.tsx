import { getActingStoreId, getViewerAccess } from "@/app/dashboard/lib/access";
import { GeneralSettings } from "./general-settings";

export const metadata = { title: "Settings" };

/**
 * The Settings home.
 *
 * The settings menu comes from this folder's layout (settings-shell.tsx). Beside
 * it the home shows General, the way Shopify's settings open on their store
 * details. When the frame is narrow (a phone, or the Mink panel open) the home
 * shows only the menu, and General is its own page.
 *
 * Someone who may not see General gets a short line instead, since the menu
 * beside it already lists every page they can open.
 */
export default async function SettingsPage() {
  const access = await getViewerAccess();
  // The dashboard layout already handles the no-access and outage cases.
  if (!access) return null;

  if (!access.can("settings", "view")) {
    return (
      <div className="dash-page-enter mx-auto w-full max-w-3xl">
        <header className="dash-page-header">
          <h1>Settings</h1>
          <p>Choose a page from the settings menu.</p>
        </header>
      </div>
    );
  }

  return <GeneralSettings access={access} storeId={await getActingStoreId()} />;
}
