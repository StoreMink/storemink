# Sarvam multilingual voice and latency audit

27 October 2026. Follow-up to the initial Talk to Mink voice audit.

## Result

The previous integration did not fully use Sarvam's interactive capabilities.
The most material omissions were recognition-language propagation, streaming
synthesis and streaming recognition. More model features are not automatically
better: batch processing, translation and voice cloning do not make this
merchant conversation faster.

Implemented in source for `fixes`: language propagation, native-script spoken
copy, an English-Hindi persona, static brand keyterms and HTTP streaming TTS.
Streaming STT is still unimplemented. No deployment, paid model call, support
message or provider configuration change was performed. Live validation of the
new transport and listening quality remains required.

## Existing production latency

Read-only Cloud Logging queries covered the previous seven days and selected
only timestamps, service/provider names, HTTP status/duration, audio bytes,
text lengths and existing timing fields. No audio, transcript, chat text,
credentials or merchant identifiers were exported.

| Measurement                                             | Samples |  Median | 95th percentile | Maximum |
| ------------------------------------------------------- | ------: | ------: | --------------: | ------: |
| Successful transcription endpoint HTTP duration         |      68 | 0.715 s |         1.225 s | 1.950 s |
| Completed Bulbul v4 Flash requests, time to first audio |     109 | 1.008 s |         5.232 s | 9.904 s |

There was also one transcription HTTP 503, lasting 0.522 s. Separate non-empty
recognition-completion logs name `saaras_v4` in all 63 matching entries. These
are different event populations; they were not joined to infer the provider
of every HTTP request. The recognition endpoint includes both dictation and
hands-free voice chat.

All 109 TTS samples came from `storemink-web-prod`, provider `bulbul_v4_flash`,
between 20 October 09:23:15 UTC and 26 October 23:05:10 UTC. Text length was
59 characters at the median, 116 at p95 and 148 at maximum. First-audio and
complete-request times were almost identical, consistent with waiting for the
complete REST clip. These short samples would not benefit from eliminating
splitting above 160 characters; streaming is the more relevant change here.
No matching completed TTS logs were returned for `storemink-staging`.

These are completed-server-request measurements, not end-to-end perceived
latency or an SLA. Cancelled/failed TTS work is not represented by the completed
sample. Percentiles were calculated with the nearest-rank method; adding their
percentiles would not produce a valid end-to-end percentile. Queries did not
reach their result limits (1,000 TTS / 2,000 transcription).

Existing fixed waits add to those stages: the recorder waits for 1.2 seconds
of silence, and the player schedules the initial audio with a 0.25-second lead.
Neither includes network upload, Gemini response generation, the sentence
boundary wait or browser scheduling. A fast STT request alone therefore cannot
make the complete exchange feel immediate.

Evidence files, temporary local location:

- `/private/tmp/mink-sarvam-storemink-prod-speech-timings.json`
- `/private/tmp/mink-sarvam-storemink-staging-speech-timings.json`
- `/private/tmp/mink-sarvam-prod-transcription-timings.json`
- `/private/tmp/mink-sarvam-prod-recognition-providers.json`

## Sarvam capability coverage

| Capability                                         | State after this change     | Assessment                                                                                                                                                           |
| -------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saaras v4 automatic language detection             | Used                        | Recognition supports English and 22 Indian languages; synthesis coverage differs.                                                                                    |
| Detected language returned to playback             | Fixed                       | Previously discarded. Now bound to the answer that corresponds to the recording.                                                                                     |
| Shared scripts                                     | Fixed                       | A Marathi hint preserves Marathi rather than treating all Devanagari as Hindi. Assamese/Bengali and other shared scripts use the hint too.                           |
| Romanised and mixed-language text                  | Improved                    | Valid detected language overrides browser locale for Latin text. Spoken Indic words use native scripts; written preference stays separate.                           |
| Static terminology hints                           | Added                       | Saaras keyterms includes StoreMink and Mink. No additional model/database query or catalogue exposure.                                                               |
| English-Hindi voice persona                        | Added                       | simran_enhi_customer for Hindi and mixed Hindi-English pieces; language-specific voices elsewhere.                                                                   |
| Native voices for all recognised languages         | Incomplete                  | The selected v4 catalogue has nine monolingual language mappings plus English-Hindi; not 23. Malayalam/Odia and other unsupported languages retain browser fallback. |
| Bulbul HTTP audio streaming                        | Added                       | /text-to-speech/stream, WAV to PCM incrementally. Not yet live-validated.                                                                                            |
| Bulbul preprocessing                               | Explicitly enabled          | Numbers and mixed-script copy use provider normalization. Conversational pace remains 1.0.                                                                           |
| Persistent TTS WebSocket                           | Not used                    | HTTP streaming can deliver early audio without a new socket lifecycle; measure before adding another transport.                                                      |
| Realtime STT partials and adaptive VAD             | Not used                    | Largest remaining structural latency opportunity. Current REST upload begins after the recording ends.                                                               |
| Pronunciation dictionaries                         | Not used                    | Add after listening identifies repeatable brand/SKU pronunciation errors; do not create dictionaries speculatively.                                                  |
| Batch STT, translation, diarization, voice cloning | Not needed for current flow | These solve other tasks and would not establish low conversational latency.                                                                                          |

