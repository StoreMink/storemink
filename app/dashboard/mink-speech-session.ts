"use client";

import {
  fetchMinkSpeech,
  MinkSpeechPlayhead,
  type MinkSpeechFetch,
  type MinkSpeechHead,
} from "./mink-speech-player";

/**
 * One voice-chat answer, read aloud a piece at a time as the pieces arrive.
 *
 * The voice loop cuts Mink's streamed spoken text into sentences and hands
 * each to `enqueue()` the moment it completes; the session fetches them in
 * order, one ahead of the one playing, and schedules every chunk on ONE
 * playhead, so sentence two starts the instant sentence one ends. The first
 * words therefore play a second or two after Mink starts its reply, not after
 * the whole reply is written and synthesised.
 *
 * ★ ONE PIECE AHEAD, NO MORE (`MINK_SPEECH_PREFETCH`). The model's first audio
 * takes 1.2 to 1.6 s and a sentence plays for 2 to 5 s, so one piece in
 * flight behind the one playing is enough to hide the gap, and it holds at
 * most two `/api/mink/speech` slots per voice chat against the route's cap.
 * ★ A BROKEN PIECE DOES NOT END THE ANSWER. The player cannot tell where a
 * stalled stream's words stopped, so the rest of that sentence is lost and
 * the merchant is told once; the next sentence is intact and plays.
 * ★ THE BROWSER VOICE IS A SWITCH, NOT A FALLBACK PER PIECE. `off` (no model
 * switched on) moves the rest of the session to `speechSynthesis`, so the
 * voice cannot flip back and forth within one answer; a single piece the
 * model refused is read by the browser after the model's audio has drained,
 * and the model resumes with the next.
 * ★ CANCEL BUMPS A GENERATION. Every awaited continuation re-checks it, so a
 * fetch that lands or an utterance that ends after a barge-in acts on
 * nothing; `onIdle` never fires for a cancelled session.
 */

/** Pieces fetched ahead of the one playing. */
export const MINK_SPEECH_PREFETCH = 1;
export const MINK_SPEECH_TRUNCATED_NOTICE =
  "The rest of that answer could not be read aloud.";

/**
 * A synthesiser that never fires `end` (Chrome's remote voices are known to
 * fall silent on long text) would leave the loop in `speaking` for ever, so a
 * watchdog sized to the text treats a missing end event as the end.
 */
export function speechWatchdogMs(text: string): number {
  return Math.min(120_000, 8_000 + text.length * 90);
}

export type MinkSpeechSessionEvents = {
  /** The first audible output of the session (the loop moves to "Speaking…"). */
  onStart(): void;
  /** A piece began playing; its words are the caption. */
  onPieceStart(text: string): void;
  /** After `end()`: the queue is empty and the last audio has played. */
  onIdle(outcome: "done" | "truncated"): void;
  /** A short merchant-facing message, at most once per session. */
  onNotice(text: string): void;
  /** The platform has no read-aloud model on; the browser voice took over. */
  onVoiceOff(): void;
};

export type MinkSpeechSession = {
  enqueue(text: string, lang: string): void;
  /** Forget pieces not yet playing; the one playing finishes. */
  dropPending(): void;
  /** No more pieces will come; `onIdle` fires once the last has played. */
  end(): void;
  /** Stop everything now; nothing fires afterwards. */
  cancel(): void;
  readonly active: boolean;
};

type Piece = {
  text: string;
  lang: string;
  fetch: MinkSpeechFetch | null;
  head: MinkSpeechHead | null;
  buffered: Int16Array[];
  finished: boolean;
  truncated: boolean;
  wake: (() => void) | null;
};

