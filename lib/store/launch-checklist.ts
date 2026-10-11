import "server-only";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  admins,
  products,
  storeBillingSettings,
  storePages,
  storePaymentProviders,
  storeShippingSettings,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { effectivePlan } from "@/lib/plans";
import type { Store } from "@/lib/store/resolve";
import { isThemePending } from "@/lib/store/launch-state";
import { policyBodyHtml } from "@/lib/legal/policy-text";
import { homepageEditedSinceSeed } from "@/lib/themes/switch-rules";
import {
  LAUNCH_POLICY_SLUGS,
  evaluateLaunchChecklist,
  type LaunchChecklist,
  type LaunchFacts,
} from "@/lib/store/launch-checklist-rules";

// ---------------------------------------------------------------------------
// Gathers the FACTS the checklist rules judge (launch-checklist-rules.ts).
//
// Every read carries the trusted store id and runs under the service scope,
// because this is read on the dashboard Home by any admin who can see it and
// re-run by `launchStore` as the authority on whether the store may open.
// Nothing here is stored: a merchant deleting their only product makes the
// checklist incomplete again on the next read, which is what makes it honest.
// ---------------------------------------------------------------------------

/** Theme sample products are named "… (Sample)" by every bundled preset
 *  (lib/themes/definitions/*), which is also what their own copy tells the
 *  merchant to replace. */
const SAMPLE_MARK = "%(Sample)%";

export async function buildLaunchChecklist(
  store: Store,
): Promise<LaunchChecklist> {
  const storeId = store.id;
  const [productCounts, billing, pages, shipping, payments, verifiedOwners] =
    await Promise.all([
      withService((db) =>
        db
          .select({
            published: sql<number>`count(*) filter (where ${products.status} = 'published' and ${products.name} not like ${SAMPLE_MARK})`,
            samples: sql<number>`count(*) filter (where ${products.name} like ${SAMPLE_MARK})`,
          })
          .from(products)
          .where(eq(products.storeId, storeId)),
      ),
      withService((db) =>
        db
          .select({
            businessName: storeBillingSettings.businessName,
            legalName: storeBillingSettings.legalName,
            businessAddress: storeBillingSettings.businessAddress,
            contactEmail: storeBillingSettings.contactEmail,
            contactPhone: storeBillingSettings.contactPhone,
            taxId: storeBillingSettings.taxId,
            gstEnabled: storeBillingSettings.gstEnabled,
          })
          .from(storeBillingSettings)
          .where(eq(storeBillingSettings.storeId, storeId))
          .limit(1),
      ),
      withService((db) =>
        db
          .select({
            slug: storePages.slug,
            status: storePages.status,
            publishedSections: storePages.publishedSections,
            createdAt: storePages.createdAt,
            updatedAt: storePages.updatedAt,
          })
          .from(storePages)
          .where(
            and(
              eq(storePages.storeId, storeId),
              inArray(storePages.slug, ["", ...LAUNCH_POLICY_SLUGS]),
            ),
          ),
      ),
      withService((db) =>
        db
          .select({ storeId: storeShippingSettings.storeId })
          .from(storeShippingSettings)
          .where(eq(storeShippingSettings.storeId, storeId))
          .limit(1),
      ),
      withService((db) =>
        db
          .select({ enabled: storePaymentProviders.enabled })
          .from(storePaymentProviders)
          .where(
            and(
              eq(storePaymentProviders.storeId, storeId),
              eq(storePaymentProviders.enabled, true),
            ),
          )
          .limit(1),
      ),
      // A store owner who proved their mobile with a texted code. The
      // TIMESTAMP, not `phone`: invited staff type a number nobody checked.
      withService((db) =>
        db
          .select({ id: admins.id })
          .from(admins)
          .where(
            and(
              eq(admins.storeId, storeId),
              eq(admins.role, "superadmin"),
              isNotNull(admins.phoneVerifiedAt),
            ),
          )
          .limit(1),
      ),
    ]);

  const counts = productCounts[0] ?? { published: 0, samples: 0 };
  const b = billing[0];
  const filled = (v: string | null | undefined) =>
    typeof v === "string" && v.trim().length > 0;

  const policies: Record<string, boolean> = {};
  for (const slug of LAUNCH_POLICY_SLUGS) {
    const row = pages.find((p) => p.slug === slug);
    policies[slug] =
      !!row &&
      row.status === "published" &&
      policyBodyHtml(row.publishedSections)
        .replace(/<[^>]*>/g, "")
        .trim().length > 0;
  }

  // ★ Measured from when the THEME last wrote the homepage, not from when
  // the row was created: a theme switch from the Storefront page rewrites the
  // seed, and counting that as the merchant's edit would tick this task for
  // them (lib/themes/switch-rules.ts).
  const home = pages.find((p) => p.slug === "");
  const homepageEdited = homepageEditedSinceSeed(store.settings, home);

  const brand = (store.settings?.brand ?? {}) as { logoUrl?: unknown };

  const facts: LaunchFacts = {
    plan: effectivePlan(store),
    ownerPhoneVerified: verifiedOwners.length > 0,
    // Read from the store row already in hand, so the theme task costs no
    // query; switchStoreTheme refreshes STORE_TAG on a first install, so a
    // freshly chosen theme is seen on the next read (launchStore included).
    themeChosen: !isThemePending(store),
    publishedProducts: Number(counts.published) || 0,
    sampleProducts: Number(counts.samples) || 0,
    business: {
      name: filled(b?.businessName) || filled(b?.legalName),
      address: filled(b?.businessAddress),
      email: filled(b?.contactEmail),
      phone: filled(b?.contactPhone),
    },
    policies,
    shippingSaved: shipping.length > 0,
    homepageEdited,
    logo: typeof brand.logoUrl === "string" && brand.logoUrl.trim().length > 0,
    paymentsConnected: payments.length > 0,
    gstin: filled(b?.taxId) || b?.gstEnabled === true,
    customDomainLive:
      !!store.custom_domain && store.settings?.custom_domain_verified === true,
  };
  return evaluateLaunchChecklist(facts);
}
