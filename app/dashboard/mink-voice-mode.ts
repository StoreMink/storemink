"use client";

import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  DEFAULT_SPEECH_LANG,
  speakableMinkText,
  speechLangFor,
  splitSpeechChunks,
} from "@/lib/mink/speech-text";
import {
  createMinkSpeechSegmenter,
  isEchoTranscript,
  type MinkSpeechSegmenter,
} from "@/lib/mink/speech-stream";
import {
  MINK_BARGE_IN_GATE,
  MINK_SPEECH_GATE,
  type MinkSpeechGate,
} from "@/lib/mink/voice-recorder";
import {
  createMinkVoiceCapture,
  MinkVoiceCaptureError,
  type MinkVoiceCapture,
} from "@/lib/mink/voice-turn";
import type { MinkMessage } from "./mink-ai";
import {
  createMinkSpeechSession,
  type MinkSpeechSession,
} from "./mink-speech-session";

export { speechWatchdogMs } from "./mink-speech-session";

/**
 * The spoken conversation behind the composer's "Talk with Mink" toggle.
 *
 * It lives in `ChatProvider`, not the composer: the composer is keyed on the
 * conversation and remounts when a new conversation gets its id or the panel
 * swaps with the full view, and a loop inside it died on every such remount.
 * It owns the microphone (`createMinkVoiceCapture`), the sentence segmenter
 * and the speech session for the current answer; the chat client supplies
 * the stream (`spokenText`, `spokenEnded`, `messages`) and the two verbs,
 * `send` and `cancel`.
 *
 * ★ MINK SPEAKS WHILE IT IS STILL WRITING. A voice turn's reply opens with a
 * spoken block that the stream route forwards fragment by fragment; each
 * completed sentence is handed to the speech session the moment it ends, so
 * the first words play a second or two after Mink starts answering and the
 * loop is back to listening while the written answer and its cards are still
 * arriving in the chat. The block ends at its own close tag or when the
 * answer lands, never because written text appeared first. A block the run
 * withdrew after it closed (a retry) reopens the turn for the block that
 * carries the answer; an empty block leaves the written answer to be read.
 * ★★ A SHORT ACKNOWLEDGEMENT PLAYS WHILE THE TOOLS RUN. When Mink needs a
 * tool it may first say "Let me check today's orders." in the same turn; the
 * run keeps that block (`spokenKept`) instead of withdrawing it, so the
 * merchant hears Mink within a couple of seconds instead of after the tools.
 * The turn then waits ("Thinking…") for the block with the answer and plays
 * it after the acknowledgement; if that answer has no spoken block, its
 * written text is read, exactly as for a reply with no block at all.
 * ★ THE MICROPHONE IS OPEN FOR THE WHOLE CHAT: one stream from the first turn
 * to the last, so the browser's echo canceller keeps what it has learned
 * about the speaker. The recorder is re-armed the instant a transcript is
 * sent, with a stricter gate while Mink is thinking or talking
 * (`MINK_BARGE_IN_GATE`, swapped in place so the recorder reads it without
 * restarting).
 * ★★ LOUDNESS HOLDS MINK'S VOICE; THE TRANSCRIPT DECIDES. Speech over Mink's
 * voice pauses it where it is. If the transcript has words, the merchant
 * interrupted: the voice ends for good, and the written answer, its cards and
 * its drafts still land in the chat. If it has none (a cough, a door, Mink's
 * own voice through the speaker), the voice carries on from where it paused,
 * and nothing was lost. Speech while Mink is still THINKING about a spoken
 * question cancels that reply (not charged) and carries its words into the
 * next transcript, so a question split by a pause ("show me sales for",
 * "last week") is asked whole and replaces the unanswered half in the thread;
 * a burst with no words asks the question again. A typed question, or one
 * that carried a draft or attachments, is never cancelled by speech: its
 * answer's voice is held like any other.
 * ★ ONLY SPEECH OVER MINK CAN BE MINK'S OWN VOICE. A transcript is compared
 * with what Mink said this turn only when the speech began while Mink was
 * talking; a reply that reuses Mink's words after it finished is an answer.
 * An echo confirmed once means the speaker reaches the microphone, so talking
 * over Mink is switched off for the rest of the chat and the merchant is
 * told why; the pause that echo caused is given back, so Mink never cuts
 * itself off.
 * ★ A TRANSCRIPT WAITS FOR THE CHAT TO BE FREE. `send` refuses while a reply
 * is running, and a cancelled reply stays "replying" until its stream has
 * closed, so a transcript is parked in `pendingSend` and sent from the effect
 * that sees `isReplying` fall. The slot is cleared BEFORE `send`, so the
 * effect and a direct call cannot send it twice. `send` may resolve later:
 * a draft or attachments staged in the composer go with the transcript, and
 * uploading them takes time.
 * ★ ONLY A TURN THIS LOOP OPENED IS SPOKEN. Restored history, an answer that
 * predates the toggle and a conversation loaded while listening stay silent,
 * as before; a typed send while voice chat is on gets a turn too.
 * ★ ONE STOP, MANY REASONS. Toggle off, unmount, the chat closing, the tab
 * going hidden, a chat error, a refused send, a failed microphone or
 * transcription and three empty transcripts in a row all end in `stop()`,
 * which cancels speech, closes the microphone and returns to idle; the
 * merchant-facing ones carry a short notice.
 */

