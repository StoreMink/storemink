# Talk to Mink voice audit, 27 October 2026

The later [Sarvam follow-up](mink-sarvam-realtime-audit-2026-10-27.md) adds
production timing evidence, HTTP streaming synthesis and language propagation.
The REST-only and unknown-runtime statements below describe the earlier pass.

## Scope and result

Source audit and offline regression tests of speech recognition, chat response
instructions, synthesis and browser playback. Changes are prepared for `fixes`.
No production configuration, provider selection or deployment was changed. No
paid API call was made. The active database-backed provider selections were not
read, so this report describes supported paths, not a claim that every request
currently uses every listed model.

| Stage              | Implemented path                                                                           | Selection                                                          |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Speech recognition | Google Chirp 3 or Sarvam Saaras v4                                                         | One platform-wide setting, resolved per recording; default Chirp 3 |
| Answer generation  | Gemini chat session; voice starts on the configured fallback, normally 3.5 Flash in Mumbai | Existing chat configuration and failover                           |
| Speech synthesis   | Gemini 3.8 Flash-Lite TTS or Sarvam Bulbul v4 Flash                                        | Platform-wide setting; model speech is off by default              |
| Browser playback   | Web Audio for model PCM, browser speech synthesis as fallback                              | Browser/device availability and provider outcome                   |

Google's speech recognition path uses Chirp, not Gemini. Gemini writes the
answer and can separately synthesize it. Sarvam recognition and synthesis are
also separate calls and settings.

## Findings and changes

### Identity and abusive replies

The chat model had no explicit rule connecting identity to synthetic playback.
Gemini TTS defaults to Kore, Sarvam selects a voice by language, and browser
fallback can sound different again. Giving the language model an assumed
human gender would fail whenever playback changes.

Prompt versions `read-beta-v41` and `draft-action-beta-v64` now instruct Mink
to identify as an AI assistant and use gender-neutral self-reference in every
language, with Hindi/Hinglish examples. The rule covers short spoken tool
acknowledgements, final spoken answers and written replies. It also instructs
Mink to answer the underlying store request without mirroring insults, or to
offer brief store help when there is no request. No extra moderation model
call was added.

These are model instructions, not a deterministic guarantee about all future
outputs. Live Hindi, Hinglish, English and other supported-language listening
checks remain necessary. Acoustic voice continuity across different languages
or browser fallback is not guaranteed.

Recognition currently preserves the words the merchant said. Profanity in the
merchant's own chat bubble is therefore expected transcription behavior, not
proof that Mink generated or endorsed it. Transcript masking is a separate
product choice, asked of the owner and not silently enabled. The answer prompt
addresses Mink echoing abuse; it does not censor previously saved messages or
new merchant transcripts.

### Fewer Sarvam requests

The browser already segments speech into short pieces, each at most 600
characters, and prefetches one piece. Sarvam's adapter split those pieces
again with another 160-character first-piece boundary. It now sends exactly
one REST request per incoming piece. This removes avoidable round trips and
request overhead; it does not imply proportional character-billing savings.
The initial short browser piece and one-piece-ahead prefetch remain.

Both provider entry points now reject blank, oversized and already-cancelled
synthesis work before making an API call. A regression exercises a real-shaped
piece longer than 160 characters and confirms exactly one Sarvam request with
the complete text.

### Stable fallback within an answer

Before audio starts, a failed or unsupported model piece now switches the rest
of that answer to browser speech and cancels queued model requests. It no
longer retries the same failing provider on every following sentence or
alternates model/browser voices within the answer. The next answer may try
the model again. Only an explicit platform `off` disables it for the whole
conversation. A stream that fails after some audio has played retains the
existing truncation notice; repeating a partly heard sentence would be wrong.

### Measurement and privacy

Successful and empty transcriptions now record provider duration and validated
audio byte count, without transcript or audio content. This complements TTS's
existing first-audio and total-duration measurements. The voice route rechecks
cancellation immediately before starting transcription. Provider refusal
reasons are constrained to bounded uppercase enum tokens before entering logs,
so free-text explanation fields are not copied as diagnostic codes.

## Existing efficiency retained

- Silence detection avoids recognition calls for recordings without speech.
- Microphone echo cancellation and the existing confirmed-echo handling reduce
  accidental self-transcription.
- Recordings are bounded to 30 seconds and mono 16 kHz PCM.
- Google authentication reuses one cached client and its tokens.
- Spoken replies are short and can play while the written reply finishes.
- Gemini audio streams; the client schedules PCM on one playhead.
- One-piece-ahead fetching bounds speculative work, and stopping cancels it.
- Recognition and synthesis have rate/concurrency bounds. Synthesis also has
  character budgets. These are application bounds, not provider capacity guarantees.

## Validation and remaining evidence

Offline validation: 366 tests passed across 17 suites covering recognition,
synthesis, playback, interruption, voice UI, routes, prompt loading and
persistence, chat integration, model failover and the codebase map. Typecheck,
changed-file ESLint, formatting, Help lint and diff whitespace checks passed.
Provider calls were mocked.

Before choosing a cheaper/faster provider or claiming measured production
improvement, compare the selected providers on the same recorded utterances in
staging. Include English, Hindi, Hinglish, names, order numbers, amounts,
silence/noise, interruption and recovery. Measure recognition accuracy,
end-of-speech to first audio, provider errors, request counts and billed usage;
listen for grammatical identity, pronunciation and voice continuity. Test
insults alone and an insult followed by a legitimate store question, without
executing business mutations. A small paid evaluation needs its own agreed
budget; the earlier image-capacity approval does not cover it.

Known opportunities requiring evidence rather than a blind switch: streamed
recognition to overlap speech and transcription; Sarvam streaming synthesis;
more reliable mixed-language routing (Latin Hinglish currently follows the
browser language); voice selection across all supported languages. None was
advertised as measured or deployed in this audit.

No new merchant action or setting was added. No merchant-visible workflow
change, no Help Centre update.

## Provider references checked

- [Sarvam speech recognition REST](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe): Saaras v4, automatic language detection and 16 kHz input.
- [Sarvam synthesis REST](https://docs.sarvam.ai/api-reference/text-to-speech/convert): Bulbul v4 Flash accepts up to 2,500 text characters; the app keeps its tighter 600-character limit.
- [Sarvam voices](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/voices): language-specific persona catalogue.
- [Google Chirp 3](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3): recognition API and regional capabilities.
- [Gemini 3.8 Flash-Lite TTS](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash-lite-tts): synthesis model reference.
