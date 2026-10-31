"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  queueThemeStudioImagesAction,
  retryThemeStudioRunAction,
} from "@/app/actions/theme-studio-actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { StudioActionKind } from "../../../../studio-status";
import { plainText } from "../../../../studio-ui";
import { designLabel } from "../../../../studio-words";
import { newIdempotencyKey } from "../../../../new/new-theme-helpers";
import { useStudioIntent } from "../../../studio-tabs";

// ---------------------------------------------------------------------------
// The picture runs the theme page starts (wave TS-2, builder 2C; plan
// section 4, "Fix it" by kind, and section 8 row 2): Draw missing pictures,
// Redraw (exactly the slots named) and Retry a picture run that stopped.
//
// ★ ONE CLICK WITH A SMALL CONFIRM that names how many, instead of today's
// "Generate images" then "Draw N images". Every picture is paid, so the
// confirm says what a run may cost at list price before anything is queued;
// the main view carries no cost line (those are in the Log tab).
// ★ AN INTENT ONLY OPENS THE CONFIRM (`do=draw_missing_pictures`, `redraw`,
// `retry_pictures`): the operator still presses the button inside it.
// ★ After a run is queued the page refreshes in place: the theme's status
// says it is drawing, and the progress card follows it.
// ---------------------------------------------------------------------------

/** What a run may cost at list price (image-generation-core.ts
 * imageRunEstimate, image-history.ts redrawEstimate), or null for the
 * offline test provider, which draws for nothing. */
export interface PictureRunEstimate {
  images: number;
  expectedUsd: number;
  mostUsd: number;
}