export type MinkVoiceState =
  | "idle"
  | "listening"
  | "sending"
  | "waiting"
  | "speaking";

export type MinkVoiceMicState = "closed" | "starting" | "open" | "transcribing";

export type MinkVoiceStopReason =
  | "toggle"
  | "unmount"
  | "chat_closed"
  | "hidden"
  | "send_error"
  | "send_refused"
  | "transcription_failed"
  | "silence"
  | "mic";

/** Empty transcripts in a row before the loop gives up. */
export const MAX_EMPTY_TRANSCRIPTS = 3;
/**
 * Speech this soon after Mink's first word is the merchant finishing their
 * own sentence (or the speaker's first syllable reaching the mic), not an
 * interruption; the recorder disarms and keeps listening.
 */
export const MINK_BARGE_IN_GRACE_MS = 300;
/** How long a notice stays on screen. */
export const MINK_VOICE_NOTICE_MS = 5_000;
/** Said once, when Mink is caught interrupting itself through the speaker. */
export const MINK_ECHO_NOTICE =
  "Mink heard its own voice through your speaker, so it will finish speaking before it listens. Use headphones to interrupt Mink.";

export type MinkVoiceSupport = { ok: true } | { ok: false; reason: string };

const SERVER_SUPPORT: MinkVoiceSupport = {
  ok: false,
  reason: "Voice chat needs a browser.",
};

/** Whether this browser can run the loop at all; jsdom and SSR cannot. */
export function voiceChatSupport(): MinkVoiceSupport {
  if (typeof window === "undefined") return SERVER_SUPPORT;
  if (
    !("speechSynthesis" in window) ||
    !window.speechSynthesis ||
    typeof window.SpeechSynthesisUtterance === "undefined"
  )
    return {
      ok: false,
      reason: "Voice chat needs a browser that can read answers aloud.",
    };
  if (!window.isSecureContext)
    return { ok: false, reason: "Voice chat needs HTTPS." };
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext)
    return {
      ok: false,
      reason: "Voice chat needs a browser with microphone support.",
    };
  return { ok: true };
}

/**
 * Feature detection as an external store: the server snapshot says
 * unsupported so the markup matches on hydration, and the client re-reads on
 * each render. The same answer keeps the same object, which is what stops
 * useSyncExternalStore re-rendering for ever.
 */
let lastSupport: MinkVoiceSupport = SERVER_SUPPORT;
function readSupport(): MinkVoiceSupport {
  const next = voiceChatSupport();
  if (
    next.ok !== lastSupport.ok ||
    (!next.ok && !lastSupport.ok && next.reason !== lastSupport.reason)
  )
    lastSupport = next;
  return lastSupport;
}
const noSubscription = () => () => {};

export type MinkVoiceSendOptions = {
  voice: true;
  /**
   * The question carries the words of one cancelled while Mink was thinking:
   * it replaces that unanswered question in the thread instead of following
   * it.
   */
  replaceUnanswered?: boolean;
};

export type MinkVoiceModeInput = {
  messages: MinkMessage[];
  isReplying: boolean;
  isChatOpen: boolean;
  error: { code: string; message: string } | null;
  /** The spoken block of the reply in progress, as it streams. */
  spokenText: string;
  /** The spoken block has closed; the written answer follows. */
  spokenEnded: boolean;
  /**
   * Acknowledgements the reply has already said and kept (a short sentence
   * before a tool call), joined; grows within a reply, empty between them.
   */
  spokenKept?: string;
  /**
   * Send a transcript as a voice turn. False when the chat refused it (a
   * reply is still running, or the text is empty). A promise when it went
   * through the composer with a staged draft or attachments, which resolves
   * once they were uploaded and sent (or could not be).
   */
  send: (
    text: string,
    options: MinkVoiceSendOptions,
  ) => boolean | Promise<boolean>;
  /** Stop the reply in progress; the chat keeps the merchant's message only. */
  cancel: () => void;
  /** BCP-47 tag for Latin-script answers; the browser's own language in the dashboard. */
  langFallback?: string;
  /** Injected in tests. */
  createCapture?: () => MinkVoiceCapture;
  createSession?: typeof createMinkSpeechSession;
};

