/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { Button } from "./button";
import {
  IMAGE_CUTOUT_CREDITS,
  IMAGE_SCENE_CREDITS,
  IMAGE_SPECS,
  type ImageSpecKey,
} from "@/lib/media/image-specs";
import {
  CUTOUT_CHECK_MESSAGES,
  backgroundKey,
  canHaveShadow,
  isCutoutCheck,
  type BackgroundChoice,
  type CutoutCheck,
} from "@/lib/media/background-layout";
import { SCENE_PRESETS, scenePreset } from "@/lib/media/scene-presets";

// The upload widget's background tool: pick white, a colour, transparency or
// a scene, see the result beside the original, then use it or keep the
// original.
//
// ★ THE PRODUCT IS THE MERCHANT'S OWN PHOTO. The server cuts it out and places
//   it; nothing is redrawn, even in a scene (only the empty set is drawn). The
//   copy here says so, because "AI background" reads as "AI picture" to a
//   merchant who has been burned by one.
// ★ WHAT IT COSTS IS ON THE BUTTON. The first background for a photo costs
//   IMAGE_CUTOUT_CREDITS; a scene the store has not drawn yet costs
//   IMAGE_SCENE_CREDITS; everything else (another colour, the shadow on or
//   off, a saved scene) is free. The server decides and charges; this only
//   words the button, so a miscount here can only ever overstate the price.

const PRESET_COLOURS: readonly { hex: string; name: string }[] = [
  { hex: "#f2ede4", name: "Cream" },
  { hex: "#ececec", name: "Light grey" },
  { hex: "#e6eef4", name: "Mist" },
  { hex: "#f4e4e1", name: "Blush" },
  { hex: "#e5eee4", name: "Sage" },
];

type Result = {
  url: string;
  key: string;
  transparent: boolean;
  reused: boolean;
  checks: CutoutCheck[];
};

/** A light chequerboard, the usual way to show that an image has no background. */
const CHECKERBOARD = {
  backgroundImage:
    "conic-gradient(#e5e7eb 25%, #ffffff 0 50%, #e5e7eb 0 75%, #ffffff 0)",
  backgroundSize: "16px 16px",
} as const;

const ENDPOINT = "/api/mink/image-background";

function credits(n: number): string {
  return `${n} credit${n === 1 ? "" : "s"}`;
}

