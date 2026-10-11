"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type {
  ImageHotspotsConfig,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

// A shoppable image: dots at percentage positions open a small card with a
// title, a line of copy and a link. One card open at a time; Escape, a click
// outside the picture or the dot itself closes it. A card near the right or
// bottom edge opens towards the inside of the picture.

export function ImageHotspotsSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: ImageHotspotsConfig;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!config.image_url) return null;

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
      <div className={`home-hotspots ratio-${config.image_ratio}`} ref={root}>
        <Image
          src={config.image_url}
          alt={config.image_alt || config.heading}
          fill
          sizes="(max-width: 1100px) 100vw, 1100px"
          className="home-hotspots-image"
        />
        {config.hotspots.map((spot, index) => {
          const isOpen = open === index;
          const cardId = `${sectionId}-hotspot-${index}`;
          return (
            <div
              className={`home-hotspot${isOpen ? " open" : ""}${spot.x > 55 ? " from-right" : ""}${spot.y > 60 ? " from-bottom" : ""}`}
              style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
              key={`${spot.title}-${index}`}
            >
              <button
                type="button"
                className="home-hotspot-dot"
                aria-expanded={isOpen}
                aria-controls={cardId}
                aria-label={spot.title || `Hotspot ${index + 1}`}
                onClick={() => setOpen(isOpen ? null : index)}
              >
                <span className="home-hotspot-pulse" aria-hidden />
              </button>
              {isOpen && (
                <div id={cardId} className="home-hotspot-card">
                  {spot.title && (
                    <strong className="home-hotspot-title">{spot.title}</strong>
                  )}
                  {spot.body && (
                    <p className="home-hotspot-body">{spot.body}</p>
                  )}
                  {spot.href &&
                    (/^https?:\/\//i.test(spot.href) ? (
                      <a
                        className="home-hotspot-link"
                        href={spot.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {spot.cta_label || "Shop"}
                      </a>
                    ) : (
                      <Link className="home-hotspot-link" href={spot.href}>
                        {spot.cta_label || "Shop"}
                      </Link>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}
