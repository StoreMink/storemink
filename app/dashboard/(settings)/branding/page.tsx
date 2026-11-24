import { getActingStoreId, requireSectionAccess } from "../../lib/access";
import { getStoreBrandingForEditor } from "@/app/actions/store-branding";
import { getBrandVoiceForEditor } from "@/app/actions/brand-voice-actions";
import { getStorePlanContext } from "@/lib/plans/entitlements";
import { loggableError } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import { BrandingForm } from "./branding-form";

export const metadata = { title: "Branding" };

/**
 * Whether the store's plan removes the "Powered by StoreMink" badge, for the
 * Credit line field's hint. Read the way every dashboard page reads the plan
 * in force (getStorePlanContext: the effective plan, so an expired timed plan
 * reads as Free and a live comp as its plan). ★ A failed read costs the hint
 * its plan, never the page: null makes the field state both rules.
 */
async function readRemoveBadge(storeId: string): Promise<boolean | null> {
  try {
    const { limits } = await getStorePlanContext(storeId);
    return limits.removeBadge;
  } catch (err) {
    logError("branding: plan read failed", loggableError(err), { storeId });
    return null;
  }
}

export default async function BrandingPage() {
  const access = await requireSectionAccess("branding", "view");
  const storeId = await getActingStoreId();
  const [brand, voice, removeBadge] = await Promise.all([
    getStoreBrandingForEditor(),
    getBrandVoiceForEditor(),
    readRemoveBadge(storeId),
  ]);
  const canManage = access.can("branding", "manage");
  // One editor for the whole page (branding and brand voice share its save
  // bar). Only the guide and the answers cross to the client: the voice read
  // also carries the store's Mink credit usage, which this page never shows.
  return (
    <BrandingForm
      initial={brand}
      voice={{ content: voice.content, structured: voice.structured }}
      canManage={canManage}
      removeBadge={removeBadge}
    />
  );
}
