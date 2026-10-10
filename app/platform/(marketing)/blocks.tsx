import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ArrowRight, Check } from "lucide-react";
import { PLATFORM_URL } from "@/lib/site";

// Building blocks for the marketing pages. Every page is composed from these
// so the family reads as one site: a hero, feature rows in dark cards, a
// pillar grid, and a closing CTA band. The shopify.com product-page shape,
// with no decorative icons: a pillar is numbered and titled, nothing more.

/** Canonical metadata for an apex marketing page. */
export function marketingMetadata({
  path,
  title,
  description,
}: {
  path: string;
  title: string;
  description: string;
}): Metadata {
  return {
    title: `${title} · StoreMink`,
    description,
    alternates: { canonical: `${PLATFORM_URL}${path}` },
    openGraph: {
      title: `${title} · StoreMink`,
      description,
      url: path,
      type: "website",
    },
  };
}

export function PageHero({
  label,
  title,
  lead,
  children,
  primary = { href: "/signup", text: "Start for free" },
  secondary,
}: {
  label?: string;
  title: ReactNode;
  lead: ReactNode;
  /** Optional artwork or photograph rendered under the copy. */
  children?: ReactNode;
  primary?: { href: string; text: string } | null;
  secondary?: { href: string; text: string };
}) {
  return (
    <section className="smm-hero">
      <div className="smh-container smm-hero-copy">
        {label && <p className="smh-section-label">{label}</p>}
        <h1>{title}</h1>
        <p className="smh-lead smm-hero-lead">{lead}</p>
        {(primary || secondary) && (
          <div className="smm-hero-actions">
            {primary && (
              <Link href={primary.href} className="smh-button smh-button-light">
                {primary.text}
              </Link>
            )}
            {secondary && (
              <Link
                href={secondary.href}
                className="smh-button smh-button-outline"
              >
                {secondary.text}
              </Link>
            )}
          </div>
        )}
      </div>
      {children && <div className="smh-container smm-hero-art">{children}</div>}
    </section>
  );
}

/**
 * One feature: copy beside artwork in a dark card. Rows alternate sides
 * automatically when stacked inside <FeatureRows>; `flip` forces a side.
 */
export function FeatureRow({
  label,
  title,
  children,
  points,
  link,
  art,
  tone = "lilac",
  flip,
}: {
  label?: string;
  title: ReactNode;
  children: ReactNode;
  points?: string[];
  link?: { href: string; text: string; external?: boolean };
  art: ReactNode;
  tone?: "lilac" | "mint" | "cream" | "navy" | "grey" | "photo";
  flip?: boolean;
}) {
  return (
    <article className={`smm-feature${flip ? " is-flip" : ""}`}>
      <div className="smm-feature-copy">
        {label && <p className="smh-section-label">{label}</p>}
        <h2>{title}</h2>
        <p className="smh-lead">{children}</p>
        {points && (
          <ul className="smh-check-list">
            {points.map((point) => (
              <li key={point}>
                <Check size={16} /> {point}
              </li>
            ))}
          </ul>
        )}
        {link &&
          (link.external ? (
            <a href={link.href} className="smh-text-link">
              {link.text} <ArrowRight size={16} />
            </a>
          ) : (
            <Link href={link.href} className="smh-text-link">
              {link.text} <ArrowRight size={16} />
            </Link>
          ))}
      </div>
      <div className={`smm-art is-${tone}`}>{art}</div>
    </article>
  );
}

export function FeatureRows({ children }: { children: ReactNode }) {
  return (
    <section className="smm-features">
      <div className="smh-container smm-feature-list">{children}</div>
    </section>
  );
}

export interface Pillar {
  title: string;
  body: string;
  href?: string;
  linkText?: string;
}

/**
 * A grid of short points. Each pillar carries its number in a small mono
 * label above the title, the way shopify.com labels its stat blocks, rather
 * than an icon: a row of similar-looking icons reads as decoration, and a
 * number is a real fact about the list.
 */
export function PillarGrid({
  label,
  title,
  lead,
  pillars,
  columns = 3,
}: {
  label?: string;
  title?: ReactNode;
  lead?: ReactNode;
  pillars: Pillar[];
  columns?: 2 | 3 | 4;
}) {
  return (
    <section className="smm-pillars">
      <div className="smh-container">
        {(label || title || lead) && (
          <div className="smm-pillars-head">
            {label && <p className="smh-section-label">{label}</p>}
            {title && <h2>{title}</h2>}
            {lead && <p className="smh-lead">{lead}</p>}
          </div>
        )}
        <div className={`smm-pillar-grid is-${columns}`}>
          {pillars.map((pillar, index) => {
            const inner = (
              <>
                <small className="smm-pillar-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </small>
                <h3>{pillar.title}</h3>
                <p>{pillar.body}</p>
                {pillar.href && (
                  <span className="smh-text-link">
                    {pillar.linkText ?? "Learn more"} <ArrowRight size={15} />
                  </span>
                )}
              </>
            );
            return pillar.href ? (
              <Link
                key={pillar.title}
                href={pillar.href}
                className="smm-pillar is-link"
              >
                {inner}
              </Link>
            ) : (
              <div key={pillar.title} className="smm-pillar">
                {inner}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function CtaBand({
  title = "Start selling with StoreMink today",
  lead = "No credit card needed to start. Bring your products, your brand and your ambition.",
  secondary = { href: "/pricing", text: "See plans" },
}: {
  title?: ReactNode;
  lead?: ReactNode;
  secondary?: { href: string; text: string } | null;
}) {
  return (
    <section className="smm-cta">
      <div className="smh-container smm-cta-inner">
        <h2>{title}</h2>
        <p className="smh-lead">{lead}</p>
        <div>
          <Link href="/signup" className="smh-button smh-button-light">
            Start for free
          </Link>
          {secondary && (
            <Link
              href={secondary.href}
              className="smh-button smh-button-outline"
            >
              {secondary.text}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

/** A quiet "also in StoreMink" row of links to the other product pages. */
export function RelatedPages({
  pages,
}: {
  pages: { path: string; label: string; blurb: string }[];
}) {
  return (
    <section className="smm-related">
      <div className="smh-container">
        <p className="smh-section-label">More of StoreMink</p>
        <div className="smm-related-grid">
          {pages.map((page) => (
            <Link key={page.path} href={page.path} className="smm-related-card">
              <b>{page.label}</b>
              <span>{page.blurb}</span>
              <ArrowRight size={16} />
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
