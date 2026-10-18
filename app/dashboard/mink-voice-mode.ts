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
  captureMinkVoiceTurn,
  MinkVoiceCaptureError,
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
 * It owns the microphone (`captureMinkVoiceTurn`), the sentence segmenter and
 * the speech session for the current answer; the chat client supplies the
 * stream (`spokenText`, `spokenEnded`, `streamingText`, `messages`) and the
 * two verbs, `send` and `cancel`.
 *
 * ★ MINK SPEAKS WHILE IT IS STILL WRITING. A voice turn's reply opens with a
 * spoken block that the stream route forwards fragment by fragment; each
 * completed sentence is handed to the speech session the moment it ends, so
 * the first words play a second or two after Mink starts answering and the
 * loop is back to listening while the written answer and its cards are still
 * arriving in the chat.
 * ★ THE MICROPHONE IS OPEN FOR THE WHOLE TURN. The recorder is re-armed the
 * instant a transcript is sent, with a stricter gate while Mink is thinking
 * or talking (`MINK_BARGE_IN_GATE`, swapped in place so the recorder reads it
 * without restarting). Speech over Mink's voice stops the playback and, while
 * Mink is still thinking, cancels the unfinished reply; the words become the
 * next turn. A cancelled run is not charged.
 * ★ A TRANSCRIPT WAITS FOR THE CHAT TO BE FREE. `send` refuses while a reply
 * is running, and a cancelled reply stays "replying" until its stream has
 * closed, so a transcript is parked in `pendingSend` and sent from the effect
 * that sees `isReplying` fall. The slot is cleared BEFORE `send`, so the
 * effect and a direct call cannot send it twice.
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

