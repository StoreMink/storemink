import type { ReactNode } from "react";
import { getStorefrontLayout } from "@/lib/store/storefront-layout";
import { accountShellClass } from "./account-shell-class";
import { AccountNav } from "./account-nav";
import "./account.css";

// Wraps a shopper account page (profile, orders, notifications) in the
// account template (plan Phase 2e): the page as it is, a row of tabs above
// it, or a navigation column beside it from 1024px, and an optional colour
// scheme over the whole page. The default template renders the page's own
// markup with nothing around it, so a store that chose nothing is unchanged.
export async function AccountShell({ children }: { children: ReactNode }) {
  const { templates } = await getStorefrontLayout();
  const className = accountShellClass(templates.account);
  if (!className) return <>{children}</>;
  return (
    <div className={className}>
      {templates.account.layout !== "plain" && <AccountNav />}
      {children}
    </div>
  );
}
