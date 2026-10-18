// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MINK_BARGE_IN_GATE,
  MINK_SPEECH_GATE,
  MINK_VOICE_MAX_OPEN_MS,
  startMinkRecording,
  type MinkSpeechGate,
} from "./voice-recorder";
const h = {
  stop: vi.fn(),
  close: vi.fn(),
  mic: vi.fn(),
  addModule: vi.fn(),
  resume: vi.fn(),
  node: null as unknown as {
    port: {
      onmessage: ((event: unknown) => void) | null;
      close: ReturnType<typeof vi.fn>;
    };
    disconnect: ReturnType<typeof vi.fn>;
  },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("isSecureContext", true);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: h.mic },
  });
  h.mic.mockResolvedValue({ getTracks: () => [{ stop: h.stop }] });
  h.addModule.mockResolvedValue(undefined);
  h.resume.mockResolvedValue(undefined);
  h.close.mockResolvedValue(undefined);
  const connect = () => ({ connect });
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = 16000;
      state = "running";
      destination = {};
      audioWorklet = { addModule: h.addModule };
      close = h.close;
      resume = h.resume;
      createGain() {
        return { gain: { value: 1 }, connect };
      }
      createMediaStreamSource() {
        return { connect };
      }
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { onmessage: null, close: vi.fn() };
      disconnect = vi.fn();
      constructor() {
        h.node = this;
      }
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("microphone privacy lifecycle", () => {
  it("finishes cleanly when the browser delivers no audio samples", async () => {
    const done = vi.fn();
    const stop = await startMinkRecording(
      new AbortController().signal,
      done,
      vi.fn(),
    );
    stop();
    expect(done).toHaveBeenCalledWith(null);
    expect(h.stop).toHaveBeenCalled();
  });
  it("does not capture in insecure/unsupported contexts", async () => {
    vi.stubGlobal("isSecureContext", false);
    await expect(
      startMinkRecording(new AbortController().signal, vi.fn(), vi.fn()),
    ).rejects.toThrow();
    expect(h.mic).not.toHaveBeenCalled();
  });
  it("stops tracks and context on explicit stop and emits only canonical local WAV", async () => {
    const done = vi.fn();
    const progress = vi.fn();
    const stop = await startMinkRecording(
      new AbortController().signal,
      done,
      progress,
    );
    // A second of speech: a silent clip is reported as none, not as a file.
    h.node.port.onmessage?.({ data: new Float32Array(16000).fill(0.08) });
    stop();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "voice-note.wav",
        type: "audio/wav",
        size: 32044,
      }),
    );
    expect(progress).toHaveBeenCalledWith(1);
  });
  it("discards all samples on abort without a completion callback", async () => {
    const controller = new AbortController();
    const done = vi.fn();
    await startMinkRecording(controller.signal, done, vi.fn());
    h.node.port.onmessage?.({ data: new Float32Array(128) });
    controller.abort();
    expect(h.stop).toHaveBeenCalled();
    expect(h.node.port.onmessage).toBeNull();
    expect(done).not.toHaveBeenCalled();
  });
  it("cleans up when loading the worklet fails", async () => {
    h.addModule.mockRejectedValue(new Error("CSP blocked"));
    await expect(
      startMinkRecording(new AbortController().signal, vi.fn(), vi.fn()),
    ).rejects.toThrow();
    expect(h.stop).toHaveBeenCalled();
    expect(h.close).toHaveBeenCalled();
  });
  it("stops a late permission grant after the user cancelled", async () => {
    let grant!: (stream: unknown) => void;
    h.mic.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const controller = new AbortController();
    const done = vi.fn();
    const pending = startMinkRecording(controller.signal, done, vi.fn());
    controller.abort();
    grant({ getTracks: () => [{ stop: h.stop }] });
    await expect(pending).rejects.toThrow();
    expect(h.stop).toHaveBeenCalled();
    expect(h.addModule).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
  it("automatically stops by wall time even if audio delivery stalls", async () => {
    const done = vi.fn();
    await startMinkRecording(new AbortController().signal, done, vi.fn());
    h.node.port.onmessage?.({ data: new Float32Array(128) });
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.stop).toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });
  it("automatically finishes after speech followed by a natural pause", async () => {
    const done = vi.fn();
    await startMinkRecording(new AbortController().signal, done, vi.fn());
    h.node.port.onmessage?.({ data: new Float32Array(3200).fill(0.08) });
    expect(done).not.toHaveBeenCalled();
    h.node.port.onmessage?.({ data: new Float32Array(19200) });
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({ name: "voice-note.wav", type: "audio/wav" }),
    );
    expect(h.stop).toHaveBeenCalledOnce();
  });
  it("keeps dictating through a pause when the caller finishes it by hand", async () => {
    const done = vi.fn();
    const stop = await startMinkRecording(
      new AbortController().signal,
      done,
      vi.fn(),
      { endOnSilence: false },
    );
    h.node.port.onmessage?.({ data: new Float32Array(3200).fill(0.08) });
    h.node.port.onmessage?.({ data: new Float32Array(19200) });
    expect(done).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
    stop();
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({ name: "voice-note.wav", type: "audio/wav" }),
    );
  });
  it("still finishes a hand-finished dictation at the time cap", async () => {
    const done = vi.fn();
    await startMinkRecording(new AbortController().signal, done, vi.fn(), {
      endOnSilence: false,
    });
    h.node.port.onmessage?.({ data: new Float32Array(3200).fill(0.08) });
    await vi.advanceTimersByTimeAsync(30000);
    expect(done).toHaveBeenCalledOnce();
  });
  it("★ reports a hand-finished recording with no speech as none, with no file", async () => {
    const done = vi.fn();
    const stop = await startMinkRecording(
      new AbortController().signal,
      done,
      vi.fn(),
      { endOnSilence: false },
    );
    // Room noise well under the speech threshold, for over a second.
    h.node.port.onmessage?.({ data: new Float32Array(19200).fill(0.004) });
    stop();
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(null);
    expect(h.stop).toHaveBeenCalledOnce();
  });
  it("★ reports a cap reached in silence as none, so nothing is transcribed", async () => {
    const done = vi.fn();
    await startMinkRecording(new AbortController().signal, done, vi.fn(), {
      endOnSilence: false,
    });
    h.node.port.onmessage?.({ data: new Float32Array(16000) });
    await vi.advanceTimersByTimeAsync(30000);
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(null);
  });
  it("reports each chunk's loudness for the waveform", async () => {
    const onLevel = vi.fn();
    await startMinkRecording(new AbortController().signal, vi.fn(), vi.fn(), {
      onLevel,
    });
    h.node.port.onmessage?.({ data: new Float32Array(128).fill(0.5) });
    h.node.port.onmessage?.({ data: new Float32Array(128) });
    expect(onLevel).toHaveBeenNthCalledWith(1, 0.5);
    expect(onLevel).toHaveBeenNthCalledWith(2, 0);
  });
  it("does not finish from silence before the user has spoken", async () => {
    const done = vi.fn();
    await startMinkRecording(new AbortController().signal, done, vi.fn());
    h.node.port.onmessage?.({ data: new Float32Array(24000) });
    expect(done).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
  });
  it("asks the browser for echo cancellation on every recording", async () => {
    await startMinkRecording(new AbortController().signal, vi.fn(), vi.fn());
    expect(h.mic).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
  });
  it("★ keeps a dictation that crosses the cap mid-chunk instead of discarding it", async () => {
    const done = vi.fn();
    await startMinkRecording(new AbortController().signal, done, vi.fn());
    h.node.port.onmessage?.({ data: new Float32Array(16000 * 29).fill(0.08) });
    h.node.port.onmessage?.({ data: new Float32Array(16000 * 2).fill(0.08) });
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({ size: 44 + 2 * 16000 * 30 }),
    );
  });
  it("★ the worklet no longer caps the capture itself", () => {
    const worklet = readFileSync(
      join(process.cwd(), "public", "mink-audio-recorder.js"),
      "utf8",
    );
    expect(worklet).not.toContain("480000");
    expect(worklet).toContain('registerProcessor("mink-audio-recorder"');
  });
});

