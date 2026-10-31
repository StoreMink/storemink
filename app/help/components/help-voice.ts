"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { HelpAssistantAnswer } from "@/app/actions/help-assistant-actions";
import {
  createMinkSpeechSession,
  type MinkSpeechSession,
} from "@/app/dashboard/mink-speech-session";
import {
  speakableMinkText,
  speechLangFor,
  splitSpeechChunks,
} from "@/lib/mink/speech-text";
import {
  MINK_SPEECH_GATE,
  startMinkRecording,
} from "@/lib/mink/voice-recorder";
import {
  createMinkVoiceCapture,
  MinkVoiceCaptureError,
  transcribeMinkRecording,
  type MinkVoiceCapture,
} from "@/lib/mink/voice-turn";

/**
 * Voice for the public Help Centre assistant: dictation into the message
 * box, a spoken back-and-forth ("Talk with Mink AI"), and reading one answer
 * aloud.
 *
 * ★ IT REUSES THE DASHBOARD'S RECORDER AND SPEECH SESSION, NOT ITS VOICE
 * LOOP. The dashboard loop streams spoken blocks, pauses on barge-in and asks
 * the server to stop a run; the Help assistant answers in one request, so a
 * turn here is simply: listen until a pause, transcribe, ask, read the answer
 * aloud, listen again. The microphone is NOT open while Mink speaks, so Mink
 * never hears itself and no echo handling is needed; Skip ends the answer
 * early.
 * ★ ANSWERS ARE READ BY THE BROWSER'S OWN VOICE. The paid read-aloud model
 * behind `/api/mink/speech` needs a signed-in merchant, and a public page
 * must not spend it.
 * ★ TRANSCRIPTION GOES TO `/api/help/voice`, the public route with
 * per-visitor limits; the question itself goes through the ordinary
 * `askHelpAssistant` action like a typed one.
 */

export const HELP_VOICE_ENDPOINT = "/api/help/voice";

export type HelpVoiceSupport = { microphone: boolean; speech: boolean };

const NO_SUPPORT: HelpVoiceSupport = { microphone: false, speech: false };
let lastSupport: HelpVoiceSupport = NO_SUPPORT;

/** The same answer keeps the same object, or useSyncExternalStore loops. */
function readSupport(): HelpVoiceSupport {
  if (typeof window === "undefined") return NO_SUPPORT;
  const microphone =
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.AudioContext === "function";
  const speech =
    "speechSynthesis" in window &&
    typeof window.SpeechSynthesisUtterance !== "undefined";
  if (microphone !== lastSupport.microphone || speech !== lastSupport.speech)
    lastSupport = { microphone, speech };
  return lastSupport;
}

const noSubscription = () => () => {};

/**
 * What this browser can do. The server snapshot says nothing, so the markup
 * matches on hydration and the voice buttons appear once the page is live.
 */
export function useHelpVoiceSupport(): HelpVoiceSupport {
  return useSyncExternalStore(noSubscription, readSupport, () => NO_SUPPORT);
}

/** One clip to the public Help transcription route. */
export function transcribeHelpRecording(
  recording: File,
  signal?: AbortSignal,
  onLanguage?: (languageCode: string | null) => void,
) {
  return transcribeMinkRecording(
    recording,
    signal,
    onLanguage,
    HELP_VOICE_ENDPOINT,
  );
}

/**
 * What Mink says aloud for an answer: the answer, then each step. `stepWord`
 * is the chat language's word for a step, so a Hindi answer reads "चरण 1".
 */
export function spokenHelpAnswer(
  answer: Pick<HelpAssistantAnswer, "answer" | "steps">,
  stepWord = "Step",
): string {
  const lines = [
    answer.answer,
    ...answer.steps.map((step, index) => `${stepWord} ${index + 1}: ${step}`),
  ];
  return speakableMinkText(lines.join("\n\n"));
}

