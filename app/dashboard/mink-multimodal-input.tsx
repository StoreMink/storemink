"use client";

import { randomUuid } from "@/lib/random-uuid";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AudioLines,
  Check,
  FileText,
  Loader2,
  Mic,
  Plus,
  Upload,
  X,
} from "lucide-react";
import {
  discardMinkAttachment,
  uploadMinkAttachment,
} from "@/app/actions/mink-attachment-actions";
import { sendPageExitRequest } from "@/lib/http/page-exit-request";
import {
  addReviewedMinkDocument,
  decodeMinkDocument,
  DOCUMENT_BYTES,
} from "@/lib/mink/document-input";
import {
  inputKind,
  minkAttachmentsFit,
  minkReadingBudget,
  MINK_AUDIO_SECONDS,
  MINK_INPUT_BYTES,
  MINK_INPUT_FILES,
  MINK_MESSAGE_MAX_CHARS,
} from "@/lib/mink/input-policy";
import { addSavedMinkMediaReference } from "@/lib/mink/media-attachment";
import {
  addMinkCsvReference,
  MINK_CSV_BYTES,
  validateMinkCsv,
  type MinkCsvReference,
} from "@/lib/mink/csv-input";
import { startMinkRecording } from "@/lib/mink/voice-recorder";
import { transcribeMinkRecording } from "@/lib/mink/voice-turn";
import { useMinkVoice, type MinkVoiceComposer } from "./chat-context";
import type { MinkPreparedSend } from "./mink-ai";
import { formatMinkClock, MinkWaveform } from "./mink-waveform";

const COMPOSER_FILE_ACCEPT =
  ".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,text/csv,image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown";

/**
 * A picked photo's private copy, kept with the chat (lib/mink/attachments.ts)
 * and never a Media Library row: the id the discard paths name, the address
 * (`/api/mink/attachments/{id}`) the message carries, and the file's name.
 */
type MinkAttachmentRef = { id: string; url: string; filename: string };

/**
 * What the merchant reads when the upload call itself fails: a revision
 * without this action during a deploy, or a network failure. The server's
 * own sentence for a failed save, so the two cases read alike.
 */
const UPLOAD_FAILED = "Upload failed. Please try again.";

type ComposerAttachment = {
  id: string;
  file: File;
  preview: string;
  localText: string | null;
  asset: MinkAttachmentRef | null;
  csvFile: MinkCsvReference | null;
  uploadState: "local" | "uploading" | "ready" | "error";
  /**
   * ★★ A READING SURVIVES A FAILED SEND, so a retry only redoes what failed.
   * `submit()` rebuilds the message from the raw text every time, so without
   * this a five-file send that died on the last file re-extracted the first
   * four — five more provider calls, five more slots of the per-minute input
   * budget, and a retry that hit the rate limit instead of the thing that
   * actually went wrong. A `processing >= 2` 429 or one provider timeout
   * therefore used to cost the whole batch.
   *
   * ★ KEYED ON MODE, NOT JUST PRESENT. Whether an image is read as a design or
   * as an extraction depends on the MESSAGE (`shouldReadMinkImageAsStorefrontDesign`),
   * which the merchant may edit between attempts — serving a cached design
   * reading for an extraction request is a wrong answer, not a stale one.
   */
  reading: { mode: "extract" | "design"; text: string } | null;
};

type AttachmentProgress = Partial<
  Pick<ComposerAttachment, "asset" | "csvFile" | "reading">
>;

