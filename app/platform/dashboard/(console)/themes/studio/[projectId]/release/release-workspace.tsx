"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink, Loader2, RotateCcw, Send } from "lucide-react";
import {
  changeThemeStudioCatalogAction,
  publishThemeStudioProjectAction,
} from "@/app/actions/theme-studio-actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { StudioAction, StudioActionKind } from "../../studio-status";
import { plainText } from "../../studio-ui";
import { designLabel } from "../../studio-words";
import { useStudioIntent, useStudioPage } from "../studio-tabs";

// ---------------------------------------------------------------------------
// The release controls in the theme page's header (wave TS-2, builder 2C;
// plan section 4, "Publish dialog" and "Live"; contract section 6.4). The
// server part ([projectId]/release-controls.tsx) reads the facts; this part
// acts. One step, no second person: a theme that is Ready to publish passed
// its checks and the design review bound to them on today's StoreMink build.
//
// ★ THE PUBLISH DIALOG names the design and when it was made, the real
// reach (the theme catalog and every store's Theme library, with a live
// demo store), the warnings that go live with it, and "you are looking at
// Design 1" when another design is on screen (Publish always takes the
// current one; on Try again it says which design the attempt started with,
// since no design can be made current until it finishes). It opens only
// when Publish can go ahead (never past the reason written under the
// button), and gives focus back to the control that opened it, the
// header's or the phone bar's. When the checks are from an earlier build, it says the
// design is re-checked on today's build first and the button reads
// "Re-check now"; the publish action's `rechecking` answer is not a failure.
// While it publishes, the header shows the steps it goes through; a publish
// that did not finish shows its last reasons beside Try again.
// ★ THE LIVE PANEL shows whenever a published release exists: Open live
// demo, Stop offering this theme (or Offer again), each behind a dialog
// where it changes something; live themes can't be changed yet, so Start a
// new theme from this brief. The release version picker and "Restore this
// version" are not on screen (one release per theme today); the server's
// Restore stays for live updates.
// ★ INTENTS: `do=publish` and `do=retry_publish` open the Publish dialog,
// `do=offer_again` and `do=stop_offering` their dialogs, `do=open_live_demo`
// moves focus to the demo link; none acts by itself.
// ---------------------------------------------------------------------------

/** Where a published theme goes, in the operator's words. Signup has had no
 * theme step since 11 Oct 2026: a store picks its theme in its Theme
 * library. */
export const PUBLISH_REACH =
  "the theme catalog on themes.storemink.com and every store's Theme library";

/** What publishing does, in the order it happens (publication.ts): shown,
 * not measured, while a publish runs. */
export const PUBLISH_STEPS: readonly string[] = [
  "copying the pictures",
  "saving the release",
  "building the demo store",
  "checking the demo pages",
  "adding it to the catalog",
];

/** "2 warnings go live with it", counted by kind. */
export function warningsGoLive(kinds: number, end: "." | ":"): string {
  return kinds === 1
    ? `1 warning goes live with it${end}`
    : `${kinds} warnings go live with it${end}`;
}

function stepsSentence(): string {
  const [first, ...rest] = PUBLISH_STEPS;
  return `${first.charAt(0).toUpperCase()}${first.slice(1)}, ${rest.slice(0, -1).join(", ")} and ${rest[rest.length - 1]}.`;
}

/** What the server part read for a theme that can publish (rows 3, 15, 16). */
export interface ReleasePublishFacts {
  /** The current design's number: the one Publish takes. */
  designNumber: number | null;
  /** When it was made, in words ("11:40", "1 Oct, 11:40"). */
  madeAt: string | null;
  /** The design on screen, when it is not the current one. */
  viewingNumber: number | null;
  /** The warnings that go live, one plain line per kind. */
  warnings: readonly string[];
  /** Publish re-checks the design on today's build first. */
  recheck: boolean;
  /** Why it re-checks, in one sentence; null when it does not. */
  recheckReason: string | null;
  /** Publish can do nothing useful now (the checks are not today's and no
   * re-check can start, or the theme file refuses): the reason. */
  waitReason: string | null;
  /** The last attempt's reasons, when a publish did not finish. */
  lastReasons: readonly string[];
  /** The viewer started this theme, so its notice reaches them. */
  notifies: boolean;
}

/** What the server part read for a theme with a published release. */
export interface ReleaseLiveFacts {
  offered: boolean;
  version: string | null;
  /** Since when, in words ("1 Oct"); null when unknown. */
  since: string | null;
}

