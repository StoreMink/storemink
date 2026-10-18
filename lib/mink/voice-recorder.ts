import {
  encodeMinkWav,
  MINK_AUDIO_RATE,
  MINK_AUDIO_SECONDS,
} from "./input-policy";

// End dictation after the speaker pauses, like a message composer rather than
// a voice-note recorder. The detector is armed only after real speech so room
// noise or silence immediately after permission cannot submit an empty clip.
export const MINK_SPEECH_RMS_THRESHOLD = 0.012;
export const MINK_MIN_SPEECH_MS = 180;
export const MINK_END_SILENCE_MS = 1_200;

function chunkRms(chunk: Float32Array): number {
  if (chunk.length === 0) return 0;
  let energy = 0;
  for (const sample of chunk) energy += sample * sample;
  return Math.sqrt(energy / chunk.length);
}
/**
 * Browser-only microphone lifecycle. Tracks close on every success/error/cancel path.
 *
 * ★ A PAUSE ENDS VOICE CHAT, NOT DICTATION. The hands-free loop has no button
 * to press, so it needs the silence detector; dictation is finished with the
 * composer's Done button, the way ChatGPT and Claude dictate, so stopping to
 * think mid-sentence does not cut the merchant off. `endOnSilence: false`
 * keeps the 30-second cap, which still finishes and transcribes.
 *
 * `onLevel` receives each chunk's loudness (RMS, 0 to 1) for the live
 * waveform. It runs about 125 times a second, so it must not set React state.
 */
export async function startMinkRecording(
  signal: AbortSignal,
  done: (file: File | null) => void,
  progress: (seconds: number) => void,
  options: { endOnSilence?: boolean; onLevel?: (level: number) => void } = {},
) {
  const endOnSilence = options.endOnSilence ?? true;
  if (
    !window.isSecureContext ||
    !navigator.mediaDevices?.getUserMedia ||
    !window.AudioContext
  )
    throw new Error(
      "Speech-to-text needs HTTPS and a browser with microphone and AudioWorklet support. You can type your message instead.",
    );
  let context: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let node: AudioWorkletNode | undefined;
  let finished = false;
  let total = 0;
  let voicedSamples = 0;
  let lastSpeechSample = 0;
  let chunks: Float32Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (keep = false) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (node) {
      node.port.onmessage = null;
      node.port.close();
      node.disconnect();
    }
    stream?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed")
      void context.close().catch(() => {});
    if (keep && total) {
      const samples = new Float32Array(total);
      let offset = 0;
      chunks.forEach((chunk) => {
        samples.set(chunk, offset);
        offset += chunk.length;
      });
      done(
        new File([encodeMinkWav(samples)], "voice-note.wav", {
          type: "audio/wav",
        }),
      );
    }
    if (keep && !total) done(null);
    chunks = [];
  };
  const cancel = () => stop(false);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1 },
      video: false,
    });
    if (signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Recording cancelled.");
    }
    context = new AudioContext({ sampleRate: MINK_AUDIO_RATE });
    if (context.sampleRate !== MINK_AUDIO_RATE || !context.audioWorklet)
      throw new Error(
        "This browser cannot record the supported audio format. Type your message instead.",
      );
    await context.audioWorklet.addModule("/mink-audio-recorder.js");
    signal.throwIfAborted();
    node = new AudioWorkletNode(context, "mink-audio-recorder");
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (finished) return;
      const chunk = event.data;
      if (
        !(chunk instanceof Float32Array) ||
        total + chunk.length > MINK_AUDIO_RATE * MINK_AUDIO_SECONDS
      ) {
        stop(false);
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
      const rms = chunkRms(chunk);
      if (rms >= MINK_SPEECH_RMS_THRESHOLD) {
        voicedSamples += chunk.length;
        lastSpeechSample = total;
      }
      options.onLevel?.(rms);
      progress(Math.floor(total / MINK_AUDIO_RATE));
      const speechArmed =
        voicedSamples >= (MINK_AUDIO_RATE * MINK_MIN_SPEECH_MS) / 1_000;
      const silenceSamples = (MINK_AUDIO_RATE * MINK_END_SILENCE_MS) / 1_000;
      if (
        total >= MINK_AUDIO_RATE * MINK_AUDIO_SECONDS ||
        (endOnSilence &&
          speechArmed &&
          total - lastSpeechSample >= silenceSamples)
      )
        stop(true);
    };
    const mute = context.createGain();
    mute.gain.value = 0;
    context
      .createMediaStreamSource(stream)
      .connect(node)
      .connect(mute)
      .connect(context.destination);
    await context.resume();
    signal.throwIfAborted();
    timer = setTimeout(() => stop(true), MINK_AUDIO_SECONDS * 1_000);
    return () => stop(true);
  } catch (error) {
    stop(false);
    throw error;
  }
}