export function MinkMultimodalInput({
  message,
  onAdd,
  onSubmit,
  onSubmitPrepared,
  disabled,
  canSaveMedia = false,
  children,
}: {
  message: string;
  onAdd: (message: string) => void;
  onSubmit?: (message: string) => void;
  /**
   * ★★ A typed message with attachments goes here instead of `onSubmit`, at
   * once, before anything is uploaded or read. The chat shows it (photo and
   * all) and reads the files as Mink's first step, the way ChatGPT, Claude
   * and Sidekick do; the composer used to keep the photo under a second
   * spinner until every file was read, so it looked like it was uploading
   * again. Returns false when the chat could not take it (a reply is
   * running), and then nothing leaves the box.
   */
  onSubmitPrepared?: (prepared: MinkPreparedSend) => boolean;
  disabled: boolean;
  /** Resolved server-side; the upload action rechecks this permission. */
  canSaveMedia?: boolean;
  children?: (controls: {
    attach: ReactNode;
    attachment: ReactNode;
    voice: ReactNode;
    submit: () => Promise<void>;
    /**
     * What the composer shows while dictating, in place of its toolbar row
     * (ChatGPT/Claude style): the live waveform with Cancel and Done. Null
     * otherwise. Voice chat has its own bar in the chat surface (mink-voice-view.tsx).
     */
    recorder: ReactNode;
    recording: "dictation" | null;
    /** Something is staged, so the message may be sent without words. */
    hasAttachments: boolean;
  }) => ReactNode;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dictationHintId = useId();
  const dragDepth = useRef(0);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const uploadPromises = useRef(
    new Map<string, Promise<MinkAttachmentRef | null>>(),
  );
  const removedAttachmentIds = useRef(new Set<string>());
  const [submitting, setSubmittingState] = useState(false);
  const submittingRef = useRef(false);
  const [dictationState, setDictationState] = useState<
    "starting" | "listening" | "processing" | null
  >(null);
  // ★ THE REFS ARE WHAT THE VOICE LOOP READS. Its callbacks run from an
  // utterance's end event or a transcript's arrival, long after the render
  // that created them, and the state in that render's closure is stale by
  // then: `startDictation` would refuse because it still saw "processing".
  const dictationRef = useRef<typeof dictationState>(null);
  const [elapsed, setElapsed] = useState(0);
  // A decaying peak of the microphone's loudness for the waveform. Written on
  // every audio chunk, so it is a ref: state would re-render 125 times a second.
  const levelRef = useRef(0);
  // Stops the live recording and keeps it (Done). Null when nothing records.
  const finishRef = useRef<(() => void) | null>(null);
  const doneButtonRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const latestMessage = useRef({
    message,
    onAdd,
    onSubmit,
    onSubmitPrepared,
    disabled,
  });
  const operation = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  // Whether this composer is still on screen, for a handed-over message that
  // comes back (see `handOver`).
  const mountedRef = useRef(false);

  useEffect(() => {
    latestMessage.current = {
      message,
      onAdd,
      onSubmit,
      onSubmitPrepared,
      disabled,
    };
  }, [message, onAdd, onSubmit, onSubmitPrepared, disabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function setDictation(next: typeof dictationState) {
    dictationRef.current = next;
    setDictationState(next);
  }

  function setSubmitting(next: boolean) {
    submittingRef.current = next;
    setSubmittingState(next);
  }

  /**
   * The spoken conversation (the "Talk with Mink" toggle) lives in
   * ChatProvider, which owns the microphone and the send for it; this
   * composer offers the button and stays out of the way while it is on.
   * Outside a provider the toggle is disabled.
   *
   * ★ Voice chat hides this composer but keeps it mounted, so a draft and
   * staged attachments wait here, and each spoken turn comes here first to
   * take them along (`submitMessage`). The newest submit path is read through
   * a ref, because the registration outlives the render that made it.
   */
  const voiceChat = useMinkVoice();
  const { registerComposer } = voiceChat;
  const voiceTurn = useRef<MinkVoiceComposer | null>(null);
  useEffect(() => {
    voiceTurn.current = (transcript, deliver) =>
      latestMessage.current.message.trim() || attachmentsRef.current.length
        ? submitMessage({ transcript, deliver })
        : null;
  });
  useEffect(
    () =>
      registerComposer(
        (transcript, deliver) =>
          voiceTurn.current?.(transcript, deliver) ?? null,
      ),
    [registerComposer],
  );

  function updateAttachments(
    updater: (current: ComposerAttachment[]) => ComposerAttachment[],
  ) {
    const next = updater(attachmentsRef.current);
    attachmentsRef.current = next;
    setAttachments(next);
  }

  function removeAttachment(id: string) {
    const attachment = attachmentsRef.current.find((item) => item.id === id);
    if (!attachment) return;
    removedAttachmentIds.current.add(id);
    updateAttachments((current) => current.filter((item) => item.id !== id));
    if (attachment.preview) URL.revokeObjectURL(attachment.preview);
    if (attachment.asset) discardQuietly(attachment.asset.id);
    if (previewId === id) setPreviewId(null);
  }

  useEffect(
    () => () => {
      generation.current++;
      operation.current?.abort();
      for (const attachment of attachmentsRef.current) {
        removedAttachmentIds.current.add(attachment.id);
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
        if (attachment.asset) discardQuietly(attachment.asset.id);
      }
    },
    [],
  );

  /**
   * ★★ THE UNMOUNT CLEANUP ABOVE CANNOT SURVIVE A REAL UNLOAD. It calls a
   * Server Action, and the browser cancels that request when the page is going
   * away, so picking an image and then closing the tab left the private upload
   * until the nightly purge took it, two days later. The two effects cover
   * different exits: that one handles in-app navigation, where the request
   * completes normally; this one handles the page actually being discarded.
   *
   * ★ `sendBeacon`, NOT `fetch(..., {keepalive: true})`. It is the API built
   * for exactly this and cannot be cancelled by the unload — and because
   * `application/json` is not a CORS-simple content type, a cross-origin
   * beacon would need a preflight it cannot make, so the browser refuses one
   * outright. That is a layer above the route's own same-origin check. The
   * beacon is still the first choice (lib/http/page-exit-request.ts); a
   * same-origin keepalive fetch is sent only when the beacon is refused or
   * throws, so one throwing beacon no longer skips the attachments after it,
   * and the cross-site argument above (another site's page) holds for both.
   *
   * ★ GUARDED ON `persisted === false`, WHICH IS LOAD-BEARING. `pagehide` also
   * fires when the page goes into the back/forward cache — an ordinary mobile
   * tab switch — and that page comes BACK with the previews still on screen.
   * Deleting there would leave Send citing a URL we had already destroyed,
   * which is worse than the orphan this exists to prevent.
   */
  useEffect(() => {
    const discard = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      for (const attachment of attachmentsRef.current) {
        if (!attachment.asset) continue;
        sendPageExitRequest(
          "/api/mink/media/discard",
          new Blob([JSON.stringify({ id: attachment.asset.id })], {
            type: "application/json",
          }),
        );
      }
    };
    window.addEventListener("pagehide", discard);
    return () => window.removeEventListener("pagehide", discard);
  }, []);

  // The mic button the merchant pressed is replaced by the recorder, so focus
  // would fall to the page; it moves to Done, where Enter or Space finishes.
  useEffect(() => {
    if (dictationState === "listening")
      doneButtonRef.current?.focus({ preventScroll: true });
  }, [dictationState]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(""), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!dictationState) return;
    const hide = () => {
      if (document.hidden) cancelDictation();
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [dictationState]);

  // A missed file drop must not navigate away from the dashboard.
  useEffect(() => {
    const over = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files"))
        event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (
        event.defaultPrevented ||
        !Array.from(event.dataTransfer?.types ?? []).includes("Files")
      )
        return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!disabled && !submitting && !dictationState) {
        setError(
          `Drop up to ${MINK_INPUT_FILES} files onto the message box, or use the plus button.`,
        );
      }
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [disabled, submitting, dictationState]);

  async function choose(nextFiles: File[]) {
    if (disabled || submitting || dictationState || !nextFiles.length) return;
    setError("");
    const remaining = MINK_INPUT_FILES - attachmentsRef.current.length;
    if (nextFiles.length > remaining) {
      setError(
        `Attach up to ${MINK_INPUT_FILES} files at a time. Remove a file before adding another.`,
      );
      return;
    }
    const staged: ComposerAttachment[] = [];
    try {
      for (const next of nextFiles) {
        let localText: string | null = null;
        const image = /\.(png|jpe?g|webp)$/i.test(next.name);
        if (/\.csv$/i.test(next.name)) {
          if (!next.size || next.size > MINK_CSV_BYTES)
            throw new Error("Choose a non-empty product CSV up to 5 MiB.");
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(
              await next.arrayBuffer(),
            );
          } catch {
            throw new Error("Save this CSV as UTF-8 and attach it again.");
          }
          validateMinkCsv(text);
        } else if (/\.(txt|md)$/i.test(next.name)) {
          if (next.size > DOCUMENT_BYTES)
            throw new Error("Choose a text file up to 8 KiB.");
          localText = decodeMinkDocument(next.name, await next.arrayBuffer());
        } else {
          let kind;
          try {
            kind = inputKind(next.name);
          } catch {
            throw new Error(
              "Attach a PNG, JPEG, WebP, PDF, .txt, .md or product .csv file.",
            );
          }
          if (kind === "audio")
            throw new Error(
              "Use the microphone button for speech to text. Attach a PNG, JPEG, WebP or PDF here.",
            );
          if (!next.size || next.size > MINK_INPUT_BYTES)
            throw new Error("Choose a non-empty file up to 5 MiB.");
        }
        staged.push({
          id: randomUuid(),
          file: next,
          preview: image ? URL.createObjectURL(next) : "",
          localText,
          asset: null,
          csvFile: null,
          uploadState: image && canSaveMedia ? "uploading" : "local",
          reading: null,
        });
      }
      // ★ Local text is known exactly here, so the deterministic overflow — five
      //   3,000-character notes — is refused before anything is staged rather
      //   than at Send, where the only advice left is one the merchant cannot
      //   act on. Provider readings are reserved at their floor; the budget
      //   above shrinks them to fit.
      const all = [...attachmentsRef.current, ...staged];
      if (
        !minkAttachmentsFit(
          latestMessage.current.message.trim().length,
          all.flatMap((item) =>
            item.localText === null ? [] : [item.localText.length],
          ),
          all.filter((item) => item.localText === null).length,
        )
      )
        throw new Error(
          `Your message and these files do not fit in ${MINK_MESSAGE_MAX_CHARS.toLocaleString()} characters. Remove a file or shorten your message before attaching another.`,
        );
      updateAttachments((current) => [...current, ...staged]);
      for (const attachment of staged) {
        if (attachment.preview && canSaveMedia)
          void startUpload(attachment.id).catch((cause) =>
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not upload this image.",
            ),
          );
      }
    } catch (e) {
      for (const attachment of staged) {
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      }
      setError(e instanceof Error ? e.message : "Unsupported file.");
    }
  }

  async function startUpload(id: string): Promise<MinkAttachmentRef | null> {
    const pending = uploadPromises.current.get(id);
    if (pending) return pending;
    const attachment = attachmentsRef.current.find((item) => item.id === id);
    if (!attachment?.preview || !canSaveMedia) return attachment?.asset ?? null;
    if (attachment.asset) return attachment.asset;
    updateAttachments((current) =>
      current.map((item) =>
        item.id === id ? { ...item, uploadState: "uploading" } : item,
      ),
    );
    const promise = (async () => {
      const asset = await uploadMinkImage(attachment.file);
      if (removedAttachmentIds.current.has(id)) {
        // The card was removed while this uploaded: let the copy go now.
        await discardMinkAttachment(asset.id).catch(() => undefined);
        return null;
      }
      updateAttachments((current) =>
        current.map((item) =>
          item.id === id ? { ...item, asset, uploadState: "ready" } : item,
        ),
      );
      return asset;
    })();
    uploadPromises.current.set(id, promise);
    try {
      return await promise;
    } catch (cause) {
      updateAttachments((current) =>
        current.map((item) =>
          item.id === id ? { ...item, uploadState: "error" } : item,
        ),
      );
      throw cause;
    } finally {
      uploadPromises.current.delete(id);
    }
  }

  /**
   * Starts the microphone for dictation. Resolves once the recorder is live,
   * false when it could not start.
   */
  async function startDictation(): Promise<boolean> {
    if (
      latestMessage.current.disabled ||
      submittingRef.current ||
      dictationRef.current
    )
      return false;
    setError("");
    const id = generation.current;
    const controller = new AbortController();
    operation.current = controller;
    setDictation("starting");
    setElapsed(0);
    levelRef.current = 0;
    try {
      const finish = await startMinkRecording(
        controller.signal,
        (recording) => {
          if (id !== generation.current || controller.signal.aborted) return;
          finishRef.current = null;
          if (!recording) {
            operation.current = null;
            setDictation(null);
            setError("No speech was recorded. Try again or type your message.");
            return;
          }
          setDictation("processing");
          void transcribeRecording(recording, id, controller);
        },
        (seconds) => {
          if (id !== generation.current) return;
          setDictation("listening");
          setElapsed(Number.isFinite(seconds) ? seconds : 0);
        },
        {
          // Dictation keeps listening until the merchant presses Done; a
          // pause ends a turn only in voice chat, which has no button.
          endOnSilence: false,
          onLevel: (level) => {
            levelRef.current = Math.max(level, levelRef.current * 0.9);
          },
        },
      );
      if (id !== generation.current) return false;
      if (dictationRef.current === "starting") setDictation("listening");
      finishRef.current = dictationRef.current === "listening" ? finish : null;
      return true;
    } catch (e) {
      if (id === generation.current) {
        operation.current = null;
        setDictation(null);
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Microphone unavailable.");
      }
      return false;
    }
  }

  async function transcribeRecording(
    recording: File,
    id: number,
    controller: AbortController,
  ) {
    try {
      const transcript = await transcribeMinkRecording(
        recording,
        controller.signal,
      );
      if (id !== generation.current) return;
      // The provider heard sound but no words: nothing failed.
      if (!transcript)
        throw new Error(
          "No speech was recognised. Try again or type your message.",
        );
      const current = latestMessage.current;
      const before = current.message.trimEnd();
      const combined = before ? `${before} ${transcript}` : transcript;
      if (combined.length > MINK_MESSAGE_MAX_CHARS)
        throw new Error(
          `The transcript does not fit in the ${MINK_MESSAGE_MAX_CHARS.toLocaleString()}-character message limit. Shorten the message and try again.`,
        );
      current.onAdd(combined);
    } catch (e) {
      if (id === generation.current && !controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "Voice transcription failed. Try again or type your message.",
        );
    } finally {
      if (id === generation.current) {
        operation.current = null;
        setDictation(null);
      }
    }
  }

  function cancelDictation() {
    generation.current++;
    finishRef.current = null;
    operation.current?.abort();
    operation.current = null;
    setDictation(null);
  }

  /** Done: stop listening and turn what was said into editable text. */
  function finishDictation() {
    const finish = finishRef.current;
    finishRef.current = null;
    finish?.();
  }

  async function submit() {
    await submitMessage();
  }

  /**
   * The one send path: reads the box, uploads what is staged, and hands the
   * message to `onSubmit`. Resolves true once it did.
   *
   * A spoken turn from voice chat (`voice`) puts its transcript after what is
   * in the box and goes to `deliver` instead, so the draft and the staged
   * attachments go with it, the way they would with a typed message. If it
   * cannot go, its words are left in the box rather than lost.
   */
  async function submitMessage(voice?: {
    transcript: string;
    deliver: (message: string) => boolean;
  }): Promise<boolean> {
    const draft = latestMessage.current.message.trim();
    const current = voice
      ? [draft, voice.transcript.trim()].filter(Boolean).join(" ")
      : draft;
    const { disabled: off, onSubmit, onSubmitPrepared } = latestMessage.current;
    const send =
      voice?.deliver ??
      (onSubmit
        ? (message: string) => {
            onSubmit(message);
            return true;
          }
        : null);
    const keepSpoken = () => {
      if (voice && current) latestMessage.current.onAdd(current);
    };
    const staged = attachmentsRef.current;
    if (
      dictationRef.current ||
      (!current && !staged.length) ||
      off ||
      submittingRef.current
    ) {
      keepSpoken();
      return false;
    }
    if (!send) return false;
    if (!staged.length) {
      if (send(current)) return true;
      keepSpoken();
      return false;
    }
    if (
      staged.some((attachment) => Boolean(attachment.preview)) &&
      shouldUseMinkImageOnStorefront(current) &&
      !canSaveMedia
    ) {
      setError(
        "You need permission to add Media Library images before Mink can use this image for a product or storefront change.",
      );
      keepSpoken();
      return false;
    }
    if (!voice && onSubmitPrepared)
      return handOver(current, staged, onSubmitPrepared);

    // ★ A spoken turn still prepares here, out of sight: voice chat hides
    // this composer and waits for the finished message before it listens.
    setSubmitting(true);
    setError("");
    const id = ++generation.current;
    const controller = new AbortController();
    operation.current = controller;
    try {
      const prepared = await prepareMinkAttachments({
        text: current,
        attachments: staged,
        signal: controller.signal,
        uploadImage: (attachment) =>
          canSaveMedia ? startUpload(attachment.id) : Promise.resolve(null),
        onProgress: (attachmentId, patch) =>
          updateAttachments((items) =>
            items.map((item) =>
              item.id === attachmentId ? { ...item, ...patch } : item,
            ),
          ),
      });
      if (id !== generation.current) return false;
      for (const attachment of staged) {
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      }
      attachmentsRef.current = [];
      setAttachments([]);
      setPreviewId(null);
      // The prepared message (with its file references) stays in the box if
      // the send is refused, so nothing staged is lost.
      latestMessage.current.onAdd(prepared);
      return send(prepared);
    } catch (e) {
      if (id === generation.current && !controller.signal.aborted) {
        setError(
          e instanceof Error ? e.message : "Could not process this attachment.",
        );
        keepSpoken();
      }
      return false;
    } finally {
      if (id === generation.current) {
        operation.current = null;
        setSubmitting(false);
      }
    }
  }

  /**
   * Gives a typed message and its staged files to the chat, which shows it at
   * once and reads the files while Mink works (mink-ai `run`). The box is
   * cleared now; the files come back to it, with the reason, only if they
   * could not be read or the merchant stopped Mink first.
   *
   * ★ The reading runs on the chat's own stop signal, never on this
   * composer's `generation`: the composer remounts when the panel and the
   * full view swap, and a message the merchant has already sent must not die
   * with it. Each step's result (upload, CSV copy, reading) is kept on its
   * record, so a retry after a failure redoes only what failed, as before.
   */
  function handOver(
    draft: string,
    staged: ComposerAttachment[],
    deliver: (prepared: MinkPreparedSend) => boolean,
  ): boolean {
    const records = staged.map((item) => ({ ...item }));
    const inFlight = new Map(
      records.flatMap((record) => {
        const pending = uploadPromises.current.get(record.id);
        return pending ? [[record.id, pending] as const] : [];
      }),
    );
    const patch = (id: string, change: AttachmentProgress) => {
      const record = records.find((item) => item.id === id);
      if (record) Object.assign(record, change);
    };
    const putWordsBack = () => {
      if (!draft) return;
      const now = latestMessage.current.message.trim();
      latestMessage.current.onAdd(now ? `${draft} ${now}` : draft);
    };
    const letGo = () => {
      for (const record of records) {
        removedAttachmentIds.current.add(record.id);
        if (record.preview) URL.revokeObjectURL(record.preview);
        if (record.asset) discardQuietly(record.asset.id);
      }
    };
    const prepared: MinkPreparedSend = {
      draft,
      attachments: records.map((record) => ({
        name: record.file.name,
        kind: record.preview ? "image" : "document",
        previewUrl: record.preview || null,
      })),
      prepare: async ({ signal, setStatus }) => {
        const message = await prepareMinkAttachments({
          text: draft,
          attachments: records,
          signal,
          uploadImage: async (record) => {
            if (!canSaveMedia) return null;
            const pending = inFlight.get(record.id);
            inFlight.delete(record.id);
            // The upload that began when the photo was picked, if any.
            const asset = pending ? await pending : null;
            return asset ?? uploadMinkImage(record.file);
          },
          onProgress: patch,
          onStatus: setStatus,
        });
        const previews: Record<string, string> = {};
        for (const record of records) {
          if (!record.preview) continue;
          previews[
            record.asset
              ? `url:${record.asset.url}`
              : `file:${record.file.name}`
          ] = record.preview;
        }
        return { message, previews };
      },
      restore: (failure) => {
        if (!mountedRef.current) {
          // The chat closed or swapped views meanwhile, taking this box with
          // it: the words go back, the files are let go.
          letGo();
          putWordsBack();
          return false;
        }
        updateAttachments((current) => [
          ...records.map((record) => ({
            ...record,
            uploadState: record.asset
              ? ("ready" as const)
              : uploadPromises.current.has(record.id)
                ? ("uploading" as const)
                : ("local" as const),
          })),
          ...current,
        ]);
        putWordsBack();
        if (failure) setError(failure.message);
        return true;
      },
      discard: letGo,
    };
    attachmentsRef.current = [];
    setAttachments([]);
    setPreviewId(null);
    setError("");
    if (deliver(prepared)) return true;
    attachmentsRef.current = staged;
    setAttachments(staged);
    return false;
  }

  const iconButton =
    "inline-flex h-9 w-9 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-full text-[#666] transition hover:bg-[#f2f2f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff] disabled:cursor-not-allowed disabled:opacity-40";
  const attach = (
    <button
      type="button"
      aria-label="Add image or document"
      title="Add image or document"
      disabled={
        disabled ||
        submitting ||
        Boolean(dictationState) ||
        attachments.length >= MINK_INPUT_FILES
      }
      className={iconButton}
      onClick={() => fileRef.current?.click()}
    >
      <Plus className="h-5 w-5" aria-hidden="true" />
    </button>
  );
  const voiceOn = voiceChat.enabled;
  const micLabel = dictationState
    ? "Dictation in progress"
    : voiceOn
      ? "Voice chat is listening for you"
      : "Dictate message";
  // The on state wears the chat's lavender; the off state is the mic's twin.
  const voiceToggleOn =
    "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#ddd6f5] bg-[#f8f5ff] text-[#5b3fd0] transition hover:bg-[#efe9ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff] disabled:cursor-not-allowed disabled:opacity-40";
  const voice = (
    <>
      <button
        type="button"
        aria-label={micLabel}
        title={micLabel}
        aria-describedby={dictationHintId}
        disabled={disabled || submitting || Boolean(dictationState) || voiceOn}
        className={iconButton}
        onClick={() => void startDictation()}
      >
        <Mic className="h-5 w-5" aria-hidden="true" />
      </button>
      <span id={dictationHintId} className="sr-only">
        Dictation puts speech in the message box for you to edit and send.
      </span>
      <button
        type="button"
        aria-label="Talk with Mink"
        aria-pressed={voiceOn}
        title={
          voiceChat.support.ok ? "Talk with Mink" : voiceChat.support.reason
        }
        disabled={
          !voiceChat.support.ok ||
          (!voiceOn && (disabled || submitting || Boolean(dictationState)))
        }
        className={`${voiceOn ? voiceToggleOn : iconButton} mink-talk-button`}
        onClick={() => voiceChat.toggle()}
      >
        <AudioLines className="h-5 w-5" aria-hidden="true" />
        <span className="mink-talk-label">Talk</span>
      </button>
    </>
  );
  const recording: "dictation" | null = dictationState ? "dictation" : null;
  const listening = dictationState === "listening";
  const nearCap = elapsed >= MINK_AUDIO_SECONDS - 5;
  const recorder =
    recording === "dictation" ? (
      <div
        className="flex min-h-9 w-full min-w-0 items-center gap-2"
        data-testid="mink-recorder"
      >
        <span role="status" aria-live="polite" className="sr-only">
          {dictationState === "starting"
            ? "Starting microphone…"
            : dictationState === "processing"
              ? "Converting speech to text…"
              : "Listening. Select Done when you have finished."}
        </span>
        {dictationState === "processing" ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 px-2 text-sm text-[#5c5f62]">
            <Loader2
              className="h-4 w-4 shrink-0 animate-spin"
              aria-hidden="true"
            />
            Transcribing…
          </span>
        ) : (
          <>
            <MinkWaveform
              levelRef={levelRef}
              live={listening}
              className="flex-1 px-2 text-[#1a1a1a]"
            />
            <span
              aria-hidden="true"
              title={`Dictation stops at ${formatMinkClock(MINK_AUDIO_SECONDS)}`}
              className={`w-9 shrink-0 text-right text-xs tabular-nums ${
                nearCap ? "font-medium text-[#b45309]" : "text-[#8c9196]"
              }`}
            >
              {formatMinkClock(elapsed)}
            </span>
          </>
        )}
        <button
          type="button"
          aria-label="Cancel dictation"
          title="Cancel"
          className={iconButton}
          onClick={cancelDictation}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
        <button
          ref={doneButtonRef}
          type="button"
          aria-label="Finish dictation"
          title="Done"
          disabled={!listening}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a] text-white transition hover:bg-[#333] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-30"
          onClick={finishDictation}
        >
          <Check className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    ) : null;
  const attachment = attachments.length ? (
    <div className="mb-2 flex max-w-full flex-wrap gap-2">
      {attachments.map((item) =>
        item.preview ? (
          <div key={item.id} className="relative h-16 w-16">
            <button
              type="button"
              className="h-16 w-16 overflow-hidden rounded-xl border border-[#dedede] bg-[#f7f7f8] shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff]"
              aria-label={`View ${item.file.name}`}
              onClick={() => setPreviewId(item.id)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.preview}
                alt=""
                className="h-full w-full object-cover"
              />
              {(item.uploadState === "uploading" || submitting) && (
                <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/45 text-white">
                  <Loader2
                    className="h-5 w-5 animate-spin"
                    aria-hidden="true"
                  />
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`Remove ${item.file.name}`}
              title="Remove attachment"
              disabled={submitting}
              className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-[#d7d7d7] bg-white text-[#555] shadow-sm hover:bg-[#f3f3f3] disabled:opacity-40"
              onClick={() => removeAttachment(item.id)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div
            key={item.id}
            className="flex min-w-52 max-w-full items-center gap-2 rounded-2xl border border-[#dedede] bg-[#f7f7f8] p-2 pr-2.5 text-left shadow-sm"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              aria-label={`View ${item.file.name}`}
              onClick={() => setPreviewId(item.id)}
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white text-[#6d4dff]">
                {submitting ? (
                  <Loader2
                    className="h-5 w-5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <FileText className="h-5 w-5" aria-hidden="true" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-[#252525]">
                  {item.file.name}
                </span>
                <span className="block text-xs text-[#777]">
                  {submitting
                    ? "Processing attachment…"
                    : `${Math.max(1, Math.round(item.file.size / 1024))} KiB`}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label={`Remove ${item.file.name}`}
              title="Remove attachment"
              disabled={submitting}
              className={iconButton}
              onClick={() => removeAttachment(item.id)}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ),
      )}
    </div>
  ) : null;

  const previewAttachment = attachments.find((item) => item.id === previewId);

  return (
    <div
      className="relative min-w-0"
      aria-label="Mink AI composer"
      onKeyDown={(event) => {
        if (event.key === "Escape" && dictationState) {
          event.stopPropagation();
          cancelDictation();
        } else if (event.key === "Escape" && previewId) {
          event.stopPropagation();
          setPreviewId(null);
        }
      }}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        dragDepth.current++;
        if (!disabled && !submitting && !dictationState) setDragging(true);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect =
          disabled || submitting || dictationState ? "none" : "copy";
      }}
      onDragLeave={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        if (disabled || submitting || dictationState) return;
        void choose(Array.from(event.dataTransfer.files));
      }}
    >
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={COMPOSER_FILE_ACCEPT}
        aria-label="Choose image or document"
        className="sr-only"
        tabIndex={-1}
        disabled={
          disabled ||
          submitting ||
          Boolean(dictationState) ||
          attachments.length >= MINK_INPUT_FILES
        }
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void choose(files);
        }}
      />
      {previewAttachment && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Attachment preview: ${previewAttachment.file.name}`}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreviewId(null)}
        >
          <div
            className="relative max-h-[90dvh] max-w-4xl overflow-auto rounded-2xl bg-white p-3 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Close attachment preview"
              className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/65 text-white"
              onClick={() => setPreviewId(null)}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
            {previewAttachment.preview ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={previewAttachment.preview}
                alt={previewAttachment.file.name}
                className="max-h-[78dvh] max-w-full rounded-xl object-contain"
              />
            ) : (
              <div className="flex min-h-52 min-w-64 flex-col items-center justify-center gap-3 rounded-xl bg-[#f6f4fb] p-8 text-center">
                <FileText
                  className="h-10 w-10 text-[#6d4dff]"
                  aria-hidden="true"
                />
                <p className="max-w-sm break-all text-sm font-medium text-[#252525]">
                  {previewAttachment.file.name}
                </p>
                <p className="text-xs text-[#777]">
                  {Math.max(1, Math.round(previewAttachment.file.size / 1024))}{" "}
                  KiB
                </p>
              </div>
            )}
          </div>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {error}
        </p>
      )}
      {children ? (
        children({
          attach,
          attachment,
          voice,
          submit,
          recorder,
          recording,
          hasAttachments: attachments.length > 0,
        })
      ) : (
        <>
          {attachment}
          {recorder ?? (
            <div className="flex items-center justify-between">
              {attach}
              {voice}
            </div>
          )}
        </>
      )}
      {dragging && (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#6d4dff] bg-[#f6f2ff]/95 p-4 text-sm font-medium text-[#6d4dff]"
        >
          <Upload className="h-5 w-5" aria-hidden="true" />
          Drop up to five images or documents here
        </div>
      )}
    </div>
  );
}

function stopIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

function shortName(name: string) {
  const characters = Array.from(name);
  return characters.length > 40 ? `${characters.slice(0, 37).join("")}…` : name;
}

/**
 * The private copy of a picked photo, kept with the chat (never a Media
 * Library row). The form carries the picture as `file` and nothing else: the
 * store, the admin and the path are the server's. A refusal the server
 * answers (a role without Media manage, no private storage, the waiting cap,
 * a blocked image, the type and size rules) is shown in its own words; a
 * call that never reached the server is shown as the server's own
 * failed-upload sentence, never as the thrown text.
 */
async function uploadMinkImage(file: File): Promise<MinkAttachmentRef> {
  const form = new FormData();
  form.set("file", file);
  let result: Awaited<ReturnType<typeof uploadMinkAttachment>>;
  try {
    result = await uploadMinkAttachment(form);
  } catch {
    throw new Error(UPLOAD_FAILED);
  }
  if ("error" in result)
    throw new Error(result.error || "Could not upload this image.");
  return { id: result.id, url: result.url, filename: result.filename };
}

/**
 * Let a private copy go without waiting for the answer. A discard never
 * answers an error the composer must show, and a call that cannot reach the
 * server (a deploy in progress, a closed connection) is not one to report
 * either: a picture that was never sent is purged two days after upload.
 */
function discardQuietly(id: string) {
  void discardMinkAttachment(id).catch(() => undefined);
}

async function uploadMinkCsv(
  attachment: ComposerAttachment,
  signal: AbortSignal,
): Promise<MinkCsvReference> {
  const response = await fetch("/api/mink/product-imports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    cache: "no-store",
    body: JSON.stringify({
      id: attachment.id,
      filename: attachment.file.name.slice(0, 160),
      csv: new TextDecoder("utf-8", { fatal: true }).decode(
        await attachment.file.arrayBuffer(),
      ),
    }),
  });
  const data = await response.json();
  if (!response.ok || typeof data.file?.id !== "string")
    throw new Error(data.error || "Could not upload this CSV.");
  return data.file as MinkCsvReference;
}

async function readMinkAttachment(
  source: File,
  mode: "extract" | "design",
  signal: AbortSignal,
  maxCharacters: number,
) {
  const bytes = new Uint8Array(await source.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  stopIfAborted(signal);
  const response = await fetch("/api/mink/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    cache: "no-store",
    body: JSON.stringify({
      name: source.name,
      data: btoa(binary),
      requestKey: randomUuid(),
      // Send is explicit permission to process this visible attachment. It
      // never counts as approval for a product/storefront mutation.
      confirmed: true,
      maxCharacters,
      ...(mode === "design" ? { mode } : {}),
    }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : "Could not process this attachment.",
    );
  if (
    typeof data.text !== "string" ||
    !data.text.trim() ||
    data.text.length > maxCharacters
  )
    throw new Error("The attachment returned an invalid result.");
  return data.text.trim();
}

/**
 * Turns a message and its staged files into the one message Mink receives:
 * each CSV copied and referenced, each photo kept privately with the chat
 * (with media:manage) and read, each document read, all within the message
 * limit.
 *
 * ★ Every step's result is reported through `onProgress` as soon as it
 * exists, BEFORE the next abort check, so a send stopped or failed halfway
 * keeps the uploads and readings it already paid for, and a retry redoes only
 * what is left. A stop after an upload therefore never strands that upload.
 */
async function prepareMinkAttachments({
  text,
  attachments,
  signal,
  uploadImage,
  onProgress,
  onStatus,
}: {
  text: string;
  attachments: ComposerAttachment[];
  signal: AbortSignal;
  /** The photo's private copy; null without media:manage. Throws on failure. */
  uploadImage: (
    attachment: ComposerAttachment,
  ) => Promise<MinkAttachmentRef | null>;
  onProgress: (id: string, patch: AttachmentProgress) => void;
  onStatus?: (status: string) => void;
}): Promise<string> {
  let prepared = text;
  const several = attachments.length > 1;
  let pendingReadings = attachments.filter(
    (attachment) =>
      attachment.localText === null && !/\.csv$/i.test(attachment.file.name),
  ).length;
  for (const attachment of attachments) {
    stopIfAborted(signal);
    const name = shortName(attachment.file.name);
    if (/\.csv$/i.test(attachment.file.name)) {
      let file = attachment.csvFile;
      if (!file) {
        onStatus?.(several ? `Reading ${name}…` : "Reading your file…");
        file = await uploadMinkCsv(attachment, signal);
        onProgress(attachment.id, { csvFile: file });
      }
      prepared = addMinkCsvReference(prepared, file);
      continue;
    }
    const image = Boolean(attachment.preview);
    let asset = attachment.asset;
    if (!asset && image) {
      onStatus?.(several ? `Uploading ${name}…` : "Uploading your photo…");
      asset = await uploadImage(attachment);
      if (asset) onProgress(attachment.id, { asset });
      stopIfAborted(signal);
    }
    if (asset)
      prepared = addSavedMinkMediaReference(prepared, {
        url: asset.url,
        filename: asset.filename || attachment.file.name,
      });

    let extracted: string;
    if (attachment.localText !== null) {
      extracted = attachment.localText;
    } else {
      const mode =
        image && shouldReadMinkImageAsStorefrontDesign(text)
          ? "design"
          : "extract";
      // ★ The budget is recomputed from the message as it really stands,
      //   so a long reading early on narrows what is left for the rest
      //   instead of overflowing addReviewedMinkDocument at the end.
      const budget = minkReadingBudget(prepared.length, pendingReadings);
      if (budget === null)
        throw new Error(
          `Your message and these files do not fit in ${MINK_MESSAGE_MAX_CHARS.toLocaleString()} characters. Remove a file or shorten your message, then send again.`,
        );
      if (attachment.reading?.mode === mode) {
        extracted = attachment.reading.text;
      } else {
        onStatus?.(
          image
            ? several
              ? `Looking at ${name}…`
              : "Looking at your photo…"
            : several
              ? `Reading ${name}…`
              : "Reading your file…",
        );
        extracted = await readMinkAttachment(
          attachment.file,
          mode,
          signal,
          budget,
        );
        onProgress(attachment.id, { reading: { mode, text: extracted } });
      }
      pendingReadings--;
    }
    prepared = addReviewedMinkDocument(prepared, extracted, {
      filename: attachment.file.name,
      kind: image ? "image" : "document",
    });
  }
  stopIfAborted(signal);
  return prepared;
}

/** Product images and storefront placements need a durable exact URL. */
export function shouldUseMinkImageOnStorefront(message: string) {
  const destination =
    /\b(?:home\s?page|storefront|website|web\s?page|hero|banner|carousel|gallery|section)\b/i;
  const placement =
    /\b(?:use|add|put|place|show|feature|create|make|build|design|update|replace)\b/i;
  const directImageHandoff =
    /\b(?:(?:this|here)(?:\s+is|'s)|attached|uploaded|provided)\b.{0,40}\b(?:product\s+)?(?:image|photo|picture)\b|\b(?:use|take|keep|save|add|place|show|feature)\s+(?:this|the|my)\s+(?:product\s+)?(?:image|photo|picture)\b/i;
  const productCreation =
    /\b(?:create|add|make|set\s*up)\b.{0,60}\b(?:new\s+)?product\b|\bproduct\b.{0,60}\b(?:create|add|make|set\s*up)\b/i;
  return (
    (destination.test(message) && placement.test(message)) ||
    directImageHandoff.test(message) ||
    productCreation.test(message)
  );
}

/**
 * Exact style and structure requests benefit from the validated reader.
 *
 * ★★ THE NOUN LIST USED TO MISS THE COMMONEST SENTENCE ANYBODY TYPES. It
 * required one of storefront/website/web page/home page/landing page — so
 * "make my shop look like this", the phrase this whole path was built for,
 * matched nothing and fell back to the prose extractor. The merchant got a
 * paraphrase of their reference ("cream background, dark serif headings") in
 * place of the exact hexes and block order, with nothing anywhere saying the
 * better reader had been skipped. Shop, store, site and brand are what people
 * call their own storefront.
 *
 * ★ BOTH HALVES ARE STILL REQUIRED, which is what keeps it narrow: a noun for
 * the merchant's own storefront AND a word about how it looks or how it is
 * arranged. "Add this photo to my shop page" names a destination and no
 * appearance, so it stays an ordinary extraction.
 */
export function shouldReadMinkImageAsStorefrontDesign(message: string) {
  const surface =
    /\b(?:storefront|website|web\s?site|web\s?page|home\s?page|landing\s?page|shop|store|site|brand)\b/i;
  const appearance =
    /\b(?:design|redesign|restyle|style|styling|colou?rs?|palettes?|fonts?|typefaces?|radius|rounded|themes?|looks?|aesthetics?|vibe|layouts?|structure|similar|recreate|replicate|inspired|match(?:ing)?|like\s+this|same\s+as)\b/i;
  return surface.test(message) && appearance.test(message);
}