export interface ReleasePanelProps {
  projectId: string;
  name: string;
  revision: number;
  /** The status row (studio-status.ts): 1, 2, 3, 15 or 16. */
  row: number;
  /** The row's main button and its visible secondary actions, in order
   * (the "..." menu's kinds are the header's). */
  actions: readonly StudioAction[];
  demoOrigin: string;
  live: ReleaseLiveFacts | null;
  publish: ReleasePublishFacts | null;
}

const PUBLISH_KINDS: ReadonlySet<StudioActionKind> = new Set([
  "publish",
  "retry_publish",
]);

/** The Publish dialog's words, worked out from the facts. Exported for its
 * tests. */
export function publishDialogWords(
  name: string,
  facts: ReleasePublishFacts,
  retry: boolean,
): { title: string; confirm: string; lead: string } {
  const design =
    facts.designNumber !== null ? designLabel(facts.designNumber) : name;
  const made = facts.madeAt ? ` (made ${facts.madeAt})` : "";
  if (facts.recheck)
    return {
      title: `Re-check ${design} before publishing?`,
      confirm: "Re-check now",
      lead: `${facts.recheckReason ?? "These checks are not from today's StoreMink build."} ${design} is re-checked on today's build first, about 3 to 5 minutes. Nothing is redrawn${facts.notifies ? ", and we'll tell you when it's ready to publish" : ", and it shows Ready to publish when it passes"}.`,
    };
  return {
    title: retry
      ? `Try publishing ${design}${made} again?`
      : `Publish ${design}${made}?`,
    confirm: retry ? "Try again" : "Publish now",
    lead: `It appears in ${PUBLISH_REACH}, with a live demo store. Stores that install it keep this exact version.`,
  };
}

