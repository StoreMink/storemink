"use client";

/**
 * Plays a Mink answer through the platform's read-aloud model as it streams
 * in: `/api/mink/speech` answers raw 16-bit mono PCM, and each chunk is
 * scheduled on the Web Audio clock the moment it lands, so the merchant hears
 * the first words about a second and a half after the answer (Gemini's
 * measured time to first audio) instead of after the whole answer is
 * synthesised.
 *
 * Outcomes:
 * - `done`: the audio played to the end (or a stream that broke after it had
 *   started was allowed to finish what had arrived).
 * - `off`: no model is switched on; the browser voice reads this answer and
 *   the rest of the voice chat.
 * - `browser`: the model could not read this answer (a language it has no
 *   voice for, a provider failure before any audio); the browser voice reads
 *   it.
 * - `cancelled`: speech was stopped by the voice chat.
 */
export type MinkServerSpeechResult =
  | { outcome: "done" }
  | { outcome: "cancelled" }
  | { outcome: "off" | "browser"; remaining: string };

/** Audio held ahead of the playhead before the first chunk plays. */
const START_LEAD_S = 0.25;
/** The smaller cushion used after the network fell behind playback. */
const RECOVER_LEAD_S = 0.1;
/** No bytes for this long means the stream has stalled. */
const STALL_MS = 15_000;

function readWithin<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number,
): Promise<ReadableStreamReadResult<T> | "stalled"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    reader.read(),
    new Promise<"stalled">((resolve) => {
      timer = setTimeout(() => resolve("stalled"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function playMinkServerSpeech({
  text,
  lang,
  audio,
  signal,
  onStart,
}: {
  text: string;
  lang: string;
  /** Created and resumed on the click that turned voice chat on. */
  audio: AudioContext;
  signal: AbortSignal;
  /** The first audio is about to play (the loop moves to "Speaking…"). */
  onStart: () => void;
}): Promise<MinkServerSpeechResult> {
  const browser = { outcome: "browser" as const, remaining: text };
  let response: Response;
  try {
    response = await fetch("/api/mink/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang }),
      cache: "no-store",
      signal,
    });
  } catch {
    return signal.aborted ? { outcome: "cancelled" } : browser;
  }
  if (response.status === 204)
    return response.headers.get("X-Mink-Speech") === "off"
      ? { outcome: "off", remaining: text }
      : browser;
  const format = response.headers.get("X-Mink-Audio") ?? "";
  if (!response.ok || !response.body || !format.startsWith("pcm16le"))
    return browser;
  const rate = Number(/rate=(\d+)/.exec(format)?.[1]) || 24_000;

  if (audio.state === "suspended") await audio.resume().catch(() => {});
  const reader = response.body.getReader();
  const sources: AudioBufferSourceNode[] = [];
  let playhead = 0;
  let started = false;
  let carry: number | null = null;
  let lastEnded: Promise<void> = Promise.resolve();

  const schedule = (chunk: Uint8Array) => {
    // A chunk can split a 16-bit sample; the odd byte waits for the next.
    let bytes = chunk;
    if (carry !== null) {
      const joined = new Uint8Array(chunk.length + 1);
      joined[0] = carry;
      joined.set(chunk, 1);
      bytes = joined;
      carry = null;
    }
    if (bytes.length % 2) {
      carry = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const samples = bytes.length / 2;
    if (!samples) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const buffer = audio.createBuffer(1, samples, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples; i += 1)
      channel[i] = view.getInt16(i * 2, true) / 32_768;
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    const now = audio.currentTime;
    if (playhead < now + 0.02)
      playhead = now + (started ? RECOVER_LEAD_S : START_LEAD_S);
    source.start(playhead);
    playhead += buffer.duration;
    sources.push(source);
    lastEnded = new Promise((resolve) => {
      source.onended = () => {
        source.disconnect();
        resolve();
      };
    });
    if (!started) {
      started = true;
      onStart();
    }
  };

  const stopAll = () => {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Already ended.
      }
    }
  };
  const cancelled = new Promise<"cancelled">((resolve) => {
    if (signal.aborted) resolve("cancelled");
    signal.addEventListener("abort", () => resolve("cancelled"), {
      once: true,
    });
  });

  try {
    for (;;) {
      const read = await Promise.race([
        readWithin(reader, STALL_MS),
        cancelled,
      ]);
      if (read === "cancelled") {
        stopAll();
        return { outcome: "cancelled" };
      }
      if (read === "stalled" || read.done) break;
      if (read.value?.length) schedule(read.value);
    }
  } catch {
    if (signal.aborted) {
      stopAll();
      return { outcome: "cancelled" };
    }
    // A stream that broke: what already arrived still plays, below.
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!started) return browser;
  // Let what was scheduled finish, with a safety margin in case an `ended`
  // event never comes.
  const remainingMs =
    Math.max(0, (playhead - audio.currentTime) * 1000) + 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([
    lastEnded.then(() => "ended" as const),
    cancelled,
    new Promise<"ended">((resolve) => {
      timer = setTimeout(() => resolve("ended"), remainingMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (ended === "cancelled") {
    stopAll();
    return { outcome: "cancelled" };
  }
  return { outcome: "done" };
}
