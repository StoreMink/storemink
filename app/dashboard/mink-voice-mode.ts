"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  DEFAULT_SPEECH_LANG,
  speakableMinkText,
  speechLangFor,
} from "@/lib/mink/speech-text";
import type { MinkMessage } from "./mink-ai";
import { playMinkServerSpeech, silentWavUrl } from "./mink-speech-player";

/**
 * The hands-free voice loop behind the composer's "Talk with Mink" toggle.
 *
 * The composer keeps owning the microphone: `listen()` is its existing
 * dictation (the recorder plus /api/mink/voice), `send()` is its existing
 * submit path (so limits and attachments apply), and it reports each final
 * transcript here. This hook owns everything in between: the state machine,
 * speaking the newest answer, re-arming the mic when speech ends, and the
 * conditions that stop the loop.
 *
 * ★ TWO VOICES. When the operator has a read-aloud model switched on
 * (Gemini 3.8 Flash-Lite TTS or Sarvam Bulbul V4 Flash, asked once through
 * GET /api/mink/speech as the mode turns on), answers are played through one
 * audio element unlocked by the toggle click; otherwise, and for whatever a
 * model could not play, the browser's own window.speechSynthesis reads them.
 *
 * ★ ONLY A REPLY TO SOMETHING SENT WHILE THE MODE WAS ON IS SPOKEN. Toggling
 * on records every message id present; a message is spoken only when it is
 * an assistant message, Mink has finished replying, the loop is waiting for
 * an answer, and the id is neither in that baseline nor already spoken. So
 * restored history, an error, or an answer that predates the toggle is never
 * read aloud, and a conversation loaded while the mode is on stays silent.
 * ★ THE SPEAK TOKEN MAKES CANCELLATION QUIET. speechSynthesis.cancel() fires
 * the cancelled utterance's end/error handler, which would re-arm the mic
 * exactly when the loop had been told to stop or had just started a new send.
 * Every speak bumps a token and every handler checks it, so a stale utterance
 * cannot act. The arm token does the same for a listen() still starting.
 * ★ ONE STOP, MANY REASONS. Toggle off, unmount, the chat closing, the tab
 * going hidden, a send error, a refused send and three consecutive empty
 * transcripts all end in `stop()`, which cancels speech, aborts the mic and
 * returns to idle; the merchant-facing ones carry a short notice.
 */

export type MinkVoiceState =
  | "idle"
  | "listening"
  | "sending"
  | "waiting"
  | "speaking";

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
 * A synthesiser that never fires `end` (Chrome's remote voices are known to
 * fall silent on long text) would leave the loop in `speaking` for ever, so a
 * watchdog sized to the text treats a missing end event as the end.
 */
export function speechWatchdogMs(text: string): number {
  return Math.min(120_000, 8_000 + text.length * 90);
}

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
  /** Start the microphone (the composer's dictation). Resolves false when it could not start. */
  listen: () => Promise<boolean>;
  /** Abort a recording or transcription in progress. */
  stopListening: () => void;
  /** Send a final transcript through the composer's submit path. Resolves false when refused. */
  send: (text: string) => Promise<boolean>;
  /** A short message for the merchant when the loop stops on its own. */
  onNotice?: (text: string) => void;
  /** BCP-47 tag for Latin-script answers; the browser's own language in the dashboard. */
  langFallback?: string;
};

export type MinkVoiceMode = {
  enabled: boolean;
  state: MinkVoiceState;
  support: MinkVoiceSupport;
  toggle: () => void;
  /** The composer reports each final transcript; null or blank means nothing was heard. */
  reportTranscript: (text: string | null) => void;
  /** The composer reports a transcription that failed; the loop stops with the error already shown. */
  reportTranscriptionFailure: () => void;
  /** The composer reports a send it made itself (typed): speech stops and the reply will be spoken. */
  noteSend: () => void;
};

type Live = {
  enabled: boolean;
  state: MinkVoiceState;
  baselineIds: Set<string>;
  spokenIds: Set<string>;
  baselineError: MinkVoiceModeInput["error"];
  empties: number;
  armToken: number;
  speakToken: number;
  watchdog: ReturnType<typeof setTimeout> | null;
  utterance: SpeechSynthesisUtterance | null;
  /** Whether a read-aloud model is on; unknown until GET /api/mink/speech answers. */
  serverSpeech: "unknown" | "on" | "off";
  /** The one element model audio plays through, unlocked by the toggle click. */
  player: HTMLAudioElement | null;
  speechAbort: AbortController | null;
};

