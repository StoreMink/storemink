"use client";

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Loader2, Send, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { InfoTip } from "@/components/ui/info-tip";
import {
  queueThemeStudioGenerationAction,
  reviseThemeStudioVersionAction,
  submitThemeStudioDetailsAction,
  removeThemeStudioReferenceAction,
} from "@/app/actions/theme-studio-actions";
import type {
  ThemeStudioChangeView,
  ThemeStudioProjectDetail,
  ThemeStudioVersionView,
} from "@/lib/theme-studio/repository";
import {
  checksOutcome,
  plainText,
  questionsOpen,
  stopNeedsThemeChange,
} from "../studio-ui";
import { clockWords, designLabel, stopReasonWords } from "../studio-words";
import { newIdempotencyKey } from "../new/new-theme-helpers";
import { StudioPopover } from "./studio-tabs";

// ---------------------------------------------------------------------------
// The theme page's chat (wave TS-2): one timeline of the operator's messages
// and Theme Studio's answers, the progress card at its end, and the composer.
//
// ★ THE COMPOSER IS THE ACTION FOR WORDS. A first brief is sent from here
// ("Start building"), an answer to the AI's questions, or a change to one
// design (each message makes a new design). The page fills it ("Describe a
// fix" puts a draft here through `putInChat`), and it never sends by itself.
//
// ★ SCREENSHOTS: "+ Screenshots" uploads new ones and lists the earlier ones
// to attach again; an upload no message has used yet can be deleted (a
// project holds at most 100, repository.ts, so without it a full project is
// stuck). Paste and drop on the message work too.
// ---------------------------------------------------------------------------

const ACCEPT = "image/jpeg,image/png,image/webp,image/avif";
const referenceUrl = (id: string) =>
  `/api/platform/theme-studio/references/${id}`;

const SCOPE_TITLE: Record<ThemeStudioChangeView["scope"], string> = {
  edit: "Small edit - only what you asked for changes",
  revise: "Larger change - revising the theme",
  recreate: "Starting over - building a new theme from scratch",
};

/** What the page can ask of the chat's composer. */
export interface ComposerApi {
  /** Put text in the message (below what is already there) and focus it.
   * Never sends. */
  fill(text: string): void;
  focus(): void;
  /** Send the message as if Send was pressed; `body` is used when the
   * message is empty (the saved brief for "Start building"). */
  send(body?: string): void;
}

