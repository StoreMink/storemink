"use client";

import { useState } from "react";
import { ExternalLink, Loader2, Sprout } from "lucide-react";
import { seedDemoStore } from "@/app/actions/platform";
import {
  INDUSTRY_LABELS,
  type ThemeMeta,
  type ThemeReleaseStatus,
} from "@/lib/themes/meta";

// Operator panel: one live demo store per theme (the signup picker's Preview
// target). Seed creates+fills it; Reseed wipes it back to the theme's pristine
// state (applyTheme reset; only allowed on settings.demo stores).
//
// ★ THE THEMES PAGE'S CATALOG TAB (wave TS-2, builder 2D). It offers exactly
// what it always did (name, industry, release and version, demo status, Open,
// Seed or Reseed) and no Hide or Show: bundled themes have no such action, and
// a Studio theme is offered or not from its own page. What changed is how it
// speaks: a result is a note on the theme's row, never a browser alert box,
// and a release's state is a plain word (the code's names candidate, approved
// and blocked never reach the screen).

const RELEASE_WORDS: Record<ThemeReleaseStatus, string> = {
  published: "Published",
  draft: "Draft",
  candidate: "Not published",
  approved: "Not published",
  blocked: "Not published",
};

const DEMO_WORDS: Record<ThemeMeta["demo"]["status"], string | null> = {
  healthy: null,
  provisioning: "Its demo is being set up.",
  unavailable: "Its demo is marked unavailable.",
};

type SeedNote =
  | { tone: "error"; text: string }
  | { tone: "warning"; text: string; lines: string[] }
  | { tone: "done"; text: string };

export function ThemesPanel({
  rootDomain,
  demoSlugsLive,
  themes,
}: {
  rootDomain: string;
  /** Slugs of demo stores that already exist. */
  demoSlugsLive: string[];
  /** Server-resolved runtime catalog projection. */
  themes: ThemeMeta[];
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [live, setLive] = useState(new Set(demoSlugsLive));
  const [notes, setNotes] = useState<Record<string, SeedNote>>({});

  async function seed(themeId: string, reseed: boolean) {
    setPendingId(themeId);
    setNotes((current) => {
      const next = { ...current };
      delete next[themeId];
      return next;
    });
    let note: SeedNote;
    try {
      const res = await seedDemoStore(themeId);
      if (res.error) {
        note = { tone: "error", text: res.error };
      } else {
        if (res.slug) setLive((s) => new Set(s).add(res.slug!));
        note = res.warnings?.length
          ? {
              tone: "warning",
              text: reseed
                ? "Reseeded, with warnings:"
                : "Seeded, with warnings:",
              lines: res.warnings,
            }
          : { tone: "done", text: reseed ? "Reseeded." : "Seeded." };
      }
    } catch {
      note = {
        tone: "error",
        text: "The demo store couldn't be seeded. Try again.",
      };
    }
    setNotes((current) => ({ ...current, [themeId]: note }));
    setPendingId(null);
  }

  return (
    <div className="dash-card">
      <div className="dash-card-header">
        <div>
          <h2 className="dash-card-title">Theme demo stores</h2>
          <p className="studio-muted mt-0.5 text-sm">
            The live stores the signup picker&apos;s Preview button opens.
            Reseeding resets a demo to the theme&apos;s pristine state.
          </p>
        </div>
      </div>
      <ul className="divide-y divide-[var(--dash-border)]">
        {themes.map((t) => {
          const exists = live.has(t.demo.slug);
          const industry = t.catalog.industries[0];
          const note = notes[t.id];
          const demoWords = DEMO_WORDS[t.demo.status];
          return (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-4"
            >
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--dash-text)]">
                    {t.name}
                  </span>
                  {industry ? (
                    <span className="dash-chip">
                      {INDUSTRY_LABELS[industry] ?? industry}
                    </span>
                  ) : null}
                  <span className="dash-chip">
                    {RELEASE_WORDS[t.release.status] ?? "Not published"} · v
                    {t.release.version}
                  </span>
                </div>
                <div className="studio-muted mt-1 break-all text-sm">
                  {t.demo.slug}.{rootDomain}
                  {!exists && " - not seeded yet"}
                </div>
                {demoWords ? (
                  <div className="studio-muted mt-1 text-sm">{demoWords}</div>
                ) : null}
                {note ? (
                  note.tone === "error" ? (
                    <p role="alert" className="studio-error mt-2 text-sm">
                      {note.text}
                    </p>
                  ) : note.tone === "warning" ? (
                    <div
                      role="status"
                      className="studio-notice mt-2 text-sm"
                      data-tone="warning"
                    >
                      <p>{note.text}</p>
                      <ul className="mt-1 list-disc pl-5">
                        {note.lines.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p role="status" className="studio-muted mt-2 text-sm">
                      {note.text}
                    </p>
                  )
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {exists && (
                  <a
                    href={`https://${t.demo.slug}.${rootDomain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open the ${t.name} demo (opens in a new tab)`}
                    className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
                  >
                    Open <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => seed(t.id, exists)}
                  disabled={pendingId !== null}
                  aria-label={`${exists ? "Reseed" : "Seed"} the ${t.name} demo store`}
                  className={`dash-btn dash-btn-sm pointer-coarse:min-h-11 ${exists ? "dash-btn-ghost" : "dash-btn-primary"}`}
                >
                  {pendingId === t.id ? (
                    <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sprout aria-hidden className="h-3.5 w-3.5" />
                  )}
                  {exists ? "Reseed" : "Seed"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
