"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setRevampImageSettings } from "@/app/actions/mink-operator-actions";
import {
  ELEVENLABS_IMAGE_MODELS,
  elevenLabsModelDef,
  isElevenLabsImageModel,
  REVAMP_IMAGE_PROVIDER_LABELS,
  type RevampImageProvider,
  type RevampImageSettings,
} from "@/lib/mink/image-provider-settings";
import { SegmentedChoice } from "./segmented-choice";

/**
 * Who draws a storefront redesign's photographs, for every store: Google
 * Vertex AI (2 pictures a minute, paced) or ElevenLabs, and which ElevenLabs
 * model. Photo checks stay on Vertex either way.
 */
export function ImageProviderSwitch({
  initial,
  canManage,
  keyConfigured,
}: {
  initial: RevampImageSettings;
  canManage: boolean;
  keyConfigured: boolean;
}) {
  const [settings, setSettings] = useState(initial);
  const [pending, startTransition] = useTransition();
  const eleven = settings.provider === "elevenlabs";
  const model = elevenLabsModelDef(settings.elevenLabsModel);

  function save(next: RevampImageSettings) {
    if (
      !canManage ||
      pending ||
      (next.provider === settings.provider &&
        next.elevenLabsModel === settings.elevenLabsModel)
    )
      return;
    const previous = settings;
    setSettings(next);
    startTransition(async () => {
      const result = await setRevampImageSettings({
        provider: next.provider,
        model: next.elevenLabsModel,
      });
      if (result.error || !result.success || !result.settings) {
        setSettings(previous);
        toast.error(
          result.error || "Could not change who draws redesign photos.",
        );
        return;
      }
      setSettings(result.settings);
      toast.success("Redesign photos updated.");
    });
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">
            Storefront redesign photos
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {eleven
              ? `ElevenLabs draws them with ${model.label}, with no 2-a-minute limit.`
              : "Google Vertex AI draws them, at most 2 a minute."}
          </p>
        </div>
        <div className="ml-auto">
          <SegmentedChoice<RevampImageProvider>
            label="Who draws storefront redesign photos"
            value={settings.provider}
            options={[
              { value: "vertex", label: REVAMP_IMAGE_PROVIDER_LABELS.vertex },
              {
                value: "elevenlabs",
                label: REVAMP_IMAGE_PROVIDER_LABELS.elevenlabs,
              },
            ]}
            disabled={!canManage || pending}
            onChange={(provider) => save({ ...settings, provider })}
          />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-4">
        <p
          className={`text-sm ${eleven ? "text-slate-500" : "text-slate-400"}`}
        >
          {!keyConfigured
            ? "ElevenLabs needs ELEVENLABS_API_KEY on this server."
            : !eleven
              ? "Used only when ElevenLabs is chosen above."
              : (model.note ?? "Photo checks still run on Google Vertex AI.")}
        </p>
        <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
          <span>ElevenLabs model</span>
          <select
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 disabled:text-slate-400"
            value={settings.elevenLabsModel}
            disabled={!canManage || pending || !eleven}
            onChange={(event) => {
              const value = event.target.value;
              if (isElevenLabsImageModel(value))
                save({ ...settings, elevenLabsModel: value });
            }}
          >
            {ELEVENLABS_IMAGE_MODELS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} ({option.resolution})
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
