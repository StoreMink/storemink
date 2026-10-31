"use client";

import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronLeft,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  archiveThemeStudioProjectAction,
  cancelThemeStudioRunAction,
  recheckThemeStudioVersionAction,
  restoreThemeStudioVersionAction,
  retryThemeStudioRunAction,
  stopThemeStudioChecksAction,
} from "@/app/actions/theme-studio-actions";
import type {
  ThemeStudioProjectDetail,
  ThemeStudioRestoreOutcome,
  ThemeStudioVersionView,
} from "@/lib/theme-studio/repository";
import type { DistinctnessReport } from "@/lib/theme-studio/fingerprint";
import type {
  ThemeStudioBuildTimeRange,
  ThemeStudioProgress,
} from "@/lib/theme-studio/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  STUDIO_MENU_KINDS,
  STUDIO_RELEASE_ROWS,
  type StudioAction,
  type StudioActionKind,
  type StudioStatus,
} from "../studio-status";
import {
  StudioBadge,
  checksOutcome,
  plainText,
  questionsOpen,
} from "../studio-ui";
import { clockWords, designLabel } from "../studio-words";
import { useStudioProgress } from "../use-studio-progress";
import { newIdempotencyKey } from "../new/new-theme-helpers";
import { ThemeConversation, type ComposerApi } from "./conversation";
import { DeleteThemeDialog } from "./delete-theme-button";
import { ProgressCard, type StudioPlan } from "./progress-card";
import {
  StudioPageProvider,
  StudioPopover,
  StudioTabList,
  studioPanelId,
  studioTabId,
  useIsPhone,
  useStudioIntent,
  type StudioTabItem,
} from "./studio-tabs";
import {
  STUDIO_TAB_KEYS,
  studioPageHref,
  type StudioPageApi,
  type StudioTabKey,
} from "./tab-types";
import { PreviewFrame } from "./versions/[versionId]/preview-frame";

// ---------------------------------------------------------------------------
// The theme page (wave TS-2, plan section 4 "Theme page"): one full-width
// page with the chat on the left, which folds to a rail and keeps its width,
// and the tabs on the right (Preview, Checks, Pictures, Changes, Log). The
// header has the status words and one main button from the one status
// function (studio-status.ts), the Design list and the "..." menu.
//
// ★ EVERYTHING SHOWN WAS READ ON THE SERVER behind the superadmin gate
// ([projectId]/page.tsx); every button calls an action that checks it again.
//
// ★ THE PAGE REFRESHES ONLY WHEN THE THEME CHANGED. The progress route is
// polled (use-studio-progress.ts, a GET route, so a poll never holds back
// Publish, Send or Stop) while something works, and the whole page is
// fetched again only when the revision or the list of designs changed. The
// old page re-rendered everything every 2.5 seconds.
//
// ★ THE PREVIEW STAYS LOADED. Every other tab is a server component the page
// renders only while it is open; the Preview tab is this file's own and is
// only hidden while another tab is open, so its frame keeps its page.
//
// ★ WORDS. Plain sentences; codes, the model, the creator and the build are
// in the Log tab and in Checks, Technical details only. A design's name is
// designLabel(version number). The code's state names never appear.
// ---------------------------------------------------------------------------

/** The Make current outcome in the operator's words. */
export function restoredMessage(
  versionNumber: number,
  outcome: ThemeStudioRestoreOutcome | undefined,
  changed = true,
): string {
  const design = designLabel(versionNumber);
  if (!changed) return `${design} is already current.`;
  switch (outcome) {
    case "ready_to_publish":
      return `${design} is current and Ready to publish.`;
    case "rechecking":
      return `${design} is current. Checking it again on today's StoreMink build, about 3 to 5 minutes.`;
    case "checking":
      return `${design} is current. Checking it now, about 3 to 5 minutes.`;
    default:
      return `${design} is current.`;
  }
}

/** What Check again started, in the operator's words. */
export function recheckMessage(versionNumber: number, inPlace: boolean) {
  const design = designLabel(versionNumber);
  return inPlace
    ? `Checking ${design} again on today's StoreMink build. About 3 to 5 minutes; you can leave this page.`
    : `Checking ${design} on today's StoreMink build with fresh catalogue pictures. It takes a few minutes; you can leave this page.`;
}

/** What Stop left the theme doing, in the operator's words. */
export function stoppedMessage(result: {
  status?: string;
  cancelling?: boolean;
}): string {
  if (result.cancelling)
    return "Stopping. The build step stops within a few seconds.";
  if (result.status === "failed")
    return "Stopped. This theme has no design yet: press Continue building to start it again.";
  return "Stopped. The theme is back on its last design.";
}

/** Whether the one automatic variety correction changed the design (the
 * Checks tab shows the distinctness warning with it). */
export function varietyCorrectionNote(report: DistinctnessReport): string {
  const pct = (score: number) => `${Math.round(score * 100)}%`;
  if (report.beforeScore == null || report.score == null)
    return "One automatic variety correction was attempted.";
  return report.score > report.beforeScore
    ? `One automatic variety correction raised distinctness from ${pct(report.beforeScore)} to ${pct(report.score)}.`
    : "One automatic variety correction was attempted but did not make the design more distinct, so the original design was kept.";
}

// ------------------------------------------------------------ chat width

const CHAT_PREFS_KEY = "studio:chat";
const CHAT_DEFAULT_WIDTH = 400;
const CHAT_MIN_WIDTH = 300;
const CHAT_MAX_WIDTH = 640;
const CHAT_STEP = 16;
const chatListeners = new Set<() => void>();

interface ChatPrefs {
  width: number;
  folded: boolean;
}

function readChatPrefsRaw(): string {
  try {
    return window.localStorage.getItem(CHAT_PREFS_KEY) ?? "";
  } catch {
    return "";
  }
}

function chatMaxWidth(): number {
  return typeof window === "undefined"
    ? CHAT_MAX_WIDTH
    : Math.max(
        CHAT_MIN_WIDTH,
        Math.min(CHAT_MAX_WIDTH, Math.round(window.innerWidth * 0.5)),
      );
}

function clampChatWidth(width: number): number {
  return Math.round(Math.min(chatMaxWidth(), Math.max(CHAT_MIN_WIDTH, width)));
}

/** The chat's remembered width and fold (stored text; bad text is ignored). */
export function parseChatPrefs(raw: string): ChatPrefs {
  try {
    const value = JSON.parse(raw) as Partial<ChatPrefs>;
    const width =
      typeof value.width === "number" && Number.isFinite(value.width)
        ? Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, value.width))
        : CHAT_DEFAULT_WIDTH;
    return { width, folded: value.folded === true };
  } catch {
    return { width: CHAT_DEFAULT_WIDTH, folded: false };
  }
}

