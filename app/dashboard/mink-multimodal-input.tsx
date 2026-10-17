"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AudioLines,
  FileText,
  Loader2,
  Mic,
  Plus,
  Upload,
  X,
} from "lucide-react";
import {
  deleteMediaAsset,
  uploadMediaAsset,
} from "@/app/actions/media-actions";
import type { MediaAsset } from "@/lib/media/library-types";
import {
  addReviewedMinkDocument,
  decodeMinkDocument,
  DOCUMENT_BYTES,
} from "@/lib/mink/document-input";
import {
  inputKind,
  minkAttachmentsFit,
  minkReadingBudget,
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
import { useChat } from "./chat-context";
import { useMinkVoiceMode } from "./mink-voice-mode";

const COMPOSER_FILE_ACCEPT =
  ".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,text/csv,image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown";

type ComposerAttachment = {
  id: string;
  file: File;
  preview: string;
  localText: string | null;
  asset: MediaAsset | null;
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

export function MinkMultimodalInput({
  message,
  onAdd,
  onSubmit,
  disabled,
  canSaveMedia = false,
  children,
}: {
  message: string;
  onAdd: (message: string) => void;
  onSubmit?: (message: string) => void;
  disabled: boolean;
  /** Resolved server-side; the upload action rechecks this permission. */
  canSaveMedia?: boolean;
  children?: (controls: {
    attach: ReactNode;
    attachment: ReactNode;
    voice: ReactNode;
    submit: () => Promise<void>;
  }) => ReactNode;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const uploadPromises = useRef(new Map<string, Promise<MediaAsset | null>>());
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
  const [error, setError] = useState("");
  const latestMessage = useRef({ message, onAdd, onSubmit, disabled });
  const operation = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const voiceEnabledRef = useRef(false);

  useEffect(() => {
    latestMessage.current = { message, onAdd, onSubmit, disabled };
  }, [message, onAdd, onSubmit, disabled]);

  function setDictation(next: typeof dictationState) {
    dictationRef.current = next;
    setDictationState(next);
  }

  function setSubmitting(next: boolean) {
    submittingRef.current = next;
    setSubmittingState(next);
  }

  /**
   * Hands-free voice chat (the "Talk with Mink" toggle). The hook owns the
   * loop; this composer still owns the microphone and the send, so limits,
   * attachments and the one transcription route apply exactly as they do to
   * ordinary dictation. `useChat` without a provider returns a safe default
   * whose `isChatOpen` is false, which simply keeps the loop off.
   */
  const chat = useChat();
  const voiceMode = useMinkVoiceMode({
    messages: chat.messages,
    isReplying: chat.isReplying,
    isChatOpen: chat.isChatOpen,
    error: chat.error,
    listen: () => startDictation(true),
    stopListening: cancelDictation,
    send: (text) => submitMessage(text),
    onNotice: setError,
    langFallback:
      typeof navigator !== "undefined" ? navigator.language : undefined,
  });

  useEffect(() => {
    voiceEnabledRef.current = voiceMode.enabled;
  }, [voiceMode.enabled]);

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
    if (attachment.asset) void deleteMediaAsset(attachment.asset.id);
    if (previewId === id) setPreviewId(null);
  }

  useEffect(
    () => () => {
      generation.current++;
      operation.current?.abort();
      for (const attachment of attachmentsRef.current) {
        removedAttachmentIds.current.add(attachment.id);
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
        if (attachment.asset) void deleteMediaAsset(attachment.asset.id);
      }
    },
    [],
  );

  /**
   * ★★ THE UNMOUNT CLEANUP ABOVE CANNOT SURVIVE A REAL UNLOAD. It calls a
   * Server Action, and the browser cancels that request when the page is going
   * away — so picking an image and then closing the tab left the upload in the
   * merchant's Media Library permanently, with nothing marking it as a chat
   * leftover. The two effects cover different exits: that one handles in-app
   * navigation, where the request completes normally; this one handles the
   * page actually being discarded.
   *
   * ★ `sendBeacon`, NOT `fetch(..., {keepalive: true})`. It is the API built
   * for exactly this and cannot be cancelled by the unload — and because
   * `application/json` is not a CORS-simple content type, a cross-origin
   * beacon would need a preflight it cannot make, so the browser refuses one
   * outright. That is a layer above the route's own same-origin check.
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
        navigator.sendBeacon?.(
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
          id: crypto.randomUUID(),
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

  async function startUpload(id: string): Promise<MediaAsset | null> {
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
      const form = new FormData();
      form.set("file", attachment.file);
      // Kept so Mink can use it, but not listed in the Media Library: it was
      // handed to Mink, not chosen for the library.
      form.set("purpose", "mink_attachment");
      const result = await uploadMediaAsset(form);
      if (result.error || !result.asset)
        throw new Error(result.error || "Could not upload this image.");
      if (removedAttachmentIds.current.has(id)) {
        await deleteMediaAsset(result.asset.id);
        return null;
      }
      updateAttachments((current) =>
        current.map((item) =>
          item.id === id
            ? { ...item, asset: result.asset!, uploadState: "ready" }
            : item,
        ),
      );
      return result.asset;
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
   * Starts the microphone. `forVoice` marks a recording the voice loop asked
   * for: its transcript goes to the loop instead of the box, and a silent
   * recording is reported as empty rather than shown as an error. Resolves
   * once the recorder is live, false when it could not start.
   */
  async function startDictation(forVoice = false): Promise<boolean> {
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
    try {
      await startMinkRecording(
        controller.signal,
        (recording) => {
          if (id !== generation.current || controller.signal.aborted) return;
          if (!recording) {
            if (forVoice && voiceEnabledRef.current) {
              handOffToVoice(null);
              return;
            }
            operation.current = null;
            setDictation(null);
            setError("No speech was recorded. Try again or type your message.");
            return;
          }
          setDictation("processing");
          void transcribeRecording(recording, id, controller, forVoice);
        },
        () => {
          if (id === generation.current) setDictation("listening");
        },
      );
      if (id === generation.current) setDictation("listening");
      return id === generation.current;
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
    forVoice = false,
  ) {
    const toVoice = () => forVoice && voiceEnabledRef.current;
    try {
      const response = await fetch("/api/mink/voice", {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          "X-Mink-Request-Key": crypto.randomUUID(),
        },
        body: recording,
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json();
      if (id !== generation.current) return;
      const failure = () =>
        new Error(
          typeof data.error === "string"
            ? data.error
            : "Voice transcription failed. Try again or type your message.",
        );
      if (!response.ok || typeof data.text !== "string") throw failure();
      const transcript = data.text.trim();
      if (!transcript) {
        // Nothing was said: the loop listens again instead of showing an error.
        if (toVoice()) {
          handOffToVoice(null);
          return;
        }
        throw failure();
      }
      const current = latestMessage.current;
      const before = current.message.trimEnd();
      const combined = before ? `${before} ${transcript}` : transcript;
      if (combined.length > MINK_MESSAGE_MAX_CHARS)
        throw new Error(
          `The transcript does not fit in the ${MINK_MESSAGE_MAX_CHARS.toLocaleString()}-character message limit. Shorten the message and try again.`,
        );
      if (toVoice()) {
        handOffToVoice(combined);
        return;
      }
      current.onAdd(combined);
    } catch (e) {
      if (id === generation.current && !controller.signal.aborted) {
        const message =
          e instanceof Error
            ? e.message
            : "Voice transcription failed. Try again or type your message.";
        if (toVoice()) {
          voiceMode.reportTranscriptionFailure();
          setError(`${message} Voice chat turned off.`);
        } else {
          setError(message);
        }
      }
    } finally {
      if (id === generation.current) {
        operation.current = null;
        setDictation(null);
      }
    }
  }

  function cancelDictation() {
    generation.current++;
    operation.current?.abort();
    operation.current = null;
    setDictation(null);
  }

  /**
   * Hands a finished recording to the voice loop. The generation moves on
   * first, so this dictation's own cleanup cannot clobber the recording the
   * loop starts next, and the box is free for the send it makes.
   */
  function handOffToVoice(transcript: string | null) {
    generation.current++;
    operation.current = null;
    setDictation(null);
    voiceMode.reportTranscript(transcript);
  }

  async function extractAttachment(
    source: File,
    mode: "extract" | "design",
    id: number,
    controller: AbortController,
    maxCharacters: number,
  ) {
    const bytes = new Uint8Array(await source.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    if (id !== generation.current)
      throw new DOMException("Aborted", "AbortError");
    const response = await fetch("/api/mink/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      cache: "no-store",
      body: JSON.stringify({
        name: source.name,
        data: btoa(binary),
        requestKey: crypto.randomUUID(),
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

  async function submit() {
    await submitMessage();
  }

  /**
   * The one send path. A typed send reads the box; the voice loop passes its
   * transcript explicitly, because `latestMessage` only learns a new value on
   * the next render. Resolves true once the message reached `onSubmit`; a
   * spoken message that could not be sent is left in the box instead.
   */
  async function submitMessage(explicit?: string): Promise<boolean> {
    const spoken = explicit !== undefined;
    const current = (explicit ?? latestMessage.current.message).trim();
    const { disabled: off, onSubmit: send } = latestMessage.current;
    if (dictationRef.current) {
      // A typed send while the voice loop is listening wins: the merchant
      // chose the keyboard, so the mic stops rather than the send refusing.
      if (spoken || !voiceEnabledRef.current) return false;
      cancelDictation();
    }
    if (!current || off || submittingRef.current || !send) {
      if (spoken && current) latestMessage.current.onAdd(current);
      return false;
    }
    const staged = attachmentsRef.current;
    if (!staged.length) {
      if (!spoken) voiceMode.noteSend();
      send(current);
      return true;
    }

    setSubmitting(true);
    setError("");
    const id = ++generation.current;
    const controller = new AbortController();
    operation.current = controller;
    try {
      if (
        staged.some((attachment) => Boolean(attachment.preview)) &&
        shouldUseMinkImageOnStorefront(current) &&
        !canSaveMedia
      )
        throw new Error(
          "You need permission to add Media Library images before Mink can use this image for a product or storefront change.",
        );

      let prepared = current;
      let pendingReadings = staged.filter(
        (attachment) =>
          attachment.localText === null &&
          !/\.csv$/i.test(attachment.file.name),
      ).length;
      for (const attachment of staged) {
        if (/\.csv$/i.test(attachment.file.name)) {
          let file = attachment.csvFile;
          if (!file) {
            const response = await fetch("/api/mink/product-imports", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: controller.signal,
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
            file = data.file as MinkCsvReference;
            updateAttachments((items) =>
              items.map((item) =>
                item.id === attachment.id ? { ...item, csvFile: file } : item,
              ),
            );
          }
          if (id !== generation.current) return false;
          prepared = addMinkCsvReference(prepared, file);
          continue;
        }
        const image = Boolean(attachment.preview);
        const asset =
          attachment.asset ??
          (image && canSaveMedia ? await startUpload(attachment.id) : null);
        if (id !== generation.current) return false;
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
            image && shouldReadMinkImageAsStorefrontDesign(current)
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
          extracted =
            attachment.reading?.mode === mode
              ? attachment.reading.text
              : await extractAttachment(
                  attachment.file,
                  mode,
                  id,
                  controller,
                  budget,
                );
          if (id !== generation.current) return false;
          const reading = { mode, text: extracted } as const;
          updateAttachments((currentAttachments) =>
            currentAttachments.map((item) =>
              item.id === attachment.id ? { ...item, reading } : item,
            ),
          );
          pendingReadings--;
        }
        prepared = addReviewedMinkDocument(prepared, extracted, {
          filename: attachment.file.name,
          kind: image ? "image" : "document",
        });
      }
      if (id !== generation.current) return false;
      for (const attachment of staged) {
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      }
      attachmentsRef.current = [];
      setAttachments([]);
      setPreviewId(null);
      latestMessage.current.onAdd(prepared);
      if (!spoken) voiceMode.noteSend();
      send(prepared);
      return true;
    } catch (e) {
      if (id === generation.current && !controller.signal.aborted) {
        setError(
          e instanceof Error ? e.message : "Could not process this attachment.",
        );
        if (spoken) latestMessage.current.onAdd(current);
      }
      return false;
    } finally {
      if (id === generation.current) {
        operation.current = null;
        setSubmitting(false);
      }
    }
  }

  const iconButton =
    "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#666] transition hover:bg-[#f2f2f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff] disabled:cursor-not-allowed disabled:opacity-40";
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
  const voiceOn = voiceMode.enabled;
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
        disabled={disabled || submitting || Boolean(dictationState) || voiceOn}
        className={iconButton}
        onClick={() => void startDictation()}
      >
        <Mic className="h-5 w-5" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Talk with Mink"
        aria-pressed={voiceOn}
        title={
          voiceMode.support.ok ? "Talk with Mink" : voiceMode.support.reason
        }
        disabled={
          !voiceMode.support.ok || (!voiceOn && (disabled || submitting))
        }
        className={voiceOn ? voiceToggleOn : iconButton}
        onClick={() => voiceMode.toggle()}
      >
        <AudioLines className="h-5 w-5" aria-hidden="true" />
      </button>
    </>
  );
  // What the loop is doing, in the merchant's words. Transcription counts as
  // thinking: the mic is closed and Mink is working out what was said.
  const voiceStatus = !voiceOn
    ? null
    : voiceMode.state === "speaking"
      ? "Speaking…"
      : voiceMode.state === "listening" && dictationState !== "processing"
        ? dictationState === "starting"
          ? "Starting microphone…"
          : "Listening…"
        : "Thinking…";
  const micLive = !voiceOn || dictationState === "listening";
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
        if (event.key === "Escape" && voiceOn) {
          event.stopPropagation();
          voiceMode.toggle();
        } else if (event.key === "Escape" && dictationState) {
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
      {(dictationState || voiceOn) && (
        <div
          role="status"
          aria-live="polite"
          className={
            voiceOn
              ? "mb-3 flex items-center gap-3 rounded-2xl border border-[#ddd6f5] bg-[#f8f5ff] px-4 py-3 text-sm text-[#333]"
              : "mb-3 flex items-center gap-3 rounded-2xl border border-[#e5e5e5] bg-[#f7f7f7] px-4 py-3 text-sm text-[#333]"
          }
        >
          <span className="relative flex h-3 w-3 shrink-0" aria-hidden="true">
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${micLive ? "bg-red-400" : "bg-[#b9a9f3]"}`}
            />
            <span
              className={`relative inline-flex h-3 w-3 rounded-full ${micLive ? "bg-red-500" : "bg-[#5b3fd0]"}`}
            />
          </span>
          <span className="min-w-0 flex-1">
            {voiceStatus ??
              (dictationState === "starting"
                ? "Starting microphone…"
                : dictationState === "processing"
                  ? "Converting speech to editable text…"
                  : "Listening… pause when you are finished.")}
          </span>
          <button
            type="button"
            className={iconButton}
            aria-label={voiceOn ? "Stop voice chat" : "Cancel dictation"}
            title={voiceOn ? "Stop voice chat" : "Cancel dictation"}
            onClick={() => (voiceOn ? voiceMode.toggle() : cancelDictation())}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
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
        children({ attach, attachment, voice, submit })
      ) : (
        <>
          {attachment}
          <div className="flex items-center justify-between">
            {attach}
            {voice}
          </div>
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
