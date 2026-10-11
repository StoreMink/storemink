"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { MARKETING_PAGES } from "./marketing-routes";

export function HomepageMobileNav({
  posUrl,
  themesUrl,
}: {
  posUrl: string;
  themesUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <div className="smh-mobile-menu">
      <button
        type="button"
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        aria-controls="smh-mobile-navigation"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <X size={22} /> : <Menu size={23} />}
      </button>
      {open && (
        <div className="smh-mobile-menu-panel" id="smh-mobile-navigation">
          {MARKETING_PAGES.map((page) => (
            <Link
              key={page.path}
              href={page.path}
              onClick={close}
              className={
                page.path.startsWith("/products/") ? "is-sub" : undefined
              }
            >
              {page.label}
            </Link>
          ))}
          <Link href={posUrl} onClick={close}>
            Point of Sale
          </Link>
          <a href={themesUrl} onClick={close}>
            Themes
          </a>
          <a href="https://help.storemink.com" onClick={close}>
            Help Centre
          </a>
          <Link href="/login" onClick={close}>
            Log in
          </Link>
          <Link
            href="/signup"
            className="smh-button smh-button-dark"
            onClick={close}
          >
            Start for free
          </Link>
        </div>
      )}
    </div>
  );
}