function writeChatPrefs(prefs: ChatPrefs) {
  try {
    window.localStorage.setItem(CHAT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private browsing or a full store: the width still holds until reload.
  }
  for (const listener of chatListeners) listener();
}

function subscribeChatPrefs(listener: () => void): () => void {
  chatListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    chatListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** The refused start New theme handed over (contract 8.1), read and
 * removed once. */
function takeRefusedStart(projectId: string): string | null {
  const key = `studio:start-refused:${projectId}`;
  try {
    const text = window.sessionStorage.getItem(key);
    if (text !== null) window.sessionStorage.removeItem(key);
    return text?.trim() ? text : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------- small controls

/**
 * "Check again" on the current design: one capture on today's StoreMink
 * build and the design review, nothing redrawn and no paid restyle
 * (recheckThemeStudioVersionAction). Also used by today's Checks page.
 */
export function CheckAgainButton({
  projectId,
  versionId,
  versionNumber,
  revision,
  disabled = false,
  label = "Check again",
  primary = false,
  id,
}: {
  projectId: string;
  versionId: string;
  versionNumber: number;
  revision: number;
  disabled?: boolean;
  label?: string;
  primary?: boolean;
  id?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      id={id}
      type="button"
      disabled={disabled || pending}
      onClick={() =>
        startTransition(async () => {
          try {
            const result = await recheckThemeStudioVersionAction({
              projectId,
              versionId,
              expectedRevision: revision,
            });
            if (!result.ok) {
              toast.error(
                plainText(result.error ?? "The check couldn't start."),
              );
              return;
            }
            toast.success(
              recheckMessage(versionNumber, result.inPlace !== false),
            );
            router.refresh();
          } catch {
            toast.error(
              "The request failed. Reload the page before trying again.",
            );
          }
        })
      }
      className={
        primary ? "dash-btn dash-btn-primary" : "dash-btn dash-btn-ghost"
      }
    >
      <RefreshCw aria-hidden="true" className="h-4 w-4" />
      {pending ? "Starting…" : label}
    </button>
  );
}

/**
 * Try a stopped or failed step again (retryThemeStudioRunAction): it reuses
 * the pictures the step already drew. The header's "Continue building" and
 * "Try again", and the Log tab's Retry.
 */
export function RetryRunButton({
  projectId,
  runId,
  label = "Retry",
  primary = false,
  small = false,
  disabled = false,
  id,
}: {
  projectId: string;
  runId: string | null;
  label?: string;
  primary?: boolean;
  small?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const classes = [
    "dash-btn",
    primary ? "dash-btn-primary" : "dash-btn-ghost",
    small ? "dash-btn-sm" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className="studio-action">
      <button
        id={id}
        type="button"
        disabled={disabled || pending || !runId}
        onClick={() =>
          runId &&
          startTransition(async () => {
            try {
              const result = await retryThemeStudioRunAction({
                projectId,
                runId,
                // Not crypto.randomUUID: it exists only in a secure context,
                // and a phone reaching the dev server over the network is not.
                idempotencyKey: newIdempotencyKey(),
              });
              if (!result.ok) {
                toast.error(plainText(result.error ?? "That didn't start."));
                return;
              }
              toast.success("Started again.");
              router.refresh();
            } catch {
              toast.error(
                "The request failed. Reload the page before trying again.",
              );
            }
          })
        }
        className={classes}
      >
        <RotateCcw aria-hidden="true" className="h-4 w-4" />
        {pending ? "Starting…" : label}
      </button>
      {!runId ? (
        <span className="studio-reason">
          The stopped step could not be found. Reload the page.
        </span>
      ) : null}
    </span>
  );
}

/**
 * Cancel one step in the Log tab, behind a confirm: cancelling an automatic
 * step ends the automatic checks and shows the design it was building, and a
 * photo run keeps what it drew for a Retry of that step.
 */
export function CancelRunButton({
  projectId,
  runId,
  pictures,
  disabled = false,
}: {
  projectId: string;
  runId: string;
  pictures: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  function cancel() {
    startTransition(async () => {
      try {
        const result = await cancelThemeStudioRunAction({ projectId, runId });
        if (!result.ok) {
          setError(
            plainText(result.error ?? "The step couldn't be cancelled."),
          );
          return;
        }
        toast.success("Cancellation requested.");
        setOpen(false);
        router.refresh();
      } catch {
        setError("The request failed. Reload the page before trying again.");
      }
    });
  }
  return (
    <>
      <button
        type="button"
        disabled={disabled || pending}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="dash-btn dash-btn-ghost dash-btn-sm"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" /> Cancel
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
      >
        <DialogContent className="studio-root">
          <DialogHeader>
            <DialogTitle>Cancel this step?</DialogTitle>
            <DialogDescription>
              A waiting step stops at once; a running one within seconds.{" "}
              {pictures ? "Drawn pictures are kept for Retry. " : ""}
              Automatic checks stop with it.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="studio-error text-sm">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <button
              type="button"
              disabled={pending}
              onClick={() => setOpen(false)}
              className="dash-btn dash-btn-ghost"
            >
              Keep going
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={cancel}
              className="dash-btn dash-btn-primary"
            >
              {pending ? "Cancelling…" : "Cancel step"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------- dialogs

type MenuDialog =
  | "stop"
  | "stop_and_check_again"
  | "remove_from_list"
  | "delete";

function useResetOnOpen(open: boolean, reset: () => void) {
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) reset();
  }
}

/** Stop, behind a dialog that says what is stopped and what is kept. */
function StopDialog({
  open,
  onOpenChange,
  projectId,
  name,
  revision,
  hasVersion,
  returnFocusTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  name: string;
  revision: number;
  hasVersion: boolean;
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  useResetOnOpen(open, () => setError(null));
  function stop() {
    startTransition(async () => {
      try {
        const result = await stopThemeStudioChecksAction({
          projectId,
          expectedRevision: revision,
        });
        if (!result.ok) {
          setError(plainText(result.error ?? "Theme Studio couldn't stop."));
          return;
        }
        toast.success(stoppedMessage(result));
        onOpenChange(false);
        router.refresh();
      } catch {
        setError("The request failed. Reload the page before trying again.");
      }
    });
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent className="studio-root" finalFocus={returnFocusTo}>
        <DialogHeader>
          <DialogTitle>Stop work on {name}?</DialogTitle>
          <DialogDescription>
            Pictures already drawn are saved, and Continue building reuses them.{" "}
            {hasVersion
              ? "The theme goes back to its last design."
              : "Any design it was checking is shown; with none, the theme shows as Stopped."}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="studio-error text-sm">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <button
            type="button"
            disabled={pending}
            onClick={() => onOpenChange(false)}
            className="dash-btn dash-btn-ghost"
          >
            Keep going
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={stop}
            className="dash-btn dash-btn-primary"
          >
            {pending ? "Stopping…" : "Stop now"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Row 6 ("Stuck"): one dialog that stops the stuck work, waits until the
 * page shows the stop (a newer revision: the stop moved the theme), then
 * checks the current design again with that revision. A build step still
 * finishing its stop says so instead; the theme then shows Stopped.
 */
function StopAndCheckDialog({
  open,
  onOpenChange,
  projectId,
  name,
  revision,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  name: string;
  revision: number;
  current: ThemeStudioVersionView | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<
    "confirm" | "waiting" | "cancelling" | "late"
  >("confirm");
  const [stoppedAt, setStoppedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  useResetOnOpen(open, () => {
    setPhase("confirm");
    setStoppedAt(null);
    setError(null);
  });

  function stop() {
    startTransition(async () => {
      try {
        const result = await stopThemeStudioChecksAction({
          projectId,
          expectedRevision: revision,
        });
        if (!result.ok) {
          setError(plainText(result.error ?? "Theme Studio couldn't stop."));
          return;
        }
        router.refresh();
        if (result.cancelling) {
          setPhase("cancelling");
          return;
        }
        if (result.status === "failed") {
          toast.success(stoppedMessage(result));
          onOpenChange(false);
          return;
        }
        setStoppedAt(revision);
        setPhase("waiting");
      } catch {
        setError("The request failed. Reload the page before trying again.");
      }
    });
  }

  const checkAgain = useEffectEvent(() => {
    if (!current) {
      toast.success(stoppedMessage({ status: "failed" }));
      onOpenChange(false);
      return;
    }
    startTransition(async () => {
      try {
        const result = await recheckThemeStudioVersionAction({
          projectId,
          versionId: current.id,
          expectedRevision: revision,
        });
        if (!result.ok) {
          setError(
            `Stopped, but the check couldn't start: ${plainText(result.error ?? "reload the page and try again.")}`,
          );
          setPhase("late");
          return;
        }
        toast.success(
          recheckMessage(current.versionNumber, result.inPlace !== false),
        );
        onOpenChange(false);
        router.refresh();
      } catch {
        setError(
          "Stopped, but the request to check again failed. Reload the page and check the theme again.",
        );
        setPhase("late");
      }
    });
  });

  // The stop landed when the page shows a newer revision; then check again
  // with that revision (never a guessed one).
  const landed =
    phase === "waiting" && stoppedAt !== null && revision !== stoppedAt;
  useEffect(() => {
    if (landed) checkAgain();
  }, [landed]);

  // A page that never shows the stop: say so instead of waiting forever.
  useEffect(() => {
    if (phase !== "waiting") return;
    const timer = window.setTimeout(() => setPhase("late"), 15_000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const busy = pending || phase === "waiting";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="studio-root">
        <DialogHeader>
          <DialogTitle>
            Stop the stuck work on {name} and check again?
          </DialogTitle>
          <DialogDescription>
            The stuck work holds the theme. This stops it, keeping drawn
            pictures, then checks the current design again, about 3 to 5
            minutes.
          </DialogDescription>
        </DialogHeader>
        {phase === "waiting" || (pending && phase !== "confirm") ? (
          <p role="status" className="studio-loading">
            <Loader2 aria-hidden="true" className="h-4 w-4 studio-spin" />
            Stopped. Starting the check…
          </p>
        ) : null}
        {phase === "cancelling" ? (
          <p role="status" className="text-sm">
            A build step is still finishing its stop. Then the theme shows
            Stopped and you can check it again.
          </p>
        ) : null}
        {phase === "late" && !error ? (
          <p role="status" className="text-sm">
            Stopped, but this page hasn&apos;t shown it yet. Reload, then check
            the theme again.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="studio-error text-sm">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          {phase === "confirm" ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onOpenChange(false)}
                className="dash-btn dash-btn-ghost"
              >
                Keep waiting
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={stop}
                className="dash-btn dash-btn-primary"
              >
                {pending ? "Stopping…" : "Stop and check again"}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onOpenChange(false)}
              className="dash-btn dash-btn-ghost"
            >
              Close
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Remove from list (keeps its history)": today's Archive, in a dialog. */
function RemoveFromListDialog({
  open,
  onOpenChange,
  projectId,
  name,
  revision,
  returnFocusTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  name: string;
  revision: number;
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  useResetOnOpen(open, () => setError(null));
  function remove() {
    startTransition(async () => {
      try {
        const result = await archiveThemeStudioProjectAction({
          projectId,
          expectedRevision: revision,
        });
        if (!result.ok) {
          setError(plainText(result.error ?? "The theme couldn't be removed."));
          return;
        }
        toast.success("Removed from the list. Its history is kept.");
        onOpenChange(false);
        router.refresh();
      } catch {
        setError("The request failed. Reload the page before trying again.");
      }
    });
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent className="studio-root" finalFocus={returnFocusTo}>
        <DialogHeader>
          <DialogTitle>Remove {name} from the list?</DialogTitle>
          <DialogDescription>
            It moves to Archived and can&apos;t be changed or published again.
            Its designs, checks and history are kept; Delete erases them.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="studio-error text-sm">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <button
            type="button"
            disabled={pending}
            onClick={() => onOpenChange(false)}
            className="dash-btn dash-btn-ghost"
          >
            Keep it
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={remove}
            className="dash-btn dash-btn-primary"
          >
            {pending ? "Removing…" : "Remove from list"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------- Design list

function MakeCurrentButton({
  projectId,
  version,
  revision,
  disabled,
  onDone,
}: {
  projectId: string;
  version: ThemeStudioVersionView;
  revision: number;
  disabled: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={disabled || pending}
      onClick={() =>
        startTransition(async () => {
          try {
            const result = await restoreThemeStudioVersionAction({
              projectId,
              versionId: version.id,
              expectedRevision: revision,
            });
            if (!result.ok) {
              toast.error(
                plainText(
                  result.error ?? "That design couldn't be made current.",
                ),
              );
              return;
            }
            toast.success(
              restoredMessage(
                version.versionNumber,
                result.outcome,
                result.changed,
              ),
            );
            onDone();
            router.refresh();
          } catch {
            toast.error(
              "The request failed. Reload the page before trying again.",
            );
          }
        })
      }
      className="dash-btn dash-btn-ghost dash-btn-sm"
    >
      {pending ? "Making it current…" : "Make current"}
    </button>
  );
}

function designOrigin(
  version: ThemeStudioVersionView,
  numbers: Map<string, number>,
): string | null {
  if (!version.parentVersionId) return null;
  const parent =
    version.parentVersionNumber ?? numbers.get(version.parentVersionId);
  if (parent == null) return null;
  return version.origin === "asset_edit"
    ? `new pictures on ${designLabel(parent)}`
    : `changed from ${designLabel(parent)}`;
}

function DesignPicker({
  project,
  viewedId,
  status,
  now,
  restore,
  canRevise,
  open,
  onOpenChange,
  onView,
  onChange,
}: {
  project: ThemeStudioProjectDetail;
  viewedId: string | null;
  status: StudioStatus;
  now: string;
  restore: { offered: boolean; allowed: boolean; reason: string | null };
  canRevise: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onView: (versionId: string) => void;
  onChange: (versionId: string) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const designs = [...project.versions].sort(
    (a, b) => b.versionNumber - a.versionNumber,
  );
  const numbers = new Map(project.versions.map((v) => [v.id, v.versionNumber]));
  const viewed = designs.find((d) => d.id === viewedId) ?? null;
  /** Close the list and give focus back to its button. */
  function close() {
    onOpenChange(false);
    button.current?.focus();
  }
  return (
    <span className="studio-popover-anchor">
      <button
        ref={button}
        type="button"
        id="studio-action-make_current"
        aria-expanded={open}
        aria-controls="studio-designs"
        onClick={() => onOpenChange(!open)}
        className="dash-btn dash-btn-ghost"
      >
        {viewed ? designLabel(viewed.versionNumber) : "Designs"}
        {viewed && viewed.id !== project.currentVersionId ? (
          <span className="studio-muted">, not current</span>
        ) : null}
        <ChevronDown aria-hidden="true" className="h-4 w-4" />
      </button>
      <StudioPopover
        id="studio-designs"
        open={open}
        onOpenChange={onOpenChange}
        triggerRef={button}
        label="Designs"
        align="end"
      >
        <ul className="studio-design-list">
          {designs.map((design) => {
            const isCurrent = design.id === project.currentVersionId;
            const outcome = checksOutcome(design.id, project.events);
            const checked = outcome
              ? outcome.passed
              : design.qaStatus === "passed";
            const stopped = outcome
              ? !outcome.passed
              : design.qaStatus === "failed";
            const origin = designOrigin(design, numbers);
            return (
              <li
                key={design.id}
                className="studio-design-item"
                data-viewing={design.id === viewedId}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{designLabel(design.versionNumber)}</strong>
                  {isCurrent ? (
                    <StudioBadge
                      status={{ words: status.words, tone: status.tone }}
                    />
                  ) : null}
                  {design.id === viewedId ? (
                    <span className="studio-muted text-xs">Showing</span>
                  ) : null}
                </div>
                <p>
                  Made {clockWords(design.createdAt, now)}
                  {origin ? `, ${origin}` : ""}.
                  {isCurrent
                    ? " The current design."
                    : checked
                      ? " Its checks passed."
                      : stopped
                        ? " Its checks stopped."
                        : ""}
                </p>
                {design.summary ? (
                  <p className="line-clamp-2">{plainText(design.summary)}</p>
                ) : null}
                <div className="studio-design-actions">
                  {design.id !== viewedId && design.hasPackage ? (
                    <button
                      type="button"
                      onClick={() => {
                        close();
                        onView(design.id);
                      }}
                      className="dash-btn dash-btn-ghost dash-btn-sm"
                    >
                      Show it
                    </button>
                  ) : null}
                  {!isCurrent && design.hasPackage && restore.offered ? (
                    <MakeCurrentButton
                      projectId={project.id}
                      version={design}
                      revision={project.revision}
                      disabled={!restore.allowed}
                      onDone={close}
                    />
                  ) : null}
                  {canRevise && design.hasPackage ? (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        onChange(design.id);
                      }}
                      className="dash-btn dash-btn-ghost dash-btn-sm"
                    >
                      Change this design
                    </button>
                  ) : null}
                </div>
                {!isCurrent &&
                design.hasPackage &&
                restore.offered &&
                !restore.allowed &&
                restore.reason ? (
                  <p className="studio-reason">{restore.reason}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </StudioPopover>
    </span>
  );
}

// ------------------------------------------------------------ "..." menu

interface MenuItem {
  kind: (typeof STUDIO_MENU_KINDS)[number];
  label: string;
  disabledReason: string | null;
}

function MoreMenu({
  name,
  items,
  open,
  onOpenChange,
  buttonRef,
  onPick,
}: {
  name: string;
  items: MenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onPick: (kind: MenuItem["kind"]) => void;
}) {
  if (items.length === 0) return null;
  return (
    <span className="studio-popover-anchor">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls="studio-more"
        aria-label={`More actions for ${name}`}
        onClick={() => onOpenChange(!open)}
        className="dash-btn dash-btn-ghost"
      >
        <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
      </button>
      <StudioPopover
        id="studio-more"
        open={open}
        onOpenChange={onOpenChange}
        triggerRef={buttonRef}
        label="More actions"
        align="end"
      >
        {items.map((item) => (
          <div key={item.kind}>
            <button
              type="button"
              className="studio-menu-item"
              data-danger={item.kind === "delete"}
              disabled={item.disabledReason !== null}
              onClick={() => {
                onOpenChange(false);
                onPick(item.kind);
              }}
            >
              {item.label}
            </button>
            {item.disabledReason ? (
              <p className="studio-reason">{item.disabledReason}</p>
            ) : null}
          </div>
        ))}
      </StudioPopover>
    </span>
  );
}

// -------------------------------------------------------------- Preview

function PreviewPane({
  projectId,
  viewed,
  draftLayout,
  layoutPassed,
  working,
  viewports,
}: {
  projectId: string;
  viewed: ThemeStudioVersionView | null;
  draftLayout: { versionId: string; versionNumber: number } | null;
  layoutPassed: boolean;
  working: boolean;
  viewports: Parameters<typeof PreviewFrame>[0]["viewports"];
}) {
  const [showDraft, setShowDraft] = useState(!viewed);
  const draft = draftLayout && (showDraft || !viewed?.hasPackage);
  if (draft) {
    return (
      <>
        <p className="studio-notice mb-3" data-tone="info" role="status">
          Draft layout: colour blocks stand in for pictures until they are
          drawn. A draft can&apos;t be changed or published.
          {viewed?.hasPackage ? (
            <>
              {" "}
              <button
                type="button"
                className="studio-link"
                onClick={() => setShowDraft(false)}
              >
                Show {designLabel(viewed.versionNumber)} instead
              </button>
            </>
          ) : null}
        </p>
        <PreviewFrame
          key={draftLayout.versionId}
          projectId={projectId}
          versionId={draftLayout.versionId}
          viewports={viewports}
        />
      </>
    );
  }
  if (viewed?.hasPackage) {
    return (
      <>
        {draftLayout ? (
          <p className="studio-notice mb-3" data-tone="info">
            A draft layout of the work in progress is ready to look at.{" "}
            <button
              type="button"
              className="studio-link"
              onClick={() => setShowDraft(true)}
            >
              Show the draft layout
            </button>
          </p>
        ) : null}
        <PreviewFrame
          key={viewed.id}
          projectId={projectId}
          versionId={viewed.id}
          viewports={viewports}
        />
      </>
    );
  }
  return (
    <p className="studio-notice" data-tone={working ? "info" : undefined}>
      {layoutPassed
        ? "The layout passed its check. The preview opens here once the pictures are drawn."
        : working
          ? "The preview opens here when the first design is ready."
          : viewed
            ? "This design has no theme to preview."
            : "There is no design to preview yet."}
    </p>
  );
}

// ------------------------------------------------------------- the page

const RELEASE_KINDS: ReadonlySet<StudioActionKind> = new Set([
  "open_live_demo",
  "offer_again",
  "stop_offering",
  "publish",
  "retry_publish",
]);
const CHECKS_INTENTS: readonly StudioActionKind[] = [
  "describe_fix",
  "copy_details",
];
const PICTURES_INTENTS: readonly StudioActionKind[] = [
  "redraw",
  "draw_missing_pictures",
  "retry_pictures",
];
const OWN_INTENTS: readonly StudioActionKind[] = [
  "stop",
  "stop_and_check_again",
  "check_again",
  "continue_building",
  "retry_build",
  "start_building",
  "answer",
  "remove_from_list",
  "delete",
  "make_current",
  "start_new_from_brief",
  ...CHECKS_INTENTS,
  ...PICTURES_INTENTS,
];
const WORKING_ROWS = new Set([2, 5, 6]);
const REVISABLE = new Set(["ready", "candidate", "approved"]);
const RESTORABLE = new Set(["ready", "blocked", "candidate"]);
const TAB_LABEL: Record<StudioTabKey, string> = {
  preview: "Preview",
  checks: "Checks",
  pictures: "Pictures",
  changes: "Changes",
  log: "Log",
};
const ID = "studio";

export interface ProjectWorkspaceProps {
  project: ThemeStudioProjectDetail;
  /** The progress read the server rendered with (the poll starts from it). */
  initialProgress: ThemeStudioProgress;
  /** The status row the server rendered with: `releaseControls` belongs to
   * it, so the page refreshes once when the live row leaves it (or reaches a
   * release row) even at the same revision. */
  serverRow: number;
  buildTime: ThemeStudioBuildTimeRange;
  /** The tab the server rendered (`?tab=`, default preview). */
  tab: StudioTabKey;
  /** The address named a tab: a phone then opens on it, not on the chat. */
  explicitTab: boolean;
  /** The design shown (`?version=`, or the current design). */
  versionId: string | null;
  /** The open tab's server component; null on the Preview tab. */
  tabContent: ReactNode;
  /** 2C's release controls, rendered by the server on the release rows. */
  releaseControls: ReactNode;
  viewports: Parameters<typeof PreviewFrame>[0]["viewports"];
  testProvider: boolean;
  referenceLimit: number;
  /** The viewer started this theme, so its notices and email reach them. */
  notifiesViewer: boolean;
  /** The draft layout to show while pictures are drawn (plan section 5,
   * optimisation 1). Needs a server read the progress route does not have
   * yet (TS-2 handoff), so the page passes null today. */
  draftLayout?: { versionId: string; versionNumber: number } | null;
}

export function ProjectWorkspace({
  project,
  initialProgress,
  serverRow,
  buildTime,
  tab,
  explicitTab,
  versionId,
  tabContent,
  releaseControls,
  viewports,
  testProvider,
  referenceLimit,
  notifiesViewer,
  draftLayout = null,
}: ProjectWorkspaceProps) {
  const router = useRouter();
  const live = useStudioProgress(project.id, initialProgress);
  // The words may carry a stored reason (a publish's, a stop's): never a
  // long dash on screen.
  const status: StudioStatus = {
    ...live.status,
    words: plainText(live.status.words),
  };
  const facts = live.progress.status;
  const isPhone = useIsPhone();
  const root = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerApi | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);

  // The tab the operator picked, ahead of the server's answer.
  const [selectedTab, setSelectedTab] = useState<StudioTabKey>(tab);
  const [renderedTab, setRenderedTab] = useState<StudioTabKey>(tab);
  if (tab !== renderedTab) {
    setRenderedTab(tab);
    setSelectedTab(tab);
  }
  const [tabPending, startTabTransition] = useTransition();
  const [phoneChat, setPhoneChat] = useState(!explicitTab);
  const [composerActive, setComposerActive] = useState(false);
  const [dialog, setDialog] = useState<MenuDialog | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [designsOpen, setDesignsOpen] = useState(false);
  const [reviseFrom, setReviseFrom] = useState<string | null>(null);
  const [refusedStart, setRefusedStart] = useState<string | null>(null);
  // Why the release controls hold Publish back (their sentence), so the
  // phone bar's Publish says the same instead of opening a dialog the
  // server would refuse.
  const [publishWait, setPublishWait] = useState<string | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const foldButton = useRef<HTMLButtonElement>(null);
  const railButton = useRef<HTMLButtonElement>(null);
  // Where focus goes once the chat folded or unfolded: the control that
  // undoes it (the one pressed is hidden or gone).
  const focusAfterFold = useRef<"rail" | "bar" | null>(null);

  const prefsRaw = useSyncExternalStore(
    subscribeChatPrefs,
    readChatPrefsRaw,
    () => "",
  );
  const prefs = useMemo(() => parseChatPrefs(prefsRaw), [prefsRaw]);
  const folded = prefs.folded && !isPhone;
  const chatWidth = dragWidth ?? prefs.width;

  // The analytics editor's pattern: hide the console sidebar while the page
  // is open (studio.css; `:has(.studio-page)` covers the first paint).
  useEffect(() => {
    const frame = root.current?.closest(".dashboard-frame");
    if (!frame) return;
    frame.classList.add("studio-fullwidth");
    return () => frame.classList.remove("studio-fullwidth");
  }, []);

  // Folding hides the button that was pressed, unfolding removes the rail:
  // focus moves to the control that undoes it, never to the page's start.
  useEffect(() => {
    const target = focusAfterFold.current;
    focusAfterFold.current = null;
    if (target === "rail") railButton.current?.focus();
    else if (target === "bar") foldButton.current?.focus();
  }, [folded]);

  // A whole-page refresh only when the theme itself changed (a new revision
  // or a new design), once per change.
  // ★ AND WHEN A RELEASE ROW CAME OR WENT AT THE SAME REVISION. The release
  // controls are the server's, rendered for the row it saw. A publish that
  // did not finish (publication.ts failAttempt writes no project row) or
  // stopped answering for 15 minutes moves row 2 to row 3 with no new
  // revision, and polling stops there: without this the header would keep
  // "Publishing now" and never show Try again with its reasons.
  const versionsKey = live.progress.versionIds.join(",");
  const releaseRows = STUDIO_RELEASE_ROWS as readonly number[];
  const rowMoved =
    status.row !== serverRow &&
    (releaseRows.includes(status.row) || releaseRows.includes(serverRow));
  const refreshIfStale = useEffectEvent(() => {
    if (live.revisionChanged || live.versionsChanged || rowMoved)
      router.refresh();
  });
  useEffect(() => {
    refreshIfStale();
  }, [live.progress.revision, versionsKey, status.row]);

  // A start New theme could not make (contract 8.1), shown once.
  useEffect(() => {
    const text = takeRefusedStart(project.id);
    if (text) queueMicrotask(() => setRefusedStart(text));
  }, [project.id]);

  const packaged = project.versions.filter((v) => v.hasPackage);
  const current =
    project.versions.find(
      (v) => v.id === project.currentVersionId && v.hasPackage,
    ) ?? null;
  const viewed = project.versions.find((v) => v.id === versionId) ?? null;
  const working =
    WORKING_ROWS.has(status.row) || project.status === "generating";
  const answering = project.status === "blocked" && questionsOpen(project);
  // The client copy of the server's rule (repository.ts reviseThemeStudioVersion):
  // a theme its checks blocked with no questions open takes a change.
  const canRevise =
    !working &&
    !facts.release &&
    (REVISABLE.has(project.status) ||
      (project.status === "blocked" && !answering)) &&
    packaged.length > 0;
  // Make current: the client copy of the server's rule (repository.ts
  // restoreThemeStudioVersion). Not offered on a live or removed theme; held
  // back, with the reason under it, while something works.
  const restore = {
    offered: !facts.release && project.status !== "archived",
    allowed: !working && RESTORABLE.has(project.status),
    reason: working
      ? "Theme Studio is working on this theme. Make another design current once it finishes."
      : project.status === "approved"
        ? "A publish that didn't finish holds the theme: try it again first."
        : project.status === "draft" || project.status === "failed"
          ? "This theme has no design to go back to yet."
          : null,
  };
  // The step "Continue building" and "Try again" retry: the stop the
  // progress read names, else the newest run when it stopped or failed.
  const newestRun = project.runs[0] ?? null;
  const stoppedRunId =
    (facts.stop?.kind === "run" ? facts.stop.runId : null) ??
    (newestRun &&
    (newestRun.status === "failed" || newestRun.status === "cancelled")
      ? newestRun.id
      : null);
  const reviseTarget =
    packaged.find((v) => v.id === reviseFrom) ??
    (viewed?.hasPackage ? viewed : null) ??
    current ??
    packaged[0] ??
    null;

  // -------------------------------------------------------------- the API
  const api = useMemo<StudioPageApi>(
    () => ({
      putInChat(text: string) {
        const stored = parseChatPrefs(readChatPrefsRaw());
        if (stored.folded) writeChatPrefs({ ...stored, folded: false });
        setPhoneChat(true);
        composer.current?.fill(text);
      },
      openTab(next, options = {}) {
        setSelectedTab(next);
        setPhoneChat(false);
        const href = studioPageHref(project.id, window.location.search, {
          tab: next,
          versionId: options.versionId,
          intent: options.intent ?? null,
        });
        startTabTransition(() => router.replace(href, { scroll: false }));
      },
      requestIntent(kind) {
        window.history.replaceState(
          null,
          "",
          studioPageHref(project.id, window.location.search, { intent: kind }),
        );
      },
      reportPublishWait(reason) {
        setPublishWait(reason);
      },
    }),
    [project.id, router],
  );

  function openChat() {
    const stored = parseChatPrefs(readChatPrefsRaw());
    if (stored.folded) writeChatPrefs({ ...stored, folded: false });
    setPhoneChat(true);
    composer.current?.focus();
  }

  // ------------------------------------------------------ status actions
  const actions = [status.primary, ...status.secondary].filter(
    (action): action is StudioAction => action !== null,
  );
  const releaseRow = (STUDIO_RELEASE_ROWS as readonly number[]).includes(
    status.row,
  );
  const menuKinds = new Set<string>(STUDIO_MENU_KINDS);
  const offered = new Set(actions.map((action) => action.kind));
  const visible = releaseRow
    ? []
    : actions.filter(
        (action) =>
          !menuKinds.has(action.kind) && !RELEASE_KINDS.has(action.kind),
      );
  const busyTheme = working;
  const menu: MenuItem[] = [];
  if (offered.has("stop"))
    menu.push({ kind: "stop", label: "Stop", disabledReason: null });
  const labelOf = (kind: StudioActionKind, fallback: string) =>
    actions.find((action) => action.kind === kind)?.label ?? fallback;
  if (offered.has("remove_from_list") && !facts.release)
    menu.push({
      kind: "remove_from_list",
      label: labelOf(
        "remove_from_list",
        "Remove from list (keeps its history)",
      ),
      disabledReason: busyTheme
        ? status.row === 2
          ? "A theme can't be removed from the list while it publishes."
          : "Stop the work first: a theme can't be removed while Theme Studio works on it."
        : null,
    });
  menu.push({
    kind: "delete",
    label: labelOf("delete", "Delete"),
    disabledReason: busyTheme
      ? status.row === 2
        ? "A theme can't be deleted while it publishes."
        : "Stop the work first: a theme can't be deleted while Theme Studio works on it."
      : null,
  });

  // -------------------------------------------------------------- intents
  useStudioIntent(OWN_INTENTS, (kind) => {
    if (CHECKS_INTENTS.includes(kind)) {
      if (selectedTab !== "checks") api.openTab("checks", { intent: kind });
      return "keep";
    }
    if (PICTURES_INTENTS.includes(kind)) {
      if (selectedTab !== "pictures") api.openTab("pictures", { intent: kind });
      return "keep";
    }
    switch (kind) {
      case "stop":
        if (offered.has("stop")) setDialog("stop");
        return;
      case "stop_and_check_again":
        if (offered.has("stop_and_check_again"))
          setDialog("stop_and_check_again");
        return;
      case "remove_from_list":
        if (menu.some((item) => item.kind === kind && !item.disabledReason))
          setDialog("remove_from_list");
        return;
      case "delete":
        if (!busyTheme) setDialog("delete");
        return;
      case "make_current":
        if (project.versions.length) setDesignsOpen(true);
        return;
      case "answer":
        openChat();
        return;
      default:
        // Check again, Continue building, Try again, Start building, Start
        // a new theme: focus the control; the operator presses it.
        document.getElementById(`studio-action-${kind}`)?.focus();
    }
  });

  function actionButton(action: StudioAction, primary: boolean): ReactNode {
    const id = `studio-action-${action.kind}`;
    const style = primary
      ? "dash-btn dash-btn-primary"
      : "dash-btn dash-btn-ghost";
    switch (action.kind) {
      case "check_again":
        return current ? (
          <CheckAgainButton
            id={id}
            projectId={project.id}
            versionId={current.id}
            versionNumber={current.versionNumber}
            revision={project.revision}
            label={action.label}
            primary={primary}
          />
        ) : (
          <span className="studio-action">
            <button id={id} type="button" disabled className={style}>
              {action.label}
            </button>
            <span className="studio-reason">
              This theme has no design to check yet.
            </span>
          </span>
        );
      case "stop_and_check_again":
        return (
          <button
            id={id}
            type="button"
            className={style}
            onClick={() => setDialog("stop_and_check_again")}
          >
            {action.label}
          </button>
        );
      case "continue_building":
      case "retry_build":
        return (
          <RetryRunButton
            id={id}
            projectId={project.id}
            runId={stoppedRunId}
            label={action.label}
            primary={primary}
          />
        );
      case "start_building":
        return (
          <button
            id={id}
            type="button"
            className={style}
            onClick={() => {
              openChat();
              composer.current?.send(project.draftBrief);
            }}
          >
            {action.label}
          </button>
        );
      case "answer":
        return (
          <button id={id} type="button" className={style} onClick={openChat}>
            {action.label}
          </button>
        );
      case "start_new_from_brief":
        return (
          <Link
            id={id}
            href={`/dashboard/themes/studio/new?from=${encodeURIComponent(project.id)}`}
            className={style}
          >
            {action.label}
          </Link>
        );
      // ★ THE STATUS IS THE CURRENT DESIGN'S, so its buttons open their tab
      // on the current design (`versionId: null` drops `?version=`): with
      // another design shown, Describe a fix would find nothing serious
      // there and Redraw or Retry no such picture.
      case "describe_fix":
      case "copy_details":
        return (
          <button
            id={id}
            type="button"
            className={style}
            onClick={() =>
              api.openTab("checks", { intent: action.kind, versionId: null })
            }
          >
            {action.label}
          </button>
        );
      case "redraw":
      case "draw_missing_pictures":
      case "retry_pictures":
        return (
          <button
            id={id}
            type="button"
            className={style}
            onClick={() =>
              api.openTab("pictures", { intent: action.kind, versionId: null })
            }
          >
            {action.label}
          </button>
        );
      case "make_current":
        return (
          <button
            type="button"
            className={style}
            onClick={() => setDesignsOpen(true)}
          >
            {action.label}
          </button>
        );
      default:
        return null;
    }
  }

  // ------------------------------------------------------------- the tabs
  const checksCount = facts.checks
    ? facts.checks.serious + facts.checks.warnings
    : null;
  const tabItems: StudioTabItem[] = [
    { key: "chat", label: "Chat", phoneOnly: true },
    ...STUDIO_TAB_KEYS.map((key) => ({
      key,
      label: TAB_LABEL[key],
      count:
        key === "checks"
          ? checksCount
          : key === "pictures"
            ? facts.pictures.missing
            : null,
    })),
  ];
  const showChatPane = isPhone && phoneChat;
  function selectTab(key: string) {
    if (key === "chat") {
      setPhoneChat(true);
      return;
    }
    setPhoneChat(false);
    if (key !== selectedTab || key !== tab) api.openTab(key as StudioTabKey);
  }

  // ------------------------------------------------------------- the plan
  const planVersion = current ?? packaged[0] ?? null;
  const plan: StudioPlan | null = planVersion
    ? {
        assumptions: planVersion.assumptions,
        leftOut: (planVersion.packageSummary?.gaps ?? [])
          .filter((gap) => !gap.blocking)
          .map((gap) => gap.requestedCapability),
      }
    : null;
  const steps = live.progress.steps;
  const layoutPassed =
    working &&
    steps.some((s) => s.key === "layout_check" && s.state === "done") &&
    steps.some(
      (s) =>
        s.key === "pictures" &&
        (s.state === "running" || s.state === "waiting"),
    );

  const lockedReason = facts.switches.buildingOff
    ? "Building is switched off on this deployment, so messages can't be sent now."
    : facts.switches.modelOff
      ? "This theme's model is switched off on this deployment, so messages can't be sent now."
      : status.row === 2
        ? "Publishing now. You can send changes after it finishes."
        : WORKING_ROWS.has(status.row)
          ? "You can send changes when it finishes."
          : facts.release
            ? "Live themes can't be changed yet. Start a new theme from this brief instead."
            : project.status === "archived"
              ? "This theme was removed from the list, so it can't be changed."
              : status.row === 8
                ? "This theme had too many rounds of questions. Start a new theme from this brief."
                : null;

  const phoneBar =
    status.row === 15 || status.row === 16
      ? "publish"
      : WORKING_ROWS.has(status.row)
        ? "status"
        : null;
  // Only a build or a check ends with a notice (notify.ts: ready, needs a
  // fix, questions); a publish sends none, so it never promises one.
  const away =
    notifiesViewer && status.row !== 2
      ? "We'll let you know when it's ready."
      : "You can leave this page.";

  const problemNotice =
    live.problem === "signed_out" ? (
      <p className="studio-notice" data-tone="warning" role="alert">
        Your session has ended, so this page stopped updating.{" "}
        <Link href="/dashboard/login">Sign in again</Link>.
      </p>
    ) : live.problem === "forbidden" ? (
      <p className="studio-notice" data-tone="warning" role="alert">
        Only a platform superadmin can use Theme Studio, so this page stopped
        updating.
      </p>
    ) : live.problem === "missing" ? (
      <p className="studio-notice" data-tone="warning" role="alert">
        This theme no longer exists.{" "}
        <Link href="/dashboard/themes/studio">Back to Theme Studio</Link>.
      </p>
    ) : null;

  // ★ THE TAB BAR AND ITS PANELS ARE NEIGHBOURS IN THE DOM, so Tab from
  // the selected tab goes into its panel (the WAI-ARIA tabs pattern), not
  // through the whole chat first. On a wide screen the chat comes first
  // (grid areas put it on the left anyway); on a phone the tab bar comes
  // first, since the Chat tab's panel is the chat. Keyed, so crossing the
  // breakpoint moves the tab bar or the chat, never the preview's frame.
  const tabBar = (
    <div key="tabbar" className="studio-tabbar">
      <StudioTabList
        label="Theme views"
        idPrefix={ID}
        items={tabItems}
        selected={showChatPane ? "chat" : selectedTab}
        onSelect={selectTab}
      />
    </div>
  );
  const chat = (
    <aside
      key="chat"
      id={studioPanelId(ID, "chat")}
      className="studio-chat"
      {...(isPhone
        ? {
            role: "tabpanel",
            "aria-labelledby": studioTabId(ID, "chat"),
          }
        : { "aria-label": "Chat" })}
    >
      {folded ? (
        <div className="studio-chat-rail">
          <button
            ref={railButton}
            type="button"
            className="studio-icon-btn"
            aria-expanded={false}
            aria-label="Open the chat"
            onClick={() => {
              focusAfterFold.current = "bar";
              writeChatPrefs({ ...prefs, folded: false });
            }}
          >
            <MessageSquare aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
      ) : null}
      <div className="studio-chat-bar" hidden={folded}>
        <h2>Chat</h2>
        <button
          ref={foldButton}
          type="button"
          className="studio-icon-btn"
          aria-expanded={true}
          aria-label="Fold the chat"
          onClick={() => {
            focusAfterFold.current = "rail";
            writeChatPrefs({ ...prefs, folded: true });
          }}
        >
          <PanelLeftClose aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col" hidden={folded}>
        <ThemeConversation
          key={`${project.id}:${answering ? "answer" : project.status === "draft" ? "create" : "revise"}`}
          project={project}
          generationEnabled={
            !facts.switches.buildingOff && !facts.switches.modelOff
          }
          referenceLimit={referenceLimit}
          target={reviseTarget}
          canRevise={canRevise}
          onSelectVersion={setReviseFrom}
          now={facts.now}
          working={working}
          lockedReason={lockedReason}
          apiRef={composer}
          onViewDesign={(id) =>
            api.openTab("preview", {
              versionId: id === project.currentVersionId ? null : id,
            })
          }
          onOpenChecks={(id) =>
            api.openTab("checks", {
              versionId: id === project.currentVersionId ? null : id,
            })
          }
          onComposerActive={setComposerActive}
          progressCard={
            <ProgressCard
              progress={live.progress}
              status={status}
              buildTime={buildTime}
              plan={
                plan && (plan.assumptions.length || plan.leftOut.length)
                  ? plan
                  : null
              }
              notifiesViewer={notifiesViewer}
            />
          }
        />
      </div>
    </aside>
  );
  const resizer = !folded ? (
    <div
      key="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Chat width"
      aria-valuemin={CHAT_MIN_WIDTH}
      aria-valuemax={CHAT_MAX_WIDTH}
      aria-valuenow={chatWidth}
      tabIndex={0}
      className="studio-resizer"
      data-dragging={dragWidth !== null}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { x: event.clientX, width: chatWidth };
        setDragWidth(chatWidth);
      }}
      onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        setDragWidth(
          clampChatWidth(drag.current.width + event.clientX - drag.current.x),
        );
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = null;
        writeChatPrefs({ width: chatWidth, folded: false });
        setDragWidth(null);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragWidth(null);
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        const next =
          event.key === "ArrowLeft"
            ? chatWidth - CHAT_STEP
            : event.key === "ArrowRight"
              ? chatWidth + CHAT_STEP
              : event.key === "Home"
                ? CHAT_MIN_WIDTH
                : event.key === "End"
                  ? chatMaxWidth()
                  : null;
        if (next === null) return;
        event.preventDefault();
        writeChatPrefs({ width: clampChatWidth(next), folded: false });
      }}
    />
  ) : null;
  const panels = (
    <div key="panels" className="studio-panels">
      <div
        role="tabpanel"
        id={studioPanelId(ID, "preview")}
        aria-labelledby={studioTabId(ID, "preview")}
        className="studio-tabpanel"
        data-tab="preview"
        hidden={selectedTab !== "preview"}
        tabIndex={0}
      >
        <PreviewPane
          projectId={project.id}
          viewed={viewed}
          draftLayout={draftLayout}
          layoutPassed={layoutPassed}
          working={working}
          viewports={viewports}
        />
      </div>
      {STUDIO_TAB_KEYS.filter((key) => key !== "preview").map((key) => (
        <div
          key={key}
          role="tabpanel"
          id={studioPanelId(ID, key)}
          aria-labelledby={studioTabId(ID, key)}
          className="studio-tabpanel"
          data-tab={key}
          hidden={selectedTab !== key}
          tabIndex={0}
        >
          {selectedTab !== key ? null : tab === key ? (
            tabContent
          ) : tabPending ? (
            <p role="status" className="studio-loading">
              <Loader2 aria-hidden="true" className="h-4 w-4 studio-spin" />
              Loading {TAB_LABEL[key]}…
            </p>
          ) : (
            <p className="studio-notice" data-tone="warning" role="alert">
              {TAB_LABEL[key]} didn&apos;t load.{" "}
              <button
                type="button"
                className="studio-link"
                onClick={() => api.openTab(key)}
              >
                Try again
              </button>
            </p>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <StudioPageProvider api={api}>
      <div ref={root} className="studio-root studio-page">
        <header className="studio-head">
          <div className="studio-head-row">
            <Link href="/dashboard/themes/studio" className="studio-crumb">
              <ChevronLeft aria-hidden="true" className="h-4 w-4" /> Themes
            </Link>
            <span aria-hidden="true" className="studio-muted">
              /
            </span>
            <h1 className="studio-title">{project.name}</h1>
            <span className="studio-head-status">
              <StudioBadge
                status={{ words: status.words, tone: status.tone }}
              />
            </span>
            <div className="studio-head-actions">
              {project.versions.length ? (
                <DesignPicker
                  project={project}
                  viewedId={versionId}
                  status={status}
                  now={facts.now}
                  restore={restore}
                  canRevise={canRevise}
                  open={designsOpen}
                  onOpenChange={setDesignsOpen}
                  onView={(id) =>
                    api.openTab(selectedTab, {
                      versionId: id === project.currentVersionId ? null : id,
                    })
                  }
                  onChange={(id) => {
                    setReviseFrom(id);
                    openChat();
                  }}
                />
              ) : null}
              {releaseRow
                ? releaseControls
                : visible.map((action) => (
                    <span key={action.kind} className="studio-action">
                      {actionButton(action, action === status.primary)}
                    </span>
                  ))}
              <MoreMenu
                name={project.name}
                items={menu}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                buttonRef={moreButton}
                onPick={(kind) => setDialog(kind)}
              />
            </div>
          </div>
          {refusedStart ? (
            <p className="studio-notice" data-tone="warning" role="status">
              Theme Studio couldn&apos;t start building:{" "}
              {plainText(refusedStart)} Your brief and screenshots are kept.{" "}
              <button
                type="button"
                className="studio-link"
                onClick={() => setRefusedStart(null)}
              >
                Dismiss
              </button>
            </p>
          ) : null}
        </header>

        {problemNotice ||
        facts.switches.buildingOff ||
        facts.switches.modelOff ||
        facts.switches.checksOff ||
        testProvider ? (
          <div className="studio-notices">
            {problemNotice}
            {facts.switches.buildingOff ? (
              <p className="studio-notice" data-tone="warning">
                Building is switched off on this deployment. You can look at
                designs, check them and publish.
              </p>
            ) : null}
            {facts.switches.modelOff ? (
              <p className="studio-notice" data-tone="warning">
                This theme&apos;s model is switched off on this deployment, so
                it can&apos;t build or change the design.
              </p>
            ) : null}
            {facts.switches.checksOff ? (
              <p className="studio-notice">
                The automatic checks are off on this deployment (local
                development only), so Check again is not available here.
              </p>
            ) : null}
            {testProvider ? (
              <p className="studio-notice" data-tone="info">
                This deployment uses the offline test provider: builds make no
                model call and produce a placeholder design.
              </p>
            ) : null}
          </div>
        ) : null}

        <div
          className="studio-body"
          data-chat-folded={folded}
          data-phone-pane={phoneChat ? "chat" : "tab"}
          style={{ "--studio-chat-w": `${chatWidth}px` } as CSSProperties}
        >
          {isPhone
            ? [tabBar, chat, resizer, panels]
            : [chat, resizer, tabBar, panels]}
        </div>

        {phoneBar ? (
          <div
            className="studio-phonebar"
            hidden={composerActive}
            aria-label="Theme status"
            role="region"
          >
            {phoneBar === "publish" ? (
              <>
                <span>{status.words}</span>
                <span className="studio-action">
                  <button
                    type="button"
                    className="dash-btn dash-btn-primary aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                    aria-disabled={publishWait !== null}
                    aria-describedby={
                      publishWait !== null ? "studio-phonebar-wait" : undefined
                    }
                    onClick={(event) => {
                      if (publishWait !== null) return;
                      // Focused first (Safari does not focus a pressed
                      // button), so the dialog gives focus back here.
                      event.currentTarget.focus();
                      api.requestIntent("publish");
                    }}
                  >
                    {status.primary?.label ?? "Publish"}
                  </button>
                  {publishWait !== null ? (
                    <span id="studio-phonebar-wait" className="studio-reason">
                      {publishWait}
                    </span>
                  ) : null}
                </span>
              </>
            ) : (
              <span>
                {status.row === 6 ? status.words : `${status.words}. ${away}`}
              </span>
            )}
          </div>
        ) : null}

        <StopDialog
          open={dialog === "stop"}
          onOpenChange={(open) => setDialog(open ? "stop" : null)}
          projectId={project.id}
          name={project.name}
          revision={project.revision}
          hasVersion={Boolean(project.currentVersionId)}
          returnFocusTo={moreButton}
        />
        <StopAndCheckDialog
          open={dialog === "stop_and_check_again"}
          onOpenChange={(open) =>
            setDialog(open ? "stop_and_check_again" : null)
          }
          projectId={project.id}
          name={project.name}
          revision={project.revision}
          current={current}
        />
        <RemoveFromListDialog
          open={dialog === "remove_from_list"}
          onOpenChange={(open) => setDialog(open ? "remove_from_list" : null)}
          projectId={project.id}
          name={project.name}
          revision={project.revision}
          returnFocusTo={moreButton}
        />
        <DeleteThemeDialog
          open={dialog === "delete"}
          onOpenChange={(open) => setDialog(open ? "delete" : null)}
          projectId={project.id}
          themeId={project.themeId}
          name={project.name}
          revision={project.revision}
          returnFocusTo={moreButton}
        />
      </div>
    </StudioPageProvider>
  );
}
