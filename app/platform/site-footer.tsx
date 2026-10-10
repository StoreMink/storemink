import Link from "next/link";
import { Globe2, Mail } from "lucide-react";
import { LEGAL_DOCS } from "@/lib/legal/documents";
import {
  BRAND_TAGLINE,
  BRAND_SOCIAL_LINKS,
  SUPPORT_EMAIL,
} from "@/lib/seo/brand-identity";
import { POS_URL, THEMES_URL } from "@/lib/site";
import { BrandMark } from "./brand-mark";
import { PRODUCT_PAGES } from "./marketing-routes";

// The one platform footer, shared by the apex homepage, the marketing pages
// and /legal/*.
//
// ★ IT WAS INLINE IN page.tsx, so the policy pages had neither a header nor a
// footer — the only public pages in the estate with no chrome at all, and the
// ones the signup consent sentence links to. Extracted rather than copied for
// the reason `SiteHeader` was: a second hand-written copy is how four hosts
// ended up with four different headers.
//
// Dark, four link columns, a region line and the legal row — the shopify.com
// footer shape. The region line is a plain statement (India · English · ₹),
// not a selector: StoreMink serves one region today and a dropdown with one
// entry is a control that promises a choice it does not have.
export function SiteFooter() {
  return (
    <footer className="smh-footer">
      <div className="smh-container smh-footer-grid">
        <div className="smh-footer-brand">
          <Link href="/" className="smh-logo">
            <BrandMark size={29} />
            <span aria-hidden="true">
              Store<em>Mink</em>
            </span>
          </Link>
          <p>
            {BRAND_TAGLINE} The AI-native business operating system for
            independent brands.
          </p>
          <span>
            Made in India <Globe2 size={14} />
          </span>
        </div>
        <div>
          <h3>StoreMink</h3>
          <nav>
            <Link href="/why-storemink">Why StoreMink</Link>
            <Link href="/products">Products</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/signup">Create your store</Link>
          </nav>
        </div>
        <div>
          <h3>Products</h3>
          <nav>
            {PRODUCT_PAGES.map((page) => (
              <Link key={page.path} href={page.path}>
                {page.label}
              </Link>
            ))}
            <Link href={POS_URL}>Point of Sale</Link>
            <a href={THEMES_URL}>Themes</a>
          </nav>
        </div>
        <div>
          <h3>Resources</h3>
          <nav>
            <a href="https://help.storemink.com">Help Centre</a>
            <Link href="/pricing#faq">FAQ</Link>
            <Link href="/login">Log in</Link>
          </nav>
        </div>
        <div>
          <h3>Support</h3>
          <nav>
            <a href={`mailto:${SUPPORT_EMAIL}`}>
              <Mail size={13} /> {SUPPORT_EMAIL}
            </a>
            {BRAND_SOCIAL_LINKS.map((social) => (
              <a
                key={social.href}
                href={social.href}
                rel="me noopener"
                target="_blank"
              >
                {social.label}
              </a>
            ))}
          </nav>
        </div>
      </div>
      <div className="smh-container smh-footer-base">
        <span className="smh-footer-region">
          <Globe2 size={14} /> India · English · ₹ INR
        </span>
        <nav className="smh-footer-legal" aria-label="Legal">
          {LEGAL_DOCS.map((document) => (
            <Link key={document.slug} href={`/legal/${document.slug}`}>
              {document.title}
            </Link>
          ))}
        </nav>
        <span>© {new Date().getFullYear()} StoreMink</span>
      </div>
    </footer>
  );
}
