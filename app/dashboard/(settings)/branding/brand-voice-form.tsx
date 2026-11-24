"use client";

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { generateBrandVoice } from "@/app/actions/brand-voice-actions";
import { InfoTip } from "@/components/ui/info-tip";
import type { BrandVoiceStructured } from "@/lib/ai/brand-voice";
import type { VoiceDraft } from "./branding-state";

const QUESTIONS: {
  key: keyof BrandVoiceStructured;
  label: string;
  wide?: boolean;
}[] = [
  {
    key: "sell",
    label: "What do you sell?",
    wide: true,
  },
  {
    key: "audience",
    label: "Who buys it?",
  },
  {
    key: "personality",
    label: "Three words for your personality",
  },
  {
    key: "why",
    label: "Why does your brand exist?",
  },
  {
    key: "avoid",
    label: "Words or claims to avoid",
  },
];

/**
 * Brand voice: the guide every Mink AI copy feature writes from (product
 * descriptions, SEO, marketing emails). The merchant answers five plain
 * questions, lets AI draft the guide or writes it, and saves it with the rest
 * of the page through the shared save bar, so this section owns no save of its
 * own: it edits the voice draft it is handed and reports changes upward.
 * Generating replaces the guide in the draft only; nothing is stored until the
 * merchant saves, and Discard brings the saved guide back.
 */
export function BrandVoiceSection({
  voice,
  onChange,
  canManage,
  onGeneratingChange,
}: {
  voice: VoiceDraft;
  /** The page's voice setter; always called with an updater, so an answer
   *  typed while a draft is being written is never lost. */
  onChange: Dispatch<SetStateAction<VoiceDraft>>;
  canManage: boolean;
  onGeneratingChange?: (generating: boolean) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const sellRef = useRef<HTMLInputElement>(null);

  const setAnswer = (key: keyof BrandVoiceStructured, value: string) =>
    onChange((prev) => ({
      ...prev,
      answers: { ...prev.answers, [key]: value },
    }));

  function setBusy(busy: boolean) {
    setGenerating(busy);
    onGeneratingChange?.(busy);
  }

  async function onGenerate() {
    if (!canManage || generating) return;
    if (!voice.answers.sell?.trim()) {
      setNote({
        ok: false,
        msg: "Tell us what you sell first. It anchors your brand voice.",
      });
      sellRef.current?.focus();
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const res = await generateBrandVoice(voice.answers);
      if (res.error || !res.content) {
        setNote({
          ok: false,
          msg: res.error ?? "Couldn't write a draft right now. Try again.",
        });
        return;
      }
      const content = res.content;
      onChange((prev) => ({ ...prev, content }));
      setNote({
        ok: true,
        msg: "Draft ready. Read it, change anything you like, then save.",
      });
    } catch {
      setNote({
        ok: false,
        msg: "Couldn't write a draft right now. Try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dash-card brandingCard" aria-labelledby="bv-title">
      <header className="dash-card-header">
        <div>
          <h2 className="dash-card-title" id="bv-title">
            Brand voice
          </h2>
          <p className="dash-card-sub">
            Mink AI writes your product descriptions, SEO text and marketing
            emails in this voice.
          </p>
        </div>
      </header>
      <div className="dash-card-body brandingCardBody">
        <div className="bvStep">
          <span className="bvStepNo" aria-hidden="true">
            1
          </span>
          <div className="bvStepBody">
            <h3 className="bvStepTitle">Tell us about your brand</h3>
            <div className="brandingGrid two">
              {QUESTIONS.map((q) => (
                <div
                  key={q.key}
                  className={`brandingField${q.wide ? " wide" : ""}`}
                >
                  <label htmlFor={`bv-${q.key}`}>{q.label}</label>
                  <input
                    id={`bv-${q.key}`}
                    ref={q.key === "sell" ? sellRef : undefined}
                    className="dash-input"
                    value={voice.answers[q.key] ?? ""}
                    onChange={(e) => setAnswer(q.key, e.target.value)}
                    disabled={!canManage}
                    maxLength={600}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="bvStep">
          <span className="bvStepNo" aria-hidden="true">
            2
          </span>
          <div className="bvStepBody">
            <div className="bvGuideHead">
              <div>
                <div className="flex items-center gap-1.5">
                  <h3 className="bvStepTitle">Your brand guide</h3>
                  <InfoTip label="About your brand guide">
                    Until a guide is saved, Mink AI uses a simple voice built
                    from your store name and tagline.
                  </InfoTip>
                </div>
                <p className="brandingHint">
                  Let AI draft it from your answers, or write your own.
                </p>
              </div>
              {canManage && (
                // ★ The label stays "Generate with AI": Mink AI's spotlight
                // finds this button by that text (lib/mink/guide-targets.ts,
                // generate_brand_voice) as well as by its hook.
                <button
                  type="button"
                  className="dash-btn dash-btn-ghost"
                  onClick={onGenerate}
                  disabled={generating}
                  data-mink-target="generate_brand_voice"
                >
                  {generating ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Sparkles size={15} />
                  )}
                  {generating
                    ? "Writing your brand voice…"
                    : "Generate with AI"}
                </button>
              )}
            </div>
            {note && (
              <p
                className={`brandingNote ${note.ok ? "is-ok" : "is-bad"}`}
                role={note.ok ? "status" : "alert"}
              >
                {note.msg}
              </p>
            )}
            <div className="brandingField">
              <label htmlFor="bv-content" className="sr-only">
                Your brand guide
              </label>
              <textarea
                id="bv-content"
                className="dash-input brandingGuide"
                value={voice.content}
                onChange={(e) => {
                  const content = e.target.value;
                  onChange((prev) => ({ ...prev, content }));
                }}
                disabled={!canManage}
                rows={12}
                maxLength={20000}
                aria-describedby="bv-content-hint"
              />
              <p className="brandingHint" id="bv-content-hint">
                {canManage
                  ? "Generating replaces the guide here. Nothing is saved until you press Save."
                  : "Only someone who can manage branding can change the guide."}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
