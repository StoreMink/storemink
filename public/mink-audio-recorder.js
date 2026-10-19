/* Local-only capture. No network, storage, transcription or business actions.
   Every cap lives on the main thread (lib/mink/voice-recorder.ts): a 30-second
   dictation, 30 seconds from the start of speech in voice chat, and the
   five-minute ceiling on an open voice-chat microphone. */
class MinkAudioRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const samples = input.slice();
    this.port.postMessage(samples, [samples.buffer]);
    return true;
  }
}
registerProcessor("mink-audio-recorder", MinkAudioRecorder);
