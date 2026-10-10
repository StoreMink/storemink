import Image from "next/image";
import Link from "next/link";
import type {
  MediaTextConfig,
  MediaTextStory,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

function Cta({ label, href }: { label: string; href: string }) {
  if (!label || !href) return null;
  const className = "home-media-text-cta sm-btn-primary";
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

/** One image-and-copy band: the section's own content, or one of its
 *  stories. The ratio and alignment are the section's; each band chooses
 *  which side its picture sits on. The first band's heading is the h2 the
 *  section is known by; a story's heading is an h3 under it. */
function Band({
  band,
  ratio,
  alignment,
  level,
}: {
  band: MediaTextStory;
  ratio: MediaTextConfig["media_ratio"];
  alignment: MediaTextConfig["alignment"];
  level: "h2" | "h3";
}) {
  const Heading = level;
  return (
    <div
      className={`home-media-text media-${band.media_position} align-${alignment}${band.image_url ? "" : " no-media"}`}
    >
      {band.image_url && (
        <div className={`home-media-text-media ratio-${ratio}`}>
          <Image
            src={band.image_url}
            alt={band.image_alt || band.heading}
            fill
            sizes="(max-width: 760px) 100vw, 50vw"
            className="home-media-text-image"
          />
        </div>
      )}
      <div className="home-media-text-copy">
        {band.eyebrow && <p className="home-section-eyebrow">{band.eyebrow}</p>}
        {band.heading && (
          <Heading className="home-media-text-heading">{band.heading}</Heading>
        )}
        {band.body && <p className="home-media-text-body">{band.body}</p>}
        <Cta label={band.cta_label} href={band.cta_href} />
      </div>
    </div>
  );
}

export function MediaTextSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: MediaTextConfig;
}) {
  const stories = config.stories ?? [];
  if (
    !config.heading &&
    !config.body &&
    !config.image_url &&
    stories.length === 0
  )
    return null;

  const first = (
    <Band
      band={config}
      ratio={config.media_ratio}
      alignment={config.alignment}
      level="h2"
    />
  );

  // Without stories the markup is exactly what it was before stories
  // existed: one band directly under the section.
  if (stories.length === 0) {
    return (
      <SectionShell sectionId={sectionId} style={style}>
        {first}
      </SectionShell>
    );
  }

  return (
    <SectionShell sectionId={sectionId} style={style}>
      <div className="home-media-stories">
        {first}
        {stories.map((story, index) => (
          <Band
            key={`${story.heading}-${index}`}
            band={story}
            ratio={config.media_ratio}
            alignment={config.alignment}
            level="h3"
          />
        ))}
      </div>
    </SectionShell>
  );
}
