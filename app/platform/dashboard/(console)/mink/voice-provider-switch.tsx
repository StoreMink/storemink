"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setMinkVoiceProvider } from "@/app/actions/mink-operator-actions";
import type { MinkVoiceProvider } from "@/lib/mink/voice-provider";
import { SegmentedChoice } from "./segmented-choice";

export function VoiceProviderSwitch({
  initialProvider,
  canManage,
}: {
  initialProvider: MinkVoiceProvider;
  canManage: boolean;
}) {
  const [provider, setProvider] = useState(initialProvider);
  const [pending, startTransition] = useTransition();
  const sarvam = provider === "saaras_v4";

  function choose(next: MinkVoiceProvider) {
    if (!canManage || pending || next === provider) return;
    setProvider(next);
    startTransition(async () => {
      const result = await setMinkVoiceProvider(next);
      if (result.error || !result.success || !result.provider) {
        setProvider(provider);
        toast.error(result.error || "Could not change the voice model.");
        return;
      }
      setProvider(result.provider);
      toast.success("Global voice model updated.");
    });
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">
            Speech-to-text model
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {sarvam ? "Sarvam Saaras v4" : "Google Chirp 3"} is used by Mink for
            every store.
          </p>
        </div>
        <div className="ml-auto">
          <SegmentedChoice
            label="Speech-to-text model for every store"
            value={provider}
            options={[
              { value: "chirp_3", label: "Google Chirp 3" },
              { value: "saaras_v4", label: "Sarvam Saaras v4" },
            ]}
            disabled={!canManage || pending}
            onChange={choose}
          />
        </div>
      </div>
    </section>
  );
}
