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
 * voice cannot flip back and forth within one answer. A refusal before audio
 * also moves the remaining answer to the browser after model audio drains,
 * avoiding repeated provider failures. The next answer may try the model again.
 * ★ CANCEL BUMPS A GENERATION. Every awaited continuation re-checks it, so a
 * fetch that lands or an utterance that ends after a barge-in acts on
 * nothing; `onIdle` never fires for a cancelled session.
 * ★ AN ENDED SESSION CAN BE REOPENED. A run that spoke a sentence and then
 * withdrew it for a tool call has a second spoken block coming, the one with
 * the answer; `reopen()` takes pieces again, and `onStart` and `onIdle` fire
 * again for what follows. Pieces that arrive while the last audio drains are
 * played, not dropped.
 * ★ A PIECE IS ANNOUNCED WHEN IT IS HEARD, NOT WHEN IT IS QUEUED. A sentence
 * is scheduled as soon as its audio arrives, which with a piece fetched ahead
 * is while the one before it still has seconds to play; announcing it then
 * put the next sentence on screen while the merchant was still hearing the
 * last one. `onStart` and `onPieceStart` wait for the audio clock to reach
 * the piece, and any still waiting are announced, in order, before idle.
 * ★ A WITHDRAWN SENTENCE THAT HAS NOT BEEN HEARD IS NOT HEARD. `dropPending()`
 * forgets the queue, drops the piece being fetched, and cuts from the
 * playhead any audio scheduled to start later, so the run's withdrawn words
 * (a tool call follows) are not read out after the fact. The piece already
 * playing finishes.
 * ★★ A PAUSE LOSES NOTHING. Speech over Mink holds its voice (`pause()`)
 * until the transcript says whether the merchant said anything; a cough, a
 * door or Mink's own voice through the speaker gives it back (`resume()`).
 * The model's audio is held on the context's clock, so it carries on from
 * the very syllable; the browser voice cannot be paused reliably everywhere,
 * so its sentence is stopped and said again from its start. While paused no
 * piece is announced, no browser sentence starts, and the session does not
 * call itself idle.
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
  /**
   * Forget every piece not yet heard (queued, being fetched, or scheduled to
   * play later); the one playing finishes.
   */
  dropPending(): void;
  /** No more pieces will come; `onIdle` fires once the last has played. */
  end(): void;
  /** After `end()`: more pieces are coming after all. */
  reopen(): void;
  /** Hold the voice where it is; nothing is lost (see the header). */
  pause(): void;
  /** After `pause()`: carry on where the voice stopped. */
  resume(): void;
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
  /** Audio-clock time its first audio plays (the model voice). */
  startsAt: number | null;
  /** The browser voice began reading it. */
  speaking: boolean;
  /** Its words have been put on screen (the browser voice may say it twice). */
  announced: boolean;
  /** Withdrawn before it was heard: never played, never announced. */
  dropped: boolean;
};

