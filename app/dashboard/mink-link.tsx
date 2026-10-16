"use client";

import Link from "next/link";
import type { AnchorHTMLAttributes } from "react";

/**
 * A link inside a Mink answer or card.
 *
 * ★★ A DASHBOARD DESTINATION NAVIGATES CLIENT-SIDE. Every record link in an
 * answer, an artifact card and a proposal card used to be a plain anchor, so
 * clicking "Open order" did a full page load, the dashboard layout remounted,
 * and the chat panel (whose open state lives in that layout's ChatProvider)
 * shut behind the merchant. Next's Link keeps the layout, the provider and
 * the open panel, which is what makes "look at the record, come back to the
 * answer" one gesture instead of three.
 *
 * ★ ONLY `/dashboard` PATHS GET THAT TREATMENT. A download (`download`), a
 * tab-opening link (`target`), a Help Centre address, a storefront page or an
 * API route keeps the ordinary anchor: those are either files, other hosts or
 * other layouts, where a client transition buys nothing.
 */
export function MinkLink({
  href,
  target,
  download,
  rel,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const internal =
    typeof href === "string" &&
    (href === "/dashboard" ||
      href.startsWith("/dashboard/") ||
      href.startsWith("/dashboard?")) &&
    !target &&
    download === undefined;
  if (internal) return <Link href={href} {...rest} />;
  return (
    <a href={href} target={target} download={download} rel={rel} {...rest} />
  );
}