/** A microphone failure in the visitor's words, never the browser's. */
export function microphoneMessage(error: unknown): string {
  const name = String((error as { name?: unknown } | null)?.name ?? "");
  const message = String(
    (error as { message?: unknown } | null)?.message ?? "",
  );
  if (
    name === "NotAllowedError" ||
    name === "SecurityError" ||
    /denied|not allowed|permission/i.test(message)
  )
    return "Microphone access is blocked. Allow it for this site in your browser, or type your question.";
  if (name === "NotFoundError" || /not found|no microphone/i.test(message))
    return "No microphone was found. Connect one, or type your question.";
  if (/HTTPS|AudioWorklet/i.test(message))
    return "Voice needs a secure connection and a browser with microphone support. You can type your question instead.";
  return "The microphone couldn't start. Try again, or type your question.";
}

const isAbort = (error: unknown) =>
  (error as { name?: unknown } | null)?.name === "AbortError";

function browserLanguage() {
  if (typeof navigator === "undefined") return "en-IN";
  return navigator.language || "en-IN";
}

/** A peak that falls away, so the waveform breathes instead of flickering. */
function decayingPeak(ref: { current: number }, level: number) {
  ref.current = Math.max(level, ref.current * 0.82);
}

/**
 * Safari and Chrome on iOS start speech only from a tap, so the Talk button
 * says nothing once, inside the tap, and later answers may speak.
 */
function primeSpeech() {
  try {
    const synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance === "undefined")
      return;
    const silent = new window.SpeechSynthesisUtterance(" ");
    silent.volume = 0;
    synth.speak(silent);
  } catch {
    // Speech is a convenience; the conversation still shows in the chat.
  }
}

function readWith(
  session: MinkSpeechSession,
  text: string,
  detected?: string | null,
) {
  const lang = speechLangFor(text, browserLanguage(), detected);
  for (const piece of splitSpeechChunks(text)) session.enqueue(piece, lang);
  session.end();
}

/* ---------------------------------------------------------------- dictation */

export type HelpDictationState =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing";

/**
 * The microphone button in the message box: record until Done, transcribe,
 * hand the words back to be added to the draft. Nothing is sent by itself.
 */
export function useHelpDictation(callbacks: {
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<HelpDictationState>("idle");
  const [seconds, setSeconds] = useState(0);
  const levelRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const finishRef = useRef<(() => void) | null>(null);
  const latest = useRef(callbacks);
  useEffect(() => {
    latest.current = callbacks;
  });

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    finishRef.current = null;
    levelRef.current = 0;
    setSeconds(0);
    setState("idle");
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  const start = useCallback(async () => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setSeconds(0);
    setState("starting");

    const settle = () => {
      if (controllerRef.current !== controller) return;
      controllerRef.current = null;
      finishRef.current = null;
      levelRef.current = 0;
      setState("idle");
    };

    const done = async (file: File | null) => {
      if (controller.signal.aborted) return;
      finishRef.current = null;
      levelRef.current = 0;
      if (!file) {
        settle();
        latest.current.onError(
          "No speech was recorded. Try again and speak a little closer to the microphone.",
        );
        return;
      }
      setState("transcribing");
      try {
        const text = await transcribeHelpRecording(file, controller.signal);
        if (controller.signal.aborted) return;
        if (text) latest.current.onTranscript(text);
        else
          latest.current.onError(
            "No speech was recognised. Try again, or type your question.",
          );
      } catch (error) {
        if (controller.signal.aborted || isAbort(error)) return;
        latest.current.onError(
          error instanceof MinkVoiceCaptureError
            ? error.message
            : "Voice transcription failed. Try again, or type your question.",
        );
      } finally {
        settle();
      }
    };

    try {
      const finish = await startMinkRecording(
        controller.signal,
        (file) => void done(file),
        (elapsed) => setSeconds(elapsed),
        {
          endOnSilence: false,
          onLevel: (level) => decayingPeak(levelRef, level),
        },
      );
      if (controller.signal.aborted) return;
      finishRef.current = finish;
      setState("recording");
    } catch (error) {
      if (controllerRef.current !== controller) return;
      settle();
      latest.current.onError(microphoneMessage(error));
    }
  }, []);

  const finish = useCallback(() => finishRef.current?.(), []);

  return { state, seconds, levelRef, start, finish, cancel };
}

/* ------------------------------------------------------------- conversation */