export function ReleasePanel({
  projectId,
  name,
  revision,
  row,
  actions,
  demoOrigin,
  live,
  publish,
}: ReleasePanelProps) {
  const router = useRouter();
  const page = useStudioPage();
  const [dialog, setDialog] = useState<
    "publish" | "offer_again" | "stop_offering" | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [publishing, startPublish] = useTransition();
  const [changing, startChange] = useTransition();
  const publishButton = useRef<HTMLButtonElement>(null);
  const catalogButton = useRef<HTMLButtonElement>(null);
  const demoLink = useRef<HTMLAnchorElement>(null);
  // The control that opened the Publish dialog (the header's button, or the
  // phone bar's): focus goes back to it when the dialog closes.
  const opener = useRef<HTMLElement | null>(null);
  // "Choose the design to make current" hands over to the Design list: the
  // dialog then gives focus back to nothing, or its late focus return (after
  // its closing animation) would land on Publish and close the list again.
  const handOff = useRef(false);

  const kinds = new Set(actions.map((action) => action.kind));
  const publishAction =
    actions.find((action) => PUBLISH_KINDS.has(action.kind)) ?? null;
  const retry = publishAction?.kind === "retry_publish";
  // Why Publish waits (the theme file refuses it, or no re-check can start):
  // written under the button, and never a dialog the server would refuse.
  const blocked = publish?.waitReason ?? null;
  const reportedWait = publishAction && publish ? blocked : null;

  // The phone bar's Publish holds back with the same sentence.
  useEffect(() => {
    page.reportPublishWait?.(reportedWait);
    return () => page.reportPublishWait?.(null);
  }, [page, reportedWait]);

  function openPublish(from: Element | null) {
    opener.current =
      from instanceof HTMLElement && from !== document.body
        ? from
        : publishButton.current;
    handOff.current = false;
    setDialog("publish");
  }

  useStudioIntent(
    [
      "publish",
      "retry_publish",
      "offer_again",
      "stop_offering",
      "open_live_demo",
    ],
    (kind) => {
      if (kind === "publish" || kind === "retry_publish") {
        // From the list (?do=publish) or the phone bar: the dialog opens
        // only when Publish can go ahead; otherwise focus moves to the
        // button, whose reason is read with it.
        if (publishAction && publish && !publishing && blocked === null)
          openPublish(document.activeElement);
        else publishButton.current?.focus();
        return;
      }
      if (kind === "open_live_demo") {
        demoLink.current?.focus();
        return;
      }
      if (
        (kind === "offer_again" || kind === "stop_offering") &&
        kinds.has(kind)
      ) {
        setCatalogError(null);
        setDialog(kind);
      }
    },
  );

  function confirmPublish() {
    setDialog(null);
    setNotice(null);
    startPublish(async () => {
      try {
        const result = await publishThemeStudioProjectAction({
          projectId,
          expectedRevision: revision,
        });
        if (result.kind === "rechecking") {
          // Not a failure: the design is measured again on today's build.
          const message = plainText(
            result.message ?? "Re-checking on today's StoreMink build first.",
          );
          setNotice(message);
          toast.info(message);
        } else if (!result.ok) {
          toast.error(
            plainText(
              result.problems?.[0] ??
                result.error ??
                "The theme couldn't be published.",
            ),
          );
        } else {
          toast.success(`${name} is live.`);
        }
      } catch {
        toast.error("The request failed. Reload the page before trying again.");
      }
      router.refresh();
    });
  }

  function changeCatalog(action: "hide" | "show") {
    setCatalogError(null);
    startChange(async () => {
      try {
        const result = await changeThemeStudioCatalogAction({
          projectId,
          change: { action },
        });
        if (!result.ok) {
          setCatalogError(
            plainText(result.error ?? "The catalog couldn't be changed."),
          );
          return;
        }
        toast.success(
          !result.changed
            ? "Nothing changed."
            : action === "hide"
              ? `${name} is no longer offered to new stores.`
              : `${name} is offered to new stores again.`,
        );
        setDialog(null);
        router.refresh();
      } catch {
        setCatalogError(
          "The request failed. Reload the page before trying again.",
        );
      }
    });
  }

  // ------------------------------------------------------------ publishing
  if (row === 2) {
    return (
      <div className="studio-action" role="status">
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          <Loader2 aria-hidden="true" className="h-4 w-4 studio-spin" />
          Publishing now
        </span>
        <span className="studio-reason">
          {stepsSentence()} It takes a few minutes; you can leave this page.
        </span>
      </div>
    );
  }

  // ------------------------------------------------------------------ live
  if (row === 1 && live) {
    const offerKind: "offer_again" | "stop_offering" | null = kinds.has(
      "stop_offering",
    )
      ? "stop_offering"
      : kinds.has("offer_again")
        ? "offer_again"
        : null;
    const demo = kinds.has("open_live_demo") ? (
      <a
        ref={demoLink}
        href={demoOrigin}
        target="_blank"
        rel="noopener noreferrer"
        className={
          live.offered ? "dash-btn dash-btn-primary" : "dash-btn dash-btn-ghost"
        }
      >
        Open live demo
        <ExternalLink aria-hidden="true" className="h-4 w-4" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    ) : null;
    const offer = offerKind ? (
      <button
        ref={catalogButton}
        type="button"
        className={
          offerKind === "offer_again"
            ? "dash-btn dash-btn-primary"
            : "dash-btn dash-btn-ghost"
        }
        disabled={changing}
        onClick={() => {
          setCatalogError(null);
          setDialog(offerKind);
        }}
      >
        {offerKind === "offer_again"
          ? "Offer again"
          : "Stop offering this theme"}
      </button>
    ) : null;
    return (
      <div className="studio-action">
        <div className="flex flex-wrap items-center gap-2">
          {live.offered ? (
            <>
              {demo}
              {offer}
            </>
          ) : (
            <>
              {offer}
              {demo}
            </>
          )}
        </div>
        <span className="studio-reason">
          {live.offered
            ? `Live${live.version ? `, v${live.version}` : ""}${live.since ? `, since ${live.since}` : ""}.`
            : "Not offered to new stores."}{" "}
          Stores that installed it keep this exact version. Live themes
          can&apos;t be changed yet.
        </span>
        {kinds.has("start_new_from_brief") ? (
          // The live row's next step, drawn as a button (44 px on touch).
          <Link
            href={`/dashboard/themes/studio/new?from=${encodeURIComponent(projectId)}`}
            className="dash-btn dash-btn-ghost mt-2 self-start"
          >
            Start a new theme from this brief
          </Link>
        ) : null}
        <Dialog
          open={dialog === "stop_offering" || dialog === "offer_again"}
          onOpenChange={(open) => {
            if (!open && !changing) setDialog(null);
          }}
        >
          <DialogContent className="studio-root" finalFocus={catalogButton}>
            <DialogHeader>
              <DialogTitle>
                {dialog === "offer_again"
                  ? `Offer ${name} again?`
                  : `Stop offering ${name}?`}
              </DialogTitle>
              <DialogDescription>
                {dialog === "offer_again"
                  ? `It appears again in ${PUBLISH_REACH}, with its live demo store.`
                  : "New stores can't pick it, and it leaves the Theme library of every store that has not installed it. Stores that installed it keep it."}
              </DialogDescription>
            </DialogHeader>
            {catalogError ? (
              <p role="alert" className="studio-error text-sm">
                {catalogError}
              </p>
            ) : null}
            <DialogFooter>
              <button
                type="button"
                disabled={changing}
                onClick={() => setDialog(null)}
                className="dash-btn dash-btn-ghost"
              >
                {dialog === "offer_again" ? "Cancel" : "Keep offering it"}
              </button>
              <button
                type="button"
                disabled={changing}
                onClick={() =>
                  changeCatalog(dialog === "offer_again" ? "show" : "hide")
                }
                className="dash-btn dash-btn-primary"
              >
                {changing
                  ? "Saving…"
                  : dialog === "offer_again"
                    ? "Offer again"
                    : "Stop offering"}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ------------------------------------------------- Publish and Try again
  if (!publishAction || !publish) return null;
  const words = publishDialogWords(name, publish, retry);
  const reasonId = `studio-publish-reason-${projectId}`;
  const viewing =
    publish.viewingNumber !== null && publish.designNumber !== null
      ? {
          viewed: designLabel(publish.viewingNumber),
          live: designLabel(publish.designNumber),
        }
      : null;

  return (
    <div className="studio-action">
      <button
        ref={publishButton}
        id={`studio-action-${publishAction.kind}`}
        type="button"
        className="dash-btn dash-btn-primary aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        aria-disabled={publishing || blocked !== null}
        aria-describedby={blocked !== null ? reasonId : undefined}
        onClick={(event) => {
          if (publishing || blocked !== null) return;
          openPublish(event.currentTarget);
        }}
      >
        {publishing ? (
          <Loader2 aria-hidden="true" className="h-4 w-4 studio-spin" />
        ) : retry ? (
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
        ) : (
          <Send aria-hidden="true" className="h-4 w-4" />
        )}
        {publishing
          ? publish.recheck
            ? "Starting the re-check…"
            : "Publishing…"
          : publishAction.label}
      </button>
      {publishing && !publish.recheck ? (
        <span className="studio-reason" role="status">
          {stepsSentence()} It takes a few minutes.
        </span>
      ) : blocked ? (
        <span id={reasonId} className="studio-reason">
          {blocked}
        </span>
      ) : null}
      {notice ? (
        <span className="studio-reason" role="status">
          {notice}
        </span>
      ) : null}
      {retry && publish.lastReasons.length && !publishing ? (
        <div className="studio-reason">
          <p>Its last attempt said:</p>
          <ul className="list-disc pl-5">
            {publish.lastReasons.map((reason) => (
              <li key={reason}>{plainText(reason)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Dialog
        open={dialog === "publish"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        onOpenChangeComplete={(open) => {
          // Once it has fully closed: the Design list opens, and nothing
          // takes its focus away afterwards.
          if (!open && handOff.current) page.requestIntent("make_current");
        }}
      >
        <DialogContent
          className="studio-root"
          finalFocus={() =>
            handOff.current
              ? false
              : opener.current?.isConnected
                ? opener.current
                : publishButton.current
          }
        >
          <DialogHeader>
            <DialogTitle>{words.title}</DialogTitle>
            <DialogDescription>{words.lead}</DialogDescription>
          </DialogHeader>
          {retry && publish.lastReasons.length && !publish.recheck ? (
            <div className="text-sm">
              <p>Its last attempt said:</p>
              <ul className="mt-1 list-disc pl-5">
                {publish.lastReasons.map((reason) => (
                  <li key={reason}>{plainText(reason)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {!publish.recheck && publish.warnings.length > 0 ? (
            <div className="text-sm">
              <p>{warningsGoLive(publish.warnings.length, ":")}</p>
              <ul className="mt-1 list-disc pl-5">
                {publish.warnings.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {viewing && retry ? (
            // A publish that did not finish holds the theme: no design can be
            // made current until it is tried again (repository.ts refuses),
            // so no Make current here.
            <p className="studio-notice text-sm" data-tone="info">
              You are looking at {viewing.viewed}; Try again publishes{" "}
              {viewing.live}, the design the attempt started with.
            </p>
          ) : viewing ? (
            <div className="studio-notice text-sm" data-tone="warning">
              <p>
                You are looking at {viewing.viewed}; {viewing.live} is the one
                that will go live. Make {viewing.viewed} current first.
              </p>
              <button
                type="button"
                className="studio-link mt-1"
                onClick={() => {
                  handOff.current = true;
                  setDialog(null);
                }}
              >
                Choose the design to make current
              </button>
            </div>
          ) : null}
          <DialogFooter>
            <button
              type="button"
              onClick={() => setDialog(null)}
              className="dash-btn dash-btn-ghost"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={publishing}
              onClick={confirmPublish}
              className="dash-btn dash-btn-primary"
            >
              {words.confirm}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