export type MinkVoiceMode = {
  enabled: boolean;
  state: MinkVoiceState;
  mic: MinkVoiceMicState;
  support: MinkVoiceSupport;
  /** A decaying peak of the microphone's loudness, for the waveform. */
  levelRef: RefObject<number>;
  /** The last thing Mink heard and sent. */
  heard: string | null;
  /** The sentence Mink is saying, or said last this turn. */
  said: string | null;
  /** A short message when the loop changed something on its own; clears itself. */
  notice: string | null;
  toggle: () => void;
  /** A typed send went out while voice chat is on: its answer is spoken too. */
  noteSend: () => void;
};

/**
 * Whether the answer's spoken block (the server's split, whitespace collapsed)
 * carries on from what streamed: the same block, not another one.
 */
function continuesSpoken(final: string, streamed: string): boolean {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  return flat(final).startsWith(flat(streamed));
}

type Turn = {
  session: MinkSpeechSession;
  /** Replaced when the turn reopens or its block turns out to be empty. */
  segmenter: MinkSpeechSegmenter;
  /** The spoken block is over (its end arrived having said something, or the answer landed). */
  closed: boolean;
  /** The written answer landed. */
  finalised: boolean;
  /** The session has played everything it was given. */
  idle: boolean;
  /** How much of `spokenKept` this turn has already taken in. */
  kept: number;
  /**
   * An acknowledgement played and the block with the answer has not started:
   * the session was ended so it can idle, and is reopened for the answer.
   */
  awaiting: boolean;
};

type Live = {
  enabled: boolean;
  state: MinkVoiceState;
  baselineIds: Set<string>;
  spokenIds: Set<string>;
  baselineError: MinkVoiceModeInput["error"];
  empties: number;
  /** Whether a read-aloud model is on; unknown until GET /api/mink/speech answers. */
  serverSpeech: "unknown" | "on" | "off";
  /**
   * Where model audio plays. ★ Created and resumed on the toggle click:
   * browsers (iOS above all) only let a page start audio from a user gesture,
   * and a context started there stays allowed for the voice chat.
   */
  audio: AudioContext | null;
  /** Bumped on every toggle on, so a late GET from an earlier session is ignored. */
  session: number;
  turn: Turn | null;
  /** A transcript waiting for the chat to be free. */
  pendingSend: string | null;
  /** The parked transcript replaces an unanswered question (`MinkVoiceSendOptions`). */
  pendingReplaces: boolean;
  /** A send that went through the composer and has not resolved yet. */
  sending: object | null;
  /** A send went out and the chat has not yet shown it replying. */
  replyPending: boolean;
  /**
   * The spoken question in flight, while speech may still cancel it: only a
   * plain voice question the loop sent itself. Null for a typed question and
   * for one that went out with a draft or attachments.
   */
  asked: string | null;
  /** The words of a question cancelled while Mink was thinking, asked again with the next transcript. */
  carry: string | null;
  captureAbort: AbortController | null;
  /** Bumped on every arm and stop, so a late transcript is inert. */
  captureId: number;
  /** The recorder reported speech during the current capture. */
  speechStarted: boolean;
  /** What the loop was doing when that speech began; only speech over Mink can be its echo. */
  speechFrom: MinkVoiceState | null;
  /** Mink's own voice came back as a question once: talking over it is off for this chat. */
  echoProne: boolean;
  /**
   * Mink's voice is held for speech that began over it, until the transcript
   * says whether the merchant said anything.
   */
  held: boolean;
  /** What the loop was doing when the voice was held, to go back to. */
  heldFrom: MinkVoiceState | null;
  /** The microphone for this voice chat; null while voice chat is off. */
  microphone: MinkVoiceCapture | null;
  /** The floor the recorder reads on every chunk. Swapped in place. */
  gate: { current: MinkSpeechGate };
  /** When the current answer's audio started, for the barge-in grace. */
  playingSince: number;
  /** What Mink said recently, for telling an echo from a question. */
  said: string;
  noticeTimer: ReturnType<typeof setTimeout> | null;
};

type Setters = {
  enabled(value: boolean): void;
  state(value: MinkVoiceState): void;
  mic(value: MinkVoiceMicState): void;
  heard(value: string | null): void;
  said(value: string | null): void;
  notice(value: string | null): void;
};

/** A context for model audio, or null where Web Audio is missing (jsdom). */
function startAudio(): AudioContext | null {
  try {
    const Context = window.AudioContext;
    if (typeof Context !== "function") return null;
    const audio = new Context();
    if (typeof audio.resume !== "function") return null;
    void audio.resume().catch(() => {});
    return audio;
  } catch {
    return null;
  }
}

/**
 * The loop itself, as one closure created once per provider: its methods
 * call one another freely (arm → transcript → send → arm), which a chain of
 * useCallbacks cannot express, and every one of them reads live state from
 * `l` rather than from a render's closure.
 */
