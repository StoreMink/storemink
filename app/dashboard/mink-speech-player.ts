"use client";

/**
 * Plays a Mink answer through the platform's read-aloud model as it streams
 * in: `/api/mink/speech` answers raw 16-bit mono PCM, and each chunk is
 * scheduled on the Web Audio clock the moment it lands, so the merchant hears
 * the first words about a second and a half after the answer (Gemini's
 * measured time to first audio) instead of after the whole answer is
 * synthesised.
 *
 * Two halves, so the voice chat's session can play several pieces of one
 * answer back to back on one playhead:
 * - `fetchMinkSpeech` is the network: one POST, the head (PCM, or the two
 *   ways the browser voice takes over), and the samples as they arrive, with
 *   the odd-byte carry, the stall read and the first-audio deadline inside.
 * - `MinkSpeechPlayhead` is the clock: every sample lands at the end of the
 *   last one scheduled, whichever piece it came from, so a sentence fetched
 *   while the one before it plays starts the instant that one ends.
 * `playMinkServerSpeech` composes the two for a single text.
 *
 * Outcomes:
 * - `done`: the audio played to the end.
 * - `truncated`: the audio started and then the stream broke or stalled;
 *   what had arrived was played, and the caller tells the merchant the rest
 *   could not be read (the player cannot know where the words stopped, so
 *   the browser voice cannot pick up the remainder).
 * - `off`: no model is switched on; the browser voice reads this answer and
 *   the rest of the voice chat.
 * - `browser`: the model could not read this answer (a language it has no
 *   voice for, a provider failure before any audio, or no audio at all within
 *   `firstAudioMs`); the browser voice reads it.
 * - `cancelled`: speech was stopped by the voice chat.
 */
export type MinkServerSpeechResult =
  | { outcome: "done" }
  | { outcome: "truncated" }
  | { outcome: "cancelled" }
  | { outcome: "off" | "browser"; remaining: string };

/** Audio held ahead of the playhead before the first chunk plays. */
const START_LEAD_S = 0.25;
/** The smaller cushion used after the network fell behind playback. */
const RECOVER_LEAD_S = 0.1;
/** No bytes for this long, after audio started, means the stream has stalled. */
const STALL_MS = 15_000;
/**
 * ★ A WATCHDOG ON THE FIRST AUDIO. The browser voice has one
 * (`speechWatchdogMs`); this path relied on the server's 60 s ceiling, and
 * headers that never arrived (a proxy holding the socket, a dropped link the
 * browser had not noticed) left voice chat in "Thinking…" with the mic
 * closed. Gemini's first audio lands in 1.2 to 1.6 s and Bulbul's first piece
 * in a few, so past this the browser voice reads the answer instead.
 */
export const MINK_FIRST_AUDIO_MS = 20_000;

export type MinkSpeechHead =
  | { kind: "pcm"; rate: number }
  /** No read-aloud model is on; the browser voice takes the whole voice chat. */
  | { kind: "off" }
  /** The model could not read this text; the browser voice reads it. */
  | { kind: "browser" }
  /** The caller stopped the request before an answer. */
  | { kind: "cancelled" };

export type MinkSpeechRead =
  | { done: false; samples: Int16Array }
  /** `truncated` says audio had started and the stream then broke or stalled. */
  | { done: true; truncated: boolean };

export type MinkSpeechFetch = {
  head: Promise<MinkSpeechHead>;
  /** The next samples; valid only after a `pcm` head. */
  read(): Promise<MinkSpeechRead>;
  abort(): void;
};

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

/** One speech request: the head, then samples until done. */
export function fetchMinkSpeech({
  text,
  lang,
  signal,
  firstAudioMs = MINK_FIRST_AUDIO_MS,
}: {
  text: string;
  lang: string;
  signal: AbortSignal;
  firstAudioMs?: number;
}): MinkSpeechFetch {
  // Our own controller ends the request on the first-audio deadline as well
  // as on the caller's stop; `expiredFirst` still says which one it was.
  const own = new AbortController();
  const forward = () => own.abort(signal.reason);
  if (signal.aborted) forward();
  else signal.addEventListener("abort", forward, { once: true });
  let started = false;
  let expiredFirst = false;
  let expireTimer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    expireTimer = setTimeout(() => {
      if (!started) {
        expiredFirst = true;
        own.abort(new Error("No audio arrived in time."));
      }
      resolve("expired");
    }, firstAudioMs);
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let carry: number | null = null;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(expireTimer);
    signal.removeEventListener("abort", forward);
    reader?.cancel().catch(() => {});
  };

  const head: Promise<MinkSpeechHead> = (async () => {
    try {
      const raced = await Promise.race([
        fetch("/api/mink/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, lang }),
          cache: "no-store",
          signal: own.signal,
        }),
        expired,
      ]);
      if (raced === "expired") {
        finish();
        return { kind: "browser" };
      }
      if (raced.status === 204) {
        finish();
        return raced.headers.get("X-Mink-Speech") === "off"
          ? { kind: "off" }
          : { kind: "browser" };
      }
      const format = raced.headers.get("X-Mink-Audio") ?? "";
      if (!raced.ok || !raced.body || !format.startsWith("pcm16le")) {
        finish();
        return { kind: "browser" };
      }
      reader = raced.body.getReader();
      return {
        kind: "pcm",
        rate: Number(/rate=(\d+)/.exec(format)?.[1]) || 24_000,
      };
    } catch {
      finish();
      return signal.aborted && !expiredFirst
        ? { kind: "cancelled" }
        : { kind: "browser" };
    }
  })();

  const read = async (): Promise<MinkSpeechRead> => {
    if (!reader || finished) return { done: true, truncated: false };
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array> | "stalled" | "expired";
      try {
        result = await Promise.race([
          readWithin(reader, STALL_MS),
          // The deadline matters only until something has arrived.
          ...(started ? [] : [expired]),
        ]);
      } catch {
        // A stream that broke: what already arrived still plays.
        const truncated = started && !signal.aborted;
        finish();
        return { done: true, truncated };
      }
      if (result === "expired") {
        finish();
        return { done: true, truncated: false };
      }
      if (result === "stalled") {
        finish();
        return { done: true, truncated: true };
      }
      if (result.done) {
        finish();
        return { done: true, truncated: false };
      }
      const chunk = result.value;
      if (!chunk?.length) continue;
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
      const count = bytes.length / 2;
      if (!count) continue;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i += 1)
        samples[i] = view.getInt16(i * 2, true);
      started = true;
      return { done: false, samples };
    }
  };

  return {
    head,
    read,
    abort: () => {
      own.abort(new Error("Speech request abandoned."));
      finish();
    },
  };
}

