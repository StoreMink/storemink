import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { isStorefrontGated } from "@/lib/store/launch-state";
import { storefrontAccess } from "@/lib/store/storefront-access";
import { getStoreBrand } from "@/lib/store/brand";
import { PasswordForm } from "./password-form";

// The one storefront page that must NOT call requireStorefrontStore(): that is
// what sends a locked visitor here, and it would loop. The store is resolved
// directly; a visitor who is not locked out (the shop is open, or they hold
// the password, or they are signed in as staff) is sent to the homepage.

export const metadata: Metadata = {
  title: "Opening soon",
  robots: { index: false, follow: false },
};

export default async function StorefrontPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const store = await getCurrentStoreOrNull();
  if (!store) redirect("/");
  if (
    !isStorefrontGated(store) ||
    (await storefrontAccess(store)) !== "locked"
  ) {
    redirect("/");
  }
  const brand = await getStoreBrand();
  const { next } = await searchParams;

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
        <h1 className="sm-password-title">Opening soon</h1>
        <p className="sm-password-copy">
          {brand.name} is getting ready. If you have the store password, enter
          it to take a look around.
        </p>
        <PasswordForm next={typeof next === "string" ? next : "/"} />
        <p className="sm-password-owner">
          Store owner? The password is on your{" "}
          <Link href="/dashboard">dashboard Home</Link>, next to Go live.
        </p>
      </div>
    </main>
  );
}