Recognition-language metadata describes the input's predominant language; it
is not a perfect answer-language classifier. An explicit request to reply in a
different language, multilingual switching and short answers need listening
coverage. Native-script output takes precedence where it clearly differs from
the input hint. No claim is made that every dialect or code-switch is solved.

Sarvam's current documentation is inconsistent about v4 pitch/loudness support
between the API reference and best-practices guide. This change sets neither.
The same guidance says Malayalam/Odia codes exist but v4 personas are absent;
automatically changing the selected model to v3 was not silently introduced.

## Implementation details

`voice-turn.ts` preserves a validated BCP-47 language through an optional
callback, retaining its string transcript API for ordinary dictation.
`mink-voice-mode.ts` captures that metadata with the recording, ignores stale
capture results and confirmed echoes, and stores the accepted hint on the
answer. An interruption's language cannot retune an answer already playing.
`speech-text.ts` resolves shared scripts using the hint, normalises Sarvam's
`od-IN` to the browser-standard `or-IN`, and recognises Odia, Urdu, Santali and
Manipuri scripts in addition to previous scripts.

`lib/mink/speech-wav-stream.ts` incrementally decodes a mono 16-bit PCM RIFF
stream, bounding headers/audio and handling fragmented headers, extra padded
chunks, extensible PCM, unknown data sizes and split samples. Invalid,
truncated or unsupported audio throws through existing fallback handling.
Returning early cancels the upstream reader. Unit tests prove the first PCM
can reach the player while the provider response remains open.

`MINK_SARVAM_TTS_TRANSPORT=rest` preserves the complete-clip transport for
operator rollback. Otherwise Bulbul uses HTTP streaming. There is no automatic
paid REST retry after a streaming failure. Existing first-audio timeout,
character limits, quotas, cancellation and browser fallback remain in place.

Prompt versions are `read-beta-v42` / `draft-action-beta-v65`. Spoken content
uses Indic native scripts with English words in Latin script; written replies
keep the merchant's preferred script. Neutral identity and non-echoing of abuse
from the initial audit remain. User transcripts are still accurate and unmasked.

No merchant action or setting changed, no Help Centre update.

## Remaining work for a premium conversation

1. Implement a server-authenticated realtime audio gateway for Saaras v4
   `/speech-to-text-realtime/ws`, with the provider key kept server-side.
   Browser WebSockets cannot send Sarvam's API-key header, and a generic Next
   route is not an implemented WebSocket-upgrade server here. This needs an
   explicit gateway and deployment design rather than exposing credentials.
2. Preserve per-store permission checks, voice budgets, cancellation, session
   expiry, bounded audio, final-transcript-only execution, and the existing
   server stop handshake. Partial transcripts should improve captions and
   interruption detection, never trigger business tools prematurely.
3. Tune turn detection with actual speakers. Sarvam offers millisecond VAD
   controls; simply reducing 1.2 seconds to 500 ms in the current recorder can
   cut off merchants who pause mid-question. Test Hindi, Hinglish and other
   Indian languages, long numbers, noise, headphones and speakers.
4. Run a bounded staging comparison of REST and streaming synthesis on the
   same text/voice, then measure from actual end of speech to audible reply
   for complete turns. Record median/p95, interruptions, truncation, recognition
   accuracy and cost. The earlier image-test budget is not a voice-test budget.
5. Set acceptance targets for simple conversational replies, for example a
   median around 1.5 to 2 seconds and p95 under 3 seconds. These are proposed
   targets, not measured results or a claim about ChatGPT's own latency. Tool
   work may take longer but should acknowledge promptly and preserve truthful
   action status.

## Validation

386 regression tests passed across 18 suites. After the final cancellation
fix, all 47 streaming/provider/route tests passed again, including the new
pre-playback cancellation case.

Offline regression tests cover multilingual metadata, stale recording isolation,
spoken script instructions, streaming before EOF, split WAV headers/samples,
invalid formats, cancellation before and after playback starts, provider errors,
voice interruptions, chat integration and existing model failover. Typecheck,
changed-file ESLint and formatting pass. Provider network responses are mocked;
no claim of measured post-change latency or real voice quality is made.

## Official references

- [Saaras models](https://docs.sarvam.ai/api/getting-started/models/saaras)
- [Recognition API and keyterms](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe)
- [Realtime recognition](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)
- [Streaming synthesis API](https://docs.sarvam.ai/api-reference/text-to-speech/convert-stream)
- [Bulbul v4 guidance, code-mixing and language coverage](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/best-practices)
- [Voice catalogue](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/voices)
