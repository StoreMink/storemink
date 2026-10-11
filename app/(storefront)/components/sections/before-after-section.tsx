"use client";

import { useState } from "react";
import Image from "next/image";
import type {
  BeforeAfterConfig,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

// Two photographs in one frame. The "after" picture is the base layer and
// the "before" picture sits over it, clipped to the handle's position. The
// control is a native range input laid over the whole frame — so dragging
// anywhere moves the handle, the keyboard moves it in steps, and a screen
// reader gets a slider — while the visible handle is drawn beside it.

export function BeforeAfterSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: BeforeAfterConfig;
}) {
  const [position, setPosition] = useState(config.start);

  if (!config.before.image_url || !config.after.image_url) return null;

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
      <div className={`home-before-after ratio-${config.image_ratio}`}>
        <div className="home-before-after-layer is-after">
          <Image
            src={config.after.image_url}
            alt={config.after.image_alt || config.after.label}
            fill
            sizes="(max-width: 1100px) 100vw, 1100px"
            className="home-before-after-image"
          />
        </div>
        <div
          className="home-before-after-layer is-before"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
        >
          <Image
            src={config.before.image_url}
            alt={config.before.image_alt || config.before.label}
            fill
            sizes="(max-width: 1100px) 100vw, 1100px"
            className="home-before-after-image"
          />
        </div>
        <span className="home-before-after-label is-before" aria-hidden>
          {config.before.label}
        </span>
        <span className="home-before-after-label is-after" aria-hidden>
          {config.after.label}
        </span>
        <div
          className="home-before-after-handle"
          style={{ left: `${position}%` }}
          aria-hidden
        >
          <span className="home-before-after-grip" />
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={position}
          onChange={(event) => setPosition(Number(event.target.value))}
          className="home-before-after-range"
          aria-label={`Reveal ${config.before.label} or ${config.after.label}`}
          aria-valuetext={`${position}% ${config.before.label}`}
        />
      </div>
    </SectionShell>
  );
}
