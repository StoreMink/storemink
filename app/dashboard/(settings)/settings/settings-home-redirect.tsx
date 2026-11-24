"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader } from "@/components/ui/loader";
import { SETTINGS_GENERAL } from "./settings-nav";

/** Whether the element or an ancestor is display: none. */
export function isHidden(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (getComputedStyle(n).display === "none") return true;
  }
  return false;
}

/**
 * The Settings home's page column. A wide frame shows the menu and a page
 * beside it, so the home opens General there; a narrow frame (a phone, or the
 * Mink panel open) hides the page column and the home is only the menu.
 *
 * ★ IT ASKS THE PAGE COLUMN, NOT THE WINDOW. Which layout shows is a
 * container query on the frame (settings-shell.css), so only the column's
 * own visibility says whether a page would be seen. The home renders nothing
 * heavier than this, so General's reads happen only where it shows.
 *
 * It watches the frame's size too, so widening a narrow window on the home
 * opens General rather than leaving an empty column. `replace`, so Back does
 * not land on the home and bounce forward again.
 */
export function SettingsHomeRedirect() {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let done = false;
    const check = () => {
      if (done || isHidden(el)) return;
      done = true;
      router.replace(SETTINGS_GENERAL);
    };
    check();
    const frame = el.closest(".sm-settings");
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [router]);

  return (
    <div ref={ref} className="flex h-[50vh] w-full items-center justify-center">
      <Loader />
    </div>
  );
}
