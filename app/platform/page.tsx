import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  CircleCheck,
  Code2,
  Globe2,
  LayoutTemplate,
  MessageSquare,
  Package,
  Palette,
  ShoppingBag,
  Smartphone,
  Sparkles,
  Store,
  Users,
} from "lucide-react";
import { PLATFORM_URL, POS_URL, THEMES_URL } from "@/lib/site";
import {
  BRAND_DESCRIPTION,
  SUPPORT_EMAIL,
  platformOrganizationSchema,
  platformWebsiteSchema,
} from "@/lib/seo/brand-identity";
import { allowanceLabel, includedMinkCredits } from "@/lib/plans";
import { getPlanPricing } from "@/lib/plans/pricing";
import { getPlanAllowances } from "@/lib/plans/allowances";
import { getMinkConfig } from "@/lib/mink/config";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";
import { PricingCards, type PricingCard } from "./pricing-cards";
import { FAQS, PLANS } from "./pricing-content";
import {
  ChannelsArt,
  CommerceCommandCentre,
  GrowthArt,
  MinkArt,
  OrderFlowArt,
} from "./homepage-art";
import {
  BuilderArt,
  InvoiceArt,
  RegisterArt,
  StorefrontArt,
} from "./product-art";
import "./homepage.css";

// The homepage stays a server component. The only client JavaScript is the
// isolated monthly/yearly switch inside PricingCards and the mobile menu;
// everything else — the rotating hero line, the channel marquee, the header
// dropdowns — is CSS, so it remains fast, crawlable and keyboard-friendly.
//
// Structure follows the shopify.com homepage beat for beat (dark hero with a
// rotating promise → "sell everywhere" strip → three product cards → regional
// section → merchant-stage stories → AI assistant → customisation → POS →
// trust numbers → pricing → three steps → FAQ → final CTA → dark footer), but
// every claim on it is a StoreMink capability that exists today. No invented
// merchants, no invented conversion statistics.

// The rotating second line of the hero. The first entry is also the one a
// screen reader and a reduced-motion visitor get, so it has to stand alone.
const HERO_ROTATION = [
  "the store they line up for.",
  "a household name.",
  "a shop on every street.",
  "a wholesale business.",
  "the next big thing.",
];

// The "sell everywhere" strip. Each is a real StoreMink channel or capability.
const CHANNELS = [
  { icon: Globe2, label: "Online store", note: "yourbrand.storemink.com" },
  { icon: Store, label: "Point of Sale", note: "Counter, tablet or phone" },
  { icon: MessageSquare, label: "Enquiries", note: "Quote-based selling" },
  { icon: Package, label: "Pickup in store", note: "Buy online, collect" },
  { icon: Users, label: "Wholesale (B2B)", note: "Customer groups & pricing" },
  { icon: BarChart3, label: "Email campaigns", note: "Merge-tag emails" },
  { icon: Palette, label: "Your own domain", note: "yourbrand.com" },
  { icon: Sparkles, label: "Mink AI", note: "Built into the dashboard" },
];

const priceInr = (value: number) => `₹${value.toLocaleString("en-IN")}`;

