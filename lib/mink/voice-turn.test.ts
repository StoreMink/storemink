// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureMinkVoiceTurn,
  createMinkVoiceCapture,
  MinkVoiceCaptureError,
  transcribeMinkRecording,
  type MinkVoiceCapture,
} from "./voice-turn";
import { MINK_SPEECH_GATE, type MinkMicrophone } from "./voice-recorder";

const recorder = vi.hoisted(() => ({
  start: vi.fn(),
  done: null as null | ((file: File | null) => void),
  progress: null as null | (() => void),
  options: null as null | Record<string, unknown>,
}));
vi.mock("./voice-recorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./voice-recorder")>()),
  startMinkRecording: recorder.start,
}));

const fetchMock = vi.fn();
const wav = () => new File(["wav"], "voice-note.wav", { type: "audio/wav" });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ text: "  How many orders today?  " }),
  });
  recorder.start.mockReset();
  recorder.done = null;
  recorder.progress = null;
  recorder.options = null;
  recorder.start.mockImplementation((_signal, done, progress, options) => {
    recorder.done = done;
    recorder.progress = progress;
    recorder.options = options;
    return Promise.resolve(vi.fn());
  });
});
afterEach(() => vi.unstubAllGlobals());

function capture(
  overrides: Partial<Parameters<typeof captureMinkVoiceTurn>[0]> = {},
) {
  return captureMinkVoiceTurn({
    signal: new AbortController().signal,
    gate: { current: MINK_SPEECH_GATE },
    onSpeechStart: () => true,
    ...overrides,
  });
}

describe("captureMinkVoiceTurn", () => {
  it("preserves recognition language for playback without changing the transcript", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        text: "तुमची ऑर्डर तयार आहे",
        languageCode: "mr-IN",
      }),
    });
    const onLanguage = vi.fn();
    const pending = capture({ onLanguage });
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalledOnce());
    recorder.done?.(wav());
    expect(await pending).toBe("तुमची ऑर्डर तयार आहे");
    expect(onLanguage).toHaveBeenCalledWith("mr-IN");
  });

  it("records in voice mode, then transcribes, reporting each phase", async () => {
    const onPhase = vi.fn();
    const onSpeechStart = vi.fn(() => true);
    const gate = { current: MINK_SPEECH_GATE };
    const pending = capture({ onPhase, onSpeechStart, gate });
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalledOnce());
    expect(recorder.options).toMatchObject({ endOnSilence: true });
    expect((recorder.options as { voice: { gate: unknown } }).voice.gate).toBe(
      gate,
    );
    expect(onPhase).toHaveBeenCalledWith("open");
    recorder.done?.(wav());
    expect(await pending).toBe("How many orders today?");
    expect(onPhase.mock.calls.map((call) => call[0])).toEqual([
      "open",
      "transcribing",
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/mink/voice");
    expect(init.headers["X-Mink-Request-Key"]).toMatch(/[0-9a-f-]{36}/);
  });

  it("resolves null for a silent clip and for an empty transcript, without a provider call for the former", async () => {
    const silent = capture();
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalledOnce());
    recorder.done?.(null);
    expect(await silent).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    // What the route answers when the provider understood no words.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "", languageCode: null }),
    });
    const empty = capture();
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalledTimes(2));
    recorder.done?.(wav());
    expect(await empty).toBeNull();
  });

  it("names the failure: microphone or transcription", async () => {
    recorder.start.mockRejectedValueOnce(new Error("Permission denied."));
    await expect(capture()).rejects.toMatchObject({
      name: "MinkVoiceCaptureError",
      kind: "mic",
      message: "Permission denied.",
    });

    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "The voice service is busy." }),
    });
    const pending = capture();
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalledTimes(2));
    recorder.done?.(wav());
    await expect(pending).rejects.toMatchObject({
      kind: "transcription",
      message: "The voice service is busy.",
    });
  });

  it("★ reports a dropped connection as a transcription failure, never a microphone one", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const pending = capture();
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalledOnce());
    recorder.done?.(wav());
    await expect(pending).rejects.toMatchObject({
      name: "MinkVoiceCaptureError",
      kind: "transcription",
      message:
        "Voice transcription could not connect. Check your connection and try again.",
    });

    // An injected transcriber that throws something unexpected, likewise.
    const odd = capture({
      transcribe: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalledTimes(2));
    recorder.done?.(wav());
    await expect(odd).rejects.toMatchObject({ kind: "transcription" });
  });

  it("keeps an abort during transcription an abort", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const pending = capture({ signal: controller.signal });
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalledOnce());
    recorder.done?.(wav());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with an abort when the loop stops mid-recording", async () => {
    const controller = new AbortController();
    const pending = capture({ signal: controller.signal });
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("transcribeMinkRecording", () => {
  it("throws a transcription error with a safe message when the body is not JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error("not json");
      },
    });
    await expect(transcribeMinkRecording(wav())).rejects.toBeInstanceOf(
      MinkVoiceCaptureError,
    );
  });
});

