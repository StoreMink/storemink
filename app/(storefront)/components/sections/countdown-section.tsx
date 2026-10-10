"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type {
  CountdownConfig,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

// A live countdown to an instant. The server renders the frame with blank
// tiles (it must not read a clock the client would then disagree with), the
// browser starts ticking once mounted. Past the instant the section shows
// its message, or nothing when there is none.

const UNITS = [
  ["days", 86_400_000],
  ["hours", 3_600_000],
  ["minutes", 60_000],
  ["seconds", 1_000],
] as const;

export function splitRemaining(remainingMs: number) {
  let left = Math.max(0, remainingMs);
  return UNITS.map(([unit, size]) => {
    const value = Math.floor(left / size);
    left -= value * size;
    return { unit, value };
  });
}

export function CountdownSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: CountdownConfig;
}) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  const end = Date.parse(config.ends_at);
  if (!Number.isFinite(end)) return null;
  const remaining = now === null ? null : end - now;
  const expired = remaining !== null && remaining <= 0;
  if (expired && !config.expired_message) return null;

  const parts =
    remaining === null
      ? UNITS.map(([unit]) => ({ unit, value: null }))
      : splitRemaining(remaining);

  return (
    <SectionShell sectionId={sectionId} style={style}>
      <div className={`home-countdown align-${config.alignment}`}>
        {config.eyebrow && (
          <p className="home-section-eyebrow">{config.eyebrow}</p>
        )}
        {config.heading && (
          <h2 className="home-countdown-heading">{config.heading}</h2>
        )}
        {config.subheading && !expired && (
          <p className="home-countdown-sub">{config.subheading}</p>
        )}
        {expired ? (
          <p className="home-countdown-expired">{config.expired_message}</p>
        ) : (
          <div
            className="home-countdown-tiles"
            role="timer"
            aria-live="off"
            aria-label={config.heading || "Time remaining"}
          >
            {parts.map(({ unit, value }) => (
              <div className="home-countdown-tile" key={unit}>
                <span className="home-countdown-value">
                  {value === null ? "–" : String(value).padStart(2, "0")}
                </span>
                <span className="home-countdown-unit">{unit}</span>
              </div>
            ))}
          </div>
        )}
        {config.cta_label && config.cta_href && !expired && (
          <Link
            className="home-countdown-cta sm-btn-primary"
            href={config.cta_href}
          >
            {config.cta_label}
          </Link>
        )}
      </div>
    </SectionShell>
  );
}