function createVoiceLoop(deps: { input: MinkVoiceModeInput; set: Setters }) {
  const { set } = deps;
  // The newest props, refreshed by an effect on every render; and the
  // waveform's level, a plain holder the loop owns so the hook never hands a
  // React ref to code that runs during render.
  const latest = { current: deps.input };
  const levelRef = { current: 0 };
  const l: Live = {
    enabled: false,
    state: "idle",
    baselineIds: new Set(),
    spokenIds: new Set(),
    baselineError: null,
    empties: 0,
    serverSpeech: "unknown",
    audio: null,
    session: 0,
    turn: null,
    pendingSend: null,
    pendingReplaces: false,
    sending: null,
    replyPending: false,
    asked: null,
    carry: null,
    captureAbort: null,
    captureId: 0,
    speechStarted: false,
    speechFrom: null,
    echoProne: false,
    held: false,
    heldFrom: null,
    microphone: null,
    gate: { current: MINK_SPEECH_GATE },
    playingSince: 0,
    said: "",
    noticeTimer: null,
  };

  const setPhase = (next: MinkVoiceState) => {
    l.state = next;
    set.state(next);
  };

  const notice = (text: string) => {
    set.notice(text);
    if (l.noticeTimer) clearTimeout(l.noticeTimer);
    l.noticeTimer = setTimeout(() => {
      l.noticeTimer = null;
      set.notice(null);
    }, MINK_VOICE_NOTICE_MS);
  };

  /**
   * Closes the model-audio context. Called when voice chat stops, and as
   * soon as the platform says the browser voice reads: an open AudioContext
   * takes the audio session (iOS ducks other media for it), which is a poor
   * trade for a context nothing will ever play through.
   */
  const releaseAudio = () => {
    void l.audio?.close().catch(() => {});
    l.audio = null;
  };

  const dropTurn = () => {
    l.turn?.session.cancel();
    l.turn = null;
    l.held = false;
    l.heldFrom = null;
    l.gate.current = MINK_SPEECH_GATE;
  };

  const stop = (reason: MinkVoiceStopReason, text?: string) => {
    if (!l.enabled) return;
    l.enabled = false;
    l.captureId += 1;
    l.captureAbort?.abort();
    l.captureAbort = null;
    l.microphone?.close();
    l.microphone = null;
    dropTurn();
    l.pendingSend = null;
    l.pendingReplaces = false;
    l.sending = null;
    l.replyPending = false;
    l.asked = null;
    l.carry = null;
    l.speechStarted = false;
    l.speechFrom = null;
    releaseAudio();
    levelRef.current = 0;
    setPhase("idle");
    set.mic("closed");
    set.enabled(false);
    if (text && reason !== "toggle") notice(text);
  };

  /**
   * Speech began over Mink: its voice is held where it is, not stopped,
   * until the transcript says whether the merchant said anything.
   */
  const hold = () => {
    if (!l.turn) return;
    l.heldFrom = l.state;
    l.held = true;
    l.turn.session.pause();
  };

  /** The speech over Mink held no words: its voice carries on where it paused. */
  const release = () => {
    const turn = l.turn;
    const from = l.heldFrom;
    l.held = false;
    l.heldFrom = null;
    if (!turn) return;
    turn.session.resume();
    if (turn.idle) return;
    // The speaker's first syllable reaching the mic again is not an interruption.
    l.playingSince = Date.now();
    if (from === "speaking" || from === "waiting") setPhase(from);
  };

  /**
   * The merchant started talking over Mink. Its voice is held; the reply
   * keeps writing, and its answer, cards and drafts land in the chat as usual.
   *
   * ★★ ONLY A QUESTION MINK IS STILL THINKING ABOUT IS CANCELLED. Talking over
   * Mink's voice used to cancel the run too, and with the browser voice the
   * spoken block plays while the written answer is still being produced: one
   * "okay" over Mink, or Mink's own voice through the speaker, threw away the
   * answer and every draft it had prepared. While Mink is thinking, a spoken
   * question is cancelled (nothing is charged) and its words are carried into
   * the next transcript, because the merchant was usually not finished: a
   * pause mid-question ends a turn. A typed question, or one that went out
   * with a draft or attachments, is never cancelled by speech; the new words
   * wait for it to finish.
   */
  const interrupt = () => {
    const thinking =
      l.state === "waiting" && (latest.current.isReplying || l.replyPending);
    const asked = l.asked;
    l.asked = null;
    if (thinking && asked !== null) {
      dropTurn();
      l.carry = asked;
      l.replyPending = false;
      latest.current.cancel();
      return;
    }
    hold();
  };

  const enqueue = (turn: Turn, pieces: string[]) => {
    if (pieces.length && turn.awaiting) resumeTurn(turn);
    const fallback = latest.current.langFallback ?? DEFAULT_SPEECH_LANG;
    for (const piece of pieces)
      turn.session.enqueue(piece, speechLangFor(piece, fallback));
  };

  /** The answer after an acknowledgement has something to say: take pieces again. */
  const resumeTurn = (turn: Turn) => {
    turn.awaiting = false;
    turn.idle = false;
    turn.session.reopen();
  };

  /** Opens the speech session for the reply that was just sent. */
  const beginTurn = () => {
    dropTurn();
    l.empties = 0;
    l.replyPending = true;
    l.gate.current = MINK_BARGE_IN_GATE;
    // An echo is judged against this answer's words only: an earlier
    // answer's are not what is coming out of the speaker now.
    l.said = "";
    set.said(null);
    const createSession =
      latest.current.createSession ?? createMinkSpeechSession;
    const useModel = l.audio !== null && l.serverSpeech !== "off";
    const turn: Turn = {
      segmenter: createMinkSpeechSegmenter(),
      closed: false,
      finalised: false,
      idle: false,
      kept: 0,
      awaiting: false,
      session: null as unknown as MinkSpeechSession,
    };
    turn.session = createSession({
      audio: useModel ? l.audio : null,
      voice: useModel ? "model" : "browser",
      events: {
        onStart: () => {
          if (l.turn !== turn) return;
          l.playingSince = Date.now();
          // A reopened turn can start again after it went idle, when the
          // ordinary floor is back: Mink's voice must not trip it.
          l.gate.current = MINK_BARGE_IN_GATE;
          setPhase("speaking");
        },
        onPieceStart: (text) => {
          if (l.turn !== turn) return;
          l.said = `${l.said} ${text}`.slice(-600);
          set.said(text);
        },
        onIdle: () => {
          if (l.turn !== turn) return;
          turn.idle = true;
          if (turn.awaiting && !turn.finalised) {
            // The acknowledgement has played and the answer is still being
            // worked out: Mink is thinking, not finished. Speech now is
            // speech over a reply in progress, under the barge-in gate.
            l.gate.current = MINK_BARGE_IN_GATE;
            if (l.state === "speaking") setPhase("waiting");
            arm();
            return;
          }
          l.gate.current = MINK_SPEECH_GATE;
          if (turn.finalised) l.turn = null;
          if (l.serverSpeech === "off") releaseAudio();
          if (l.state === "speaking" || l.state === "waiting")
            setPhase(l.pendingSend ? "sending" : "listening");
          if (l.pendingSend) trySend();
          // The microphone may have closed on its own cap during a long answer.
          arm();
        },
        onNotice: (text) => {
          if (l.turn === turn) notice(text);
        },
        onVoiceOff: () => {
          if (l.turn === turn) l.serverSpeech = "off";
        },
      },
    });
    l.turn = turn;
    setPhase("waiting");
  };

  const trySend = () => {
    if (!l.enabled || !l.pendingSend || l.sending) return;
    if (latest.current.isReplying) return;
    const text = l.pendingSend;
    const replace = l.pendingReplaces;
    l.pendingSend = null;
    l.pendingReplaces = false;
    const session = l.session;
    const settle = (taken: boolean, asked: string | null) => {
      if (!l.enabled || session !== l.session) return;
      if (!taken) {
        stop(
          "send_refused",
          "Voice chat turned off: the message could not be sent.",
        );
        return;
      }
      beginTurn();
      l.asked = asked;
      // A send through the composer resolves after its upload, by which time
      // the chat may already show the reply running.
      if (latest.current.isReplying) l.replyPending = false;
      arm();
    };
    const result = latest.current.send(
      text,
      replace ? { voice: true, replaceUnanswered: true } : { voice: true },
    );
    if (typeof result === "boolean") {
      settle(result, text);
      return;
    }
    const token = {};
    l.sending = token;
    const done = (taken: boolean) => {
      if (l.sending === token) l.sending = null;
      // It carried a draft or attachments: speech never withdraws it.
      settle(taken, null);
    };
    void result.then(done, () => done(false));
  };

  /** The recorder reached its speech floor; may it start a turn now? */
  const onSpeechStart = (id: number): boolean => {
    if (!l.enabled || id !== l.captureId) return false;
    switch (l.state) {
      case "listening":
        l.speechFrom = "listening";
        l.speechStarted = true;
        return true;
      case "speaking":
        // The speaker reaches the microphone here: Mink finishes first.
        if (l.echoProne) return false;
        if (Date.now() - l.playingSince < MINK_BARGE_IN_GRACE_MS) return false;
        l.speechFrom = "speaking";
        interrupt();
        setPhase("listening");
        l.speechStarted = true;
        return true;
      case "waiting":
        l.speechFrom = "waiting";
        interrupt();
        setPhase("listening");
        l.speechStarted = true;
        return true;
      default:
        return false;
    }
  };

  /** Park a transcript for the chat, and send it at once if the chat is free. */
  const queueSend = (text: string, replace: boolean) => {
    l.pendingSend = text;
    l.pendingReplaces = replace;
    set.heard(text);
    setPhase("sending");
    trySend();
  };

  const onTranscript = (text: string | null, id: number) => {
    if (id !== l.captureId) return;
    l.captureAbort = null;
    set.mic("closed");
    if (!l.enabled) return;
    const heard = (text ?? "").trim();
    // ★ Only speech that began over Mink's voice can be that voice coming
    // back. Compared after Mink finished, a reply that reuses its words
    // ("keep it as a draft") was dropped as an echo, and three in a row
    // switched voice chat off as "nothing was heard".
    const echo =
      heard !== "" &&
      l.speechFrom === "speaking" &&
      isEchoTranscript(heard, l.said);
    if (echo && !l.echoProne) {
      l.echoProne = true;
      notice(MINK_ECHO_NOTICE);
    }
    const carried = l.carry;
    l.carry = null;
    if (!heard || echo) {
      // The burst that cancelled a question while Mink was thinking said
      // nothing (a cough, a door): ask the question again, not nothing.
      if (carried !== null) {
        queueSend(carried, true);
        return;
      }
      // ★ The burst over Mink's voice said nothing (a cough, a door, Mink's
      // own voice through the speaker): Mink carries on where it paused.
      if (l.held) {
        release();
        arm();
        return;
      }
      // Silence while listening counts; the recorder's own cap closing an
      // open mic during a long answer does not, and nor does an echo, which
      // is Mink's voice and not a merchant who went quiet.
      if (!echo && (l.speechStarted || l.state === "listening")) {
        l.empties += 1;
        if (l.empties >= MAX_EMPTY_TRANSCRIPTS) {
          stop("silence", "Voice chat turned off: nothing was heard.");
          return;
        }
      }
      arm();
      return;
    }
    // The merchant said something: the voice they talked over ends for good.
    if (l.held) dropTurn();
    l.empties = 0;
    queueSend(
      carried !== null ? `${carried} ${heard}` : heard,
      carried !== null,
    );
  };

  const onCaptureError = (error: unknown, id: number) => {
    if (id !== l.captureId) return;
    l.captureAbort = null;
    set.mic("closed");
    if (!l.enabled) return;
    if ((error as { name?: unknown } | null)?.name === "AbortError") return;
    if (
      error instanceof MinkVoiceCaptureError &&
      error.kind === "transcription"
    )
      stop("transcription_failed", `${error.message} Voice chat turned off.`);
    else stop("mic", "Voice chat turned off: the microphone could not start.");
  };

  /** Starts listening on the chat's microphone unless it already is. */
  const arm = () => {
    const microphone = l.microphone;
    if (!l.enabled || l.captureAbort || !microphone) return;
    const controller = new AbortController();
    const id = ++l.captureId;
    l.captureAbort = controller;
    l.speechStarted = false;
    l.speechFrom = null;
    levelRef.current = 0;
    set.mic("starting");
    microphone
      .capture({
        signal: controller.signal,
        gate: l.gate,
        onLevel: (level) => {
          levelRef.current = Math.max(level, levelRef.current * 0.9);
        },
        onSpeechStart: () => onSpeechStart(id),
        onPhase: (phase) => {
          if (id === l.captureId) set.mic(phase);
        },
      })
      .then(
        (text) => onTranscript(text, id),
        (error: unknown) => onCaptureError(error, id),
      );
  };

  const toggle = () => {
    if (l.enabled) {
      stop("toggle");
      return;
    }
    const check = voiceChatSupport();
    if (!check.ok) {
      notice(check.reason);
      return;
    }
    const { messages, error } = latest.current;
    // Whatever turned the last session off is history now, and "Voice chat
    // turned off" under "Listening…" reads as the new session failing.
    if (l.noticeTimer) clearTimeout(l.noticeTimer);
    l.noticeTimer = null;
    set.notice(null);
    l.enabled = true;
    l.baselineIds = new Set(messages.map((message) => String(message.id)));
    l.spokenIds = new Set();
    l.baselineError = error;
    l.empties = 0;
    l.said = "";
    l.pendingSend = null;
    l.pendingReplaces = false;
    l.sending = null;
    l.replyPending = false;
    l.asked = null;
    l.carry = null;
    l.echoProne = false;
    l.held = false;
    l.heldFrom = null;
    l.gate.current = MINK_SPEECH_GATE;
    l.microphone = (latest.current.createCapture ?? createMinkVoiceCapture)();
    l.audio = startAudio();
    l.serverSpeech = "unknown";
    const session = ++l.session;
    // Asked now, while the merchant is still speaking, so the first answer
    // already knows which voice to use. An answer that arrives after this
    // session ended (toggled off and on again) must not decide for the next.
    const settle = (on: boolean) => {
      if (session !== l.session || l.serverSpeech !== "unknown") return;
      l.serverSpeech = on ? "on" : "off";
      if (!on && !l.turn) releaseAudio();
    };
    void fetch("/api/mink/speech", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { enabled?: unknown } | null) =>
        settle(data?.enabled === true),
      )
      .catch(() => settle(false));
    set.enabled(true);
    set.heard(null);
    set.said(null);
    setPhase("listening");
    arm();
  };

  /**
   * A typed (or Home-box, or card) send while voice chat is on: its answer is
   * spoken too. ★ It never cancels anything: the chat has already started the
   * new run, so a cancel here would stop the question just asked.
   */
  const noteSend = () => {
    if (!l.enabled) return;
    dropTurn();
    l.pendingSend = null;
    l.pendingReplaces = false;
    l.carry = null;
    set.heard(null);
    beginTurn();
    l.asked = null;
    arm();
  };

  /**
   * The block the turn closed on was withdrawn: the run spoke a sentence and
   * then called a tool. The answer comes in another block, so the turn takes
   * pieces again, from a fresh segmenter, through the same session.
   */
  const reopenTurn = (turn: Turn) => {
    turn.session.dropPending();
    turn.segmenter = createMinkSpeechSegmenter();
    turn.closed = false;
    turn.idle = false;
    turn.session.reopen();
    // Back to thinking, unless the merchant has already started talking.
    if (l.state === "listening" && !l.speechStarted && !l.pendingSend) {
      l.gate.current = MINK_BARGE_IN_GATE;
      setPhase("waiting");
    }
  };

  /** The block closed: its tail plays and the session ends after it. */
  const closeBlock = (turn: Turn) => {
    const tail = turn.segmenter.close();
    if (!turn.segmenter.spoke) {
      // An empty block (or one with nothing speakable): the turn stays open,
      // so the written answer is read when it lands, as for a reply with no
      // block at all. A fresh segmenter keeps taking text if it is withdrawn.
      turn.segmenter = createMinkSpeechSegmenter();
      return;
    }
    turn.closed = true;
    enqueue(turn, tail);
    turn.session.end();
  };

  /**
   * The run kept the block as an acknowledgement (a tool call follows it):
   * it plays to its end, nothing is withdrawn, and the turn waits for the
   * block with the answer. ★ `said` is the server's own text for the block,
   * because the events around a tool call can reach this loop in one render
   * and its close may never have been seen here.
   */
  const keepBlock = (turn: Turn, said: string) => {
    if (!turn.closed) enqueue(turn, turn.segmenter.close(said));
    const spoke = turn.segmenter.spoke;
    turn.segmenter = createMinkSpeechSegmenter();
    turn.closed = false;
    if (!spoke) return;
    turn.awaiting = true;
    turn.session.end();
    // Already played out before the run said it was keeping it: Mink is
    // still thinking, unless the merchant has started talking.
    if (
      turn.idle &&
      l.state === "listening" &&
      !l.speechStarted &&
      !l.pendingSend
    ) {
      l.gate.current = MINK_BARGE_IN_GATE;
      setPhase("waiting");
    }
  };

  /** The chat stream moved: feed the open turn, or notice that it ended. */
  const onChat = (input: {
    messages: MinkMessage[];
    isReplying: boolean;
    spokenText: string;
    spokenEnded: boolean;
    spokenKept?: string;
  }) => {
    if (!l.enabled) return;
    const { messages, isReplying, spokenText, spokenEnded } = input;
    const spokenKept = input.spokenKept ?? "";
    if (isReplying) l.replyPending = false;
    const turn = l.turn;
    if (turn && !turn.finalised) {
      // (0) An acknowledgement was kept: it is said, and the next block is
      // the answer. First, because the answer may have landed in the same
      // render, and it must play after the acknowledgement.
      if (spokenKept.length > turn.kept) {
        keepBlock(turn, spokenKept.slice(turn.kept).trim());
        turn.kept = spokenKept.length;
      }
      const last = messages[messages.length - 1];
      const id = last ? String(last.id) : null;
      if (
        last &&
        id &&
        last.role === "assistant" &&
        !l.baselineIds.has(id) &&
        !l.spokenIds.has(id)
      ) {
        // (1) The written answer landed: whatever spoken text is left plays,
        // and a reply with no spoken block at all is read from the answer.
        l.spokenIds.add(id);
        turn.finalised = true;
        l.replyPending = false;
        // ★ The question is answered, so nothing is left to cancel or carry.
        // The reply stream is still closing here (isReplying stays true until
        // it does), and speech in that moment used to cancel the answered
        // run and send the answered question again, joined to the new words:
        // the thread then showed the question twice.
        l.asked = null;
        // After an acknowledgement the session is open again for whatever
        // the answer says, even nothing: ending it then still idles the turn.
        if (turn.awaiting) resumeTurn(turn);
        // ★ The block the turn closed on is not this answer's: it was an
        // acknowledgement whose keep (`spokenKept`) arrived in the same render
        // as the answer, which clears it, so case (0) never saw it. It plays
        // on, and the answer's own block is read after it; without this the
        // turn stayed closed and the answer was never said.
        if (
          turn.closed &&
          last.spoken &&
          !continuesSpoken(last.spoken, turn.segmenter.seen)
        ) {
          turn.segmenter = createMinkSpeechSegmenter();
          turn.closed = false;
          resumeTurn(turn);
        }
        if (!turn.closed) {
          turn.closed = true;
          let tail = turn.segmenter.close(last.spoken ?? undefined);
          if (!turn.segmenter.spoke && tail.length === 0)
            tail = splitSpeechChunks(speakableMinkText(last.text));
          enqueue(turn, tail);
          turn.session.end();
        }
        if (turn.idle) l.turn = null;
      } else if (!isReplying && !l.replyPending) {
        // (3) The run ended without an answer: cancelled, or it failed.
        dropTurn();
        if (l.state === "waiting" || l.state === "speaking")
          setPhase(l.pendingSend ? "sending" : "listening");
      } else {
        // ★ A closed block whose text is no longer there was withdrawn by
        // the run (a tool call follows): reopen for the block with the
        // answer. The text clearing once the answer lands is case (1), and
        // once the run has ended, case (3); neither reaches here.
        if (turn.closed && !spokenText.startsWith(turn.segmenter.seen))
          reopenTurn(turn);
        if (!turn.closed) {
          // (2) The spoken block is streaming. ★ It ends at its own close
          // tag: written text arriving first (even a newline before the
          // block) used to close the turn on its first sentence.
          const { pieces, reset } = turn.segmenter.push(spokenText);
          if (reset) turn.session.dropPending();
          enqueue(turn, pieces);
          if (spokenEnded) closeBlock(turn);
        }
      }
    }
    if (!isReplying && l.pendingSend) trySend();
  };

  const onError = (error: MinkVoiceModeInput["error"]) => {
    if (l.enabled && error && error !== l.baselineError)
      stop("send_error", "Voice chat turned off after an error.");
  };

  const destroy = () => {
    stop("unmount");
    if (l.noticeTimer) clearTimeout(l.noticeTimer);
    l.noticeTimer = null;
  };

  const setInput = (input: MinkVoiceModeInput) => {
    latest.current = input;
  };

  return {
    toggle,
    noteSend,
    stop,
    onChat,
    onError,
    destroy,
    setInput,
    levelRef,
  };
}