function costLine(estimate: PictureRunEstimate | null): string {
  if (!estimate)
    return "The offline test provider draws placeholder pictures at no cost.";
  return `That is ${estimate.images} picture${estimate.images === 1 ? "" : "s"}, about $${estimate.expectedUsd.toFixed(2)} at list price, or at most $${estimate.mostUsd.toFixed(2)} if every picture needs every redraw.`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A button that opens a small confirm; the confirm starts the run. */
function ConfirmedRun({
  label,
  icon,
  primary,
  small,
  blockedReason,
  intent,
  title,
  body,
  confirmLabel,
  run,
  done,
  id,
}: {
  label: string;
  icon: ReactNode;
  primary: boolean;
  small: boolean;
  blockedReason: string | null;
  intent: StudioActionKind | null;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** Starts the run; resolves to the server's refusal, or null. */
  run: () => Promise<string | null>;
  done: string;
  id?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const button = useRef<HTMLButtonElement>(null);
  const reason = useRef<HTMLSpanElement>(null);
  useStudioIntent(intent ? [intent] : [], () => {
    if (blockedReason !== null) {
      // A disabled button can't take focus: its reason can, and is read.
      reason.current?.focus();
      return;
    }
    setError(null);
    setOpen(true);
  });
  function start() {
    startTransition(async () => {
      try {
        const refusal = await run();
        if (refusal) {
          setError(plainText(refusal));
          return;
        }
        toast.success(done);
        setOpen(false);
        router.refresh();
      } catch {
        setError("The request failed. Reload the page before trying again.");
      }
    });
  }
  return (
    <span className="studio-action">
      <button
        ref={button}
        id={id}
        type="button"
        disabled={blockedReason !== null}
        className={[
          "dash-btn",
          primary ? "dash-btn-primary" : "dash-btn-ghost",
          small ? "dash-btn-sm" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {icon}
        {label}
      </button>
      {blockedReason ? (
        <span ref={reason} tabIndex={-1} className="studio-reason">
          {blockedReason}
        </span>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
      >
        <DialogContent className="studio-root" finalFocus={button}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription render={<div />}>{body}</DialogDescription>
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
              Cancel
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={start}
              className="dash-btn dash-btn-primary"
            >
              {pending ? "Starting…" : confirmLabel}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
}

interface PictureTarget {
  projectId: string;
  versionId: string;
  versionNumber: number;
  revision: number;
  packageDigest: string;
}

/**
 * "Draw missing pictures": a picture for every placeholder of this design,
 * all matched to one art direction, after a confirm that names how many.
 * Nothing shows when no placeholder needs drawing.
 */
export function GenerateImagesButton({
  projectId,
  versionId,
  versionNumber,
  revision,
  packageDigest,
  slots,
  estimate,
  blockedReason,
  intent = null,
  primary = true,
}: PictureTarget & {
  /** Placeholder slots the run would draw. */
  slots: number;
  estimate: PictureRunEstimate | null;
  blockedReason: string | null;
  /** The address intent that opens this confirm (the Pictures tab's). */
  intent?: StudioActionKind | null;
  primary?: boolean;
}) {
  if (slots === 0) return null;
  const design = designLabel(versionNumber);
  return (
    <ConfirmedRun
      label="Draw missing pictures"
      icon={<ImagePlus aria-hidden="true" className="h-4 w-4" />}
      primary={primary}
      small={false}
      blockedReason={blockedReason}
      intent={intent}
      title={`Draw ${count(slots, "missing picture", "missing pictures")}?`}
      body={
        <>
          <p>
            Theme Studio draws a picture for{" "}
            {slots === 1
              ? "the placeholder"
              : `each of the ${slots} placeholders`}
            , in one matched style, as a new design. {design} stays as it is.
          </p>
          <p className="mt-2">{costLine(estimate)}</p>
        </>
      }
      confirmLabel={`Draw ${count(slots, "picture", "pictures")}`}
      run={async () => {
        const result = await queueThemeStudioImagesAction({
          projectId,
          versionId,
          expectedRevision: revision,
          expectedPackageDigest: packageDigest,
          idempotencyKey: newIdempotencyKey(),
        });
        return result.ok ? null : (result.error ?? "That didn't start.");
      }}
      done="Drawing the pictures. The theme page follows it."
    />
  );
}

/**
 * "Redraw": exactly these slots, drawn again to match the theme's art
 * direction and checked, after a confirm that names how many and which.
 */
export function RedrawPicturesButton({
  projectId,
  versionId,
  versionNumber,
  revision,
  packageDigest,
  slotIds,
  slotNames,
  estimate,
  blockedReason,
  intent = null,
  primary = false,
  small = false,
  label,
  id,
}: PictureTarget & {
  slotIds: readonly string[];
  /** Each slot's name in words, in the same order. */
  slotNames: readonly string[];
  estimate: PictureRunEstimate | null;
  blockedReason: string | null;
  intent?: StudioActionKind | null;
  primary?: boolean;
  small?: boolean;
  label?: string;
  id?: string;
}) {
  if (slotIds.length === 0) return null;
  const n = slotIds.length;
  const design = designLabel(versionNumber);
  const names = slotNames.slice(0, 8);
  return (
    <ConfirmedRun
      id={id}
      label={label ?? `Redraw ${count(n, "picture", "pictures")}`}
      icon={<RefreshCw aria-hidden="true" className="h-4 w-4" />}
      primary={primary}
      small={small}
      blockedReason={blockedReason}
      intent={intent}
      title={`Redraw ${count(n, "picture", "pictures")}?`}
      body={
        <>
          <p>
            Theme Studio draws {n === 1 ? "this picture" : `these ${n}`} again
            in the theme&apos;s style, as a new design. {design} stays as it is.
          </p>
          {names.length ? (
            <ul className="mt-2 list-disc pl-5">
              {names.map((name, index) => (
                <li key={`${slotIds[index]}`}>{name}</li>
              ))}
              {n > names.length ? (
                <li>and {count(n - names.length, "more", "more")}</li>
              ) : null}
            </ul>
          ) : null}
          <p className="mt-2">{costLine(estimate)}</p>
        </>
      }
      confirmLabel={`Redraw ${count(n, "picture", "pictures")}`}
      run={async () => {
        const result = await queueThemeStudioImagesAction({
          projectId,
          versionId,
          expectedRevision: revision,
          expectedPackageDigest: packageDigest,
          idempotencyKey: newIdempotencyKey(),
          slotIds: [...slotIds],
        });
        return result.ok ? null : (result.error ?? "That didn't start.");
      }}
      done={`Redrawing ${count(n, "picture", "pictures")}. The theme page follows it.`}
    />
  );
}

/**
 * The picture intents no button on the tab takes (nothing to redraw, draw
 * or retry): the address's `do` only moves focus to the picture list, and
 * is taken out of the address.
 */
export function PictureIntentFallback({
  kinds,
  focusId,
}: {
  kinds: readonly StudioActionKind[];
  focusId: string;
}) {
  useStudioIntent(kinds, () => {
    document.getElementById(focusId)?.focus();
  });
  return null;
}

/**
 * "Retry" a picture run that stopped or failed (retryThemeStudioRunAction):
 * it keeps the pictures already drawn and draws the rest.
 */
export function RetryPicturesButton({
  projectId,
  runId,
  drawn,
  blockedReason,
  intent = null,
  primary = true,
}: {
  projectId: string;
  runId: string;
  /** Pictures the run already drew, when it said. */
  drawn: number | null;
  blockedReason: string | null;
  intent?: StudioActionKind | null;
  primary?: boolean;
}) {
  return (
    <ConfirmedRun
      label="Retry"
      icon={<RotateCcw aria-hidden="true" className="h-4 w-4" />}
      primary={primary}
      small={false}
      blockedReason={blockedReason}
      intent={intent}
      title="Try drawing the pictures again?"
      body={
        <p>
          {drawn
            ? `The ${count(drawn, "picture", "pictures")} already drawn ${drawn === 1 ? "is" : "are"} kept and reused; Theme Studio draws the rest and checks each one.`
            : "Pictures already drawn are kept and reused; Theme Studio draws the rest and checks each one."}
        </p>
      }
      confirmLabel="Try again"
      run={async () => {
        const result = await retryThemeStudioRunAction({
          projectId,
          runId,
          idempotencyKey: newIdempotencyKey(),
        });
        return result.ok ? null : (result.error ?? "That didn't start.");
      }}
      done="Drawing the pictures again. The theme page follows it."
    />
  );
}
