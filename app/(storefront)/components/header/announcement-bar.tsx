"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import styles from "./Header.module.css";
import type { AnnouncementConfig } from "@/lib/chrome/types";

/**
 * The announcement bar: one line above the header, the way Shopify themes
 * carry a delivery promise or a sale. It renders INSIDE the fixed header, in
 * a transparent top border the root's `sm-announce` class gives the bar
 * (Header.module.css), so the header's measured height — what every page
 * reserves as --sm-header-h — includes it with no second measurement, and
 * the header's own padding, which every variant sets differently, is never
 * involved. The copy is one line (ellipsis, never a wrap), so the bar's
 * height is a constant the CSS knows before hydration.
 *
 * The root class is painted by the storefront layout on the server; this
 * effect keeps it true in the Website Builder, where the merchant toggles
 * the bar live through ChromeProvider without a reload.
 */
export function AnnouncementBar({
  announcement,
}: {
  announcement: AnnouncementConfig | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = !!announcement?.enabled && !!announcement.text;
  useEffect(() => {
    if (!active) return;
    const root = ref.current?.closest(".storefront-root");
    if (!root) return;
    root.classList.add("sm-announce");
    return () => root.classList.remove("sm-announce");
  }, [active]);
  if (!active || !announcement) return null;
  const text = announcement.text;
  return (
    <div ref={ref} className={styles.announcement} data-sm="announcement">
      {announcement.href ? (
        <Link href={announcement.href} className={styles.announcementLink}>
          <span className={styles.announcementText}>{text}</span>
        </Link>
      ) : (
        <p className={styles.announcementText}>{text}</p>
      )}
    </div>
  );
}