let silentUrl: string | null = null;

/**
 * Starts the audio element on the user's click so later answers may play.
 * jsdom and old browsers have no object URLs or playable audio; then the
 * browser voice simply does all the reading.
 */
function unlockPlayer(player: HTMLAudioElement) {
  if (typeof URL.createObjectURL !== "function") return;
  try {
    silentUrl ??= silentWavUrl();
    player.src = silentUrl;
    const started = player.play() as Promise<void> | undefined;
    if (started && typeof started.catch === "function") started.catch(() => {});
  } catch {
    // Not unlocked: a later play() is refused and the browser voice reads.
  }
}

export function useMinkVoiceMode(input: MinkVoiceModeInput): MinkVoiceMode {
  const latest = useRef(input);
  const live = useRef<Live>({
    enabled: false,
    state: "idle",
    baselineIds: new Set(),
    spokenIds: new Set(),
    baselineError: null,
    empties: 0,
    armToken: 0,
    speakToken: 0,
    watchdog: null,
    utterance: null,
    serverSpeech: "unknown",
    player: null,
    speechAbort: null,
  });
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<MinkVoiceState>("idle");
  const support = useSyncExternalStore(
    noSubscription,
    readSupport,
    () => SERVER_SUPPORT,
  );

  useEffect(() => {
    latest.current = input;
  });

  const setPhase = useCallback((next: MinkVoiceState) => {
    live.current.state = next;
    setState(next);
  }, []);

  const cancelSpeech = useCallback(() => {
    const l = live.current;
    l.speakToken += 1;
    if (l.watchdog) clearTimeout(l.watchdog);
    l.watchdog = null;
    l.utterance = null;
    l.speechAbort?.abort();
    l.speechAbort = null;
    l.player?.pause();
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  }, []);

  const stop = useCallback(
    (reason: MinkVoiceStopReason, notice?: string) => {
      const l = live.current;
      if (!l.enabled) return;
      l.enabled = false;
      l.armToken += 1;
      cancelSpeech();
      latest.current.stopListening();
      setPhase("idle");
      setEnabled(false);
      if (notice && reason !== "toggle") latest.current.onNotice?.(notice);
    },
    [cancelSpeech, setPhase],
  );

  const arm = useCallback(async () => {
    const l = live.current;
    if (!l.enabled) return;
    const token = ++l.armToken;
    setPhase("listening");
    let started = false;
    try {
      started = await latest.current.listen();
    } catch {
      started = false;
    }
    if (!l.enabled || token !== l.armToken) return;
    if (!started)
      stop("mic", "Voice chat turned off: the microphone could not start.");
  }, [setPhase, stop]);

  /** The browser's own voice: the fallback, and the voice when no model is on. */
  const speakWithBrowser = useCallback(
    (text: string, lang: string, token: number) => {
      const l = live.current;
      const synth =
        typeof window !== "undefined" ? window.speechSynthesis : undefined;
      if (
        !text ||
        !synth ||
        typeof window.SpeechSynthesisUtterance === "undefined"
      ) {
        void arm();
        return;
      }
      if (l.watchdog) clearTimeout(l.watchdog);
      synth.cancel();
      const utterance = new window.SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      const finish = () => {
        if (token !== l.speakToken || !l.enabled) return;
        if (l.watchdog) clearTimeout(l.watchdog);
        l.watchdog = null;
        l.utterance = null;
        void arm();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      // Chrome drops end events for an utterance nothing references.
      l.utterance = utterance;
      l.watchdog = setTimeout(() => {
        if (token !== l.speakToken) return;
        synth.cancel();
        finish();
      }, speechWatchdogMs(text));
      setPhase("speaking");
      synth.speak(utterance);
    },
    [arm, setPhase],
  );

  const speak = useCallback(
    (markdown: string) => {
      const l = live.current;
      const text = speakableMinkText(markdown);
      if (!text) {
        void arm();
        return;
      }
      const token = ++l.speakToken;
      if (l.watchdog) clearTimeout(l.watchdog);
      l.watchdog = null;
      l.speechAbort?.abort();
      const lang = speechLangFor(
        text,
        latest.current.langFallback ?? DEFAULT_SPEECH_LANG,
      );
      if (l.serverSpeech !== "on" || !l.player) {
        speakWithBrowser(text, lang, token);
        return;
      }
      // "Thinking…" until the first audio is ready, then "Speaking…".
      const controller = new AbortController();
      l.speechAbort = controller;
      void playMinkServerSpeech({
        text,
        lang,
        player: l.player,
        signal: controller.signal,
        onStart: () => {
          if (token === l.speakToken && l.enabled) setPhase("speaking");
        },
      }).then((result) => {
        if (token !== l.speakToken || !l.enabled) return;
        if (l.speechAbort === controller) l.speechAbort = null;
        if (result.outcome === "cancelled") return;
        if (result.outcome === "done") {
          void arm();
          return;
        }
        if (result.outcome === "off") l.serverSpeech = "off";
        speakWithBrowser(result.remaining, lang, token);
      });
    },
    [arm, setPhase, speakWithBrowser],
  );

  const toggle = useCallback(() => {
    const l = live.current;
    if (l.enabled) {
      stop("toggle");
      return;
    }
    const check = voiceChatSupport();
    if (!check.ok) {
      latest.current.onNotice?.(check.reason);
      return;
    }
    const { messages, error } = latest.current;
    l.enabled = true;
    l.baselineIds = new Set(messages.map((message) => String(message.id)));
    l.spokenIds = new Set();
    l.baselineError = error;
    l.empties = 0;
    if (!l.player && typeof window.Audio === "function") {
      try {
        l.player = new window.Audio();
      } catch {
        l.player = null;
      }
    }
    if (l.player) unlockPlayer(l.player);
    l.serverSpeech = "unknown";
    // Asked now, while the merchant is still speaking, so the first answer
    // already knows which voice to use.
    void fetch("/api/mink/speech", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { enabled?: unknown } | null) => {
        if (l.serverSpeech === "unknown")
          l.serverSpeech = data?.enabled === true ? "on" : "off";
      })
      .catch(() => {
        if (l.serverSpeech === "unknown") l.serverSpeech = "off";
      });
    setEnabled(true);
    void arm();
  }, [arm, stop]);

  const reportTranscript = useCallback(
    (text: string | null) => {
      const l = live.current;
      if (!l.enabled || l.state !== "listening") return;
      const spoken = (text ?? "").trim();
      if (!spoken) {
        l.empties += 1;
        if (l.empties >= MAX_EMPTY_TRANSCRIPTS) {
          stop("silence", "Voice chat turned off: nothing was heard.");
          return;
        }
        void arm();
        return;
      }
      l.empties = 0;
      cancelSpeech();
      const token = ++l.armToken;
      setPhase("sending");
      void (async () => {
        let sent = false;
        try {
          sent = await latest.current.send(spoken);
        } catch {
          sent = false;
        }
        if (!l.enabled || token !== l.armToken) return;
        if (!sent) {
          stop(
            "send_refused",
            "Voice chat turned off: the message could not be sent.",
          );
          return;
        }
        setPhase("waiting");
      })();
    },
    [arm, cancelSpeech, setPhase, stop],
  );

  const reportTranscriptionFailure = useCallback(() => {
    const l = live.current;
    if (!l.enabled || l.state !== "listening") return;
    stop("transcription_failed", "Voice chat turned off.");
  }, [stop]);

  const noteSend = useCallback(() => {
    const l = live.current;
    if (!l.enabled) return;
    cancelSpeech();
    l.armToken += 1;
    l.empties = 0;
    setPhase("waiting");
  }, [cancelSpeech, setPhase]);

  // The chat's stream is the external system here: these three effects react
  // to it the way a subscription callback would, so the loop's phase moves in
  // step with an answer landing, the panel closing or a send failing.
  const { messages, isReplying, isChatOpen, error } = input;
  useEffect(() => {
    const l = live.current;
    if (!l.enabled || l.state !== "waiting" || isReplying) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    const id = String(last.id);
    if (l.baselineIds.has(id) || l.spokenIds.has(id)) return;
    l.spokenIds.add(id);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the newest answer arrived from the chat stream
    speak(last.text);
  }, [messages, isReplying, speak]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the panel closed under the loop
    if (!isChatOpen) stop("chat_closed");
  }, [isChatOpen, stop]);

  useEffect(() => {
    const l = live.current;
    if (l.enabled && error && error !== l.baselineError)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the send the loop made failed in the chat
      stop("send_error", "Voice chat turned off after an error.");
  }, [error, stop]);

  useEffect(() => {
    if (!enabled) return;
    const hide = () => {
      if (document.hidden)
        stop("hidden", "Voice chat turned off while the tab was hidden.");
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [enabled, stop]);

  useEffect(() => () => stop("unmount"), [stop]);

  return {
    enabled,
    state,
    support,
    toggle,
    reportTranscript,
    reportTranscriptionFailure,
    noteSend,
  };
}
