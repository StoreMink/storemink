"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The shopper's account navigation (plan Phase 2e, the account template):
// one row of links the three account pages share. Rendered only when the
// template asks for tabs or a sidebar; the pages themselves are unchanged.
export const ACCOUNT_LINKS = [
  { href: "/profile", label: "Profile" },
  { href: "/orders", label: "Orders" },
  { href: "/notifications", label: "Notifications" },
] as const;

export function AccountNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="sm-account-nav" aria-label="Account">
      {ACCOUNT_LINKS.map((link) => {
        const current =
          pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? "page" : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
