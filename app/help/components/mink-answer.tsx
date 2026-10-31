"use client";

import Link from "next/link";
import {
  Check,
  Copy,
  FileText,
  Mail,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
} from "lucide-react";
import type { HelpAssistantAnswer } from "@/app/actions/help-assistant-actions";
import type { HelpLanguageCode } from "@/lib/help/languages";
import type { MinkStrings } from "./mink-strings";
import type { HelpRating } from "./recent-chats";

export const SUPPORT_EMAIL = "support@storemink.com";

/** One Mink AI answer: steps, notes, source guides, follow-ups and actions. */
export function MinkAnswer({
  answer,
  strings: t,
  language,
  rating,
  thanked,
  copied,
  speaking,
  canListen,
  followUpsDisabled,
  onOpenGuide,
  onFollowUp,
  onCopy,
  onListen,
  onRate,
}: {
  answer: HelpAssistantAnswer;
  strings: MinkStrings;
  language: HelpLanguageCode | null;
  rating?: HelpRating;
  thanked: boolean;
  copied: boolean;
  speaking: boolean;
  canListen: boolean;
  followUpsDisabled: boolean;
  onOpenGuide: () => void;
  onFollowUp: (question: string) => void;
  onCopy: () => void;
  onListen: () => void;
  onRate: (rating: HelpRating) => void;
}) {
  // A guide is written in English, so in another language the card says
  // what opening it does rather than an English category name.
  const translated = Boolean(language && language !== "en");
  const clarifications = answer.clarificationPrompts ?? [];
  const showFollowUps = answer.followUps.length > 0 || answer.needsHuman;

  return (
    <>
      {answer.steps.length > 0 && (
        <ol className="hc-assistant-steps">
          {answer.steps.map((step, index) => (
            <li key={`${index}-${step}`}>
              <span className="hc-assistant-step-number" aria-hidden>
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}
      {answer.notes.length > 0 && (
        <div className="hc-assistant-notes">
          <strong>{t.important}</strong>
          <ul>
            {answer.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
      {answer.sources.length > 0 && (
        <div className="hc-assistant-sources">
          <strong>{t.sourceGuides}</strong>
          <div className="hc-assistant-source-grid">
            {answer.sources.map((source) => (
              <Link href={source.url} key={source.url} onClick={onOpenGuide}>
                <FileText size={18} aria-hidden />
                <span>
                  <span className="hc-assistant-source-title">
                    {source.title}
                  </span>
                  <small>
                    {translated
                      ? t.readFullGuide
                      : (source.category ?? t.readFullGuide)}
                  </small>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
      {clarifications.length > 0 && (
        <div className="hc-assistant-clarifications">
          <strong>{t.includeDetails}</strong>
          <ul>
            {clarifications.map((prompt) => (
              <li key={prompt}>{prompt}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="hc-assistant-message-actions">
        <button
          type="button"
          onClick={onCopy}
          aria-label={t.copy}
          title={copied ? t.copied : t.copy}
        >
          {copied ? (
            <Check size={16} aria-hidden />
          ) : (
            <Copy size={16} aria-hidden />
          )}
        </button>
        {canListen && (
          <button
            type="button"
            onClick={onListen}
            aria-label={speaking ? t.stopListening : t.listen}
            aria-pressed={speaking}
            title={speaking ? t.stopListening : t.listen}
          >
            {speaking ? (
              <Square size={15} aria-hidden />
            ) : (
              <Volume2 size={16} aria-hidden />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => onRate("up")}
          aria-label={t.helpful}
          aria-pressed={rating === "up"}
          title={t.helpful}
          className={rating === "up" ? "is-active" : undefined}
        >
          <ThumbsUp size={16} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => onRate("down")}
          aria-label={t.notHelpful}
          aria-pressed={rating === "down"}
          title={t.notHelpful}
          className={rating === "down" ? "is-active" : undefined}
        >
          <ThumbsDown size={16} aria-hidden />
        </button>
        {copied && (
          <span className="hc-assistant-action-note" role="status">
            {t.copied}
          </span>
        )}
      </div>
      {thanked && (
        <p className="hc-assistant-thanks" role="status">
          {t.thanks}
        </p>
      )}
      {showFollowUps && (
        <div className="hc-assistant-followups">
          {answer.followUps.map((question) => (
            <button
              type="button"
              key={question}
              onClick={() => onFollowUp(question)}
              disabled={followUpsDisabled}
            >
              {question}
            </button>
          ))}
          {answer.needsHuman && (
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="hc-assistant-followup-link"
            >
              <Mail size={14} aria-hidden />
              <span>{t.emailSupport}</span>
            </a>
          )}
        </div>
      )}
    </>
  );
}
