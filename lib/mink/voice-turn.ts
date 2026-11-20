/**
 * One voice-chat turn from the microphone to a transcript, shared with the
 * composer's dictation for the transcription half.
 *
 * Client-safe (no React): the voice loop in ChatProvider owns the microphone
 * now, so the composer cannot tear the loop down when it remounts on a
 * conversation change or a panel/overlay swap.
 */

import { randomUuid } from "@/lib/random-uuid";
import {
  openMinkMicrophone,
  startMinkRecording,
  type MinkMicrophone,
  type MinkSpeechGate,
} from "./voice-recorder";
import { normalizeSpeechLanguage } from "./speech-text";

export class MinkVoiceCaptureError extends Error {
  readonly kind: "mic" | "transcription";
  constructor(kind: "mic" | "transcription", message: string) {
    super(message);
    this.name = "MinkVoiceCaptureError";
    this.kind = kind;
  }
}

const TRANSCRIPTION_FAILED =
  "Voice transcription failed. Try again or type your message.";
const TRANSCRIPTION_UNREACHABLE =
  "Voice transcription could not connect. Check your connection and try again.";

const isAbort = (error: unknown) =>
  (error as { name?: unknown } | null)?.name === "AbortError";

/**
 * Sends one canonical WAV to the platform's transcription provider and
 * returns the trimmed transcript (empty when nothing was understood).
 *
 * ★ A REQUEST THAT NEVER REACHED THE SERVER IS A TRANSCRIPTION FAILURE. A
 * dropped connection rejects `fetch` with a TypeError, which voice chat used
 * to report as "the microphone could not start": the merchant checked their
 * microphone for a network fault. An abort is still an abort.
 */
export async function transcribeMinkRecording(
  recording: File,
  signal?: AbortSignal,
  onLanguage?: (languageCode: string | null) => void,
  /**
   * The transcription route. The dashboard's (the default) needs a signed-in
   * merchant; the Help Centre's public assistant posts to `/api/help/voice`,
   * which has its own per-visitor limits.
   */
  endpoint = "/api/mink/voice",
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Mink-Request-Key": randomUuid(),
      },
      body: recording,
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new MinkVoiceCaptureError("transcription", TRANSCRIPTION_UNREACHABLE);
  }
  const data = (await response.json().catch(() => ({}))) as {
    text?: unknown;
    error?: unknown;
    languageCode?: unknown;
  };
  if (!response.ok || typeof data.text !== "string")
    throw new MinkVoiceCaptureError(
      "transcription",
      typeof data.error === "string" ? data.error : TRANSCRIPTION_FAILED,
    );
  if (!signal?.aborted)
    onLanguage?.(normalizeSpeechLanguage(data.languageCode));
  return data.text.trim();
}

export type MinkVoiceCaptureInput = {
  signal: AbortSignal;
  gate: { current: MinkSpeechGate };
  onLevel?: (level: number) => void;
  onSpeechStart: () => boolean;
  /** `open` once the microphone is live, `transcribing` once it closed. */
  onPhase?: (phase: "open" | "transcribing") => void;
  /** Recognition's language hint, scoped to this recording, never browser locale. */
  onLanguage?: (languageCode: string | null) => void;
  /**
   * The open microphone to record on (voice chat keeps one for the whole
   * chat); when absent one is opened for this turn and closed after it.
   */
  microphone?: () => Promise<MinkMicrophone>;
  /** Injected in tests. */
  transcribe?: typeof transcribeMinkRecording;
};

/**
 * Records until the merchant has spoken and paused (or the recorder's own
 * caps end it), transcribes, and resolves the transcript, or null when
 * nothing was heard. Rejects with an AbortError when `signal` aborts, and
 * with `MinkVoiceCaptureError` when the microphone or the transcription
 * failed.
 */
export async function captureMinkVoiceTurn(
  input: MinkVoiceCaptureInput,
): Promise<string | null> {
  const recording = await new Promise<File | null>((resolve, reject) => {
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      input.onPhase?.("open");
    };
    const abort = () => {
      reject(new DOMException("Voice capture cancelled.", "AbortError"));
    };
    if (input.signal.aborted) {
      abort();
      return;
    }
    input.signal.addEventListener("abort", abort, { once: true });
    const done = (file: File | null) => {
      input.signal.removeEventListener("abort", abort);
      resolve(file);
    };
    const options = {
      endOnSilence: true,
      onLevel: input.onLevel,
      voice: { gate: input.gate, onSpeechStart: input.onSpeechStart },
    };
    const microphone = input.microphone;
    const started = microphone
      ? microphone().then((live) =>
          live.record(input.signal, done, () => {}, options),
        )
      : startMinkRecording(input.signal, done, open, options);
    started.then(open, (error) => {
      input.signal.removeEventListener("abort", abort);
      reject(
        new MinkVoiceCaptureError(
          "mic",
          error instanceof Error ? error.message : "Microphone unavailable.",
        ),
      );
    });
  });
  if (!recording) return null;
  input.onPhase?.("transcribing");
  let text: string;
  try {
    text = await (input.transcribe ?? transcribeMinkRecording)(
      recording,
      input.signal,
      input.onLanguage,
    );
  } catch (error) {
    if (error instanceof MinkVoiceCaptureError || isAbort(error)) throw error;
    throw new MinkVoiceCaptureError("transcription", TRANSCRIPTION_UNREACHABLE);
  }
  return text || null;
}

/** The microphone for one voice chat; see `createMinkVoiceCapture`. */
export type MinkVoiceCapture = {
  capture(
    input: Omit<MinkVoiceCaptureInput, "microphone">,
  ): Promise<string | null>;
  close(): void;
};

/**
 * ★★ ONE MICROPHONE FOR THE WHOLE VOICE CHAT. Opened on the first turn and
 * kept open until `close()`, so every turn records on the same stream and
 * the browser's echo canceller keeps what it has learned about the speaker
 * (it started from nothing on every turn while each turn opened its own).
 * A microphone that could not open is tried again on the next turn, and one
 * whose device went away is opened again.
 */
export function createMinkVoiceCapture(
  options: { open?: typeof openMinkMicrophone } = {},
): MinkVoiceCapture {
  const open = options.open ?? openMinkMicrophone;
  let pending: Promise<MinkMicrophone> | null = null;
  let ended = false;
  const microphone = async (): Promise<MinkMicrophone> => {
    if (ended) throw new Error("Voice chat has ended.");
    if (!pending) {
      const opening = open();
      pending = opening;
      opening.catch(() => {
        if (pending === opening) pending = null;
      });
    }
    const current = pending;
    const live = await current;
    if (ended) {
      live.close();
      throw new Error("Voice chat has ended.");
    }
    if (!live.closed) return live;
    if (pending === current) pending = null;
    return microphone();
  };
  return {
    capture: (input) => captureMinkVoiceTurn({ ...input, microphone }),
    close() {
      ended = true;
      const opening = pending;
      pending = null;
      void opening?.then(
        (live) => live.close(),
        () => {},
      );
    },
  };
}
