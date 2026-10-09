"use client";

import { useState } from "react";
import Image from "next/image";
import { Plus, Minus } from "lucide-react";
import type {
  AccordionConfig,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

// Collapsible content — rows a shopper opens as needed (shipping, care,
// materials, sizing). The section's blocks are typed: a "text" row is a
// heading and a body, an "image" row also shows a picture inside the open
// panel. Unlike the FAQ accordion, several rows may stay open together and
// there is no category filter. Bodies are plain text (never HTML), rendered
// with the storefront tokens so the section reskins per theme.
export function AccordionSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: AccordionConfig;
}) {
  const [open, setOpen] = useState<ReadonlySet<number>>(
    () => new Set(config.open_first ? [0] : []),
  );

  if (config.items.length === 0) return null;

  const toggle = (index: number) => {
    setOpen((current) => {
      const isOpen = current.has(index);
      if (config.allow_multiple) {
        const next = new Set(current);
        if (isOpen) next.delete(index);
        else next.add(index);
        return next;
      }
      return isOpen ? new Set() : new Set([index]);
    });
  };

  return (
    <SectionShell sectionId={sectionId} style={style}>
      {(config.heading || config.subheading) && (
        <div className="home-section-head">
          {config.heading && (
            <h2 className="home-section-title">{config.heading}</h2>
          )}
          {config.subheading && (
            <p className="home-section-sub">{config.subheading}</p>
          )}
        </div>
      )}

      <div className="home-accordion-list">
        {config.items.map((item, index) => {
          const isOpen = open.has(index);
          const panelId = `${sectionId}-accordion-${index}`;
          const hasMedia = item.type === "image" && Boolean(item.image_url);
          return (
            <div
              className={`home-accordion-item${isOpen ? " open" : ""}`}
              key={`${item.heading}-${index}`}
            >
              <button
                type="button"
                className="home-accordion-q"
                onClick={() => toggle(index)}
                aria-expanded={isOpen}
                aria-controls={panelId}
              >
                <span>{item.heading}</span>
                {isOpen ? (
                  <Minus size={20} aria-hidden />
                ) : (
                  <Plus size={20} aria-hidden />
                )}
              </button>
              {isOpen && (
                <div
                  id={panelId}
                  className={`home-accordion-panel${hasMedia ? " has-media" : ""}`}
                >
                  {item.body && <p className="home-accordion-a">{item.body}</p>}
                  {hasMedia && (
                    <div className="home-accordion-media">
                      <Image
                        src={item.image_url}
                        alt={item.image_alt || item.heading}
                        fill
                        sizes="(max-width: 700px) 100vw, 260px"
                        className="home-accordion-image"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}