export type MinkVoiceModeInput = {
  messages: MinkMessage[];
  isReplying: boolean;
  isChatOpen: boolean;
  error: { code: string; message: string } | null;
  /** The spoken block of the reply in progress, as it streams. */
  spokenText: string;
  /** The spoken block has closed; the written answer follows. */
  spokenEnded: boolean;
  /** The written answer so far. */
  streamingText: string;
  /**
   * Send a transcript as a voice turn. False when the chat refused it (a
   * reply is still running, or the text is empty).
   */
  send: (text: string, options: { voice: true }) => boolean;
  /** Stop the reply in progress; the chat keeps the merchant's message only. */
  cancel: () => void;
  /** BCP-47 tag for Latin-script answers; the browser's own language in the dashboard. */
  langFallback?: string;
  /** Injected in tests. */
  capture?: typeof captureMinkVoiceTurn;
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

type Turn = {
  session: MinkSpeechSession;
  segmenter: MinkSpeechSegmenter;
  /** The spoken block is over (its end arrived, or the written answer did). */
  closed: boolean;
  /** The written answer landed. */
  finalised: boolean;
  /** The session has played everything it was given. */
  idle: boolean;
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
  /** A send went out and the chat has not yet shown it replying. */
  replyPending: boolean;
  captureAbort: AbortController | null;
  /** Bumped on every arm and stop, so a late transcript is inert. */
  captureId: number;
  /** The recorder reported speech during the current capture. */
  speechStarted: boolean;
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
    replyPending: false,
    captureAbort: null,
    captureId: 0,
    speechStarted: false,
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
    l.gate.current = MINK_SPEECH_GATE;
  };

  const stop = (reason: MinkVoiceStopReason, text?: string) => {
    if (!l.enabled) return;
    l.enabled = false;
    l.captureId += 1;
    l.captureAbort?.abort();
    l.captureAbort = null;
    dropTurn();
    l.pendingSend = null;
    l.replyPending = false;
    l.speechStarted = false;
    releaseAudio();
    levelRef.current = 0;
    setPhase("idle");
    set.mic("closed");
    set.enabled(false);
    if (text && reason !== "toggle") notice(text);
  };

  /**
   * The merchant started talking over Mink: playback stops, and a reply
   * still being produced is cancelled (its stream closes with no answer, and
   * nothing is charged). A reply whose answer has already landed is left to
   * finish writing; only its voice is cut.
   */
  const interrupt = () => {
    const unfinished =
      (l.state === "waiting" || l.state === "speaking") &&
      (latest.current.isReplying || l.replyPending);
    dropTurn();
    if (unfinished) latest.current.cancel();
    l.replyPending = false;
  };

  const enqueue = (turn: Turn, pieces: string[]) => {
    const fallback = latest.current.langFallback ?? DEFAULT_SPEECH_LANG;
    for (const piece of pieces)
      turn.session.enqueue(piece, speechLangFor(piece, fallback));
  };

  /** Opens the speech session for the reply that was just sent. */
  const beginTurn = () => {
    dropTurn();
    l.empties = 0;
    l.replyPending = true;
    l.gate.current = MINK_BARGE_IN_GATE;
    set.said(null);
    const createSession =
      latest.current.createSession ?? createMinkSpeechSession;
    const useModel = l.audio !== null && l.serverSpeech !== "off";
    const turn: Turn = {
      segmenter: createMinkSpeechSegmenter(),
      closed: false,
      finalised: false,
      idle: false,
      session: null as unknown as MinkSpeechSession,
    };
    turn.session = createSession({
      audio: useModel ? l.audio : null,
      voice: useModel ? "model" : "browser",
      events: {
        onStart: () => {
          if (l.turn !== turn) return;
          l.playingSince = Date.now();
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
    if (!l.enabled || !l.pendingSend || latest.current.isReplying) return;
    const text = l.pendingSend;
    l.pendingSend = null;
    if (!latest.current.send(text, { voice: true })) {
      stop(
        "send_refused",
        "Voice chat turned off: the message could not be sent.",
      );
      return;
    }
    beginTurn();
    arm();
  };

  /** The recorder reached its speech floor; may it start a turn now? */
  const onSpeechStart = (id: number): boolean => {
    if (!l.enabled || id !== l.captureId) return false;
    switch (l.state) {
      case "listening":
        l.speechStarted = true;
        return true;
      case "speaking":
        if (Date.now() - l.playingSince < MINK_BARGE_IN_GRACE_MS) return false;
        interrupt();
        setPhase("listening");
        l.speechStarted = true;
        return true;
      case "waiting":
        interrupt();
        setPhase("listening");
        l.speechStarted = true;
        return true;
      default:
        return false;
    }
  };

  const onTranscript = (text: string | null, id: number) => {
    if (id !== l.captureId) return;
    l.captureAbort = null;
    set.mic("closed");
    if (!l.enabled) return;
    const heard = (text ?? "").trim();
    if (!heard || isEchoTranscript(heard, l.said)) {
      // Silence while listening counts; the recorder's own cap closing an
      // open mic during a long answer does not.
      if (l.speechStarted || l.state === "listening") {
        l.empties += 1;
        if (l.empties >= MAX_EMPTY_TRANSCRIPTS) {
          stop("silence", "Voice chat turned off: nothing was heard.");
          return;
        }
      }
      arm();
      return;
    }
    l.empties = 0;
    l.pendingSend = heard;
    set.heard(heard);
    setPhase("sending");
    trySend();
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

  /** Opens the microphone unless it is already open. */
  const arm = () => {
    if (!l.enabled || l.captureAbort) return;
    const controller = new AbortController();
    const id = ++l.captureId;
    l.captureAbort = controller;
    l.speechStarted = false;
    levelRef.current = 0;
    set.mic("starting");
    const capture = latest.current.capture ?? captureMinkVoiceTurn;
    capture({
      signal: controller.signal,
      gate: l.gate,
      onLevel: (level) => {
        levelRef.current = Math.max(level, levelRef.current * 0.9);
      },
      onSpeechStart: () => onSpeechStart(id),
      onPhase: (phase) => {
        if (id === l.captureId) set.mic(phase);
      },
    }).then(
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
    l.enabled = true;
    l.baselineIds = new Set(messages.map((message) => String(message.id)));
    l.spokenIds = new Set();
    l.baselineError = error;
    l.empties = 0;
    l.said = "";
    l.pendingSend = null;
    l.replyPending = false;
    l.gate.current = MINK_SPEECH_GATE;
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

  const noteSend = () => {
    if (!l.enabled) return;
    interrupt();
    l.pendingSend = null;
    set.heard(null);
    beginTurn();
    arm();
  };

  /** The chat stream moved: feed the open turn, or notice that it ended. */
  const onChat = (input: {
    messages: MinkMessage[];
    isReplying: boolean;
    spokenText: string;
    spokenEnded: boolean;
    streamingText: string;
  }) => {
    if (!l.enabled) return;
    const { messages, isReplying, spokenText, spokenEnded, streamingText } =
      input;
    if (isReplying) l.replyPending = false;
    const turn = l.turn;
    if (turn && !turn.finalised) {
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
      } else if (!turn.closed) {
        // (2) The spoken block is streaming.
        const { pieces, reset } = turn.segmenter.push(spokenText);
        if (reset) turn.session.dropPending();
        enqueue(turn, pieces);
        if (spokenEnded || (streamingText && turn.segmenter.seen)) {
          turn.closed = true;
          enqueue(turn, turn.segmenter.close());
          turn.session.end();
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
  const { spokenText, spokenEnded, streamingText } = input;
  useEffect(() => {
    loop.onChat({
      messages,
      isReplying,
      spokenText,
      spokenEnded,
      streamingText,
    });
  }, [loop, messages, isReplying, spokenText, spokenEnded, streamingText]);

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