/**
 * One playhead for a whole voice-chat answer. Every piece of audio is placed
 * at the end of the last one, so pieces fetched one after another play with
 * no gap between them; only when the network falls behind does a fresh lead
 * open up.
 */
export class MinkSpeechPlayhead {
  private playhead = 0;
  private sources: AudioBufferSourceNode[] = [];
  private lastEnded: Promise<void> = Promise.resolve();
  /** Whether anything has been scheduled yet. */
  started = false;

  constructor(private readonly audio: AudioContext) {}

  /** The audio-clock time the scheduled audio ends. */
  get endsAt(): number {
    return this.playhead;
  }

  /** Schedules samples to play right after whatever is already queued. */
  schedule(samples: Int16Array, rate: number): void {
    if (!samples.length) return;
    const buffer = this.audio.createBuffer(1, samples.length, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1)
      channel[i] = samples[i] / 32_768;
    const source = this.audio.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audio.destination);
    const now = this.audio.currentTime;
    if (this.playhead < now + 0.02)
      this.playhead = now + (this.started ? RECOVER_LEAD_S : START_LEAD_S);
    source.start(this.playhead);
    this.playhead += buffer.duration;
    this.sources.push(source);
    this.lastEnded = new Promise((resolve) => {
      source.onended = () => {
        source.disconnect();
        resolve();
      };
    });
    this.started = true;
  }

  /**
   * Resolves once the last scheduled audio has played, with a safety margin
   * in case an `ended` event never comes. Immediate when nothing was queued.
   */
  async drained(): Promise<void> {
    if (!this.started) return;
    const remainingMs =
      Math.max(0, (this.playhead - this.audio.currentTime) * 1000) + 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.lastEnded,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remainingMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** Stops every scheduled source at once. */
  stop(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already ended.
      }
    }
    this.sources = [];
  }
}

export async function playMinkServerSpeech({
  text,
  lang,
  audio,
  signal,
  onStart,
  firstAudioMs = MINK_FIRST_AUDIO_MS,
}: {
  text: string;
  lang: string;
  /** Created and resumed on the click that turned voice chat on. */
  audio: AudioContext;
  signal: AbortSignal;
  /** The first audio is about to play (the loop moves to "Speaking…"). */
  onStart: () => void;
  /** How long to wait for the first audio before the browser voice reads it. */
  firstAudioMs?: number;
}): Promise<MinkServerSpeechResult> {
  const browser = { outcome: "browser" as const, remaining: text };
  const cancelled = new Promise<"cancelled">((resolve) => {
    if (signal.aborted) resolve("cancelled");
    signal.addEventListener("abort", () => resolve("cancelled"), {
      once: true,
    });
  });
  const fetched = fetchMinkSpeech({ text, lang, signal, firstAudioMs });
  const head = await fetched.head;
  if (signal.aborted || head.kind === "cancelled") {
    fetched.abort();
    return { outcome: "cancelled" };
  }
  if (head.kind === "off") return { outcome: "off", remaining: text };
  if (head.kind === "browser") return browser;

  if (audio.state === "suspended") await audio.resume().catch(() => {});
  const playhead = new MinkSpeechPlayhead(audio);
  let truncated = false;
  for (;;) {
    const read = await Promise.race([fetched.read(), cancelled]);
    if (read === "cancelled") {
      fetched.abort();
      playhead.stop();
      return { outcome: "cancelled" };
    }
    if (read.done) {
      truncated = read.truncated;
      break;
    }
    const first = !playhead.started;
    playhead.schedule(read.samples, head.rate);
    if (first && playhead.started) onStart();
  }
  if (!playhead.started) return browser;
  const ended = await Promise.race([
    playhead.drained().then(() => "ended" as const),
    cancelled,
  ]);
  if (ended === "cancelled") {
    playhead.stop();
    return { outcome: "cancelled" };
  }
  return { outcome: truncated ? "truncated" : "done" };
}
