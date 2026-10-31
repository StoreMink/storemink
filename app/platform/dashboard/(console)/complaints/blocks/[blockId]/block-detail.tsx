"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { InfoTip } from "@/components/ui/info-tip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  addStoreEmailedReplyAction,
  extendArchiveAction,
  liftBlockAction,
  markRemovedByHandAction,
  openArchiveAction,
  releaseArchiveHoldAction,
  replyToStoreAction,
  retryStorageAction,
  tellStoreNowAction,
} from "@/app/actions/takedown-actions";
import type { BlockKind } from "@/lib/moderation/kinds";
// Types only: console-read.ts and storage.ts are server-only, and a type
// import is erased.
import type {
  ArchiveForViewing,
  ArchiveSummary,
  BlockStatus,
  FileStage,
} from "@/lib/moderation/console-read";
import { istDate } from "../../complaints-console";

// ---------------------------------------------------------------------------
// The controls of a block's page (takedown design 6.6): Tell the store now,
// Lift block, Retry now, Mark as removed, the archived copy (open, keep
// longer, release the hold) and the replies to the store.
//
// ★ EACH IS ONE T15 ACTION (app/actions/takedown-actions.ts), never a lib
// module, and each action checks the operator's role again on the server.
// The superadmin-only controls (Tell the store now, Lift block, the archived
// copy's buttons, design 3.10) are not rendered for a member at all; the
// member reads why instead ("Only a superadmin can open it.").
//
// ★ THE ARCHIVED COPY IS NEVER READ UNRECORDED. "Open the copy" asks why
// first (`openArchiveAction` records it and answers a ten-minute receipt);
// the files and the record are then links to the archive routes with that
// receipt, and an image's bytes are fetched only when "Show" is pressed,
// because every load is recorded too.
//
// ★ IN-APP DIALOGS ONLY, never `window.confirm`, and the action's sentence
// is the one shown: a refusal comes back in the design's words.
// ---------------------------------------------------------------------------

const BTN = "dash-btn dash-btn-ghost pointer-coarse:min-h-11";
const PRIMARY = "dash-btn dash-btn-primary pointer-coarse:min-h-11";
const LABEL = "mb-1 block text-sm font-medium text-[var(--dash-text)]";
const HINT = "mt-1 block text-xs text-[var(--dash-text-2)]";
const ERROR = "text-sm text-[var(--dash-red)]";
const LINK =
  "text-sm text-[var(--dash-accent)] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center";

/** Shown only when the request itself failed, never for a refusal. */
export const REQUEST_FAILED =
  "The request didn't reach StoreMink. Refresh the page and try again.";

/** The lift's refusal while a replacement holds the file (BLOCK_ERRORS.liftReplacing). */
export const LIFT_REPLACING =
  "StoreMink is replacing this file right now. Try again in a minute.";

type Answer =
  | { ok: true; message: string; warnings?: string[] }
  | { ok: false; error: string };

