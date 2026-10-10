// The platform's public marketing pages — ONE registry, read by the header,
// the mobile menu, the footer and the apex sitemap, so a page cannot exist
// without being linked, and a link cannot point at a page that does not exist.
//
// Pure: no imports, so app/sitemap.ts can read it without dragging anything
// else in. Paths are apex-relative; proxy.ts rewrites storemink.com/* into
// /platform/* so these resolve to app/platform/(marketing)/<path>/page.tsx.

export interface MarketingPage {
  path: string;
  /** Short label for navigation. */
  label: string;
  /** One line under the label in menus and on the products overview. */
  blurb: string;
}

export const PRODUCT_PAGES: readonly MarketingPage[] = [
  {
    path: "/products/online-store",
    label: "Online store",
    blurb: "Themes, the visual builder and your own domain.",
  },
  {
    path: "/products/orders-inventory",
    label: "Orders & inventory",
    blurb: "Every order and every shelf, across locations.",
  },
  {
    path: "/products/payments",
    label: "Payments & GST",
    blurb: "Your own gateway, cash on delivery and GST invoices.",
  },
  {
    path: "/products/marketing",
    label: "Customers & marketing",
    blurb: "Groups, offers, campaigns, blogs and reviews.",
  },
  {
    path: "/products/mink-ai",
    label: "Mink AI",
    blurb: "Your very own commerce AI, built into the dashboard.",
  },
];

export const MARKETING_PAGES: readonly MarketingPage[] = [
  {
    path: "/why-storemink",
    label: "Why StoreMink",
    blurb: "One platform for the way India sells.",
  },
  {
    path: "/products",
    label: "Products",
    blurb: "Everything behind your brand, in one place.",
  },
  ...PRODUCT_PAGES,
  {
    path: "/pricing",
    label: "Pricing",
    blurb: "Start free. Paid plans in rupees, 0% transaction fee.",
  },
];