type Announcement = {
  piece: Piece;
  gen: number;
  timer: ReturnType<typeof setTimeout> | null;
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
  let paused = false;
  const resumeWaiters: (() => void)[] = [];
  // The browser sentence being read, so `pause()` can stop it.
  let reading: { stop(): void } | null = null;
  const queue: Piece[] = [];
  let active: Piece | null = null;
  // Model pieces with audio on the playhead not yet heard, in playing order.
  let scheduled: Piece[] = [];
  // Pieces scheduled but not yet heard, waiting to be announced, in order.
  const announcements: Announcement[] = [];
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

  const audioNow = () => options.audio?.currentTime ?? 0;
  const heard = (piece: Piece) =>
    piece.speaking || (piece.startsAt !== null && piece.startsAt <= audioNow());

  /** Announces every waiting piece up to and including `through` (all when absent). */
  const releaseAnnouncements = (through?: Announcement) => {
    if (through && !announcements.includes(through)) return;
    while (announcements.length) {
      const next = announcements.shift()!;
      if (next.timer) clearTimeout(next.timer);
      if (!next.piece.dropped) announce(next.piece);
      if (next === through) return;
    }
  };

  /**
   * Times an announcement to the audio clock. ★ Not while paused: the clock
   * has stopped, and a timer on the wall clock would put the sentence on
   * screen before anyone hears it; `resume()` sets them again.
   */
  const armAnnouncement = (entry: Announcement) => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (paused) return;
    const waitMs = ((entry.piece.startsAt ?? 0) - audioNow()) * 1000;
    if (waitMs <= 0) {
      releaseAnnouncements(entry);
      return;
    }
    entry.timer = setTimeout(() => {
      if (entry.gen === generation) releaseAnnouncements(entry);
    }, waitMs);
  };

  const announceWhenHeard = (piece: Piece, gen: number) => {
    const entry: Announcement = { piece, gen, timer: null };
    announcements.push(entry);
    armAnnouncement(entry);
  };

  /** Waits out a pause; returns at once when not paused or no longer current. */
  const whilePaused = async (gen: number) => {
    while (paused && gen === generation)
      await new Promise<void>((resolve) => resumeWaiters.push(resolve));
  };
  const wakeResumeWaiters = () => {
    for (const resolve of resumeWaiters.splice(0)) resolve();
  };

  const forgetAnnouncements = (drop: (piece: Piece) => boolean) => {
    for (let i = announcements.length - 1; i >= 0; i -= 1) {
      const entry = announcements[i];
      if (!drop(entry.piece)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      announcements.splice(i, 1);
    }
  };

  const driveModel = async (
    piece: Piece,
    gen: number,
  ): Promise<"played" | "browser" | "off" | "cancelled" | "dropped"> => {
    if (!playhead) return "browser";
    startFetch(piece);
    while (!piece.head) {
      if (piece.dropped) return "dropped";
      await waitFor(piece);
      if (gen !== generation) return "cancelled";
    }
    // Before the head is read: an aborted fetch answers "cancelled", which
    // must not hand withdrawn words to the browser voice.
    if (piece.dropped) return "dropped";
    const head = piece.head;
    if (head.kind === "off") return "off";
    if (head.kind !== "pcm") return "browser";
    // A context the browser suspended is woken; one this session paused is
    // left for `resume()`.
    if (!paused && options.audio?.state === "suspended")
      await options.audio.resume().catch(() => {});
    if (gen !== generation) return "cancelled";
    let scheduledAny = false;
    const flush = () => {
      for (const samples of piece.buffered.splice(0)) {
        if (piece.dropped) return;
        const at = playhead.schedule(samples, head.rate);
        if (at === null || scheduledAny) continue;
        scheduledAny = true;
        piece.startsAt = at;
        scheduled = scheduled.filter((item) => !heard(item));
        scheduled.push(piece);
        announceWhenHeard(piece, gen);
      }
    };
    for (;;) {
      flush();
      if (piece.dropped) return "dropped";
      if (piece.finished) {
        flush();
        break;
      }
      await waitFor(piece);
      if (gen !== generation) return "cancelled";
    }
    if (piece.dropped) return "dropped";
    if (!scheduledAny) return "browser";
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
    // The model's audio has played, so its announcements are all due.
    releaseAnnouncements();
    if (!synth || typeof Utterance === "undefined") return;
    /** Reads the piece once; true when `pause()` stopped it mid-sentence. */
    const readOnce = () =>
      new Promise<boolean>((resolve) => {
        const utterance = new Utterance(piece.text);
        utterance.lang = piece.lang;
        utterances.add(utterance);
        let settled = false;
        const finish = (stopped: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          utterances.delete(utterance);
          if (reading === current) reading = null;
          resolve(stopped);
        };
        const current = {
          stop: () => {
            // Settled first, so the end event the cancel raises is ignored.
            finish(true);
            synth.cancel();
          },
        };
        const watchdog = setTimeout(() => {
          if (gen === generation) synth.cancel();
          finish(false);
        }, speechWatchdogMs(piece.text));
        utterance.onend = () => finish(false);
        utterance.onerror = () => finish(false);
        reading = current;
        piece.speaking = true;
        if (!piece.announced) {
          piece.announced = true;
          announce(piece);
        }
        synth.speak(utterance);
      });
    for (;;) {
      await whilePaused(gen);
      if (gen !== generation || piece.dropped) return;
      // Stopped by a pause: the sentence is said again, from its start.
      if (!(await readOnce())) return;
    }
  };

  const drive = async (piece: Piece, gen: number) => {
    if (voice === "model") {
      const result = await driveModel(piece, gen);
      if (result === "cancelled" || result === "played" || result === "dropped")
        return;
      voice = "browser";
      abortQueuedFetches();
      // Only an explicit operator switch disables model audio for the whole
      // conversation. A transient refusal changes this answer alone.
      if (result === "off") events.onVoiceOff();
    }
    await driveBrowser(piece, gen);
  };

  const settleIdle = async (gen: number) => {
    if (playhead) await playhead.drained();
    // Reopened, or handed another piece, while the last audio drained.
    if (gen !== generation || idleFired || !ended || queue.length) return;
    // Everything has played: no piece is announced after the session idles.
    releaseAnnouncements();
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
            if (!ended) return;
            await settleIdle(gen);
            if (gen !== generation || idleFired) return;
            continue;
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
        startsAt: null,
        speaking: false,
        announced: false,
        dropped: false,
      });
      if (!driving) void pump();
      else if (active && queue.length <= MINK_SPEECH_PREFETCH)
        startFetch(queue[queue.length - 1]);
    },
    dropPending() {
      abortQueuedFetches();
      queue.length = 0;
      const unheard = scheduled.filter((piece) => !heard(piece));
      if (active && !heard(active) && !unheard.includes(active))
        unheard.push(active);
      for (const piece of unheard) {
        piece.dropped = true;
        piece.fetch?.abort();
      }
      // Pieces play in order, so the first one with audio is where to cut.
      const cutAt = unheard.find((piece) => piece.startsAt !== null)?.startsAt;
      if (playhead && cutAt != null) playhead.cutFrom(cutAt);
      scheduled = scheduled.filter((piece) => !piece.dropped);
      forgetAnnouncements((piece) => piece.dropped);
      if (active?.dropped) notify(active);
    },
    end() {
      if (dead) return;
      ended = true;
      if (!driving) void pump();
    },
    reopen() {
      if (dead) return;
      ended = false;
      idleFired = false;
      startedAny = false;
    },
    pause() {
      if (dead || paused) return;
      paused = true;
      playhead?.pause();
      for (const entry of announcements) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
      }
      reading?.stop();
    },
    resume() {
      if (dead || !paused) return;
      paused = false;
      playhead?.resume();
      for (const entry of [...announcements]) armAnnouncement(entry);
      wakeResumeWaiters();
    },
    cancel() {
      if (dead) return;
      dead = true;
      generation += 1;
      paused = false;
      wakeResumeWaiters();
      reading = null;
      abortQueuedFetches();
      queue.length = 0;
      forgetAnnouncements(() => true);
      scheduled = [];
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
