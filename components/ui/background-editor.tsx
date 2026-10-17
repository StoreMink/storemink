/* eslint-disable @next/next/no-img-element */
"use client";

import { useState } from "react";
import { AlertTriangle, Check, Loader2, RotateCcw } from "lucide-react";
import { Button } from "./button";
import { IMAGE_SPECS, type ImageSpecKey } from "@/lib/media/image-specs";
import {
  CUTOUT_CHECK_MESSAGES,
  backgroundKey,
  canHaveShadow,
  isCutoutCheck,
  type BackgroundChoice,
  type CutoutCheck,
} from "@/lib/media/background-layout";
import { SCENE_PRESETS, scenePreset } from "@/lib/media/scene-presets";
import {
  PHOTO_EDIT_INSTRUCTION_MAX,
  normalizeEditInstruction,
} from "@/lib/media/photo-edit";

// The upload widget's photo tool, in two modes, the way Shopify's product
// image editor splits them:
//
// - BACKGROUND: the real product cut out and put on white, a colour or
//   transparency. Nothing is redrawn; the copy says so, because "AI
//   background" reads as "AI picture" to a merchant who has been burned by one.
// - SCENE: Mink AI re-shoots the photo in a setting the merchant picks or
//   describes. The product IS redrawn there (lib/media/photo-edit.ts says
//   why), so the copy says that too and asks them to compare before using it.
//
// ★ NO PRICES ON SCREEN (owner, 2026-10-18): the merchant dashboard never
//   says how many Mink credits something costs or used. The server decides
//   and charges (a background removal once per photo, every scene photo);
//   the balance lives under Plans & Billing.
// ★ EARLIER SCENE PHOTOS STAY ON SCREEN. Each one was paid for, so trying
//   again must never throw the last one away: the merchant can go back to any
//   of them before choosing.

const PRESET_COLOURS: readonly { hex: string; name: string }[] = [
  { hex: "#f2ede4", name: "Cream" },
  { hex: "#ececec", name: "Light grey" },
  { hex: "#e6eef4", name: "Mist" },
  { hex: "#f4e4e1", name: "Blush" },
  { hex: "#e5eee4", name: "Sage" },
];

type Mode = "background" | "scene";

type Result = {
  url: string;
  key: string;
  transparent: boolean;
  checks: CutoutCheck[];
};

type SceneShot = {
  url: string;
  /** What was asked for: a preset's label or the merchant's own words. */
  request: string;
};

/** A light chequerboard, the usual way to show that an image has no background. */
const CHECKERBOARD = {
  backgroundImage:
    "conic-gradient(#e5e7eb 25%, #ffffff 0 50%, #e5e7eb 0 75%, #ffffff 0)",
  backgroundSize: "16px 16px",
} as const;

const BACKGROUND_ENDPOINT = "/api/mink/image-background";
const SCENE_ENDPOINT = "/api/mink/image-edit";