export function useMinkVoiceMode(input: MinkVoiceModeInput): MinkVoiceMode {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<MinkVoiceState>("idle");
  const [mic, setMic] = useState<MinkVoiceMicState>("closed");
  const [heard, setHeard] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loop] = useState(() =>
    createVoiceLoop({
      input,
      set: {
        enabled: setEnabled,
        state: setState,
        mic: setMic,
        heard: setHeard,
        said: setSaid,
        notice: setNotice,
      },
    }),
  );
  const support = useSyncExternalStore(
    noSubscription,
    readSupport,
    () => SERVER_SUPPORT,
  );

  // Declared first: the effects below read the newest props through the loop.
  useEffect(() => {
    loop.setInput(input);
  });

  // The chat's stream is the external system here: these effects react to
  // it the way a subscription callback would, so the loop's phase moves in
  // step with spoken text arriving, an answer landing or a send failing.
  const { messages, isReplying, isChatOpen, error } = input;
  const { spokenText, spokenEnded, spokenKept } = input;
  useEffect(() => {
    loop.onChat({ messages, isReplying, spokenText, spokenEnded, spokenKept });
  }, [loop, messages, isReplying, spokenText, spokenEnded, spokenKept]);

  useEffect(() => {
    if (!isChatOpen) loop.stop("chat_closed");
  }, [isChatOpen, loop]);

  useEffect(() => {
    loop.onError(error);
  }, [error, loop]);

  useEffect(() => {
    if (!enabled) return;
    const hide = () => {
      if (document.hidden)
        loop.stop("hidden", "Voice chat turned off while the tab was hidden.");
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [enabled, loop]);

  useEffect(() => () => loop.destroy(), [loop]);

  return useMemo(
    () => ({
      enabled,
      state,
      mic,
      support,
      levelRef: loop.levelRef,
      heard,
      said,
      notice,
      toggle: loop.toggle,
      noteSend: loop.noteSend,
    }),
    [enabled, state, mic, support, heard, said, notice, loop],
  );
}