export type HelpTalkPhase =
  | "off"
  | "starting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking";

export type HelpTalkReply = {
  answer?: Pick<HelpAssistantAnswer, "answer" | "steps"> | null;
  /** The question could not be asked (too short, a pause, a failure). */
  error?: string;
  /** True when the words did not read as a question at all. */
  unclear?: boolean;
};

/** Words with nothing in them three times running end the conversation. */
export const HELP_TALK_EMPTY_LIMIT = 3;

/** What the talk loop says or shows in its own words, in the chat language. */
export type HelpTalkPhrases = {
  /** Ending after three turns with no words. */
  silence: string;
  /** Asking again when the words were not a question. */
  unclear: string;
  /** Put before an error that is read aloud. */
  sorry: string;
  /** The answer could not be fetched at all. */
  failed: string;
  /** Ending because the tab was hidden. */
  hidden: string;
  /** Ending for any other reason. */
  stopped: string;
  /** The word for a step, read before its number. */
  stepWord: string;
};

export const ENGLISH_TALK_PHRASES: HelpTalkPhrases = {
  silence: "I didn't hear anything for a while, so I ended the voice chat.",
  unclear: "Sorry, I didn't catch a question there. Could you say it again?",
  sorry: "Sorry.",
  failed: "Mink AI couldn't respond just now.",
  hidden: "Voice chat ended because the page was hidden.",
  stopped: "Voice chat stopped. Try again, or type your question.",
  stepWord: "Step",
};

type TalkRun = {
  controller: AbortController;
  capture: MinkVoiceCapture;
  session: MinkSpeechSession | null;
  skip: (() => void) | null;
};

/**
 * "Talk with Mink AI": a spoken conversation inside the chat. Each turn the
 * visitor's words become an ordinary message (through `ask`), and the answer
 * is read aloud while it also appears in the thread with its guides.
 */
