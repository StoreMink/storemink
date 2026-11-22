import type { SectionStyle, TickerConfig } from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

// Scrolling marquee strip. theme = TEXT colour ("dark" ink on light backgrounds,
// "light" on dark ones — pair with the section Style background for the band).
// Pure CSS animation (homepage.css): two identical sequences translate -50% for
// a seamless loop; pauses on hover.
//
// ★★ WITH MOTION OFF, EACH MESSAGE SHOWS ONCE (23 Nov 2026). A sequence holds
// the messages several times over, to fill a wide screen before the loop
// point. Under prefers-reduced-motion the band stands still and wraps, and it
// used to show every one of those copies: three messages became a block of
// twelve, eight rows tall. That is what a shopper with "Reduce motion" on saw,
// and what Theme Studio photographed for a theme's catalogue picture (the
// capture runs with motion off; the owner found it on Aurelle). So the copies
// are marked `is-repeat`, and the stylesheet drops them when motion is off.
// They are also hidden from screen readers, which used to read each message
// once per copy.
export function TickerSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: TickerConfig;
}) {
  if (config.messages.length === 0) return null;

  // Repeat the messages enough to fill wide screens before the -50% loop point,
  // so short lists don't leave a visible gap (fewer messages → more repeats).
  const repeats = Math.min(
    12,
    Math.max(3, Math.ceil(12 / config.messages.length)),
  );
  const sequence = Array.from({ length: repeats }).flatMap(
    () => config.messages,
  );

  // A single filled sequence; the track holds two of these (the second aria-
  // hidden, and every copy inside the first too, so screen readers announce
  // the messages only once).
  const originals = config.messages.length;
  const seq = (ariaHidden?: boolean) => (
    <div className="home-ticker-seq" aria-hidden={ariaHidden || undefined}>
      {sequence.map((message, i) => {
        const repeat = i >= originals;
        return (
          <span
            className={`home-ticker-item${repeat ? " is-repeat" : ""}${
              i === originals - 1 ? " is-last" : ""
            }`}
            aria-hidden={repeat && !ariaHidden ? true : undefined}
            key={i}
          >
            {message}
          </span>
        );
      })}
    </div>
  );

  return (
    <SectionShell sectionId={sectionId} style={style}>
      <div
        className={`home-ticker theme-${config.theme} speed-${config.speed}`}
      >
        <div className="home-ticker-track">
          {seq()}
          {seq(true)}
        </div>
      </div>
    </SectionShell>
  );
}
