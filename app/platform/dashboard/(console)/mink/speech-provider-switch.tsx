"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setMinkSpeechSettings } from "@/app/actions/mink-operator-actions";
import {
  MINK_SPEECH_PROVIDER_LABELS,
  type MinkSpeechProvider,
  type MinkSpeechSettings,
} from "@/lib/mink/voice-provider";
import { SegmentedChoice } from "./segmented-choice";

/**
 * Text-to-speech for Mink voice chat, for every store. The first choice
 * decides whether a model reads answers at all (the browser voice is each
 * merchant's own); the second, only live while a model is chosen, picks it.
 */
export function SpeechProviderSwitch({
  initial,
  canManage,
}: {
  initial: MinkSpeechSettings;
  canManage: boolean;
}) {
  const [settings, setSettings] = useState(initial);
  const [pending, startTransition] = useTransition();
  const sarvam = settings.provider === "bulbul_v4_flash";

  function save(next: MinkSpeechSettings) {
    if (
      !canManage ||
      pending ||
      (next.enabled === settings.enabled && next.provider === settings.provider)
    )
      return;
    const previous = settings;
    setSettings(next);
    startTransition(async () => {
      const result = await setMinkSpeechSettings(next);
      if (result.error || !result.success || !result.settings) {
        setSettings(previous);
        toast.error(result.error || "Could not change the read-aloud voice.");
        return;
      }
      setSettings(result.settings);
      toast.success("Read-aloud voice updated.");
    });
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">
            Text-to-speech model
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {settings.enabled
              ? `${MINK_SPEECH_PROVIDER_LABELS[settings.provider]} reads voice chat answers aloud for every store.`
              : "Voice chat answers are read aloud by each merchant's own browser voice."}
          </p>
        </div>
        <div className="ml-auto">
          <SegmentedChoice
            label="Who reads voice chat answers aloud"
            value={settings.enabled ? "model" : "browser"}
            options={[
              { value: "browser", label: "Browser voice" },
              { value: "model", label: "Text-to-speech model" },
            ]}
            disabled={!canManage || pending}
            onChange={(next) =>
              save({ ...settings, enabled: next === "model" })
            }
          />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-4">
        <p
          className={`text-sm ${settings.enabled ? "text-slate-500" : "text-slate-400"}`}
        >
          {!settings.enabled
            ? "Used only when Text-to-speech model is chosen above."
            : sarvam
              ? "Indian-language voices; Malayalam uses the browser voice."
              : "One voice for every language Mink answers in."}
        </p>
        <div className="ml-auto">
          <SegmentedChoice<MinkSpeechProvider>
            label="Text-to-speech model for every store"
            value={settings.provider}
            options={[
              {
                value: "gemini_3_8_flash_lite_tts",
                label: MINK_SPEECH_PROVIDER_LABELS.gemini_3_8_flash_lite_tts,
              },
              {
                value: "bulbul_v4_flash",
                label: MINK_SPEECH_PROVIDER_LABELS.bulbul_v4_flash,
              },
            ]}
            disabled={!canManage || pending || !settings.enabled}
            dormant={!settings.enabled}
            onChange={(provider) => save({ ...settings, provider })}
          />
        </div>
      </div>
    </section>
  );
}