export default async function StoreminkLanding() {
  // The allowance is operator-editable (lib/plans/allowances.ts), so the
  // advertised number is resolved here rather than compiled into PLANS —
  // otherwise the pricing table would promise one figure while the quota gate
  // enforced another.
  const [pricing, allowances] = await Promise.all([
    getPlanPricing(),
    getPlanAllowances(),
  ]);
  const included = includedMinkCredits(
    allowances,
    getMinkConfig().chargeCredits,
  );
  const cheapestPaidInr = Math.min(
    ...PLANS.map((plan) => pricing[plan.meta.id].monthlyInr).filter(
      (price) => price > 0,
    ),
  );

  const pricingCards: PricingCard[] = PLANS.map((plan) => ({
    id: plan.meta.id,
    name: plan.meta.name,
    who: plan.who,
    features: [
      ...plan.features,
      `${allowanceLabel(included[plan.meta.id])} Mink credits a month`,
    ],
    cta: plan.cta,
    popular: plan.popular,
    ...pricing[plan.meta.id],
  }));

  const planOffers = PLANS.map((plan) => ({
    "@type": "Offer",
    name: `StoreMink ${plan.meta.name}`,
    description: plan.meta.tagline,
    priceCurrency: "INR",
    price: pricing[plan.meta.id].monthlyInr,
    url: `${PLATFORM_URL}/#pricing`,
    availability: "https://schema.org/InStock",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      priceCurrency: "INR",
      price: pricing[plan.meta.id].monthlyInr,
      billingDuration: 1,
      billingIncrement: 1,
      unitCode: "MON",
      referenceQuantity: {
        "@type": "QuantitativeValue",
        value: 1,
        unitCode: "MON",
      },
    },
  }));

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      platformOrganizationSchema(),
      platformWebsiteSchema(),
      {
        "@type": "SoftwareApplication",
        "@id": `${PLATFORM_URL}/#software`,
        name: "StoreMink",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: PLATFORM_URL,
        description: BRAND_DESCRIPTION,
        publisher: { "@id": `${PLATFORM_URL}/#organization` },
        offers: {
          "@type": "AggregateOffer",
          priceCurrency: "INR",
          lowPrice: 0,
          highPrice: pricing.pro.monthlyInr,
          offerCount: PLANS.length,
          offers: planOffers,
        },
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="smh">
        <a className="smh-skip" href="#main-content">
          Skip to content
        </a>

        <SiteHeader />

        <main id="main-content">
          {/* Hero — dark, full-bleed, one promise and one button. */}
          <section className="smh-hero">
            <div className="smh-hero-glow" aria-hidden="true" />
            <div className="smh-container smh-hero-copy">
              <p className="smh-eyebrow">
                <span>AI-native</span> business platform, built in India
              </p>
              <h1>
                Build <em>what&apos;s yours.</em>
                <span className="smh-rotator">
                  <span className="smh-rotator-static">
                    Be {HERO_ROTATION[0]}
                  </span>
                  <span className="smh-rotator-track" aria-hidden="true">
                    {/* The first line is repeated at the end so the slide
                        loops back to it without a visible jump. */}
                    {[...HERO_ROTATION, HERO_ROTATION[0]].map((line, i) => (
                      <span key={`${line}-${i}`}>Be {line}</span>
                    ))}
                  </span>
                </span>
              </h1>
              <p className="smh-hero-lead">
                Dream big and build fast on StoreMink. Your storefront,
                operations and intelligence together in one place — the commerce
                platform made for how India sells.
              </p>
              <div className="smh-hero-actions">
                <Link href="/signup" className="smh-button smh-button-light">
                  Start for free
                </Link>
              </div>
              <p className="smh-hero-proof">
                Free plan forever · No credit card · 0% StoreMink transaction
                fee
              </p>
            </div>
            <div className="smh-container smh-command-wrap">
              <CommerceCommandCentre />
            </div>
          </section>

          {/* Sell everywhere — the channel strip. */}
          <section className="smh-everywhere" aria-label="Where you can sell">
            <div className="smh-container">
              <h2>
                Sell everywhere people shop. <span>Online and in person.</span>{" "}
                <span>On enquiry and wholesale.</span>{" "}
                <span>From one dashboard.</span>
              </h2>
            </div>
            <div className="smh-marquee" aria-hidden="true">
              <div className="smh-marquee-track">
                {[...CHANNELS, ...CHANNELS].map((channel, index) => (
                  <div className="smh-marquee-card" key={index}>
                    <span>
                      <channel.icon size={18} />
                    </span>
                    <b>{channel.label}</b>
                    <small>{channel.note}</small>
                  </div>
                ))}
              </div>
            </div>
            <ul className="smh-everywhere-list">
              {CHANNELS.map((channel) => (
                <li key={channel.label}>{channel.label}</li>
              ))}
            </ul>
          </section>

          {/* Three product cards. */}
          <section className="smh-cards-area" id="platform">
            <div className="smh-container">
              <p className="smh-section-label">One business operating system</p>
              <div className="smh-cards">
                <article className="smh-card">
                  <div className="smh-card-art smh-card-art-store">
                    <StorefrontArt />
                  </div>
                  <div className="smh-card-copy">
                    <h2>Get a store that&apos;s built to sell</h2>
                    <p>
                      Pick a theme, arrange ready-made sections in the visual
                      builder and publish on your own domain. No developer
                      needed.
                    </p>
                    <Link
                      href="/products/online-store"
                      className="smh-text-link"
                    >
                      Build your online store <ArrowRight size={15} />
                    </Link>
                  </div>
                </article>

                <article className="smh-card">
                  <div className="smh-card-art smh-card-art-orders">
                    <OrderFlowArt />
                  </div>
                  <div className="smh-card-copy">
                    <h2>Control everything in one place</h2>
                    <p>
                      Orders, inventory, customers and the counter. Run it all
                      from one dashboard that stays in sync.
                    </p>
                    <ul className="smh-chip-list">
                      <li>Payments</li>
                      <li>Shipping</li>
                      <li>Customers</li>
                      <li>Retail</li>
                      <li>Inventory</li>
                      <li>Catalogue</li>
                    </ul>
                  </div>
                </article>

                <article className="smh-card">
                  <div className="smh-card-art smh-card-art-channels">
                    <ChannelsArt />
                  </div>
                  <div className="smh-card-copy">
                    <h2>Sell on every channel</h2>
                    <p>
                      Online orders, counter sales, pickups, enquiries and
                      wholesale — one catalogue, one customer list.
                    </p>
                    <Link
                      href="/products/orders-inventory"
                      className="smh-text-link"
                    >
                      Sell online and in store <ArrowRight size={15} />
                    </Link>
                  </div>
                </article>
              </div>
            </div>
          </section>

          {/* Built for India. */}
          <section className="smh-india" id="india">
            <div className="smh-container smh-india-grid">
              <div className="smh-india-copy">
                <h2>Built for the way India sells</h2>
                <p>
                  Rupee pricing, GST tax classes and printable invoices are
                  built in. Connect your own payment gateway and keep every
                  rupee — StoreMink takes 0% of your sales.
                </p>
                <ul className="smh-check-list">
                  <li>
                    <Check size={16} /> Inclusive or exclusive GST pricing
                  </li>
                  <li>
                    <Check size={16} /> HSN codes and CGST/SGST breakdowns
                  </li>
                  <li>
                    <Check size={16} /> Cash on delivery and online payments
                  </li>
                  <li>
                    <Check size={16} /> Shiprocket fulfilment
                  </li>
                </ul>
                <Link href="/pricing" className="smh-button smh-button-dark">
                  See plans in rupees
                </Link>
              </div>
              <div className="smh-india-art">
                <InvoiceArt />
              </div>
            </div>
          </section>

          {/* For every stage. */}
          <section className="smh-stories">
            <div className="smh-container">
              <h2>For anyone from a first order to a growing brand</h2>
              <div className="smh-story-grid">
                <article className="smh-story is-start">
                  <div className="smh-story-copy">
                    <small>Get started fast</small>
                    <h3>
                      Launch from your kitchen table, with a store that looks
                      the part.
                    </h3>
                  </div>
                  <div className="smh-story-art">
                    <StorefrontArt />
                  </div>
                </article>
                <article className="smh-story is-grow">
                  <div className="smh-story-copy">
                    <small>Grow as big as you want</small>
                    <h3>
                      Turn first orders into repeat customers with groups,
                      coupons and campaigns.
                    </h3>
                  </div>
                  <div className="smh-story-art">
                    <GrowthArt />
                  </div>
                </article>
                <article className="smh-story is-retail">
                  <div className="smh-story-copy">
                    <small>Open the counter</small>
                    <h3>
                      Add a shop, a second one, and keep every shelf in sync
                      with your site.
                    </h3>
                  </div>
                  <div className="smh-story-art">
                    <RegisterArt compact />
                  </div>
                </article>
              </div>
              <div className="smh-stories-cta">
                <Link href="/pricing" className="smh-button smh-button-dark">
                  Pick a plan that fits
                </Link>
              </div>
            </div>
          </section>

          {/* Mink AI. */}
          <section className="smh-mink" id="mink">
            <div className="smh-container smh-mink-grid">
              <div className="smh-mink-copy">
                <p className="smh-section-label">Your very own commerce AI</p>
                <h2>Meet your secret weapon, Mink.</h2>
                <p>
                  Ask questions about your store and get answers from your own
                  data. Have Mink prepare product descriptions, emails and pages
                  as private drafts you review before anything goes live. Built
                  right into your StoreMink dashboard.
                </p>
                <ul className="smh-check-list is-light">
                  <li>
                    <Check size={16} /> Permission-aware answers from your store
                    data
                  </li>
                  <li>
                    <Check size={16} /> Private, editable drafts — nothing
                    publishes itself
                  </li>
                  <li>
                    <Check size={16} /> Mink credits included on every plan
                  </li>
                </ul>
                <Link
                  href="/products/mink-ai"
                  className="smh-text-link is-light"
                >
                  Meet Mink AI <ArrowRight size={15} />
                </Link>
              </div>
              <MinkArt />
            </div>
          </section>

          {/* Customise everything. */}
          <section className="smh-custom">
            <div className="smh-container">
              <div className="smh-custom-head">
                <h2>Make every page yours</h2>
                <p>
                  Start from a theme, shape it in the builder, and go further
                  with your own code when you want to.
                </p>
              </div>
              <div className="smh-custom-grid">
                <article className="smh-custom-card is-wide">
                  <div className="smh-custom-copy">
                    <span className="smh-icon-chip">
                      <LayoutTemplate size={20} />
                    </span>
                    <h3>Visual website builder</h3>
                    <p>
                      Arrange ready-made sections, preview every change and
                      publish when it is right.
                    </p>
                  </div>
                  <div className="smh-custom-art">
                    <BuilderArt />
                  </div>
                </article>
                <article className="smh-custom-card">
                  <span className="smh-icon-chip">
                    <Palette size={20} />
                  </span>
                  <h3>Themes</h3>
                  <p>
                    Distinct looks with their own type and colour, ready to make
                    your own.
                  </p>
                  <a href={THEMES_URL} className="smh-text-link">
                    Browse themes <ArrowRight size={15} />
                  </a>
                </article>
                <article className="smh-custom-card">
                  <span className="smh-icon-chip">
                    <Code2 size={20} />
                  </span>
                  <h3>Custom code</h3>
                  <p>
                    Add your own snippets and tracking on paid plans when the
                    builder is not enough.
                  </p>
                  <Link href="/pricing" className="smh-text-link">
                    See what each plan includes <ArrowRight size={15} />
                  </Link>
                </article>
              </div>
            </div>
          </section>

          {/* Point of Sale. */}
          <section className="smh-pos">
            <div className="smh-container smh-pos-grid">
              <div className="smh-pos-copy">
                <p className="smh-section-label">StoreMink Point of Sale</p>
                <h2>
                  Your website and your counter, finally on the same page.
                </h2>
                <p>
                  Sell from a computer, tablet or phone. Products, customers and
                  location stock stay connected to your online store in real
                  time.
                </p>
                <ul>
                  <li>
                    <CircleCheck size={18} />
                    <span>
                      <b>Fast in-store checkout</b> with barcode search, held
                      sales and split payments.
                    </span>
                  </li>
                  <li>
                    <CircleCheck size={18} />
                    <span>
                      <b>Live multi-location inventory</b> with transfers and
                      low-stock visibility.
                    </span>
                  </li>
                  <li>
                    <CircleCheck size={18} />
                    <span>
                      <b>Connected fulfilment</b> for pickup, returns and store
                      credit.
                    </span>
                  </li>
                </ul>
                <Link href={POS_URL} className="smh-button smh-button-light">
                  Explore Point of Sale <ArrowRight size={17} />
                </Link>
              </div>
              <div className="smh-pos-media">
                <Image
                  src="/brand/storemink-pos-multidevice.png"
                  alt="StoreMink Point of Sale running on a desktop, tablet and phone"
                  width={1536}
                  height={1024}
                  sizes="(max-width: 900px) 100vw, 56vw"
                />
                <span className="smh-pos-badge">
                  <Smartphone size={16} /> Works across your devices
                </span>
              </div>
            </div>
          </section>

          {/* Trust. */}
          <section className="smh-trust" aria-label="Why build on StoreMink">
            <div className="smh-container">
              <h2>There&apos;s no better place for you to build</h2>
              <div className="smh-trust-grid">
                <div>
                  <b>₹0</b>
                  <span>to start. Free plan, no card.</span>
                </div>
                <div>
                  <b>0%</b>
                  <span>
                    StoreMink transaction fee. Your gateway, your money.
                  </span>
                </div>
                <div>
                  <b>D2C + B2B</b>
                  <span>in one storefront, one catalogue.</span>
                </div>
                <div>
                  <b>Online + POS</b>
                  <span>one inventory, every location.</span>
                </div>
              </div>
              <p className="smh-trust-note">
                <CircleCheck size={16} /> Your products, settings, content and
                history are never deleted by a plan downgrade or a failed
                payment.
              </p>
            </div>
          </section>

          {/* Pricing. */}
          <section className="smh-pricing-area" id="pricing">
            <div className="smh-container">
              <div className="smh-pricing-head">
                <p className="smh-section-label">Simple pricing</p>
                <h2>Start free. Grow for less.</h2>
                <p>
                  Every plan includes a real storefront and 0% StoreMink
                  transaction fees. Paid plans start at{" "}
                  {priceInr(cheapestPaidInr)} per month.
                </p>
              </div>
              <div className="smh-pricing-component">
                <PricingCards plans={pricingCards} />
              </div>
              <p className="smh-pricing-foot">
                <CircleCheck size={16} /> Your store data is never deleted by a
                plan downgrade or failed payment.
              </p>
              <div className="smh-pricing-more">
                <Link href="/pricing" className="smh-text-link">
                  Compare every feature on every plan <ArrowRight size={15} />
                </Link>
              </div>
            </div>
          </section>

          {/* Three steps. */}
          <section className="smh-steps">
            <div className="smh-container">
              <h2>Build fast on StoreMink</h2>
              <ol className="smh-steps-list">
                <li>
                  <span>1</span>
                  <div className="smh-step-icon">
                    <Package size={22} />
                  </div>
                  <h3>Add your first product</h3>
                  <p>
                    Name, price, photos and GST class. Mink can draft the
                    description.
                  </p>
                </li>
                <li>
                  <span>2</span>
                  <div className="smh-step-icon">
                    <LayoutTemplate size={22} />
                  </div>
                  <h3>Customise your store</h3>
                  <p>
                    Choose a theme, arrange sections, add your logo and your own
                    domain.
                  </p>
                </li>
                <li>
                  <span>3</span>
                  <div className="smh-step-icon">
                    <ShoppingBag size={22} />
                  </div>
                  <h3>Set up payments</h3>
                  <p>
                    Turn on cash on delivery, or connect your own gateway and
                    start taking orders.
                  </p>
                </li>
              </ol>
              <div className="smh-steps-cta">
                <Link href="/signup" className="smh-button smh-button-dark">
                  Take your shot <ArrowRight size={17} />
                </Link>
              </div>
            </div>
          </section>

          {/* FAQ. */}
          <section className="smh-faq" id="faq">
            <div className="smh-container smh-faq-grid">
              <div className="smh-faq-copy">
                <p className="smh-section-label">Good to know</p>
                <h2>Questions before you begin?</h2>
                <p>
                  Find step-by-step guides in the{" "}
                  <a href="https://help.storemink.com">StoreMink Help Centre</a>
                  , or email us at{" "}
                  <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
                </p>
              </div>
              <div className="smh-faq-list">
                {FAQS.map((faq) => (
                  <details key={faq.q}>
                    <summary>
                      {faq.q}
                      <ChevronDown size={19} />
                    </summary>
                    <p>{faq.a}</p>
                  </details>
                ))}
              </div>
            </div>
          </section>

          {/* Final CTA. */}
          <section className="smh-final">
            <div className="smh-container smh-final-inner">
              <h2>Start selling with StoreMink today</h2>
              <p>
                Free plan forever. No credit card. Bring your products, your
                brand and your ambition.
              </p>
              <div>
                <Link href="/signup" className="smh-button smh-button-dark">
                  Start for free
                </Link>
                <Link href="/pricing" className="smh-button smh-button-soft">
                  See plans
                </Link>
              </div>
            </div>
          </section>
        </main>

        <SiteFooter />
      </div>
    </>
  );
}
