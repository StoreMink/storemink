import Image from "next/image";
import Link from "next/link";
import type {
  ImageMarqueeConfig,
  MarqueeImage,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

// A row of pictures drifting sideways: the ticker's mechanism (two identical
// sequences, the track translates -50% for a seamless loop; pauses on hover;
// static and wrapped under prefers-reduced-motion) applied to images.

function Frame({
  item,
  ratio,
  children,
}: {
  item: MarqueeImage;
  ratio: ImageMarqueeConfig["image_ratio"];
  children: React.ReactNode;
}) {
  const className = `home-marquee-item ratio-${ratio}`;
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

export function ImageMarqueeSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: ImageMarqueeConfig;
}) {
  const items = config.items.filter((item) => item.image_url);
  if (items.length === 0) return null;

  // Repeat the pictures enough to fill a wide screen before the -50% loop
  // point (fewer pictures → more repeats).
  const repeats = Math.min(8, Math.max(2, Math.ceil(10 / items.length)));
  const sequence = Array.from({ length: repeats }).flatMap(() => items);

  const seq = (ariaHidden?: boolean) => (
    <div className="home-marquee-seq" aria-hidden={ariaHidden || undefined}>
      {sequence.map((item, i) => (
        <Frame item={item} ratio={config.image_ratio} key={i}>
          <Image
            src={item.image_url}
            alt={ariaHidden ? "" : item.image_alt}
            fill
            sizes="(max-width: 760px) 50vw, 320px"
            className="home-marquee-image"
          />
        </Frame>
      ))}
    </div>
  );

  return (
    <SectionShell sectionId={sectionId} style={style}>
      <div className={`home-marquee size-${config.size} speed-${config.speed}`}>
        <div className="home-marquee-track">
          {seq()}
          {seq(true)}
        </div>
      </div>
    </SectionShell>
  );
}
