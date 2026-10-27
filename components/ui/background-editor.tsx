/* eslint-disable @next/next/no-img-element */
"use client";

import { useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
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

// The upload widget's background tool: the real product cut out and put on
// white, a colour or transparency, compared with the original, then used or
// discarded.
//
// ★ THE PRODUCT IS THE MERCHANT'S OWN PHOTO. Nothing is redrawn; the copy says
//   so, because "AI background" reads as "AI picture" to a merchant who has
//   been burned by one.
// ★ NO SCENES HERE (owner, 2026-10-18). A product in a setting ("hanging from
//   a tree in a garden", "worn by a model") is asked for in Mink AI chat, the
//   way Shopify Sidekick works, never from a form in the product editor.
// ★ NO PRICES ON SCREEN (owner, 2026-10-18): the merchant dashboard never
//   says how many Mink credits something costs or used. The server decides
//   and charges (a background removal once per photo); the balance lives
//   under Plans & Billing.

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
  checks: CutoutCheck[];
};

/** A light chequerboard, the usual way to show that an image has no background. */
const CHECKERBOARD = {
  backgroundImage:
    "conic-gradient(#e5e7eb 25%, #ffffff 0 50%, #e5e7eb 0 75%, #ffffff 0)",
  backgroundSize: "16px 16px",
} as const;

const ENDPOINT = "/api/mink/image-background";

export function BackgroundEditor({
  sourceUrl,
  spec,
  onUse,
  onClose,
}: {
  sourceUrl: string;
  spec: ImageSpecKey;
  onUse: (url: string) => void;
  onClose: () => void;
}) {
  const slot = IMAGE_SPECS[spec];
  const [choice, setChoice] = useState<BackgroundChoice>({ kind: "white" });
  const [colour, setColour] = useState(PRESET_COLOURS[0].hex);
  const [shadow, setShadow] = useState(true);
  const [result, setResult] = useState<Result | null>(null);
  const [cutOut, setCutOut] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withShadow = shadow && canHaveShadow(choice);
  const chosenKey = `${backgroundKey(choice)}${withShadow ? "-shadow" : ""}`;
  const current = result && result.key === chosenKey ? result : null;
  const shown = current ?? result;

  const pickColour = (hex: string) => {
    setColour(hex);
    setChoice({ kind: "colour", hex });
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

  const choiceButton = (active: boolean) =>
    `rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
      active
        ? "border-primary bg-primary/10 text-foreground"
        : "border-border text-muted-foreground hover:bg-muted/50"
    }`;

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
                <span role="status">
                  {cutOut
                    ? "Applying…"
                    : "Removing the background… this takes about 20 seconds"}
                </span>
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
        Your product stays exactly as photographed: only the background changes,
        and the product is centred at {slot.width} × {slot.height} px.
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
            {cutOut ? "Apply background" : "Remove background"}
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
