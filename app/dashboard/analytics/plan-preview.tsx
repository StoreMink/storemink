"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Lock } from "lucide-react";
import type { PlanGatedSectionId } from "@/lib/analytics/layout";
import {
  PREVIEW_HIDE_DAYS,
  previewHiddenCookie,
  type PlanPreviewData,
} from "@/lib/analytics/plan-previews";

// A locked Analytics section, shown where the real one would sit so a seller
// on a lower plan can see what the plan adds. Real numbers are used in the
// headline wherever StoreMink already has them; the art is a labelled sample.
//
// Hidden previews come back after 30 days: by then the store has usually
// grown, and the reason to look again has changed. The choice is a cookie on
// the store's own host so the SERVER can leave the section out entirely (no
// flash of a section that then disappears).

const PLAN_NAME = { basic: "Basic", pro: "Pro" } as const;

function SearchArt() {
  return (
    <div className="dash-an-preview-art-inner">
      <svg viewBox="0 0 240 70" preserveAspectRatio="none" aria-hidden>
        <polyline
          className="is-previous"
          points="0,52 30,48 60,50 90,40 120,44 150,36 180,38 210,30 240,32"
        />
        <polyline
          className="is-current"
          points="0,50 30,42 60,44 90,30 120,34 150,22 180,26 210,14 240,10"
        />
      </svg>
      {[86, 64, 48].map((width) => (
        <div key={width} className="dash-an-preview-line">
          <span style={{ width: `${width}%` }} />
          <em />
        </div>
      ))}
    </div>
  );
}

function ProfitArt() {
  return (
    <div className="dash-an-preview-art-inner">
      {["Sales", "Cost of goods", "Gross profit", "Gross margin"].map(
        (label, index) => (
          <div
            key={label}
            className={`dash-an-preview-row${index === 2 ? " is-strong" : ""}`}
          >
            <span>{label}</span>
            <em />
          </div>
        ),
      )}
    </div>
  );
}

function TrafficArt() {
  return (
    <div className="dash-an-preview-art-inner">
      <div className="dash-an-preview-chips" aria-hidden>
        <span>Instagram 38%</span>
        <span>Google 27%</span>
        <span>Mobile 74%</span>
        <span>Mumbai</span>
      </div>
      {[
        ["Sessions", 100],
        ["Viewed a product", 62],
        ["Added to cart", 24],
        ["Reached checkout", 11],
        ["Purchased", 6],
      ].map(([label, width]) => (
        <div key={label} className="dash-an-preview-funnel">
          <span className="dash-an-preview-funnel-label">{label}</span>
          <span className="dash-an-preview-funnel-bar">
            <span style={{ width: `${width}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

const ART: Record<PlanGatedSectionId, () => React.JSX.Element> = {
  "google-search": SearchArt,
  profit: ProfitArt,
  "storefront-traffic": TrafficArt,
};

export function PlanPreviewSection({ preview }: { preview: PlanPreviewData }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const plan = PLAN_NAME[preview.plan];
  const Art = ART[preview.id];

  const hide = () => {
    try {
      document.cookie = `${previewHiddenCookie(preview.id)}=${Date.now()}; max-age=${
        PREVIEW_HIDE_DAYS * 86_400
      }; path=/dashboard; samesite=lax`;
    } catch {
      // A blocked cookie only means the preview returns on the next visit.
    }
    setHidden(true);
  };

  return (
    <section
      className="dash-section dash-an-preview-section"
      aria-label={`${preview.title}, available on ${plan}`}
    >
      <h2>
        {preview.title}
        <span className={`dash-an-plan-badge is-${preview.plan}`}>
          <Lock aria-hidden /> {plan}
        </span>
      </h2>
      <div className="dash-an-preview">
        <div className="dash-an-preview-copy">
          <p className="dash-an-preview-headline">{preview.headline}</p>
          <p className="dash-an-preview-text">{preview.pitch}</p>
          <ul className="dash-an-preview-points">
            {preview.points.map((point) => (
              <li key={point}>
                <Check aria-hidden /> {point}
              </li>
            ))}
          </ul>
          <div className="dash-an-preview-actions">
            {preview.canUpgrade ? (
              <Link href="/dashboard/plans" className="dash-an-upsell-cta">
                See {plan}
              </Link>
            ) : (
              <span className="dash-an-upsell-note">
                Ask your store owner to upgrade to {plan}.
              </span>
            )}
            <button
              type="button"
              className="dash-an-preview-hide"
              onClick={hide}
            >
              Hide for {PREVIEW_HIDE_DAYS} days
            </button>
          </div>
        </div>
        <div className="dash-an-preview-art" aria-hidden>
          <span className="dash-an-preview-sample">Sample</span>
          <Art />
        </div>
      </div>
    </section>
  );
}