/** An open microphone that records nothing until a test hands it a clip. */
function fakeMicrophone() {
  const state = { closed: false };
  const recordings: {
    done: (file: File | null) => void;
    options: unknown;
  }[] = [];
  const mic = {
    get closed() {
      return state.closed;
    },
    close: vi.fn(() => {
      state.closed = true;
    }),
    // Like the real one, a turn already cancelled is refused.
    record: vi.fn(
      (
        signal: AbortSignal,
        done: (file: File | null) => void,
        _progress: unknown,
        options?: unknown,
      ) => {
        signal.throwIfAborted();
        recordings.push({ done, options });
        return vi.fn();
      },
    ),
  };
  return { mic: mic as MinkMicrophone & typeof mic, state, recordings };
}

const turn = (
  voice: MinkVoiceCapture,
  signal: AbortSignal = new AbortController().signal,
) =>
  voice.capture({
    signal,
    gate: { current: MINK_SPEECH_GATE },
    onSpeechStart: () => true,
  });

describe("★★ createMinkVoiceCapture: one microphone for the whole chat", () => {
  it("opens the microphone once and records every turn on it", async () => {
    const { mic, recordings } = fakeMicrophone();
    const open = vi.fn(async () => mic as MinkMicrophone);
    const voice = createMinkVoiceCapture({ open });

    const first = turn(voice);
    await vi.waitFor(() => expect(recordings).toHaveLength(1));
    expect(recordings[0].options).toMatchObject({ endOnSilence: true });
    recordings[0].done(wav());
    expect(await first).toBe("How many orders today?");

    const second = turn(voice);
    await vi.waitFor(() => expect(recordings).toHaveLength(2));
    recordings[1].done(null);
    expect(await second).toBeNull();

    expect(open).toHaveBeenCalledOnce();
    expect(mic.close).not.toHaveBeenCalled();
    voice.close();
    await vi.waitFor(() => expect(mic.close).toHaveBeenCalled());
  });

  it("tries a microphone that could not open again on the next turn", async () => {
    const { mic, recordings } = fakeMicrophone();
    const open = vi
      .fn<() => Promise<MinkMicrophone>>()
      .mockRejectedValueOnce(new Error("Permission denied."))
      .mockResolvedValueOnce(mic);
    const voice = createMinkVoiceCapture({ open });

    await expect(turn(voice)).rejects.toMatchObject({
      name: "MinkVoiceCaptureError",
      kind: "mic",
      message: "Permission denied.",
    });
    const next = turn(voice);
    await vi.waitFor(() => expect(recordings).toHaveLength(1));
    recordings[0].done(null);
    expect(await next).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("opens the microphone again once its device went away", async () => {
    const first = fakeMicrophone();
    const second = fakeMicrophone();
    const open = vi
      .fn<() => Promise<MinkMicrophone>>()
      .mockResolvedValueOnce(first.mic)
      .mockResolvedValueOnce(second.mic);
    const voice = createMinkVoiceCapture({ open });

    const a = turn(voice);
    await vi.waitFor(() => expect(first.recordings).toHaveLength(1));
    first.recordings[0].done(null);
    await a;
    // The headset was unplugged between turns.
    first.state.closed = true;
    const b = turn(voice);
    await vi.waitFor(() => expect(second.recordings).toHaveLength(1));
    second.recordings[0].done(null);
    expect(await b).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("a turn abandoned while the microphone opens leaves it open for the next turn", async () => {
    const { mic, recordings } = fakeMicrophone();
    let grant!: (live: MinkMicrophone) => void;
    const open = vi.fn(
      () =>
        new Promise<MinkMicrophone>((resolve) => {
          grant = resolve;
        }),
    );
    const voice = createMinkVoiceCapture({ open });

    const controller = new AbortController();
    const abandoned = turn(voice, controller.signal);
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    grant(mic);

    const next = turn(voice);
    await vi.waitFor(() => expect(recordings).toHaveLength(1));
    recordings[0].done(null);
    expect(await next).toBeNull();
    expect(open).toHaveBeenCalledOnce();
    expect(mic.close).not.toHaveBeenCalled();
  });

  it("★ ending voice chat releases the microphone, even one still opening, and refuses later turns", async () => {
    const { mic } = fakeMicrophone();
    let grant!: (live: MinkMicrophone) => void;
    const open = vi.fn(
      () =>
        new Promise<MinkMicrophone>((resolve) => {
          grant = resolve;
        }),
    );
    const voice = createMinkVoiceCapture({ open });

    const controller = new AbortController();
    const pending = turn(voice, controller.signal);
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    controller.abort();
    voice.close();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // Permission arrives after the merchant ended the chat.
    grant(mic);
    await vi.waitFor(() => expect(mic.close).toHaveBeenCalled());

    await expect(turn(voice)).rejects.toMatchObject({
      kind: "mic",
      message: "Voice chat has ended.",
    });
    expect(open).toHaveBeenCalledOnce();
  });
});
