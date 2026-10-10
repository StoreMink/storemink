import type { Metadata } from "next";
// Self-contained: signup is the first screen of the product, not a marketing
// page, so it does not load the marketing site's homepage.css.
import "./signup.css";

// page.tsx is a client component (the signup wizard), so its metadata lives
// here. Without this it inherited the platform layout's metadata wholesale and
// served the homepage's exact title + og:url — two URLs claiming to be the same
// page, one of which app/sitemap.ts submits.
export const metadata: Metadata = {
  title: "Create your store · StoreMink",
  description:
    "Create your StoreMink account and set up your store in a few minutes. No credit card needed to start.",
  alternates: { canonical: "/signup" },
  openGraph: {
    title: "Create your store · StoreMink",
    description:
      "Create your StoreMink account and set up your store in a few minutes. No credit card needed to start.",
    url: "/signup",
  },
};

// Signup no longer offers themes (every store starts on the default and its
// owner chooses another from the dashboard's Themes page), so this layout has
// nothing to load: the wizard's only server state, the live plan prices, is
// read by the Plan step itself from /api/plans/pricing.
export default function SignupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
