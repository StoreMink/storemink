"use server";

import { updateTag } from "next/cache";
import {
  getViewerContext,
  isStoreSuperadmin,
} from "@/app/dashboard/lib/access";
import { emitEvent } from "@/lib/notifications/record";
import { notifyStoreContentPublished } from "@/lib/seo/store-indexing";
import { getStoreUrl } from "@/lib/site";
import { isStoreLaunched, markStoreLaunched } from "@/lib/store/launch";
import { STOREFRONT_PASSWORD_PATH } from "@/lib/store/launch-copy";
import { buildLaunchChecklist } from "@/lib/store/launch-checklist";
import type { LaunchChecklist } from "@/lib/store/launch-checklist-rules";
import {
  getCurrentStore,
  lookupStoreById,
  STORE_TAG,
} from "@/lib/store/resolve";
import {
  getOrCreateStorefrontPassword,
  rotateStorefrontPassword,
} from "@/lib/store/storefront-access";
import { logError } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// Opening a store to the public.
//
// ★★ GO LIVE IS THE ONLY THING THAT SETS `launched`, AND IT RE-RUNS THE
// CHECKLIST FIRST. The dashboard card is a courtesy; a merchant could call
// this action directly, so the decision is made here, from the store's own
// rows, at the moment of pressing. A store with no refund policy cannot be
// opened by anybody, through any UI.
//
// ★ THE OWNER'S CALL. Opening a shop to the public and dropping its password
// is the SUPERADMIN's decision (the owner-only rule CODEBASE.md §22 applies to
// discounts, for the same reason: it is irreversible in effect and it is their
// business). Every admin who can see Home can read the checklist and the
// password; only the owner can press the button or change the password.
// ---------------------------------------------------------------------------

export interface LaunchState {
  launched: boolean;
  checklist: LaunchChecklist;
  /** The store's public address (its custom domain when live, else the
   *  StoreMink subdomain). */
  storeUrl: string;
  /** Where a visitor enters the password — useful to share with a reviewer. */
  previewUrl: string;
  /** Null until the store is unlaunched AND the viewer may see it. */
  password: string | null;
  canLaunch: boolean;
}

export async function getLaunchState(): Promise<LaunchState | null> {
  const ctx = await getViewerContext();
  if (!ctx?.profile) return null;
  const store = await getCurrentStore();
  const launched = isStoreLaunched(store);
  const [checklist, storeUrl] = await Promise.all([
    buildLaunchChecklist(store),
    getStoreUrl(),
  ]);
  let password: string | null = null;
  if (!launched) {
    try {
      password = (await getOrCreateStorefrontPassword(store.id)).password;
    } catch (err) {
      // The card still renders; the password row reads "unavailable" rather
      // than the whole Home page failing over a secondary detail.
      logError("getLaunchState: storefront password unavailable", err, {
        storeId: store.id,
      });
    }
  }
  return {
    launched,
    checklist,
    storeUrl,
    previewUrl: `${storeUrl}${STOREFRONT_PASSWORD_PATH}`,
    password,
    canLaunch: ctx.isSuperadmin,
  };
}

export interface LaunchResult {
  success?: boolean;
  storeUrl?: string;
  error?: string;
  /** Required items still outstanding, when refused for that reason. */
  missing?: string[];
}

export async function launchStore(): Promise<LaunchResult> {
  if (!(await isStoreSuperadmin())) {
    return { error: "Only the store owner can open the store." };
  }
  const store = await getCurrentStore();
  if (isStoreLaunched(store)) {
    return { success: true, storeUrl: await getStoreUrl() };
  }

  const checklist = await buildLaunchChecklist(store);
  if (!checklist.ready) {
    return {
      error: "Finish the required steps before going live.",
      missing: checklist.missing,
    };
  }

  await markStoreLaunched(store.id);
  // The resolver caches `settings`; a read-your-own-writes refresh so the
  // merchant's very next click on My Store opens the public shop rather than
  // the password page for the length of the cache window.
  updateTag(STORE_TAG);

  const after = await lookupStoreById(store.id).catch(() => null);
  if (!after || !isStoreLaunched(after)) {
    return {
      error: "The store couldn't be opened just now. Please try again.",
    };
  }

  const storeUrl = await getStoreUrl();
  emitEvent({
    type: "store.launched",
    storeId: store.id,
    actor: { type: "system" },
    subject: { type: "store", id: store.id, label: store.name },
    payload: { storeUrl },
  });
  // Indexing was deliberately withheld while the store was closed; this is
  // the moment the homepage and shop become something worth submitting.
  await notifyStoreContentPublished({
    storeId: store.id,
    paths: ["/", "/shop"],
  }).catch((err) =>
    logError("launchStore: indexing hook failed", err, { storeId: store.id }),
  );
  return { success: true, storeUrl };
}

export async function regenerateStorefrontPassword(): Promise<{
  password?: string;
  error?: string;
}> {
  if (!(await isStoreSuperadmin())) {
    return { error: "Only the store owner can change the store password." };
  }
  const store = await getCurrentStore();
  if (isStoreLaunched(store)) {
    return { error: "The store is already open; it has no password." };
  }
  try {
    return { password: (await rotateStorefrontPassword(store.id)).password };
  } catch (err) {
    logError("regenerateStorefrontPassword failed", err, { storeId: store.id });
    return { error: "Couldn't change the password right now." };
  }
}
