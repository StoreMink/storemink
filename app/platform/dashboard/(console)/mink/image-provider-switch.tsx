"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setImageGenerationSettings } from "@/app/actions/mink-operator-actions";
import {
  ELEVENLABS_IMAGE_QUALITY_LABELS,
  ELEVENLABS_IMAGE_RESOLUTION_LABELS,
  IMAGE_PROVIDER_LABELS,
  type ElevenLabsImageQuality,
  type ElevenLabsImageResolution,
  type ImageGenerationSettings,
  type ImageProvider,
} from "@/lib/images/provider-settings";
import { SegmentedChoice } from "./segmented-choice";

/**
 * Which provider draws Theme Studio's and the storefront redesign's photos,
 * for every store. The first choice picks the provider; the two below it,
 * live only while ElevenLabs is chosen, set that provider's quality and
 * resolution.
 */
export function ImageProviderSwitch({
  initial,
  keyConfigured,
  canManage,
}: {
  initial: ImageGenerationSettings;
  /** Whether this environment holds ElevenLabs' API key. */
  keyConfigured: boolean;
  canManage: boolean;
}) {
  const [settings, setSettings] = useState(initial);
  const [pending, startTransition] = useTransition();
  const elevenlabs = settings.provider === "elevenlabs";

  function save(next: ImageGenerationSettings) {
    if (
      !canManage ||
      pending ||
      (next.provider === settings.provider &&
        next.elevenlabsQuality === settings.elevenlabsQuality &&
        next.elevenlabsResolution === settings.elevenlabsResolution)
    )
      return;
    const previous = settings;
    setSettings(next);
    startTransition(async () => {
      const result = await setImageGenerationSettings(next);
      if (result.error || !result.success || !result.settings) {
        setSettings(previous);
        toast.error(result.error || "Could not change the image provider.");
        return;
      }
      setSettings(result.settings);
      toast.success("Image provider updated.");
    });
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">
            Image provider
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            {elevenlabs
              ? `${IMAGE_PROVIDER_LABELS.elevenlabs} draws Theme Studio and storefront redesign photos.`
              : `${IMAGE_PROVIDER_LABELS.google} draws Theme Studio and storefront redesign photos.`}{" "}
            Applies to the next job that starts. Every other picture stays on
            Google.
          </p>
          {elevenlabs && !keyConfigured && (
            <p className="mt-1 max-w-3xl text-sm font-medium text-amber-700">
              This environment has no ElevenLabs API key, so photos are still
              drawn by Google.
            </p>
          )}
        </div>
        <div className="ml-auto">
          <SegmentedChoice<ImageProvider>
            label="Who draws Theme Studio and storefront redesign photos"
            value={settings.provider}
            options={[
              { value: "google", label: IMAGE_PROVIDER_LABELS.google },
              { value: "elevenlabs", label: IMAGE_PROVIDER_LABELS.elevenlabs },
            ]}
            disabled={!canManage || pending}
            onChange={(provider) => save({ ...settings, provider })}
          />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-4">
        <p
          className={`text-sm ${elevenlabs ? "text-slate-500" : "text-slate-400"}`}
        >
          {elevenlabs
            ? "Quality of each photo. Low costs less."
            : "Used only when ElevenLabs is chosen above."}
        </p>
        <div className="ml-auto">
          <SegmentedChoice<ElevenLabsImageQuality>
            label="ElevenLabs photo quality"
            value={settings.elevenlabsQuality}
            options={[
              { value: "low", label: ELEVENLABS_IMAGE_QUALITY_LABELS.low },
              {
                value: "medium",
                label: ELEVENLABS_IMAGE_QUALITY_LABELS.medium,
              },
            ]}
            disabled={!canManage || pending || !elevenlabs}
            dormant={!elevenlabs}
            onChange={(elevenlabsQuality) =>
              save({ ...settings, elevenlabsQuality })
            }
          />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-4">
        <p
          className={`text-sm ${elevenlabs ? "text-slate-500" : "text-slate-400"}`}
        >
          {!elevenlabs
            ? "Used only when ElevenLabs is chosen above."
            : settings.elevenlabsResolution === "1K"
              ? "1K photos are enlarged to fit the page, so they look softer than 2K."
              : "2K photos are sharper and cost a little more."}
        </p>
        <div className="ml-auto">
          <SegmentedChoice<ElevenLabsImageResolution>
            label="ElevenLabs photo resolution"
            value={settings.elevenlabsResolution}
            options={[
              { value: "1K", label: ELEVENLABS_IMAGE_RESOLUTION_LABELS["1K"] },
              { value: "2K", label: ELEVENLABS_IMAGE_RESOLUTION_LABELS["2K"] },
            ]}
            disabled={!canManage || pending || !elevenlabs}
            dormant={!elevenlabs}
            onChange={(elevenlabsResolution) =>
              save({ ...settings, elevenlabsResolution })
            }
          />
        </div>
      </div>
    </section>
  );
}