function ChangeBubble({ change }: { change: ThemeStudioChangeView }) {
  const details: string[] = [];
  if (change.scope === "edit") {
    if (change.changed)
      details.push(
        `${change.changed} setting${change.changed === 1 ? "" : "s"} changed; everything else, including the pictures, is kept.`,
      );
    if (change.redraws)
      details.push(
        change.redrawsDeferred
          ? `Redraw ${change.redraws} picture${change.redraws === 1 ? "" : "s"} from the Pictures tab to finish this change.`
          : `Redrawing ${change.redraws} picture${change.redraws === 1 ? "" : "s"} to match the theme’s existing art direction.`,
      );
  }
  if (change.fellBack)
    details.push(
      "The change couldn’t be made as a simple edit, so the theme was revised instead.",
    );
  if (change.scope === "recreate")
    details.push(
      "Your earlier designs stay available to preview or make current.",
    );
  return (
    <div className="studio-bubble" data-from="studio">
      <p className="studio-bubble-meta">{SCOPE_TITLE[change.scope]}</p>
      {change.summary ? <p>{plainText(change.summary)}</p> : null}
      {details.length ? (
        <ul className="studio-muted mt-2 list-disc space-y-1 pl-5 text-xs">
          {details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ThemeConversation({
  project,
  generationEnabled,
  referenceLimit,
  target,
  canRevise,
  onSelectVersion,
  initialBody,
  now,
  working,
  lockedReason,
  progressCard,
  apiRef,
  onViewDesign,
  onOpenChecks,
  onComposerActive,
}: {
  project: ThemeStudioProjectDetail;
  generationEnabled: boolean;
  referenceLimit: number;
  /** The design a change is made to. */
  target: ThemeStudioVersionView | null;
  canRevise: boolean;
  onSelectVersion: (id: string | null) => void;
  initialBody?: string;
  /** The read time of the page's facts (ISO), for "10:05" times. */
  now: string;
  /** Theme Studio is working on this theme (building, checking or
   * publishing), so nothing new can start. */
  working: boolean;
  /** Why a message can't be sent now, in a sentence (the page knows the
   * status and the switches); shown only while the composer is locked, and
   * a general sentence when absent. */
  lockedReason?: string | null;
  /** The progress card, shown at the end of the timeline. */
  progressCard?: ReactNode;
  apiRef?: RefObject<ComposerApi | null>;
  /** Show a design in the Preview tab. */
  onViewDesign?: (versionId: string) => void;
  /** Open the Checks tab on a design. */
  onOpenChecks?: (versionId: string) => void;
  /** The composer has focus (true) or lost it (false): the phone bar hides
   * while the composer is the action. */
  onComposerActive?: (active: boolean) => void;
}) {
  const router = useRouter();
  // Waiting for answers only while the questions are open: a theme blocked
  // by its checks (security) has none and takes a change instead, as the
  // server allows (repository.ts questionsOpen, reviseThemeStudioVersion).
  const answering = project.status === "blocked" && questionsOpen(project);
  const creating = project.status === "draft";
  const [body, setBody] = useState(
    creating ? project.draftBrief : (initialBody ?? ""),
  );
  const [selected, setSelected] = useState<string[]>(() => {
    const previous = answering
      ? (project.messages.filter((message) => message.kind !== "images").at(-1)
          ?.referenceAssetIds ?? [])
      : [];
    return [
      ...new Set([
        ...previous,
        ...(creating
          ? project.references.filter((ref) => !ref.cited).map((ref) => ref.id)
          : []),
      ]),
    ].slice(0, referenceLimit);
  });
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const [submittedRevision, setSubmittedRevision] = useState<number | null>(
    null,
  );
  // One key per message, made on its first send and kept for a retry of the
  // same message (the server runs it once). Never crypto.randomUUID at
  // render: it exists only in a secure context, and a phone reaching the dev
  // server over the network is not one.
  const key = useRef<string | null>(null);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const libraryButton = useRef<HTMLButtonElement>(null);
  const editable =
    generationEnabled &&
    (creating || answering || canRevise) &&
    !working &&
    submittedRevision !== project.revision;
  const disabled = !editable || sending || uploading;
  const library = [
    ...new Set([...project.references.map((ref) => ref.id), ...uploaded]),
  ];
  const packaged = project.versions.filter((version) => version.hasPackage);
  const hasVersions = packaged.length > 0;
  const sendLabel = creating
    ? "Start building"
    : answering
      ? "Send answer"
      : "Send message";

  useEffect(() => {
    // Keep the latest answer in view without jumping the whole page.
    const node = log.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [project.messages.length, project.versions.length, project.status]);

  useEffect(() => {
    if (focusTick > 0) composer.current?.focus();
  }, [focusTick]);

  async function upload(files: File[]) {
    if (busy.current || disabled || files.length === 0) return;
    const room = referenceLimit - selected.length;
    if (files.length > room) {
      toast.error(
        `Attach up to ${referenceLimit} screenshots per message. Remove an attachment first.`,
      );
      return;
    }
    busy.current = true;
    setUploading(true);
    try {
      for (const file of files) {
        if (
          !ACCEPT.split(",").includes(file.type) ||
          file.size > 10 * 1024 * 1024
        ) {
          toast.error(
            `${file.name}: use a JPEG, PNG, WebP or AVIF image up to 10 MB.`,
          );
          continue;
        }
        try {
          const response = await fetch(
            `/api/platform/theme-studio/projects/${project.id}/references`,
            {
              method: "POST",
              body: file,
              headers: { "Content-Type": "application/octet-stream" },
            },
          );
          const result = (await response.json()) as {
            id?: string;
            error?: string;
          };
          if (!response.ok || !result.id)
            throw new Error(result.error ?? "Upload failed.");
          const id = result.id;
          setUploaded((ids) => [...new Set([...ids, id])]);
          setSelected((ids) => [...new Set([...ids, id])]);
        } catch (error) {
          toast.error(
            `${file.name}: ${error instanceof Error ? plainText(error.message) : "Upload failed. Try again."}`,
          );
        }
      }
    } finally {
      busy.current = false;
      setUploading(false);
      if (input.current) input.current.value = "";
      router.refresh();
    }
  }

  async function removeUpload(id: string) {
    if (busy.current) return;
    busy.current = true;
    setUploading(true);
    try {
      const result = await removeThemeStudioReferenceAction({
        projectId: project.id,
        assetId: id,
      });
      if (!result.ok) {
        toast.error(result.error ?? "The screenshot couldn't be deleted.");
        return;
      }
      setSelected((ids) => ids.filter((item) => item !== id));
      setUploaded((ids) => ids.filter((item) => item !== id));
      router.refresh();
    } catch {
      toast.error("The screenshot couldn't be deleted.");
    } finally {
      busy.current = false;
      setUploading(false);
    }
  }

  async function send(fallback?: string) {
    const text = (body.trim() ? body : (fallback ?? "")).trim();
    if (busy.current || disabled || !text) return;
    busy.current = true;
    setSending(true);
    const idempotencyKey = (key.current ??= newIdempotencyKey());
    try {
      const common = {
        projectId: project.id,
        expectedRevision: project.revision,
        body: text,
        referenceAssetIds: selected,
        idempotencyKey,
      };
      const result = creating
        ? await queueThemeStudioGenerationAction(common)
        : answering
          ? await submitThemeStudioDetailsAction(common)
          : target
            ? await reviseThemeStudioVersionAction({
                ...common,
                versionId: target.id,
                expectedPackageDigest: target.packageDigest ?? "",
              })
            : { ok: false, error: "Choose a design to change." };
      if (!result.ok) {
        toast.error(
          result.error
            ? plainText(result.error)
            : "Your message couldn't be sent.",
        );
        return;
      }
      setSubmittedRevision(project.revision);
      setBody("");
      setSelected([]);
      key.current = null;
      onSelectVersion(null);
      router.refresh();
    } catch {
      toast.error(
        "Your message couldn't be confirmed. Try again; the same request won't run twice.",
      );
    } finally {
      busy.current = false;
      setSending(false);
    }
  }

  useImperativeHandle(apiRef, () => ({
    fill(text: string) {
      setBody((previous) => {
        const current = previous.trimEnd();
        if (!current) return text;
        return current.includes(text.trim())
          ? previous
          : `${current}\n\n${text}`;
      });
      setFocusTick((tick) => tick + 1);
    },
    focus() {
      setFocusTick((tick) => tick + 1);
    },
    send(fallback?: string) {
      void send(fallback);
    },
  }));

  const timeline = [
    ...project.messages
      .filter((message) => message.kind !== "images" && !message.automatic)
      .map((message) => ({
        id: message.id,
        createdAt: message.createdAt,
        content: (
          <div className="studio-bubble" data-from="operator">
            <p className="studio-bubble-meta">
              You, {clockWords(message.createdAt, now)}
            </p>
            <p className="whitespace-pre-wrap">{message.body}</p>
            {message.referenceAssetIds?.length > 0 ? (
              <div className="studio-thumbs">
                {message.referenceAssetIds.map((id, index) => (
                  <a
                    key={id}
                    href={referenceUrl(id)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open screenshot ${index + 1}`}
                    className="studio-thumb"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- private reference route */}
                    <img
                      src={referenceUrl(id)}
                      alt={`Attached screenshot ${index + 1}`}
                      loading="lazy"
                    />
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        ),
      })),
    ...packaged.map((version) => {
      const outcome = checksOutcome(version.id, project.events);
      const stopped = outcome ? !outcome.passed : version.qaStatus === "failed";
      const label = designLabel(version.versionNumber);
      return {
        id: version.id,
        createdAt: version.createdAt,
        content: (
          <div className="studio-bubble" data-from="studio">
            <p className="studio-bubble-meta flex items-center gap-2">
              <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
              Theme Studio, {label}
            </p>
            <p>{plainText(version.summary)}</p>
            {stopped ? (
              <p className="studio-muted mt-2 text-xs">
                {stopNeedsThemeChange(outcome?.code)
                  ? `The automatic checks stopped on ${label}. Read why in Checks, then describe what to fix.`
                  : `The automatic checks stopped on ${label}. Read why in Checks; the theme itself does not need a change.`}
              </p>
            ) : null}
            <div className="studio-bubble-actions">
              {onViewDesign ? (
                <button
                  type="button"
                  className="studio-link"
                  onClick={() => onViewDesign(version.id)}
                >
                  Preview {label}
                </button>
              ) : null}
              {stopped && onOpenChecks ? (
                <button
                  type="button"
                  className="studio-link"
                  onClick={() => onOpenChecks(version.id)}
                >
                  Open Checks
                </button>
              ) : null}
              {canRevise ? (
                <button
                  type="button"
                  className="studio-link"
                  onClick={() => {
                    onSelectVersion(version.id);
                    setFocusTick((tick) => tick + 1);
                  }}
                >
                  Change this design
                </button>
              ) : null}
            </div>
          </div>
        ),
      };
    }),
    ...project.runs
      .filter((run) => run.change && run.status === "succeeded")
      .map((run) => ({
        id: `change-${run.id}`,
        createdAt: run.finishedAt ?? run.createdAt,
        content: <ChangeBubble change={run.change!} />,
      })),
    ...project.runs
      .filter(
        (run) =>
          run.questions.length ||
          run.declineReason ||
          run.status === "failed" ||
          run.status === "cancelled",
      )
      .map((run) => ({
        id: `response-${run.id}`,
        createdAt: run.finishedAt ?? run.createdAt,
        content: (
          <div className="studio-bubble" data-from="studio">
            <p className="studio-bubble-meta">Theme Studio</p>
            {run.questions.length ? (
              <>
                <p>I need a little more detail to continue:</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {run.questions.map((question) => (
                    <li key={question}>{plainText(question)}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                {run.declineReason
                  ? plainText(run.declineReason)
                  : run.status === "cancelled"
                    ? hasVersions
                      ? "This request was stopped. Your earlier designs are still available."
                      : "This request was stopped before a design was made."
                    : `${plainText(stopReasonWords(run.errorCode, "run"))}${hasVersions ? " Your earlier designs are still available." : ""}`}
              </p>
            )}
          </div>
        ),
      })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const placeholder = working
    ? "You can send changes when it finishes."
    : answering
      ? "Reply to the questions above."
      : creating
        ? "Describe what to build"
        : "Describe a change";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={log}
        className="studio-chat-log"
        role="log"
        aria-label="Chat with Theme Studio"
      >
        {timeline.length ? (
          timeline.map((entry) => <div key={entry.id}>{entry.content}</div>)
        ) : (
          <div className="studio-bubble" data-from="studio">
            Tell me what you want to build, and attach screenshots of stores you
            like.
          </div>
        )}
        {progressCard}
        {!working && submittedRevision === project.revision ? (
          <p role="status" className="studio-loading">
            <Loader2 aria-hidden="true" className="h-4 w-4 studio-spin" />
            Sent. Theme Studio is starting; this page updates by itself.
          </p>
        ) : null}
      </div>
      <form
        className="studio-composer"
        aria-label="Message Theme Studio"
        // Locked (Theme Studio works, publishes, or the theme takes no
        // change): on a phone it folds to its one-line reason (studio.css),
        // so the progress card above it keeps the room.
        data-locked={
          !editable && submittedRevision !== project.revision
            ? "true"
            : undefined
        }
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        onFocus={() => onComposerActive?.(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            onComposerActive?.(false);
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files"))
            event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length) {
            event.preventDefault();
            void upload(Array.from(event.dataTransfer.files));
          }
        }}
      >
        {canRevise && target ? (
          <div className="studio-muted flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-2">
              Changing
              <select
                aria-label="Design to change"
                value={target.id}
                disabled={disabled}
                onChange={(event) => onSelectVersion(event.target.value)}
              >
                {packaged.map((version) => (
                  <option key={version.id} value={version.id}>
                    {designLabel(version.versionNumber)}
                    {version.id === project.currentVersionId
                      ? " (current)"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <span>Each message makes a new design.</span>
            <InfoTip label="About changes">
              Small requests change only that. Say “start over” to rebuild from
              scratch.
            </InfoTip>
          </div>
        ) : null}
        <textarea
          ref={composer}
          aria-label="Message Theme Studio"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={12000}
          disabled={disabled}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.files).filter(
              (file) => file.type.startsWith("image/"),
            );
            if (images.length) {
              event.preventDefault();
              void upload(images);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={placeholder}
        />
        {selected.length ? (
          <ul className="studio-thumbs" aria-label="Message attachments">
            {selected.map((id, index) => (
              <li key={id} className="studio-thumb">
                {/* eslint-disable-next-line @next/next/no-img-element -- private reference route */}
                <img
                  src={referenceUrl(id)}
                  alt={`Screenshot ${index + 1} to send`}
                />
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove screenshot ${index + 1} from message`}
                  className="studio-thumb-remove"
                  onClick={() =>
                    setSelected((ids) => ids.filter((item) => item !== id))
                  }
                >
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {/* Reached through "Upload screenshots" in the Screenshots list, so
            it is no invisible stop in the Tab order. */}
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          aria-label="Upload screenshots"
          className="sr-only"
          tabIndex={-1}
          disabled={disabled}
          onChange={(event) =>
            void upload(Array.from(event.target.files ?? []))
          }
        />
        <div className="studio-composer-row">
          <span className="studio-popover-anchor">
            <button
              ref={libraryButton}
              type="button"
              aria-expanded={libraryOpen}
              aria-controls="studio-screenshots"
              onClick={() => setLibraryOpen((open) => !open)}
              className="dash-btn dash-btn-ghost dash-btn-sm"
            >
              {uploading ? (
                <Loader2 aria-hidden="true" className="h-4 w-4 studio-spin" />
              ) : (
                <ImagePlus aria-hidden="true" className="h-4 w-4" />
              )}
              Screenshots
              <span className="studio-muted">
                <span className="sr-only">, attached: </span>
                {selected.length}/{referenceLimit}
              </span>
            </button>
            <StudioPopover
              id="studio-screenshots"
              open={libraryOpen}
              onOpenChange={setLibraryOpen}
              triggerRef={libraryButton}
              label="Screenshots"
              align="start"
              place="above"
            >
              <div className="studio-library">
                <button
                  type="button"
                  disabled={disabled || selected.length >= referenceLimit}
                  onClick={() => input.current?.click()}
                  className="dash-btn dash-btn-ghost dash-btn-sm"
                >
                  <ImagePlus aria-hidden="true" className="h-4 w-4" /> Upload
                  screenshots
                </button>
                <p className="studio-muted text-xs">
                  {selected.length} of {referenceLimit} attached. JPEG, PNG,
                  WebP or AVIF, up to 10 MB each and 40 MB per message. You can
                  also paste or drop them.
                </p>
                {library.length ? (
                  <>
                    <p className="text-sm font-semibold">
                      Earlier screenshots ({library.length})
                    </p>
                    <ul className="studio-library-grid">
                      {library.map((id, index) => {
                        const unused = project.references.some(
                          (ref) => ref.id === id && !ref.cited,
                        );
                        return (
                          <li key={id} className="studio-library-item">
                            {/* eslint-disable-next-line @next/next/no-img-element -- private reference route */}
                            <img
                              src={referenceUrl(id)}
                              alt={`Earlier screenshot ${index + 1}`}
                              loading="lazy"
                            />
                            <label className="studio-check-label">
                              <input
                                type="checkbox"
                                checked={selected.includes(id)}
                                disabled={
                                  disabled ||
                                  (!selected.includes(id) &&
                                    selected.length >= referenceLimit)
                                }
                                onChange={(event) =>
                                  setSelected((ids) =>
                                    event.target.checked
                                      ? [...ids, id]
                                      : ids.filter((item) => item !== id),
                                  )
                                }
                              />
                              Attach screenshot {index + 1}
                            </label>
                            {unused ? (
                              <button
                                type="button"
                                disabled={disabled}
                                aria-label={`Delete screenshot ${index + 1}`}
                                className="dash-btn dash-btn-ghost dash-btn-sm"
                                onClick={() => void removeUpload(id)}
                              >
                                <Trash2
                                  aria-hidden="true"
                                  className="h-3.5 w-3.5"
                                />
                                Delete
                              </button>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="studio-muted text-xs">
                      Only screenshots no message has used can be deleted.
                    </p>
                  </>
                ) : (
                  <p className="studio-muted text-xs">
                    No earlier screenshots yet.
                  </p>
                )}
              </div>
            </StudioPopover>
          </span>
          <button
            type="submit"
            disabled={disabled || !body.trim()}
            className="dash-btn dash-btn-primary"
          >
            {sending ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 studio-spin" />
            ) : (
              <Send aria-hidden="true" className="h-4 w-4" />
            )}
            {sendLabel}
          </button>
        </div>
        {!editable && submittedRevision !== project.revision ? (
          <p className="studio-reason">
            {lockedReason ??
              (!generationEnabled
                ? "Building is switched off on this deployment, so messages can't be sent now."
                : "Theme Studio can't take a message right now. Use the button at the top of the page.")}
          </p>
        ) : (
          <p className="studio-muted text-xs">Ctrl or ⌘ and Enter to send.</p>
        )}
      </form>
    </div>
  );
}