export function BackgroundEditor({
  sourceUrl,
  spec,
  initialMode = "background",
  backgroundAvailable = true,
  scenesAvailable = false,
  onUse,
  onClose,
}: {
  sourceUrl: string;
  spec: ImageSpecKey;
  /** Which tool the merchant opened. */
  initialMode?: Mode;
  /** Whether background removal is offered here. */
  backgroundAvailable?: boolean;
  /** Whether Mink AI scenes are offered here. */
  scenesAvailable?: boolean;
  onUse: (url: string) => void;
  onClose: () => void;
}) {
  const slot = IMAGE_SPECS[spec];
  const [mode, setMode] = useState<Mode>(
    initialMode === "scene" && scenesAvailable
      ? "scene"
      : backgroundAvailable
        ? "background"
        : "scene",
  );

  // Background mode.
  const [choice, setChoice] = useState<BackgroundChoice>({ kind: "white" });
  const [colour, setColour] = useState(PRESET_COLOURS[0].hex);
  const [shadow, setShadow] = useState(true);
  const [result, setResult] = useState<Result | null>(null);
  const [cutOut, setCutOut] = useState(false);

  // Scene mode.
  const [presetId, setPresetId] = useState<string | null>(SCENE_PRESETS[0].id);
  const [described, setDescribed] = useState("");
  const [shots, setShots] = useState<SceneShot[]>([]);
  const [shownShot, setShownShot] = useState(0);

  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withShadow = shadow && canHaveShadow(choice);
  const chosenKey = `${backgroundKey(choice)}${withShadow ? "-shadow" : ""}`;
  const current = result && result.key === chosenKey ? result : null;

  const preset = presetId ? scenePreset(presetId) : null;
  const ownWords = normalizeEditInstruction(described);
  const sceneRequest = ownWords ?? preset?.label ?? null;
  const shot = shots[shownShot] ?? null;
  const shotMatchesRequest = shot !== null && shot.request === sceneRequest;

  const switchMode = (next: Mode) => {
    if (working) return;
    setError(null);
    setMode(next);
  };

  const pickColour = (hex: string) => {
    setColour(hex);
    setChoice({ kind: "colour", hex });
  };

  const applyBackground = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(BACKGROUND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: sourceUrl,
          spec,
          background: choice,
          shadow: withShadow,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        checks?: unknown;
        error?: string;
      };
      if (!res.ok || !body.url) {
        setError(
          body.error ?? "Changing the background failed. Nothing was charged.",
        );
        return;
      }
      setCutOut(true);
      setResult({
        url: body.url,
        key: chosenKey,
        transparent: choice.kind === "transparent",
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

  const createScene = async () => {
    if (working || !sceneRequest) return;
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(SCENE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          ownWords
            ? { url: sourceUrl, spec, instruction: ownWords }
            : { url: sourceUrl, spec, preset: presetId },
        ),
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !body.url) {
        setError(
          body.error ?? "Creating the photo failed. Nothing was charged.",
        );
        return;
      }
      // Only one request runs at a time (`working`), so `shots` is current.
      setShots([...shots, { url: body.url, request: sceneRequest }]);
      setShownShot(shots.length);
    } catch {
      setError(
        "Creating the photo failed. Check your connection and try again.",
      );
    } finally {
      setWorking(false);
    }
  };

  const choiceButton = (active: boolean) =>
    `rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
      active
        ? "border-primary bg-primary/10 text-foreground"
        : "border-border text-muted-foreground hover:bg-muted/50"
    }`;

  const shownBackground = current ?? result;
  const shownUrl = mode === "scene" ? shot?.url : shownBackground?.url;
  const transparent = mode === "background" && shownBackground?.transparent;
  const workingLabel =
    mode === "scene"
      ? "Mink AI is creating your photo… this takes about 20 seconds"
      : !cutOut
        ? "Removing the background… this takes about 20 seconds"
        : "Applying…";

  return (
    <div className="w-full">
      {backgroundAvailable && scenesAvailable && (
        <div
          role="tablist"
          aria-label="Photo tool"
          className="mb-3 inline-flex rounded-lg border border-border p-0.5"
        >
          {(
            [
              ["background", "Background"],
              ["scene", "Scene"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => switchMode(value)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                mode === value
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

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
            style={transparent ? CHECKERBOARD : undefined}
            data-checkerboard={transparent ? "" : undefined}
          >
            {shownUrl ? (
              <img
                src={shownUrl}
                alt={
                  mode === "scene"
                    ? "In the new scene"
                    : "With the new background"
                }
                className="absolute inset-0 h-full w-full object-contain"
              />
            ) : (
              <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
                {mode === "scene"
                  ? "Choose a scene or describe one below."
                  : "Choose a background below."}
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

      {mode === "background" ? (
        <>
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
          </div>

          {choice.kind === "colour" && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {PRESET_COLOURS.map((option) => (
                <button
                  key={option.hex}
                  type="button"
                  aria-label={option.name}
                  aria-pressed={colour === option.hex}
                  title={option.name}
                  onClick={() => pickColour(option.hex)}
                  className={`h-7 w-7 rounded-full border ${
                    colour === option.hex
                      ? "ring-2 ring-primary ring-offset-1"
                      : "border-border"
                  }`}
                  style={{ backgroundColor: option.hex }}
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

          {choice.kind !== "transparent" && (
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
            Your product stays exactly as photographed: only the background
            changes, and the product is centred at {slot.width} × {slot.height}{" "}
            px.
          </p>
        </>
      ) : (
        <>
          <div
            role="group"
            aria-label="Scene"
            className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {SCENE_PRESETS.map((option) => {
              const active = !ownWords && presetId === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setPresetId(option.id);
                    setDescribed("");
                  }}
                  className={`rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                    active
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <span className="block font-medium text-foreground">
                    {option.label}
                  </span>
                  <span className="block text-muted-foreground">
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>

          <label className="mt-3 block text-xs font-medium text-foreground">
            Or describe your own scene
            <textarea
              value={described}
              onChange={(e) => setDescribed(e.target.value)}
              maxLength={PHOTO_EDIT_INSTRUCTION_MAX}
              rows={2}
              placeholder="For example: hanging from a tree branch in a garden, or worn by a model on a city street"
              className="mt-1 block w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-sm font-normal text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>

          {shots.length > 1 && (
            <div
              role="group"
              aria-label="Your scene photos"
              className="mt-2 flex flex-wrap gap-1.5"
            >
              {shots.map((item, index) => (
                <button
                  key={item.url}
                  type="button"
                  aria-pressed={index === shownShot}
                  aria-label={`Photo ${index + 1}: ${item.request}`}
                  title={item.request}
                  onClick={() => setShownShot(index)}
                  className={`h-12 w-12 overflow-hidden rounded border ${
                    index === shownShot
                      ? "ring-2 ring-primary ring-offset-1"
                      : "border-border"
                  }`}
                >
                  <img
                    src={item.url}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}

          <p className="mt-2 text-xs text-muted-foreground">
            Mink AI photographs your product in the scene, so it redraws the
            product too. Compare it with your real product before you use it:
            small details such as a print or a label can change.
          </p>
        </>
      )}

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      <div className="mt-2 flex flex-wrap gap-2">
        {mode === "background" ? (
          current ? (
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
              onClick={applyBackground}
              disabled={working}
              className="gap-1.5"
            >
              {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {cutOut ? "Apply background" : "Remove background"}
            </Button>
          )
        ) : (
          <>
            {shot && (
              <Button
                type="button"
                size="sm"
                onClick={() => onUse(shot.url)}
                disabled={working}
                className="gap-1.5"
              >
                <Check className="h-3.5 w-3.5" />
                Use this photo
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant={shot ? "outline" : "default"}
              onClick={createScene}
              disabled={working || !sceneRequest}
              className="gap-1.5"
            >
              {working ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                shotMatchesRequest && <RotateCcw className="h-3.5 w-3.5" />
              )}
              {shotMatchesRequest ? "Try again" : "Create photo"}
            </Button>
          </>
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
