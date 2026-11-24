import { getViewerAccess } from "@/app/dashboard/lib/access";
import { SettingsHomeRedirect } from "./settings-home-redirect";

export const metadata = { title: "Settings" };

/**
 * The Settings home.
 *
 * The settings menu comes from this folder's layout (settings-shell.tsx).
 * When the frame is narrow (a phone, or the Mink panel open) the home is only
 * that menu. When it is wide, the page column beside the menu is showing, and
 * the home opens General there (settings-home-redirect.tsx), the way Shopify's
 * settings open on their store details. General is never read here, so a
 * narrow frame costs no reads it would hide.
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

  return <SettingsHomeRedirect />;
}
