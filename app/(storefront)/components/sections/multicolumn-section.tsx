import Image from "next/image";
import Link from "next/link";
import type {
  MulticolumnConfig,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";
import { USP_ICON_COMPONENTS } from "./usp-icons";

// Multi-column rich text (Shopify's "Multicolumn"): two to four columns of
// an icon or a picture, a heading, copy and an optional link. The columns
// are the section's blocks.

function ColumnLink({ label, href }: { label: string; href: string }) {
  if (!label || !href) return null;
  const className = "home-multicolumn-link";
  if (/^https?:\/\//i.test(href)) {
    return (
      <a
        className={className}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {label}
      </a>
    );
  }
  return (
    <Link className={className} href={href}>
      {label}
    </Link>
  );
}

export function MulticolumnSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: MulticolumnConfig;
}) {
  if (config.items.length === 0) return null;

  return (
    <SectionShell sectionId={sectionId} style={style}>
      {(config.eyebrow || config.heading || config.subheading) && (
        <div className="home-section-head">
          {config.eyebrow && (
            <p className="home-section-eyebrow">{config.eyebrow}</p>
          )}
          {config.heading && (
            <h2 className="home-section-title">{config.heading}</h2>
          )}
          {config.subheading && (
            <p className="home-section-sub">{config.subheading}</p>
          )}
        </div>
      )}
      <div
        className={`home-multicolumn cols-${config.columns} align-${config.alignment}`}
      >
        {config.items.map((item, index) => {
          const Icon = item.icon ? USP_ICON_COMPONENTS[item.icon] : null;
          return (
            <div
              className="home-multicolumn-item"
              key={`${item.heading}-${index}`}
            >
              {item.image_url ? (
                <div
                  className={`home-multicolumn-media ratio-${config.image_ratio}`}
                >
                  <Image
                    src={item.image_url}
                    alt={item.image_alt || item.heading}
                    fill
                    sizes="(max-width: 760px) 100vw, 33vw"
                    className="home-multicolumn-image"
                  />
                </div>
              ) : Icon ? (
                <Icon className="home-multicolumn-icon" aria-hidden="true" />
              ) : null}
              {item.heading && (
                <h3 className="home-multicolumn-heading">{item.heading}</h3>
              )}
              {item.body && (
                <p className="home-multicolumn-body">{item.body}</p>
              )}
              <ColumnLink label={item.cta_label} href={item.cta_href} />
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}
