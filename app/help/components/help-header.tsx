"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Menu, X } from "lucide-react";
import { BrandMark } from "../../platform/brand-mark";
import { HelpAssistant } from "./help-assistant";
import { openHelpMink } from "./mink-launch";
import { HelpSearchBox } from "./search-box";

const SIGNUP_URL = "https://storemink.com/signup";

/**
 * The home page answers to both "/" (help.storemink.com rewrites it) and
 * "/help", so the server render and the browser agree whichever one the
 * pathname reports.
 */
export function isHelpHomePath(pathname: string | null): boolean {
  return pathname === "/" || pathname === "/help" || pathname === "/help/";
}

/** Whether this is the search results page ("/search" on the Help host). */
export function isHelpSearchPath(pathname: string | null): boolean {
  return pathname === "/search" || pathname === "/help/search";
}

/**
 * The compact header search. On the results page it shows the search that
 * was made, so it can be changed or cleared; keyed by it, so a new search
 * (or Back) refills the box rather than keeping what was typed before.
 */
function HeaderSearch() {
  const pathname = usePathname();
  const params = useSearchParams();
  const query = isHelpSearchPath(pathname) ? (params.get("q") ?? "") : "";
  return <HelpSearchBox compact key={query} initialQuery={query} />;
}

/**
 * The Help Centre header. The home page carries its own large search, so its
 * header shows the three places a visitor goes instead (guides, Mink AI,
 * support); every other page keeps the compact search. Small screens fold
 * everything behind the menu button, and Mink AI opens from the menu there.
 */
export function HelpHeader({ voiceEnabled }: { voiceEnabled: boolean }) {
  const pathname = usePathname();
  const isHome = isHelpHomePath(pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPath, setMenuPath] = useState(pathname);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // A new page closes the menu (the state is reset while rendering, the way
  // React recommends, rather than in an effect).
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      toggleRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  function openMink() {
    setMenuOpen(false);
    openHelpMink({ expand: true });
  }

  return (
    <header className="hc-topbar">
      <div className={`hc-topbar-inner${isHome ? " is-home" : ""}`}>
        {/* One brand lockup across all three public hosts: the real mark, the
            wordmark with Mink in the brand purple, then the section label.
            storemink.com is bare, pos.storemink.com reads "StoreMink | POS",
            and this reads "StoreMink | HELP". */}
        <Link href="/help" className="hc-logo" aria-label="StoreMink Help">
          <BrandMark size={29} priority />
          <span aria-hidden="true">
            Store<em>Mink</em>
          </span>
          <i aria-hidden="true" data-short="Help">
            <span>Help Centre</span>
          </i>
        </Link>

        {isHome ? (
          <nav className="hc-topnav" aria-label="Help Centre">
            <Link href="/help#topics">Guides</Link>
            <button type="button" onClick={openMink}>
              Mink AI
            </button>
            <Link href="/help#contact">Contact support</Link>
          </nav>
        ) : (
          // useSearchParams needs a Suspense boundary on pages rendered
          // ahead of a request; the fallback is the same empty box.
          <Suspense fallback={<HelpSearchBox compact />}>
            <HeaderSearch />
          </Suspense>
        )}

        <div className="hc-topbar-actions">
          <a href={SIGNUP_URL} className="hc-topbar-cta" rel="noopener">
            Create your store
          </a>
          {/* Voice follows Mink AI's platform switch, read on the server; the
              browser decides whether it can record. */}
          <HelpAssistant voiceEnabled={voiceEnabled} />
          <button
            ref={toggleRef}
            type="button"
            className="hc-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="hc-mobile-menu"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((value) => !value)}
          >
            {menuOpen ? (
              <X size={22} aria-hidden />
            ) : (
              <Menu size={22} aria-hidden />
            )}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div id="hc-mobile-menu" className="hc-mobile-menu">
          <div className="hc-mobile-menu-inner">
            <nav aria-label="Help Centre">
              <Link href="/help#topics" onClick={() => setMenuOpen(false)}>
                Guides
              </Link>
              <button type="button" onClick={openMink}>
                Mink AI
              </button>
              <Link href="/help#contact" onClick={() => setMenuOpen(false)}>
                Contact support
              </Link>
              <a href={SIGNUP_URL} rel="noopener">
                Create your store
              </a>
            </nav>
          </div>
        </div>
      )}
    </header>
  );
}
