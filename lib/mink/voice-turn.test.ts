// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureMinkVoiceTurn,
  MinkVoiceCaptureError,
  transcribeMinkRecording,
} from "./voice-turn";
import { MINK_SPEECH_GATE } from "./voice-recorder";

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

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: " " }),
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