export function useHelpTalk(options: {
  ask: (text: string) => Promise<HelpTalkReply>;
  /** The chat language's words; English when absent. */
  phrases?: HelpTalkPhrases;
  /**
   * The speech language of the language the visitor picked (for example
   * "hi-IN"), used when the transcription did not name one. Absent: the
   * language heard, then the browser's.
   */
  speechLang?: string | null;
  /** Injected in tests. */
  createCapture?: () => MinkVoiceCapture;
  createSession?: typeof createMinkSpeechSession;
}) {
  const [phase, setPhase] = useState<HelpTalkPhase>("off");
  const [caption, setCaption] = useState("");
  const [notice, setNotice] = useState("");
  const levelRef = useRef(0);
  const runRef = useRef<TalkRun | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const stop = useCallback((message = "") => {
    const run = runRef.current;
    runRef.current = null;
    if (run) {
      run.controller.abort();
      run.session?.cancel();
      run.session = null;
      run.capture.close();
    }
    levelRef.current = 0;
    setCaption("");
    setPhase("off");
    setNotice(message);
  }, []);

  const skip = useCallback(() => runRef.current?.skip?.(), []);
  const clearNotice = useCallback(() => setNotice(""), []);
  const phrases = () => latest.current.phrases ?? ENGLISH_TALK_PHRASES;

  const start = useCallback(() => {
    if (runRef.current) return;
    primeSpeech();
    const create = latest.current.createCapture ?? createMinkVoiceCapture;
    const run: TalkRun = {
      controller: new AbortController(),
      capture: create(),
      session: null,
      skip: null,
    };
    runRef.current = run;
    setNotice("");
    setCaption("");
    setPhase("starting");

    const live = () => runRef.current === run;

    const speak = (text: string, detected: string | null) =>
      new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          run.skip = null;
          run.session = null;
          resolve();
        };
        run.controller.signal.addEventListener("abort", finish, {
          once: true,
        });
        const createSession =
          latest.current.createSession ?? createMinkSpeechSession;
        const session = createSession({
          audio: null,
          voice: "browser",
          events: {
            onStart: () => {
              if (live()) setPhase("speaking");
            },
            onPieceStart: (piece) => {
              if (live()) setCaption(piece);
            },
            onIdle: finish,
            onNotice: () => {},
            onVoiceOff: () => {},
          },
        });
        run.session = session;
        run.skip = () => {
          session.cancel();
          finish();
        };
        readWith(session, text, detected ?? latest.current.speechLang);
      });

    const loop = async () => {
      let empty = 0;
      while (live()) {
        let detected: string | null = null;
        setPhase("listening");
        setCaption("");
        let heard: string | null;
        try {
          heard = await run.capture.capture({
            signal: run.controller.signal,
            gate: { current: MINK_SPEECH_GATE },
            onSpeechStart: () => true,
            onLevel: (level) => decayingPeak(levelRef, level),
            onPhase: (step) => {
              if (step === "transcribing" && live()) {
                levelRef.current = 0;
                setPhase("transcribing");
              }
            },
            onLanguage: (code) => {
              detected = code;
            },
            transcribe: transcribeHelpRecording,
          });
        } catch (error) {
          if (!live() || isAbort(error)) return;
          stop(
            error instanceof MinkVoiceCaptureError && error.kind === "mic"
              ? microphoneMessage(error)
              : error instanceof Error && error.message
                ? error.message
                : phrases().stopped,
          );
          return;
        }
        if (!live()) return;
        if (!heard) {
          empty += 1;
          if (empty >= HELP_TALK_EMPTY_LIMIT) {
            stop(phrases().silence);
            return;
          }
          continue;
        }
        empty = 0;
        setPhase("thinking");
        setCaption(heard);
        const reply = await latest.current.ask(heard).catch(
          (): HelpTalkReply => ({
            error: phrases().failed,
          }),
        );
        if (!live()) return;
        const words = phrases();
        const spoken = reply.answer
          ? spokenHelpAnswer(reply.answer, words.stepWord)
          : reply.unclear
            ? words.unclear
            : reply.error
              ? `${words.sorry} ${reply.error}`
              : "";
        if (spoken) await speak(spoken, detected);
      }
    };

    void loop();
    // `phrases` reads the latest options when it runs, like `ask`.
  }, [stop]);

  useEffect(
    () => () => {
      const run = runRef.current;
      runRef.current = null;
      if (run) {
        run.controller.abort();
        run.session?.cancel();
        run.capture.close();
      }
    },
    [],
  );

  // A hidden tab cannot be heard and should not be listening.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && runRef.current)
        stop((latest.current.phrases ?? ENGLISH_TALK_PHRASES).hidden);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [stop]);

  return {
    phase,
    active: phase !== "off",
    caption,
    notice,
    levelRef,
    start,
    stop,
    skip,
    clearNotice,
  };
}

/* --------------------------------------------------------------- read aloud */

/** Reads one answer aloud on demand; starting another stops the first. */
export function useHelpReadAloud(
  createSession: typeof createMinkSpeechSession = createMinkSpeechSession,
) {
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const sessionRef = useRef<MinkSpeechSession | null>(null);

  const stop = useCallback(() => {
    sessionRef.current?.cancel();
    sessionRef.current = null;
    setSpeakingId(null);
  }, []);

  const speak = useCallback(
    /** `lang`: the picked language's speech code, used when the text's script
     * does not decide it (an answer in Latin letters). */
    (id: number, text: string, lang?: string | null) => {
      sessionRef.current?.cancel();
      sessionRef.current = null;
      const spoken = speakableMinkText(text);
      if (!spoken) {
        setSpeakingId(null);
        return;
      }
      const session: MinkSpeechSession = createSession({
        audio: null,
        voice: "browser",
        events: {
          onStart: () => {},
          onPieceStart: () => {},
          onIdle: () => {
            if (sessionRef.current !== session) return;
            sessionRef.current = null;
            setSpeakingId(null);
          },
          onNotice: () => {},
          onVoiceOff: () => {},
        },
      });
      sessionRef.current = session;
      setSpeakingId(id);
      readWith(session, spoken, lang);
    },
    [createSession],
  );

  useEffect(
    () => () => {
      sessionRef.current?.cancel();
      sessionRef.current = null;
    },
    [],
  );

  return { speakingId, speak, stop };
}