export function createMinkSpeechSession(options: {
  audio: AudioContext | null;
  voice: "model" | "browser";
  events: MinkSpeechSessionEvents;
  /** Injected in tests. */
  fetchSpeech?: typeof fetchMinkSpeech;
  synth?: SpeechSynthesis | null;
  utteranceClass?: typeof SpeechSynthesisUtterance;
}): MinkSpeechSession {
  const { events } = options;
  const fetchSpeech = options.fetchSpeech ?? fetchMinkSpeech;
  const synth =
    options.synth !== undefined
      ? options.synth
      : typeof window !== "undefined"
        ? (window.speechSynthesis ?? null)
        : null;
  const Utterance =
    options.utteranceClass ??
    (typeof window !== "undefined"
      ? window.SpeechSynthesisUtterance
      : undefined);
  const playhead = options.audio ? new MinkSpeechPlayhead(options.audio) : null;
  let voice: "model" | "browser" = playhead ? options.voice : "browser";
  let generation = 0;
  let dead = false;
  let ended = false;
  let idleFired = false;
  let driving = false;
  let startedAny = false;
  let truncatedNoticed = false;
  const queue: Piece[] = [];
  let active: Piece | null = null;
  // Chrome drops end events for an utterance nothing references.
  const utterances = new Set<SpeechSynthesisUtterance>();

  const notify = (piece: Piece) => {
    const wake = piece.wake;
    piece.wake = null;
    wake?.();
  };
  const waitFor = (piece: Piece) =>
    new Promise<void>((resolve) => {
      piece.wake = resolve;
    });

  const startFetch = (piece: Piece) => {
    if (piece.fetch || voice !== "model") return;
    const controller = new AbortController();
    const fetched = fetchSpeech({
      text: piece.text,
      lang: piece.lang,
      signal: controller.signal,
    });
    piece.fetch = { ...fetched, abort: () => controller.abort() };
    void (async () => {
      const head = await fetched.head;
      piece.head = head;
      notify(piece);
      if (head.kind !== "pcm") {
        piece.finished = true;
        notify(piece);
        return;
      }
      for (;;) {
        const read = await fetched.read();
        if (controller.signal.aborted) break;
        if (read.done) {
          piece.truncated = read.truncated;
          break;
        }
        piece.buffered.push(read.samples);
        notify(piece);
      }
      piece.finished = true;
      notify(piece);
    })();
  };

  const abortQueuedFetches = () => {
    for (const piece of queue) {
      piece.fetch?.abort();
      piece.fetch = null;
      piece.head = null;
      piece.buffered = [];
      piece.finished = false;
    }
  };

  const announce = (piece: Piece) => {
    if (!startedAny) {
      startedAny = true;
      events.onStart();
    }
    events.onPieceStart(piece.text);
  };

  const driveModel = async (
    piece: Piece,
    gen: number,
  ): Promise<"played" | "browser" | "off" | "cancelled"> => {
    if (!playhead) return "browser";
    startFetch(piece);
    while (!piece.head) {
      await waitFor(piece);
      if (gen !== generation) return "cancelled";
    }
    const head = piece.head;
    if (head.kind === "off") return "off";
    if (head.kind !== "pcm") return "browser";
    if (options.audio?.state === "suspended")
      await options.audio.resume().catch(() => {});
    if (gen !== generation) return "cancelled";
    let announced = false;
    const flush = () => {
      for (const samples of piece.buffered.splice(0)) {
        playhead.schedule(samples, head.rate);
        if (!announced && playhead.started) {
          announced = true;
          announce(piece);
        }
      }
    };
    for (;;) {
      flush();
      if (piece.finished) {
        flush();
        break;
      }
      await waitFor(piece);
      if (gen !== generation) return "cancelled";
    }
    if (!announced) return "browser";
    if (piece.truncated && !truncatedNoticed) {
      truncatedNoticed = true;
      events.onNotice(MINK_SPEECH_TRUNCATED_NOTICE);
    }
    return "played";
  };

  const driveBrowser = async (piece: Piece, gen: number) => {
    // Never over the model's audio: wait for what is queued to play out.
    if (playhead?.started) {
      await playhead.drained();
      if (gen !== generation) return;
    }
    if (!synth || typeof Utterance === "undefined") return;
    await new Promise<void>((resolve) => {
      const utterance = new Utterance(piece.text);
      utterance.lang = piece.lang;
      utterances.add(utterance);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        utterances.delete(utterance);
        resolve();
      };
      const watchdog = setTimeout(() => {
        if (gen === generation) synth.cancel();
        finish();
      }, speechWatchdogMs(piece.text));
      utterance.onend = finish;
      utterance.onerror = finish;
      announce(piece);
      synth.speak(utterance);
    });
  };

  const drive = async (piece: Piece, gen: number) => {
    if (voice === "model") {
      const result = await driveModel(piece, gen);
      if (result === "cancelled" || result === "played") return;
      if (result === "off") {
        voice = "browser";
        abortQueuedFetches();
        events.onVoiceOff();
      }
    }
    await driveBrowser(piece, gen);
  };

  const settleIdle = async (gen: number) => {
    if (playhead) await playhead.drained();
    if (gen !== generation || idleFired) return;
    idleFired = true;
    events.onIdle(truncatedNoticed ? "truncated" : "done");
  };

  const pump = async () => {
    if (driving || dead) return;
    driving = true;
    const gen = generation;
    try {
      while (gen === generation) {
        if (!active) {
          active = queue.shift() ?? null;
          if (!active) {
            if (ended) await settleIdle(gen);
            return;
          }
        }
        startFetch(active);
        if (queue[0]) startFetch(queue[0]);
        await drive(active, gen);
        if (gen !== generation) return;
        active = null;
      }
    } finally {
      driving = false;
    }
  };

  return {
    enqueue(text, lang) {
      if (dead || idleFired || !text) return;
      queue.push({
        text,
        lang,
        fetch: null,
        head: null,
        buffered: [],
        finished: false,
        truncated: false,
        wake: null,
      });
      if (!driving) void pump();
      else if (active && queue.length <= MINK_SPEECH_PREFETCH)
        startFetch(queue[queue.length - 1]);
    },
    dropPending() {
      abortQueuedFetches();
      queue.length = 0;
    },
    end() {
      if (dead) return;
      ended = true;
      if (!driving) void pump();
    },
    cancel() {
      if (dead) return;
      dead = true;
      generation += 1;
      abortQueuedFetches();
      queue.length = 0;
      if (active) {
        active.fetch?.abort();
        notify(active);
        active = null;
      }
      playhead?.stop();
      synth?.cancel();
      utterances.clear();
    },
    get active() {
      return active !== null || queue.length > 0;
    },
  };
}
