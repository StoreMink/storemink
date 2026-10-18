"use client";

import { splitSpeechChunks } from "@/lib/mink/speech-text";

/**
 * Plays a Mink answer through the platform's read-aloud model
 * (`/api/mink/speech`), a few sentences at a time: the first short piece is
 * fetched and played while the next is already being made, so the merchant
 * hears the first words a couple of seconds after the answer lands instead
 * of waiting for the whole answer to be synthesised.
 *
 * Outcomes:
 * - `done`: everything was played.
 * - `off`: no model is switched on; the browser voice reads the answer and
 *   the rest of the voice chat.
 * - `browser`: this answer could not be played by the model (a language it has
 *   no voice for, a provider failure, a blocked playback); `remaining` is what
 *   still needs reading, which the browser voice takes over.
 * - `cancelled`: speech was stopped by the voice chat.
 */
export type MinkServerSpeechResult =
  | { outcome: "done" }
  | { outcome: "cancelled" }
  | { outcome: "off" | "browser"; remaining: string };

type Fetched =
  | { kind: "audio"; url: string }
  | { kind: "off" }
  | { kind: "browser" };

async function fetchSpeech(
  text: string,
  lang: string,
  signal: AbortSignal,
): Promise<Fetched> {
  try {
    const response = await fetch("/api/mink/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang }),
      cache: "no-store",
      signal,
    });
    if (response.status === 204)
      return response.headers?.get("X-Mink-Speech") === "off"
        ? { kind: "off" }
        : { kind: "browser" };
    const type = response.headers?.get("Content-Type") ?? "";
    if (!response.ok || !type.startsWith("audio/")) return { kind: "browser" };
    const blob = await response.blob();
    return { kind: "audio", url: URL.createObjectURL(blob) };
  } catch {
    return { kind: "browser" };
  }
}

/** Generous: a piece that never reports its end must not hold the loop. */
function pieceWatchdogMs(text: string) {
  return Math.min(120_000, 15_000 + text.length * 120);
}

function playPiece(
  player: HTMLAudioElement,
  url: string,
  text: string,
  signal: AbortSignal,
): Promise<"ended" | "error" | "cancelled"> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: "ended" | "error" | "cancelled") => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      player.onended = null;
      player.onerror = null;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      player.pause();
      settle("cancelled");
    };
    const watchdog = setTimeout(() => settle("ended"), pieceWatchdogMs(text));
    signal.addEventListener("abort", onAbort, { once: true });
    player.onended = () => settle("ended");
    player.onerror = () => settle("error");
    player.src = url;
    try {
      const started = player.play();
      if (started && typeof started.catch === "function")
        started.catch(() => settle("error"));
    } catch {
      settle("error");
    }
  });
}

export async function playMinkServerSpeech({
  text,
  lang,
  player,
  signal,
  onStart,
}: {
  text: string;
  lang: string;
  player: HTMLAudioElement;
  signal: AbortSignal;
  /** The first audio is about to play (the loop moves to "Speaking…"). */
  onStart: () => void;
}): Promise<MinkServerSpeechResult> {
  const pieces = splitSpeechChunks(text);
  if (!pieces.length) return { outcome: "done" };
  // Its own controller, so an early stop also cancels the piece being
  // prefetched; the caller's signal still cancels everything.
  const local = new AbortController();
  const forward = () => local.abort();
  signal.addEventListener("abort", forward, { once: true });
  let finished = false;
  const urls: string[] = [];
  const track = (fetched: Promise<Fetched>) =>
    fetched.then((result) => {
      if (result.kind === "audio") {
        if (finished) URL.revokeObjectURL(result.url);
        else urls.push(result.url);
      }
      return result;
    });
  try {
    let next = track(fetchSpeech(pieces[0], lang, local.signal));
    for (let index = 0; index < pieces.length; index += 1) {
      const current = await next;
      if (signal.aborted) return { outcome: "cancelled" };
      if (current.kind !== "audio")
        return {
          outcome: current.kind,
          remaining: pieces.slice(index).join(" "),
        };
      if (index + 1 < pieces.length)
        next = track(fetchSpeech(pieces[index + 1], lang, local.signal));
      if (index === 0) onStart();
      const played = await playPiece(
        player,
        current.url,
        pieces[index],
        signal,
      );
      if (played === "cancelled") return { outcome: "cancelled" };
      if (played === "error")
        return {
          outcome: "browser",
          remaining: pieces.slice(index).join(" "),
        };
    }
    return { outcome: "done" };
  } finally {
    finished = true;
    local.abort();
    signal.removeEventListener("abort", forward);
    urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  }
}

/**
 * A tiny silent WAV, played once on the click that turns voice chat on.
 * ★ Browsers only let a page start audio from a user gesture; iOS Safari
 * applies that per audio element. Playing this on the toggle click "unlocks"
 * the one element every later answer is played through.
 */
export function silentWavUrl(): string {
  const samples = 800;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) =>
    [...value].forEach((char, i) =>
      view.setUint8(offset + i, char.charCodeAt(0)),
    );
  write(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}
