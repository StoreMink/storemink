/**
 * One voice-chat turn from the microphone to a transcript, shared with the
 * composer's dictation for the transcription half.
 *
 * Client-safe (no React): the voice loop in ChatProvider owns the microphone
 * now, so the composer cannot tear the loop down when it remounts on a
 * conversation change or a panel/overlay swap.
 */

import { startMinkRecording, type MinkSpeechGate } from "./voice-recorder";

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

/**
 * Sends one canonical WAV to the platform's transcription provider and
 * returns the trimmed transcript (empty when nothing was understood).
 */
export async function transcribeMinkRecording(
  recording: File,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch("/api/mink/voice", {
    method: "POST",
    headers: {
      "Content-Type": "audio/wav",
      "X-Mink-Request-Key": crypto.randomUUID(),
    },
    body: recording,
    cache: "no-store",
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as {
    text?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof data.text !== "string")
    throw new MinkVoiceCaptureError(
      "transcription",
      typeof data.error === "string" ? data.error : TRANSCRIPTION_FAILED,
    );
  return data.text.trim();
}

/**
 * Records until the merchant has spoken and paused (or the recorder's own
 * caps end it), transcribes, and resolves the transcript, or null when
 * nothing was heard. Rejects with an AbortError when `signal` aborts, and
 * with `MinkVoiceCaptureError` when the microphone or the transcription
 * failed.
 */
export async function captureMinkVoiceTurn(input: {
  signal: AbortSignal;
  gate: { current: MinkSpeechGate };
  onLevel?: (level: number) => void;
  onSpeechStart: () => boolean;
  /** `open` once the microphone is live, `transcribing` once it closed. */
  onPhase?: (phase: "open" | "transcribing") => void;
  /** Injected in tests. */
  transcribe?: typeof transcribeMinkRecording;
}): Promise<string | null> {
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
    startMinkRecording(
      input.signal,
      (file) => {
        input.signal.removeEventListener("abort", abort);
        resolve(file);
      },
      open,
      {
        endOnSilence: true,
        onLevel: input.onLevel,
        voice: { gate: input.gate, onSpeechStart: input.onSpeechStart },
      },
    ).then(open, (error) => {
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
  const text = await (input.transcribe ?? transcribeMinkRecording)(
    recording,
    input.signal,
  );
  return text || null;
}
