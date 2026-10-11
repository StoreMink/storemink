import Link from "next/link";
import type { HeroConfig, SectionStyle } from "@/lib/homepage/section-types";
import { videoEmbedUrl } from "@/lib/homepage/video-embed";
import { SectionShell } from "./section-shell";
import { HeroImage, HeroOverlay, heroClasses } from "./hero-media";
import { MediaTone } from "./media-tone";

// First-class hero block. Six variants:
//   banner    — inset rounded card on a solid colour field, copy left / image
//               right (grocery-market style);
//   split     — half copy / half image band;
//   minimal   — centred statement; an image (if any) becomes a full cover
//               background behind the copy;
//   fullbleed — the photograph fills the whole band and the copy sits over
//               it, left or centred: a one-slide carousel without the
//               controls, and the opening every Studio theme uses;
//   stacked   — the copy above a full-width photograph (plan Phase 2d);
//   offset    — the photograph fills the band and the copy sits in a card
//               over it, at the lower edge unless content_position says
//               otherwise; the card is opaque, so no tone probe or overlay.
// `config.background` is validated as a strict colour (safeColor), so it is
// safe in an inline style attribute — same contract as SectionStyle.background.
export function HeroSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: HeroConfig;
}) {
  if (!config.heading && !config.image_url && !config.video_url) return null;

  const hasCta = config.cta_label && config.cta_href;
  const isExternal = /^https?:\/\//i.test(config.cta_href);
  const cta = hasCta ? (
    isExternal ? (
      <a
        className="home-hero-cta sm-btn-primary"
        href={config.cta_href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {config.cta_label}
      </a>
    ) : (
      <Link className="home-hero-cta sm-btn-primary" href={config.cta_href}>
        {config.cta_label}
      </Link>
    )
  ) : null;

  const hasMedia = !!(config.image_url || config.video_url);
  // Copy over the photo's own pixels: MediaTone and the overlay apply.
  const overlaid =
    (config.variant === "minimal" || config.variant === "fullbleed") &&
    hasMedia;
  // The media covers the band (an offset hero's copy card sits over it).
  const asBackground = overlaid || (config.variant === "offset" && hasMedia);
  // Video wins over the image; the image doubles as its poster frame.
  // YouTube/Vimeo links become a chrome-less background embed; direct files
  // play via <video>. Muted + playsInline are required for mobile autoplay.
  const embedUrl = videoEmbedUrl(config.video_url);
  const media = embedUrl ? (
    <span className="home-video-embed-wrap">
      <iframe
        src={embedUrl}
        className="home-video-embed"
        allow="autoplay; encrypted-media; picture-in-picture"
        title={config.heading || "Hero video"}
        tabIndex={-1}
        aria-hidden
      />
    </span>
  ) : config.video_url ? (
    <video
      src={config.video_url}
      poster={config.image_url || undefined}
      className="home-hero-video"
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
    />
  ) : config.image_url ? (
    <HeroImage
      src={config.image_url}
      alt={config.heading || "Hero"}
      eager
      sizes={
        asBackground || config.variant === "stacked"
          ? "100vw"
          : "(max-width: 860px) 100vw, 50vw"
      }
      className="home-hero-img"
      options={config}
    />
  ) : null;
  const extra = heroClasses({
    height: config.height,
    content_position: config.content_position,
    // A tuned overlay only means something where copy sits on the media.
    overlay_opacity: overlaid ? config.overlay_opacity : undefined,
  });

  return (
    <SectionShell sectionId={sectionId} style={style}>
      <div
        className={`home-hero variant-${config.variant} theme-${config.theme} align-${config.alignment}${extra ? ` ${extra}` : ""}`}
        style={
          config.background ? { background: config.background } : undefined
        }
      >
        {asBackground && (
          <div className="home-hero-bgmedia">
            {media}
            <HeroOverlay
              opacity={overlaid ? config.overlay_opacity : undefined}
              theme={config.theme}
            />
          </div>
        )}
        {overlaid && config.image_url && !config.video_url && (
          <MediaTone
            preferred={config.theme}
            copy=".home-hero-copy"
            off={config.overlay_opacity !== undefined}
          />
        )}
        <div className="home-hero-copy">
          {config.badge_text && (
            <span className="home-hero-badge">{config.badge_text}</span>
          )}
          <h1 className="home-hero-heading">{config.heading}</h1>
          {config.subheading && (
            <p className="home-hero-sub">{config.subheading}</p>
          )}
          {cta}
        </div>
        {!asBackground && media && (
          <div className="home-hero-media">{media}</div>
        )}
      </div>
    </SectionShell>
  );
}
