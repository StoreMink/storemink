import Image from "next/image";
import Link from "next/link";
import type {
  LogoItem,
  LogoStripConfig,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

// Press, partner or stockist marks: a static centred row, or the marquee
// track drifting sideways. Monochrome renders every mark in one tone so
// mixed brands sit quietly under the store's own colours.

function Mark({
  item,
  children,
}: {
  item: LogoItem;
  children: React.ReactNode;
}) {
  const className = "home-logo";
  if (item.href && /^https?:\/\//i.test(item.href)) {
    return (
      <a
        className={className}
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  }
  if (item.href) {
    return (
      <Link className={className} href={item.href}>
        {children}
      </Link>
    );
  }
  return <span className={className}>{children}</span>;
}

export function LogoStripSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: LogoStripConfig;
}) {
  const items = config.items.filter((item) => item.image_url);
  if (items.length === 0) return null;

  const marks = (ariaHidden?: boolean) =>
    items.map((item, i) => (
      <Mark item={item} key={i}>
        <Image
          src={item.image_url}
          alt={ariaHidden ? "" : item.image_alt}
          fill
          sizes="160px"
          className="home-logo-image"
        />
      </Mark>
    ));

  return (
    <SectionShell sectionId={sectionId} style={style}>
      <div
        className={`home-logos layout-${config.layout}${config.monochrome ? " is-monochrome" : ""}`}
      >
        {config.heading && (
          <p className="home-logos-heading">{config.heading}</p>
        )}
        {config.layout === "scroll" ? (
          <div className="home-marquee size-sm speed-slow home-logos-scroll">
            <div className="home-marquee-track">
              <div className="home-marquee-seq">{marks()}</div>
              <div className="home-marquee-seq" aria-hidden>
                {marks(true)}
              </div>
            </div>
          </div>
        ) : (
          <div className="home-logos-row">{marks()}</div>
        )}
      </div>
    </SectionShell>
  );
}
