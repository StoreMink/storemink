import type { Metadata } from "next";
import Link from "next/link";
import { Inter } from "next/font/google";
import { HELP_URL } from "@/lib/site";
import { platformOrganizationSchema } from "@/lib/seo/brand-identity";
import { serializeJsonLd } from "@/lib/seo/json-ld";
import { PLATFORM_URL, SEARCH_INDEXABLE } from "@/lib/store/host";
import { getMinkConfig } from "@/lib/mink/config";
import { BrandMark } from "../platform/brand-mark";
import { HelpHeader } from "./components/help-header";
import "./help.css";

const helpFont = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dash",
});

export const metadata: Metadata = {
  metadataBase: new URL(HELP_URL),
  title: {
    default: "StoreMink Help Centre",
    template: "%s | StoreMink Help",
  },
  description:
    "Guides for creating your StoreMink storefront and managing products, orders, payments, inventory, locations, POS and Mink AI.",
  alternates: { canonical: "/help" },
  // Only production (storemink.com) is ever indexed — staging/dev help pages
  // are explicitly noindex, matching the SEARCH_INDEXABLE gate used by
  // robots.ts / sitemap.ts.
  ...(SEARCH_INDEXABLE ? {} : { robots: { index: false, follow: false } }),
};

// The help centre had NO Organization or WebSite node anywhere — only the
// category and article routes emitted JSON-LD. So every help article declared a
// publisher that resolved to nothing on this host, and a whole subdomain of
// first-party content contributed nothing to the StoreMink entity. Same @id as
// the apex (lib/seo/brand-identity.ts), so the two describe one entity rather
// than two.
const HELP_GRAPH = {
  "@context": "https://schema.org",
  "@graph": [
    platformOrganizationSchema(),
    {
      "@type": "WebSite",
      "@id": `${HELP_URL}/#website`,
      name: "StoreMink Help Centre",
      url: HELP_URL,
      publisher: { "@id": platformOrganizationSchema()["@id"] },
    },
  ],
};

export default function HelpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={`hc ${helpFont.variable}`}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(HELP_GRAPH) }}
      />
      <HelpHeader voiceEnabled={getMinkConfig().enabled} />

      {children}

      <footer className="hc-footer">
        <div className="hc-footer-inner">
          <Link
            href="/help"
            className="hc-footer-logo"
            aria-label="StoreMink Help"
          >
            <BrandMark size={22} />
            <span aria-hidden="true">
              Store<em>Mink</em>
            </span>
          </Link>
          <nav className="hc-footer-links" aria-label="StoreMink">
            <a href={PLATFORM_URL}>
              {PLATFORM_URL.replace(/^https?:\/\//, "")}
            </a>
            <a href={`${PLATFORM_URL}/legal/terms`}>Terms of service</a>
            <a href={`${PLATFORM_URL}/legal/privacy`}>Privacy policy</a>
            <a href="mailto:support@storemink.com">Contact support</a>
          </nav>
          <span className="hc-footer-copy">
            © {new Date().getFullYear()} StoreMink LLP
          </span>
        </div>
      </footer>

      {/* ★★ THE MINK AI DRAWER IS PORTALLED HERE, NOT RENDERED IN THE HEADER.
          `.hc-topbar` carries `backdrop-filter: blur(18px)` for its frosted
          glass, and a backdrop-filtered element becomes the CONTAINING BLOCK
          for every `position: fixed` descendant — so the drawer resolved its
          top/right/bottom against the 73px header instead of the viewport and
          rendered as a 360x8px sliver at the header's bottom edge. It is a
          child of `.hc` rather than `document.body` so the portalled panel
          keeps the `--hc-*` tokens, the Inter `--font-dash` variable and the
          `.hc a` reset it styles itself with. Empty in a column flex
          container, so it contributes no height. */}
      <div id="hc-overlay-root" />
    </div>
  );
}
