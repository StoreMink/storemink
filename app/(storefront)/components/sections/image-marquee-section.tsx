import Image from "next/image";
import Link from "next/link";
import type {
  ImageMarqueeConfig,
  MarqueeImage,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

// A row of pictures drifting sideways: the ticker's mechanism (two identical
// sequences, the track translates -50% for a seamless loop; pauses on hover)
// applied to images.
//
// ★★ WITH MOTION OFF, EACH PICTURE SHOWS ONCE (23 Nov 2026), for the ticker's
// reason (ticker-section.tsx): a sequence holds the pictures several times
// over, and the still, wrapped band used to show every copy (two pictures
// became ten). The copies are marked `is-repeat`; the stylesheet drops them
// when motion is off, and they leave the tab order and the screen reader's
// reading like the looping copy.

function Frame({
  item,
  ratio,
  hidden,
  repeat,
  ariaHidden,
  children,
}: {
  item: MarqueeImage;
  ratio: ImageMarqueeConfig["image_ratio"];
  /** The looping copy is aria-hidden, so its links must leave the tab order
   *  too (axe: aria-hidden-focus); a shopper tabs through each picture once. */
  hidden?: boolean;
  /** A copy made only to fill the loop: dropped when motion is off. */
  repeat?: boolean;
  /** Set on a copy inside the sequence screen readers DO read. */
  ariaHidden?: boolean;
  children: React.ReactNode;
}) {
  const className = `home-marquee-item ratio-${ratio}${repeat ? " is-repeat" : ""}`;
  const tabIndex = hidden ? -1 : undefined;
  const hide = ariaHidden ? true : undefined;
  if (item.href && /^https?:\/\//i.test(item.href)) {
    return (
      <a
        className={className}
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        tabIndex={tabIndex}
        aria-hidden={hide}
      >
        {children}
      </a>
    );
  }
  if (item.href) {
    return (
      <Link
        className={className}
        href={item.href}
        tabIndex={tabIndex}
        aria-hidden={hide}
      >
        {children}
      </Link>
    );
  }
  return (
    <span className={className} aria-hidden={hide}>
      {children}
    </span>
  );
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
      {sequence.map((item, i) => {
        const repeat = i >= items.length;
        // Read and tabbed once: the first copy of the first sequence only.
        const silent = ariaHidden || repeat;
        return (
          <Frame
            item={item}
            ratio={config.image_ratio}
            hidden={silent}
            repeat={repeat}
            ariaHidden={repeat && !ariaHidden}
            key={i}
          >
            <Image
              src={item.image_url}
              alt={silent ? "" : item.image_alt}
              fill
              sizes="(max-width: 760px) 50vw, 320px"
              className="home-marquee-image"
            />
          </Frame>
        );
      })}
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
