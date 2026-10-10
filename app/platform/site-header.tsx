import Image from "next/image";
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
// Every destination is a real route (marketing-routes.ts), so the header is
// identical on every page.
//
// The two mega menus are CSS-only — they open on hover and on :focus-within,
// so they work with a keyboard and need no client JavaScript. The trigger is
// a real <button> so it is focusable; the panel beneath it is plain links.
// Their images are lazy, so a visitor who never opens a menu never fetches
// them.
export function SiteHeader() {
  const [build, orders, payments, marketing, mink] = PRODUCT_PAGES;
  // Menu card photographs: scenes of starting, growing and selling in India
  // (scripts/marketing-photos.mjs), never a theme's seed image.
  const menuPhotos = {
    start: "/marketing/stories/start.webp",
    switch: "/marketing/stories/grow.webp",
    india: "/marketing/channels/in-store.webp",
  };

  // The rail's two tiles are a picture of each product rather than an icon:
  // Mink as the two lines of a chat, the register as its own photograph.
  const builtIn = (
    <div className="smh-mega-side">
      <small>Built into every store</small>
      <Link href={mink.path} className="smh-mega-tile">
        <span>
          <span className="smh-mega-tile-chat" aria-hidden="true">
            <span>What sold best last week?</span>
            <span>Here is last week by channel and shop.</span>
          </span>
        </span>
        <b>Mink AI</b>
        <small>Your commerce-obsessed AI assistant.</small>
      </Link>
      <Link href={POS_URL} className="smh-mega-tile is-mint">
        <span>
          <Image
            src="/brand/storemink-pos-multidevice.png"
            alt=""
            width={1536}
            height={1024}
            sizes="260px"
          />
        </span>
        <b>Point of Sale</b>
        <small>The counter that shares stock with your site.</small>
      </Link>
    </div>
  );

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
              Why StoreMink <ChevronDown size={16} aria-hidden="true" />
            </button>
            <div className="smh-mega">
              <div className="smh-mega-inner">
                <div className="smh-mega-cards">
                  <Link href="/why-storemink" className="smh-mega-card">
                    <span>
                      <Image
                        src={menuPhotos.start}
                        alt=""
                        width={1200}
                        height={900}
                        sizes="30vw"
                      />
                    </span>
                    <b>Get started fast</b>
                    <small>You could be selling by tomorrow.</small>
                  </Link>
                  <Link href="/why-storemink#switch" className="smh-mega-card">
                    <span>
                      <Image
                        src={menuPhotos.switch}
                        alt=""
                        width={1200}
                        height={900}
                        sizes="30vw"
                      />
                    </span>
                    <b>Switch to StoreMink</b>
                    <small>Bring your catalogue over with a CSV.</small>
                  </Link>
                  <Link href={payments.path} className="smh-mega-card">
                    <span>
                      <Image
                        src={menuPhotos.india}
                        alt=""
                        width={1200}
                        height={900}
                        sizes="30vw"
                      />
                    </span>
                    <b>Built for India</b>
                    <small>Rupees, GST invoices, 0% transaction fee.</small>
                  </Link>
                </div>
                {builtIn}
              </div>
            </div>
          </div>
          <div className="smh-nav-item">
            <button type="button" aria-haspopup="true">
              Products <ChevronDown size={16} aria-hidden="true" />
            </button>
            <div className="smh-mega">
              <div className="smh-mega-inner">
                <div className="smh-mega-cols">
                  <div>
                    <small>Build</small>
                    <Link href={build.path}>
                      <b>{build.label}</b>
                      <span>{build.blurb}</span>
                    </Link>
                    <a href={THEMES_URL}>
                      <b>Themes</b>
                      <span>Complete stores, ready to make your own.</span>
                    </a>
                    <Link href="/products/online-store#builder">
                      <b>Website builder</b>
                      <span>Every page, edited on a live preview.</span>
                    </Link>
                  </div>
                  <div>
                    <small>Sell</small>
                    <Link href={POS_URL}>
                      <b>Point of Sale</b>
                      <span>Counter, tablet or phone.</span>
                    </Link>
                    <Link href={orders.path}>
                      <b>{orders.label}</b>
                      <span>{orders.blurb}</span>
                    </Link>
                    <Link href={payments.path}>
                      <b>{payments.label}</b>
                      <span>{payments.blurb}</span>
                    </Link>
                  </div>
                  <div>
                    <small>Grow</small>
                    <Link href={marketing.path}>
                      <b>{marketing.label}</b>
                      <span>{marketing.blurb}</span>
                    </Link>
                    <Link href={mink.path}>
                      <b>{mink.label}</b>
                      <span>{mink.blurb}</span>
                    </Link>
                    <Link href="/products">
                      <b>All products</b>
                      <span>Everything behind your brand, in one place.</span>
                    </Link>
                  </div>
                </div>
                {builtIn}
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
          <Link href="/signup" className="smh-button smh-button-light">
            Start for free
          </Link>
        </div>
        <HomepageMobileNav posUrl={POS_URL} themesUrl={THEMES_URL} />
      </nav>
    </header>
  );
}
