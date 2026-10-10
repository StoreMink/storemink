import { SiteFooter } from "../site-footer";
import { SiteHeader } from "../site-header";
import "../homepage.css";
import "./marketing.css";

// The shell for every marketing page other than the homepage: Why StoreMink,
// the Products family and Pricing. Same `.smh` scope, same header and footer
// as the apex, so the pages cannot drift from it — the policy pages learned
// that lesson the hard way (see ../legal/layout.tsx).
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="smh">
      <a className="smh-skip" href="#main-content">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main-content">{children}</main>
      <SiteFooter />
    </div>
  );
}
