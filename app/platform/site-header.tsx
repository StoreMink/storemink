import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { POS_URL, THEMES_URL } from "@/lib/site";
import { BrandMark } from "./brand-mark";
import { HomepageMobileNav } from "./homepage-mobile-nav";
import { PRODUCT_PAGES } from "./marketing-routes";

// The one platform header, shared by the apex homepage, the marketing pages
// (Why StoreMink, Products, Pricing) and /legal/*.
//
// ★ IT WAS INLINE IN page.tsx, AND THE POLICY PAGES THEREFORE HAD NO HEADER AT
// ALL — /legal and /legal/{slug} rendered a bare document with no mark, no
// navigation and no way back to the site except one "All policies" link. A
// second hand-written copy for those routes is how four hosts ended up with
// four different headers in the first place, so this is the shared one.
//
// Every destination is a real route now (marketing-routes.ts), so the header
// is identical on every page — there is no longer an `anchorBase` to thread.
//
// The two dropdowns are CSS-only — they open on hover and on :focus-within,
// so they work with a keyboard and need no client JavaScript. The trigger is
// a real <button> so it is focusable; the panel beneath it is plain links.
export function SiteHeader() {
  const [build, orders, payments, marketing, mink] = PRODUCT_PAGES;
  return (
    <header className="smh-header">
      <nav className="smh-nav" aria-label="Main navigation">
        <Link href="/" className="smh-logo" aria-label="StoreMink home">
          <BrandMark size={29} priority />
          <span aria-hidden="true">
            Store<em>Mink</em>
          </span>
        </Link>
        <div className="smh-nav-links">
          <div className="smh-nav-item">
            <button type="button" aria-haspopup="true">
              Why StoreMink <ChevronDown size={14} aria-hidden="true" />
            </button>
            <div className="smh-menu">
              <Link href="/why-storemink">
                <b>Why StoreMink</b>
                <span>One platform for the way India sells.</span>
              </Link>
              <Link href="/why-storemink#switch">
                <b>Switch to StoreMink</b>
                <span>Bring your catalogue over with a CSV.</span>
              </Link>
              <Link href="/products/mink-ai">
                <b>Mink AI</b>
                <span>Your very own commerce AI, built in.</span>
              </Link>
            </div>
          </div>
          <div className="smh-nav-item">
            <button type="button" aria-haspopup="true">
              Products <ChevronDown size={14} aria-hidden="true" />
            </button>
            <div className="smh-menu smh-menu-wide">
              <div>
                <small>Build</small>
                <Link href={build.path}>{build.label}</Link>
                <a href={THEMES_URL}>Themes</a>
                <Link href="/products/online-store#builder">
                  Website builder
                </Link>
              </div>
              <div>
                <small>Sell</small>
                <Link href={POS_URL}>Point of Sale</Link>
                <Link href={orders.path}>{orders.label}</Link>
                <Link href={payments.path}>{payments.label}</Link>
              </div>
              <div>
                <small>Grow</small>
                <Link href={marketing.path}>{marketing.label}</Link>
                <Link href={mink.path}>{mink.label}</Link>
                <Link href="/products">All products</Link>
              </div>
            </div>
          </div>
          <Link href="/pricing">Pricing</Link>
          <Link href={POS_URL}>Point of Sale</Link>
          <a href="https://help.storemink.com">Resources</a>
        </div>
        <div className="smh-nav-actions">
          <Link href="/login" className="smh-link-button">
            Log in
          </Link>
          <Link href="/signup" className="smh-button smh-button-dark">
            Start for free
          </Link>
        </div>
        <HomepageMobileNav posUrl={POS_URL} themesUrl={THEMES_URL} />
      </nav>
    </header>
  );
}