describe("★★ voice chat keeps the microphone open", () => {
  const speech = (ms: number, level = 0.08) =>
    new Float32Array((16000 * ms) / 1000).fill(level);
  const silence = (ms: number) => new Float32Array((16000 * ms) / 1000);
  function voiceOptions(
    gate: MinkSpeechGate = MINK_SPEECH_GATE,
    onSpeechStart = vi.fn(() => true),
  ) {
    const holder = { current: gate };
    return { holder, onSpeechStart, voice: { gate: holder, onSpeechStart } };
  }

  it("reports speech once at the floor and sends pre-roll plus the utterance", async () => {
    const done = vi.fn();
    const { voice, onSpeechStart } = voiceOptions();
    await startMinkRecording(new AbortController().signal, done, vi.fn(), {
      voice,
    });
    // Two seconds of quiet room before anyone speaks.
    for (let i = 0; i < 16; i += 1)
      h.node.port.onmessage?.({ data: silence(125) });
    expect(onSpeechStart).not.toHaveBeenCalled();
    h.node.port.onmessage?.({ data: speech(200) });
    expect(onSpeechStart).toHaveBeenCalledOnce();
    h.node.port.onmessage?.({ data: speech(200) });
    expect(onSpeechStart).toHaveBeenCalledOnce();
    h.node.port.onmessage?.({ data: silence(1200) });
    expect(done).toHaveBeenCalledOnce();
    const file = done.mock.calls[0][0] as File;
    // Well under the full two seconds of room noise plus speech.
    expect(file.size).toBeLessThan(44 + 2 * 16000 * 2.3);
    expect(file.size).toBeGreaterThan(44 + 2 * 16000 * 1.6);
  });

  it("★ a refused speech start disarms and keeps listening", async () => {
    const done = vi.fn();
    const onSpeechStart = vi.fn(() => false);
    const { voice } = voiceOptions(MINK_SPEECH_GATE, onSpeechStart);
    await startMinkRecording(new AbortController().signal, done, vi.fn(), {
      voice,
    });
    h.node.port.onmessage?.({ data: speech(200) });
    h.node.port.onmessage?.({ data: silence(1500) });
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    onSpeechStart.mockReturnValue(true);
    h.node.port.onmessage?.({ data: speech(200) });
    expect(onSpeechStart).toHaveBeenCalledTimes(2);
    h.node.port.onmessage?.({ data: silence(1200) });
    expect(done).toHaveBeenCalledOnce();
    expect(done.mock.calls[0][0]).toBeInstanceOf(File);
  });

  it("★ reads the gate live, so a barge-in needs a louder, longer burst", async () => {
    const { voice, holder, onSpeechStart } = voiceOptions(MINK_BARGE_IN_GATE);
    await startMinkRecording(new AbortController().signal, vi.fn(), vi.fn(), {
      voice,
    });
    // Ordinary talking level, which arms the normal gate at once.
    h.node.port.onmessage?.({ data: speech(300, 0.02) });
    expect(onSpeechStart).not.toHaveBeenCalled();
    h.node.port.onmessage?.({ data: speech(300, 0.05) });
    expect(onSpeechStart).not.toHaveBeenCalled();
    h.node.port.onmessage?.({ data: speech(100, 0.05) });
    expect(onSpeechStart).toHaveBeenCalledOnce();
  });

  it("forgets sporadic bursts before arming", async () => {
    const { voice, onSpeechStart } = voiceOptions();
    await startMinkRecording(new AbortController().signal, vi.fn(), vi.fn(), {
      voice,
    });
    h.node.port.onmessage?.({ data: speech(100) });
    h.node.port.onmessage?.({ data: silence(400) });
    h.node.port.onmessage?.({ data: speech(100) });
    expect(onSpeechStart).not.toHaveBeenCalled();
    h.node.port.onmessage?.({ data: speech(100) });
    expect(onSpeechStart).toHaveBeenCalledOnce();
  });

  it("★ the caps count from speech, and the idle clock pauses while Mink plays", async () => {
    const done = vi.fn();
    const { voice, holder } = voiceOptions(MINK_BARGE_IN_GATE);
    await startMinkRecording(new AbortController().signal, done, vi.fn(), {
      voice,
    });
    // Forty seconds of Mink's own answer playing: no stop, no cap.
    await vi.advanceTimersByTimeAsync(40_000);
    for (let i = 0; i < 40; i += 1)
      h.node.port.onmessage?.({ data: silence(1000) });
    expect(done).not.toHaveBeenCalled();
    // Back to listening: thirty quiet seconds end the recording as nothing heard.
    holder.current = MINK_SPEECH_GATE;
    for (let i = 0; i < 29; i += 1)
      h.node.port.onmessage?.({ data: silence(1000) });
    expect(done).not.toHaveBeenCalled();
    h.node.port.onmessage?.({ data: silence(1000) });
    expect(done).toHaveBeenCalledWith(null);
  });

  it("★ a long utterance is finished thirty seconds after it began, by clock or by samples", async () => {
    let done = vi.fn();
    let { voice } = voiceOptions();
    await startMinkRecording(new AbortController().signal, done, vi.fn(), {
      voice,
    });
    await vi.advanceTimersByTimeAsync(25_000);
    h.node.port.onmessage?.({ data: speech(300) });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(done).toHaveBeenCalledOnce();
    expect(done.mock.calls[0][0]).toBeInstanceOf(File);

    done = vi.fn();
    ({ voice } = voiceOptions());
    await startMinkRecording(new AbortController().signal, done, vi.fn(), {
      voice,
    });
    h.node.port.onmessage?.({ data: speech(300) });
    for (let i = 0; i < 31; i += 1)
      h.node.port.onmessage?.({ data: speech(1000) });
    expect(done).toHaveBeenCalledOnce();
    expect((done.mock.calls[0][0] as File).size).toBe(44 + 2 * 16000 * 30);
  });

  it("stops an open microphone at the absolute ceiling", async () => {
    const done = vi.fn();
    const { voice } = voiceOptions(MINK_BARGE_IN_GATE);
    await startMinkRecording(new AbortController().signal, done, vi.fn(), {
      voice,
    });
    await vi.advanceTimersByTimeAsync(MINK_VOICE_MAX_OPEN_MS + 1);
    expect(done).toHaveBeenCalledWith(null);
    expect(h.stop).toHaveBeenCalled();
  });
});
