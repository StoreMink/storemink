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

/**
 * What counts as the merchant speaking: the loudness floor, how long it must
 * hold, and whether Mink is playing audio meanwhile (which pauses the idle
 * clock, since the mic is open to be interrupted, not to time out).
 */
export type MinkSpeechGate = { rms: number; minMs: number; playing: boolean };
/** Today's floor: ordinary talking in a quiet room. */
export const MINK_SPEECH_GATE: MinkSpeechGate = {
  rms: MINK_SPEECH_RMS_THRESHOLD,
  minMs: MINK_MIN_SPEECH_MS,
  playing: false,
};
/**
 * ★ The floor while Mink is talking or thinking: louder and longer, because
 * speaker bleed survives echo cancellation on a laptop and a cough during
 * generation must not cancel a reply. The voice loop swaps the gate in place,
 * so the recorder reads the new floor without restarting.
 */
export const MINK_BARGE_IN_GATE: MinkSpeechGate = {
  rms: 0.035,
  minMs: 350,
  playing: true,
};
/** Audio kept from before speech started, so the first syllable is not lost. */
export const MINK_PRE_ROLL_MS = 400;
/** A silent stretch this long before arming forgets sporadic bursts. */
export const MINK_VOICED_DECAY_MS = 300;
/** The absolute stop for a microphone left open in voice chat. */
export const MINK_VOICE_MAX_OPEN_MS = 5 * 60_000;

export type MinkVoiceRecordingOptions = {
  gate: { current: MinkSpeechGate };
  /** Speech was heard; false means "not now" and the recorder keeps listening. */
  onSpeechStart: () => boolean;
};

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
 * ★ A CLIP WITH NO SPEECH IN IT IS REPORTED AS NONE. Done, and the cap, used
 * to hand over whatever had been captured, so a merchant who pressed the mic
 * and then Done without speaking sent room noise to the provider: a
 * transcription call, an input-quota slot and a 400 "Voice transcript is
 * invalid." for a clip the recorder already knew held nothing. The floor
 * that arms the silence detector (180 ms above the speech threshold) decides,
 * so `done(null)` reaches the composer's existing "No speech was recorded"
 * path and voice chat's empty-transcript path without a round trip.
 *
 * ★ IN VOICE CHAT THE MICROPHONE STAYS OPEN FOR THE WHOLE TURN (`options.voice`).
 * While nobody has spoken, only the newest `MINK_PRE_ROLL_MS` of audio is kept,
 * so the clip sent for transcription is the utterance with a little lead-in,
 * never a minute of echo-cancelled room; the 30-second cap counts from the
 * moment speech starts; and the idle clock that ends a silent recording does
 * not advance while the gate says Mink is playing, so listening through a
 * long answer cannot time the mic out. `onSpeechStart` fires once when the
 * gate's floor is reached and may answer false (a barge-in inside the grace
 * window), after which the recorder disarms and keeps listening.
 *
 * ★ ECHO CANCELLATION IS REQUESTED, NOT ASSUMED. The browser default is
 * whatever the device does; in voice chat the speaker is playing Mink's own
 * voice into the mic, and the barge-in floor is the second layer, not the
 * first.
 *
 * `onLevel` receives each chunk's loudness (RMS, 0 to 1) for the live
 * waveform. It runs about 125 times a second, so it must not set React state.
 */
export async function startMinkRecording(
  signal: AbortSignal,
  done: (file: File | null) => void,
  progress: (seconds: number) => void,
  options: {
    endOnSilence?: boolean;
    onLevel?: (level: number) => void;
    voice?: MinkVoiceRecordingOptions;
  } = {},
) {
  const endOnSilence = options.endOnSilence ?? true;
  const voice = options.voice;
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
  /** Samples received, for timing; never trimmed. */
  let received = 0;
  /** Samples held in `chunks`; the pre-roll ring trims it. */
  let kept = 0;
  let voicedSamples = 0;
  let lastSpeechSample = 0;
  let armed = false;
  let speechStartSample = 0;
  let idleSamples = 0;
  let chunks: Float32Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const capSamples = MINK_AUDIO_RATE * MINK_AUDIO_SECONDS;
  const preRollSamples = (MINK_AUDIO_RATE * MINK_PRE_ROLL_MS) / 1_000;
  const decaySamples = (MINK_AUDIO_RATE * MINK_VOICED_DECAY_MS) / 1_000;
  const silenceSamples = (MINK_AUDIO_RATE * MINK_END_SILENCE_MS) / 1_000;
  const stop = (keep = false) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearTimeout(openTimer);
    signal.removeEventListener("abort", cancel);
    if (node) {
      node.port.onmessage = null;
      node.port.close();
      node.disconnect();
    }
    stream?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed")
      void context.close().catch(() => {});
    const heard = kept > 0 && armed;
    if (keep && heard) {
      const samples = new Float32Array(kept);
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
    if (keep && !heard) done(null);
    chunks = [];
  };
  const cancel = () => stop(false);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
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
    // ★ The version query defeats a cached copy of the worklet that still
    // carried its own 30-second cap; every cap is enforced here now.
    await context.audioWorklet.addModule("/mink-audio-recorder.js?v=2");
    signal.throwIfAborted();
    node = new AudioWorkletNode(context, "mink-audio-recorder");
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (finished) return;
      const chunk = event.data;
      if (!(chunk instanceof Float32Array)) {
        stop(false);
        return;
      }
      const gate = voice?.gate.current ?? MINK_SPEECH_GATE;
      // The cap counts from the start of a dictation and from the start of
      // speech in voice chat; the chunk that crosses it is kept up to the cap.
      const capFrom = voice ? (armed ? speechStartSample : null) : 0;
      let samples = chunk;
      let hitCap = false;
      if (capFrom !== null) {
        const room = capFrom + capSamples - received;
        if (samples.length >= room) {
          samples = samples.subarray(0, Math.max(0, room));
          hitCap = true;
        }
      }
      if (samples.length) {
        chunks.push(samples);
        received += samples.length;
        kept += samples.length;
      }
      const rms = chunkRms(chunk);
      if (rms >= gate.rms) {
        voicedSamples += samples.length;
        lastSpeechSample = received;
      } else if (!armed && received - lastSpeechSample >= decaySamples) {
        voicedSamples = 0;
      }
      if (!armed && voicedSamples >= (MINK_AUDIO_RATE * gate.minMs) / 1_000) {
        if (!voice || voice.onSpeechStart()) {
          armed = true;
          speechStartSample = Math.max(0, received - voicedSamples);
          if (voice) {
            clearTimeout(timer);
            timer = setTimeout(() => stop(true), MINK_AUDIO_SECONDS * 1_000);
          }
        } else {
          voicedSamples = 0;
        }
      }
      if (voice && !armed) {
        while (chunks.length > 1 && kept - chunks[0].length >= preRollSamples)
          kept -= chunks.shift()!.length;
        if (!gate.playing) idleSamples += samples.length;
      }
      options.onLevel?.(rms);
      progress(Math.floor(received / MINK_AUDIO_RATE));
      if (
        hitCap ||
        (!voice && received >= capSamples) ||
        (voice && !armed && idleSamples >= capSamples) ||
        (endOnSilence && armed && received - lastSpeechSample >= silenceSamples)
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
    if (voice) openTimer = setTimeout(() => stop(true), MINK_VOICE_MAX_OPEN_MS);
    else timer = setTimeout(() => stop(true), MINK_AUDIO_SECONDS * 1_000);
    return () => stop(true);
  } catch (error) {
    stop(false);
    throw error;
  }
}
