import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { isStorefrontGated, isThemePending } from "@/lib/store/launch-state";
import { storefrontAccess } from "@/lib/store/storefront-access";
import { getStoreBrand } from "@/lib/store/brand";
import { STOREFRONT_PASSWORD_PATH } from "@/lib/store/launch-copy";

// What a store shows, past its password, while its owner has not chosen a
// theme (lib/store/launch-state.ts isThemePending). Every other storefront
// page sends visitors here through requireStorefrontStore().
//
// ★ This page must NOT call requireStorefrontStore(): that is what sends a
// pending store's visitors here, and it would loop. It applies the same checks
// in the same order itself — unknown host, then the password, then the theme —
// and only renders when the visitor is past the password AND the store is
// still pending. Once a theme is chosen the page sends visitors to the shop.
//
// It renders in the minimal shell (the storefront layout drops the header,
// footer and cart for a pending store) and reuses the password page's card.

export const metadata: Metadata = {
  title: "Store in progress",
  robots: { index: false, follow: false },
};

export default async function StoreInProgressPage() {
  const store = await getCurrentStoreOrNull();
  if (!store) notFound();
  if (
    isStorefrontGated(store) &&
    (await storefrontAccess(store)) === "locked"
  ) {
    redirect(STOREFRONT_PASSWORD_PATH);
  }
  if (!isThemePending(store)) redirect("/");

  const brand = await getStoreBrand();

  return (
    <main className="sm-password-page">
      <div className="sm-password-card">
        {brand.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={brand.logoUrl}
            alt={brand.name}
            className="sm-password-logo"
          />
        ) : (
          <div className="sm-password-name">{brand.name}</div>
        )}
        <h1 className="sm-password-title">Store in progress</h1>
        <p className="sm-password-copy">
          This store is being set up. Please check back soon.
        </p>
        <p className="sm-password-owner">
          Are you the owner?{" "}
          {/* No prefetch: nearly every visitor here is not the owner, and the
              dashboard is a signed-in route they would only be bounced from. */}
          <Link href="/dashboard/storefront" prefetch={false}>
            Choose a theme in your dashboard
          </Link>
        </p>
      </div>
    </main>
  );
}