/** "Open", "Suspended": the status a store had, as the console names it. */
function statusWord(status: string | null): string | null {
  const value = (status ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value === "active") return "Open";
  const words = value.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The lift dialog's body (design 6.6), by what was blocked and where its file
 * stands: a store opens with the status it had; a file replaced in
 * StoreMink's storage is put back; a file removed by hand is put back by
 * hand; anything else shows again. The archived copy's date follows.
 */
export function liftDialogLines(input: {
  kind: BlockKind;
  storeName: string;
  storeStatusBefore: string | null;
  fileStage: FileStage | null;
  archive: {
    keepUntil: string;
    legalHold: boolean;
    purgedAt: string | null;
  } | null;
}): string[] {
  const lines: string[] = [];
  if (input.kind === "store") {
    const before = statusWord(input.storeStatusBefore);
    lines.push(
      before
        ? `The store opens again with the status it had before (${before}).`
        : "The store opens again with the status it had before.",
    );
  } else if (input.kind === "file") {
    if (input.fileStage === "replaced") {
      lines.push(
        "The original file goes back to its address. Some image sizes may show the placeholder for up to 4 hours.",
      );
    } else if (input.fileStage === "removed_by_hand") {
      lines.push(
        "Pages show it again. Put the file back by hand from the archived copy if needed (see the runbook).",
      );
    } else {
      lines.push("Pages show it again.");
    }
  } else {
    lines.push(
      `It shows on ${input.storeName} again as the store last saved it, if the store has it published.`,
    );
  }
  if (input.archive && !input.archive.purgedAt) {
    lines.push(
      input.archive.legalHold
        ? "The archived copy is kept until it is released."
        : `The archived copy is kept until ${istDate(input.archive.keepUntil)}.`,
    );
  }
  return lines;
}

/** One dialog: a question, its fields, and one write behind its button. */
function ActionDialog({
  title,
  description,
  confirmLabel,
  children,
  blockedReason,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  children?: ReactNode;
  /** Why the button is unavailable, written under it. */
  blockedReason?: string | null;
  onSubmit: () => Promise<Answer>;
  onClose: () => void;
}) {
  const router = useRouter();
  const reasonId = useId();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      try {
        const res = await onSubmit();
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success(res.message);
        for (const warning of res.warnings ?? []) toast.warning(warning);
        onClose();
        router.refresh();
      } catch {
        setError(REQUEST_FAILED);
      }
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription render={<div />}>
              {description}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {children}
        {error ? (
          <p role="alert" className={ERROR}>
            {error}
          </p>
        ) : null}
        {blockedReason ? (
          <p id={reasonId} className="text-xs text-[var(--dash-text-2)]">
            {blockedReason}
          </p>
        ) : null}
        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className={BTN}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || Boolean(blockedReason)}
            aria-describedby={blockedReason ? reasonId : undefined}
            className={PRIMARY}
          >
            {pending ? (
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            ) : null}
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  rows?: number;
}) {
  // The hint sits outside the label, so the field's name stays the label alone.
  const hintId = useId();
  return (
    <div>
      <label className="block">
        <span className={LABEL}>{label}</span>
        <textarea
          className="dash-input w-full"
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hint ? hintId : undefined}
        />
      </label>
      {hint ? (
        <span id={hintId} className={HINT}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function Tick({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-[var(--dash-text)] pointer-coarse:min-h-11">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export type BlockActionsProps = {
  blockId: string;
  kind: BlockKind;
  label: string;
  storeName: string;
  storeStatusBefore: string | null;
  status: BlockStatus;
  /** The store was told about the block (not kept from it under an order). */
  told: boolean;
  fileStage: FileStage | null;
  /** A replacement holds the file right now: a lift waits (design 5.4). */
  replacingNow: boolean;
  archive: {
    keepUntil: string;
    legalHold: boolean;
    purgedAt: string | null;
  } | null;
  /** Image blocks made with this one that are still in force. */
  liveImageBlocks: number;
  superadmin: boolean;
};

/** "Tell the store now" and "Lift block" (design 6.6): a superadmin's. */
export function BlockActions(props: BlockActionsProps) {
  const [open, setOpen] = useState<"tell" | "lift" | null>(null);
  const [note, setNote] = useState("");
  const [notifyStore, setNotifyStore] = useState(true);
  const [alsoChildren, setAlsoChildren] = useState(true);
  if (!props.superadmin) return null;
  const canTell = props.status === "blocked_untold";
  const canLift = props.status !== "lifted";
  if (!canTell && !canLift) return null;
  const close = () => setOpen(null);
  const images = props.liveImageBlocks;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {canTell ? (
          <button type="button" className={BTN} onClick={() => setOpen("tell")}>
            Tell the store now
          </button>
        ) : null}
        {canLift ? (
          <button
            type="button"
            className={BTN}
            onClick={() => {
              setNote("");
              setNotifyStore(true);
              setAlsoChildren(true);
              setOpen("lift");
            }}
          >
            Lift block
          </button>
        ) : null}
      </div>

      {open === "tell" ? (
        <ActionDialog
          title={`Tell ${props.storeName} about this block now?`}
          description="They get the email, the notice and the label on the item. This can't be undone."
          confirmLabel="Tell the store now"
          onClose={close}
          onSubmit={() => tellStoreNowAction(props.blockId)}
        />
      ) : null}

      {open === "lift" ? (
        <ActionDialog
          title={
            props.kind === "store"
              ? `Lift the suspension of ${props.storeName}?`
              : `Lift the block on ${props.label}?`
          }
          description={
            <>
              {liftDialogLines({
                kind: props.kind,
                storeName: props.storeName,
                storeStatusBefore: props.storeStatusBefore,
                fileStage: props.fileStage,
                archive: props.archive,
              }).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </>
          }
          confirmLabel="Lift block"
          blockedReason={props.replacingNow ? LIFT_REPLACING : null}
          onClose={close}
          onSubmit={() =>
            liftBlockAction(props.blockId, {
              note,
              notifyStore: props.told ? notifyStore : false,
              alsoChildren: images > 0 ? alsoChildren : false,
            })
          }
        >
          <div className="space-y-3">
            <TextField
              label="Why are you lifting it? The store sees this."
              value={note}
              onChange={setNote}
            />
            {props.told ? (
              <Tick
                label="Tell the store by email"
                checked={notifyStore}
                onChange={setNotifyStore}
              />
            ) : null}
            {images > 0 ? (
              <Tick
                label={
                  images === 1
                    ? "Also lift the block on its image"
                    : `Also lift the blocks on its ${images} images`
                }
                checked={alsoChildren}
                onChange={setAlsoChildren}
              />
            ) : null}
          </div>
        </ActionDialog>
      ) : null}
    </>
  );
}

/** "Retry now" next to a copy or a replacement that is waiting (design 6.6). */
export function RetryNowButton({ blockId }: { blockId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            try {
              const res = await retryStorageAction(blockId);
              if (!res.ok) {
                setError(res.error);
                return;
              }
              toast.success(res.message);
              router.refresh();
            } catch {
              setError(REQUEST_FAILED);
            }
          });
        }}
      >
        {pending ? (
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
        ) : null}
        Retry now
      </button>
      {error ? (
        <span role="alert" className={ERROR}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** "Mark as removed" for a file built into a theme (design 6.6). */
export function MarkRemovedButton({ blockId }: { blockId: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  return (
    <>
      <button
        type="button"
        className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
        onClick={() => {
          setNote("");
          setOpen(true);
        }}
      >
        Mark as removed
      </button>
      {open ? (
        <ActionDialog
          title="Mark it as removed?"
          description="Do this only after the file is deleted."
          confirmLabel="Mark as removed"
          onClose={() => setOpen(false)}
          onSubmit={() => markRemovedByHandAction(blockId, note)}
        >
          <TextField
            label="How it was removed"
            value={note}
            onChange={setNote}
          />
        </ActionDialog>
      ) : null}
    </>
  );
}

// ── The archived copy ──────────────────────────────────────────────────────

type Viewing = { receipt: string; archive: ArchiveForViewing };

/** The archive routes of one block, with the receipt the reason earned. */
export function archiveFileHref(
  blockId: string,
  n: number,
  receipt: string,
  download = false,
): string {
  const base = `/api/platform/takedowns/${encodeURIComponent(blockId)}/files/${n}?receipt=${encodeURIComponent(receipt)}`;
  return download ? `${base}&download=1` : base;
}

export function archiveRecordHref(blockId: string, receipt: string): string {
  return `/api/platform/takedowns/${encodeURIComponent(blockId)}/record?receipt=${encodeURIComponent(receipt)}`;
}

const FILE_READ_FAILED = "Could not read the file. Please try again.";

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-[var(--dash-radius-sm)] bg-[var(--dash-surface-2)] p-3 text-xs break-all whitespace-pre-wrap text-[var(--dash-text)]">
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  );
}

/** One file of the copy: details, Download, and for a picture Show. */
function ArchivedFileRow({
  blockId,
  receipt,
  file,
}: {
  blockId: string;
  receipt: string;
  file: ArchiveForViewing["files"][number];
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const objectUrl = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const entry = file.entry;
  if (!entry) {
    return (
      <li className="py-2">
        <JsonBlock value={file.raw} />
      </li>
    );
  }
  const copied = entry.state === "copied";
  const picture = copied && /^image\//i.test(entry.contentType ?? "");
  const state = entry.state.charAt(0).toUpperCase() + entry.state.slice(1);

  async function show() {
    if (!entry) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(archiveFileHref(blockId, entry.n, receipt), {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).trim();
        setError(text && res.status !== 404 ? text : FILE_READ_FAILED);
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      objectUrl.current = url;
      setSrc(url);
    } catch {
      setError(FILE_READ_FAILED);
    } finally {
      setLoading(false);
    }
  }

  return (
    <li className="space-y-2 py-3">
      <p className="text-sm break-all text-[var(--dash-text)]">{entry.path}</p>
      <p className="text-xs text-[var(--dash-text-2)]">
        {[
          state,
          entry.contentType,
          entry.size !== null
            ? `${entry.size.toLocaleString("en-IN")} bytes`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {entry.sha256 ? (
        <p className="text-xs break-all text-[var(--dash-text-2)]">
          {`SHA-256: ${entry.sha256}`}
        </p>
      ) : null}
      {picture ? (
        src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            className="max-h-64 rounded-[var(--dash-radius-sm)]"
          />
        ) : (
          <span
            aria-hidden
            className="block h-24 w-24 rounded-[var(--dash-radius-sm)] bg-[var(--dash-surface-2)] blur-sm"
          />
        )
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {picture && !src ? (
          <button
            type="button"
            className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
            onClick={show}
            disabled={loading}
          >
            {loading ? (
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            ) : null}
            Show
          </button>
        ) : null}
        {copied ? (
          <a
            href={archiveFileHref(blockId, entry.n, receipt, true)}
            className={LINK}
          >
            Download
          </a>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className={ERROR}>
          {error}
        </p>
      ) : null}
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)] px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-[var(--dash-text)] pointer-coarse:min-h-11 pointer-coarse:py-2">
        {title}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

/** The opened copy (design 6.6): sections, its fingerprint, the files. */
function ArchiveViewer({
  blockId,
  viewing,
}: {
  blockId: string;
  viewing: Viewing;
}) {
  const snapshot =
    viewing.archive.snapshot && typeof viewing.archive.snapshot === "object"
      ? (viewing.archive.snapshot as Record<string, unknown>)
      : {};
  return (
    <div className="space-y-3 border-t border-[var(--dash-border)] pt-4">
      <p className="text-xs break-all text-[var(--dash-text-2)]">
        {`SHA-256: ${viewing.archive.sha256}`}
      </p>
      {!viewing.archive.hashMatches ? (
        <p role="alert" className={ERROR}>
          The copy no longer matches its fingerprint.
        </p>
      ) : null}
      <a href={archiveRecordHref(blockId, viewing.receipt)} className={LINK}>
        Download record
      </a>
      <Section title="Store">
        <JsonBlock value={snapshot.store} />
      </Section>
      <Section title="Item">
        <JsonBlock value={snapshot.item} />
      </Section>
      <Section title="Related">
        <JsonBlock value={snapshot.related} />
      </Section>
      <Section title="History">
        <JsonBlock value={snapshot.history} />
      </Section>
      <Section title="Files">
        {viewing.archive.files.length === 0 ? (
          <p className="text-sm text-[var(--dash-text-2)]">-</p>
        ) : (
          <ul className="divide-y divide-[var(--dash-border)]">
            {viewing.archive.files.map((file, index) => (
              <ArchivedFileRow
                key={file.entry ? `n${file.entry.n}` : `raw${index}`}
                blockId={blockId}
                receipt={viewing.receipt}
                file={file}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** What the page tells everyone about the copy (design 6.6). */
export function archiveSummaryLine(
  archive: Pick<
    ArchiveSummary,
    "createdAt" | "keepUntil" | "legalHold" | "purgedAt" | "sha256"
  >,
  superadmin: boolean,
): string {
  if (archive.purgedAt) {
    return `The copy was deleted on ${istDate(archive.purgedAt)}, as the law allows after 180 days. Its fingerprint was SHA-256 ${archive.sha256}.`;
  }
  const kept = archive.legalHold
    ? `A copy was kept on ${istDate(archive.createdAt)} and will be kept until it is released.`
    : `A copy was kept on ${istDate(archive.createdAt)} and will be deleted after ${istDate(archive.keepUntil)}.`;
  return superadmin ? kept : `${kept} Only a superadmin can open it.`;
}

/** The archived copy's card body (design 6.6). */
export function ArchiveCopy({
  blockId,
  archive,
  superadmin,
}: {
  blockId: string;
  archive: ArchiveSummary;
  superadmin: boolean;
}) {
  const [open, setOpen] = useState<"open" | "keep" | "release" | null>(null);
  const [reason, setReason] = useState("");
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [keep, setKeep] = useState<"date" | "hold">("date");
  const [until, setUntil] = useState("");
  const [whoAsked, setWhoAsked] = useState("");
  const [note, setNote] = useState("");
  const close = () => setOpen(null);
  const purged = Boolean(archive.purgedAt);

  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--dash-text)]">
        {archiveSummaryLine(archive, superadmin)}
      </p>
      {archive.legalHold && archive.legalHoldNote && !purged ? (
        <p className="text-sm text-[var(--dash-text-2)]">
          {`Who asked: ${archive.legalHoldNote}`}
        </p>
      ) : null}

      {superadmin && !purged ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BTN}
            onClick={() => {
              setReason("");
              setOpen("open");
            }}
          >
            Open the copy
          </button>
          {archive.legalHold ? (
            <button
              type="button"
              className={BTN}
              onClick={() => {
                setNote("");
                setOpen("release");
              }}
            >
              Release hold
            </button>
          ) : (
            <button
              type="button"
              className={BTN}
              onClick={() => {
                setKeep("date");
                setUntil("");
                setWhoAsked("");
                setOpen("keep");
              }}
            >
              Keep longer
            </button>
          )}
        </div>
      ) : null}

      {viewing ? <ArchiveViewer blockId={blockId} viewing={viewing} /> : null}

      {open === "open" ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) close();
          }}
        >
          <OpenCopyDialogBody
            reason={reason}
            setReason={setReason}
            onClose={close}
            onOpened={(next) => {
              setViewing(next);
              close();
            }}
            blockId={blockId}
          />
        </Dialog>
      ) : null}

      {open === "keep" ? (
        <ActionDialog
          title="Keep this copy longer"
          confirmLabel="Keep longer"
          onClose={close}
          onSubmit={() =>
            extendArchiveAction(
              blockId,
              keep === "hold" ? { hold: true } : { until },
              whoAsked,
            )
          }
        >
          <fieldset className="space-y-2">
            <legend className="sr-only">How long</legend>
            <label className="flex items-center gap-2 text-sm text-[var(--dash-text)] pointer-coarse:min-h-11">
              <input
                type="radio"
                name="keep"
                checked={keep === "date"}
                onChange={() => setKeep("date")}
              />
              Until a date
            </label>
            {keep === "date" ? (
              <input
                type="date"
                aria-label="Until a date"
                className="dash-input w-full pointer-coarse:min-h-11"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            ) : null}
            <label className="flex items-center gap-2 text-sm text-[var(--dash-text)] pointer-coarse:min-h-11">
              <input
                type="radio"
                name="keep"
                checked={keep === "hold"}
                onChange={() => setKeep("hold")}
              />
              Until we release it
            </label>
          </fieldset>
          <TextField
            label="Who asked"
            value={whoAsked}
            onChange={setWhoAsked}
            hint="The authority and their reference number."
          />
        </ActionDialog>
      ) : null}

      {open === "release" ? (
        <ActionDialog
          title="Release hold"
          confirmLabel="Release hold"
          onClose={close}
          onSubmit={() => releaseArchiveHoldAction(blockId, note)}
        >
          <TextField label="Note" value={note} onChange={setNote} />
        </ActionDialog>
      ) : null}
    </div>
  );
}

/** "Why are you opening it?" (design 6.6): the reason first, then the copy. */
function OpenCopyDialogBody({
  blockId,
  reason,
  setReason,
  onClose,
  onOpened,
}: {
  blockId: string;
  reason: string;
  setReason: (value: string) => void;
  onClose: () => void;
  onOpened: (viewing: Viewing) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      try {
        const res = await openArchiveAction(blockId, reason);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        onOpened({ receipt: res.receipt, archive: res.archive });
      } catch {
        setError(REQUEST_FAILED);
      }
    });
  }

  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Open the copy</DialogTitle>
      </DialogHeader>
      <TextField
        label="Why are you opening it?"
        value={reason}
        onChange={setReason}
        hint="The complaint reference or the authority that asked."
      />
      {error ? (
        <p role="alert" className={ERROR}>
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          className={BTN}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className={PRIMARY}
        >
          {pending ? (
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          ) : null}
          Open the copy
        </button>
      </DialogFooter>
    </DialogContent>
  );
}

// ── The conversation with the store ────────────────────────────────────────

/** "Reply to the store" and "Add the store's emailed reply" (design 6.6). */
export function StoreReplyForms({ blockId }: { blockId: string }) {
  const router = useRouter();
  const replyId = useId();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [emailed, setEmailed] = useState(false);
  const [from, setFrom] = useState("");
  const [theirReply, setTheirReply] = useState("");

  function send() {
    setError(null);
    start(async () => {
      try {
        const res = await replyToStoreAction(blockId, body);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success(res.message);
        setBody("");
        router.refresh();
      } catch {
        setError(REQUEST_FAILED);
      }
    });
  }

  return (
    <div className="space-y-3">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        className="space-y-2"
      >
        <div className="mb-1 flex items-center gap-1.5">
          <label
            htmlFor={replyId}
            className="text-sm font-medium text-[var(--dash-text)]"
          >
            Reply to the store
          </label>
          <InfoTip label="About replies">
            The store sees this in its dashboard and by email.
          </InfoTip>
        </div>
        <textarea
          id={replyId}
          className="dash-input w-full"
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={pending}
        />
        {error ? (
          <p role="alert" className={ERROR}>
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className={BTN}
            onClick={() => {
              setFrom("");
              setTheirReply("");
              setEmailed(true);
            }}
            disabled={pending}
          >
            Add the store&apos;s emailed reply
          </button>
          <button type="submit" disabled={pending} className={PRIMARY}>
            {pending ? (
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            ) : null}
            Send
          </button>
        </div>
      </form>

      {emailed ? (
        <ActionDialog
          title="Add the store's emailed reply"
          confirmLabel="Add reply"
          onClose={() => setEmailed(false)}
          onSubmit={() => addStoreEmailedReplyAction(blockId, from, theirReply)}
        >
          <div className="space-y-3">
            <label className="block">
              <span className={LABEL}>From</span>
              <input
                type="email"
                className="dash-input w-full pointer-coarse:min-h-11"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                autoComplete="off"
              />
            </label>
            <TextField
              label="Their reply"
              value={theirReply}
              onChange={setTheirReply}
              rows={4}
            />
          </div>
        </ActionDialog>
      ) : null}
    </div>
  );
}