export function BackgroundEditor({
  sourceUrl,
  spec,
  scenesAvailable = false,
  onUse,
  onClose,
}: {
  sourceUrl: string;
  spec: ImageSpecKey;
  /** Whether scenes are offered here (Mink image generation is on). */
  scenesAvailable?: boolean;
  onUse: (url: string) => void;
  onClose: () => void;
}) {
  const slot = IMAGE_SPECS[spec];
  const [choice, setChoice] = useState<BackgroundChoice>({ kind: "white" });
  const [colour, setColour] = useState(PRESET_COLOURS[0].hex);
  const [shadow, setShadow] = useState(true);
  const [freshScene, setFreshScene] = useState(false);
  const [savedScenes, setSavedScenes] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [cutOut, setCutOut] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creditsUsed, setCreditsUsed] = useState(0);

  // Which scenes this store already has for this slot: those are free.
  useEffect(() => {
    if (!scenesAvailable) return;
    const controller = new AbortController();
    fetch(`${ENDPOINT}?spec=${encodeURIComponent(spec)}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (body: { scenes?: { preset?: unknown; url?: unknown }[] } | null) => {
          const saved: Record<string, string> = {};
          for (const scene of body?.scenes ?? []) {
            if (
              typeof scene.preset === "string" &&
              typeof scene.url === "string"
            )
              saved[scene.preset] = scene.url;
          }
          setSavedScenes(saved);
        },
      )
      .catch(() => {
        // Unknown means "not saved": the button then shows the full price,
        // and the server charges nothing for a scene that turns out saved.
      });
    return () => controller.abort();
  }, [scenesAvailable, spec]);

  const sceneChoice =
    choice.kind === "scene" ? scenePreset(choice.preset) : null;
  const sceneSaved = sceneChoice ? Boolean(savedScenes[sceneChoice.id]) : false;
  const drawsScene = Boolean(sceneChoice && (freshScene || !sceneSaved));
  const withShadow = shadow && canHaveShadow(choice) && choice.kind !== "scene";
  const chosenKey = `${backgroundKey(choice)}${withShadow ? "-shadow" : ""}${
    drawsScene && sceneSaved ? "-new" : ""
  }`;
  const current = result && result.key === chosenKey ? result : null;
  const cost =
    (cutOut ? 0 : IMAGE_CUTOUT_CREDITS) +
    (drawsScene ? IMAGE_SCENE_CREDITS : 0);

  const pickColour = (hex: string) => {
    setColour(hex);
    setChoice({ kind: "colour", hex });
  };

  const pickScene = (id: string) => {
    setFreshScene(false);
    setChoice({ kind: "scene", preset: id });
  };

  const apply = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: sourceUrl,
          spec,
          background: choice,
          shadow: withShadow,
          newScene: drawsScene,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        chargedCredits?: number;
        reused?: boolean;
        checks?: unknown;
        scene?: { url?: unknown };
        error?: string;
      };
      if (!res.ok || !body.url) {
        setError(
          body.error ?? "Changing the background failed. Nothing was charged.",
        );
        return;
      }
      setCreditsUsed((n) => n + (body.chargedCredits ?? 0));
      setCutOut(true);
      let key = chosenKey;
      if (sceneChoice) {
        // The scene used is now the store's saved one for this preset.
        const sceneUrl =
          typeof body.scene?.url === "string" ? body.scene.url : body.url;
        setSavedScenes((saved) => ({ ...saved, [sceneChoice.id]: sceneUrl }));
        setFreshScene(false);
        key = backgroundKey(choice);
      }
      setResult({
        url: body.url,
        key,
        transparent: choice.kind === "transparent",
        reused: body.reused === true,
        checks: Array.isArray(body.checks)
          ? body.checks.filter(isCutoutCheck)
          : [],
      });
    } catch {
      setError(
        "Changing the background failed. Check your connection and try again.",
      );
    } finally {
      setWorking(false);
    }
  };

  const shown = current ?? result;
  const choiceButton = (active: boolean) =>
    `rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
      active
        ? "border-primary bg-primary/10 text-foreground"
        : "border-border text-muted-foreground hover:bg-muted/50"
    }`;

  const workingLabel = !cutOut
    ? "Removing the background… this takes about 20 seconds"
    : drawsScene
      ? "Drawing the scene… this takes about 20 seconds"
      : "Applying…";

  return (
    <div className="w-full">
      <div className="grid grid-cols-2 gap-2">
        <figure className="min-w-0">
          <div className="relative h-48 overflow-hidden rounded-lg border border-border/50 bg-muted/30">
            <img
              src={sourceUrl}
              alt="Original"
              className="absolute inset-0 h-full w-full object-contain"
            />
          </div>
          <figcaption className="mt-1 text-xs text-muted-foreground">
            Original
          </figcaption>
        </figure>
        <figure className="min-w-0">
          <div
            className="relative h-48 overflow-hidden rounded-lg border-2 border-primary/60 bg-muted/30"
            style={shown?.transparent ? CHECKERBOARD : undefined}
            data-checkerboard={shown?.transparent ? "" : undefined}
          >
            {shown ? (
              <img
                src={shown.url}
                alt="With the new background"
                className="absolute inset-0 h-full w-full object-contain"
              />
            ) : (
              <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
                Choose a background below.
              </p>
            )}
            {working && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/75 p-3 text-center text-sm text-foreground backdrop-blur-sm">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                <span role="status">{workingLabel}</span>
              </div>
            )}
          </div>
          <figcaption className="mt-1 text-xs text-muted-foreground">
            New · {slot.width} × {slot.height} px
          </figcaption>
        </figure>
      </div>

      <div
        role="group"
        aria-label="Background"
        className="mt-3 flex flex-wrap items-center gap-2"
      >
        <button
          type="button"
          aria-pressed={choice.kind === "white"}
          onClick={() => setChoice({ kind: "white" })}
          className={choiceButton(choice.kind === "white")}
        >
          White
        </button>
        <button
          type="button"
          aria-pressed={choice.kind === "colour"}
          onClick={() => pickColour(colour)}
          className={choiceButton(choice.kind === "colour")}
        >
          Colour
        </button>
        <button
          type="button"
          aria-pressed={choice.kind === "transparent"}
          onClick={() => setChoice({ kind: "transparent" })}
          className={choiceButton(choice.kind === "transparent")}
        >
          Transparent
        </button>
        {scenesAvailable && (
          <button
            type="button"
            aria-pressed={choice.kind === "scene"}
            onClick={() => pickScene(sceneChoice?.id ?? SCENE_PRESETS[0].id)}
            className={choiceButton(choice.kind === "scene")}
          >
            Scene
          </button>
        )}
      </div>

      {choice.kind === "colour" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {PRESET_COLOURS.map((preset) => (
            <button
              key={preset.hex}
              type="button"
              aria-label={preset.name}
              aria-pressed={colour === preset.hex}
              title={preset.name}
              onClick={() => pickColour(preset.hex)}
              className={`h-7 w-7 rounded-full border ${
                colour === preset.hex
                  ? "ring-2 ring-primary ring-offset-1"
                  : "border-border"
              }`}
              style={{ backgroundColor: preset.hex }}
            />
          ))}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="color"
              aria-label="Choose any colour"
              value={colour}
              onChange={(e) => pickColour(e.target.value.toLowerCase())}
              className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
            Any colour
          </label>
        </div>
      )}

      {(choice.kind === "white" || choice.kind === "colour") && (
        <label className="mt-2 flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={shadow}
            onChange={(e) => setShadow(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          Soft shadow under the product
        </label>
      )}

      {sceneChoice && (
        <div className="mt-2">
          <div
            role="group"
            aria-label="Scene"
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {SCENE_PRESETS.map((preset) => {
              const active = sceneChoice.id === preset.id;
              const saved = savedScenes[preset.id];
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => pickScene(preset.id)}
                  className={`overflow-hidden rounded-md border text-left text-xs transition-colors ${
                    active
                      ? "border-primary ring-1 ring-primary"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  {saved && (
                    <img
                      src={saved}
                      alt=""
                      className="h-14 w-full object-cover"
                    />
                  )}
                  <span className="block px-2 py-1.5">
                    <span className="block font-medium text-foreground">
                      {preset.label}
                    </span>
                    <span className="block text-muted-foreground">
                      {saved ? "Saved · free" : preset.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {sceneSaved && !freshScene
              ? `Uses your saved ${sceneChoice.label.toLowerCase()} scene, free, so your products match. `
              : `A new ${sceneChoice.label.toLowerCase()} scene uses ${IMAGE_SCENE_CREDITS} Mink credits. It is saved and used free for every product you place in it. `}
            {sceneSaved && (
              <button
                type="button"
                aria-pressed={freshScene}
                onClick={() => setFreshScene((fresh) => !fresh)}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {freshScene
                  ? "Use the saved scene instead"
                  : `Draw a new one · ${credits(IMAGE_SCENE_CREDITS)}`}
              </button>
            )}
          </p>
        </div>
      )}

      {current && current.checks.length > 0 && (
        <ul className="mt-2 space-y-1">
          {current.checks.map((check) => (
            <li
              key={check}
              className="flex items-start gap-1.5 text-xs text-amber-700"
            >
              <AlertTriangle
                className="mt-px h-3.5 w-3.5 shrink-0"
                aria-hidden
              />
              <span>{CUTOUT_CHECK_MESSAGES[check]}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        {sceneChoice
          ? "Mink AI draws only the empty scene; your product is placed in it exactly as photographed."
          : `Your product stays exactly as photographed: only the background changes, and the product is centred at ${slot.width} × ${slot.height} px.`}
        {cutOut
          ? " Trying other backgrounds is free."
          : ` The first background uses ${IMAGE_CUTOUT_CREDITS} Mink credit; trying others after that is free.`}
        {creditsUsed > 0 &&
          ` ${creditsUsed} Mink credit${creditsUsed === 1 ? " was" : "s were"} used.`}
        {result?.reused &&
          creditsUsed === 0 &&
          " No credits used: this photo's background was removed before."}
      </p>

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      <div className="mt-2 flex flex-wrap gap-2">
        {current ? (
          <Button
            type="button"
            size="sm"
            onClick={() => onUse(current.url)}
            disabled={working}
            className="gap-1.5"
          >
            <Check className="h-3.5 w-3.5" />
            Use this photo
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={apply}
            disabled={working}
            className="gap-1.5"
          >
            {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {drawsScene
              ? "Create scene"
              : cutOut
                ? "Apply background"
                : "Remove background"}
            {cost > 0 && (
              <span className="opacity-80">
                {/* A real space, so the name reads "Create scene · 6 credits". */}{" "}
                · {credits(cost)}
              </span>
            )}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onClose}
          disabled={working}
        >
          Keep original
        </Button>
      </div>
    </div>
  );
}
