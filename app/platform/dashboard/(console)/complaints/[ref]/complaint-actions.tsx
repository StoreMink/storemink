"use client";

import Link from "next/link";
import { useId, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  acknowledgeComplaintAction,
  markComplaintActionedAction,
  reopenComplaintAction,
  resolveComplaintAction,
  updateComplaintAction,
} from "@/app/actions/takedown-actions";
import {
  COMPLAINT_KINDS,
  COMPLAINT_OUTCOMES,
  type ComplaintKind,
  type ComplaintOutcome,
} from "@/lib/moderation/kinds";
import {
  OUTCOME_LABEL,
  actionedWords,
  blockItemHref,
  kindHelpParts,
} from "../complaints-console";

// ---------------------------------------------------------------------------
// The actions of one complaint (takedown design 6.4), each a dialog over one
// T15 action (app/actions/takedown-actions.ts), never a lib module.
//
// ★ EVERY OPERATOR GETS EVERY BUTTON HERE: logging, acknowledging, changing
// the kind, blocking, resolving and reopening are all a member's as much as a
// superadmin's (design 3.10), and each action checks again on the server.
//
// ★ THE ACTION'S SENTENCE IS THE ONE SHOWN. A refusal comes back with the
// design's own words ("The email could not be sent. If you replied from the
// mailbox, use Mark as acknowledged.", "Write a note for this outcome."); the
// request-failed line is only for a request that never got an answer.
// ---------------------------------------------------------------------------

const BTN = "dash-btn dash-btn-ghost pointer-coarse:min-h-11";
const PRIMARY = "dash-btn dash-btn-primary pointer-coarse:min-h-11";
const LABEL = "mb-1 block text-sm font-medium text-[var(--dash-text)]";
const HINT = "mt-1 block text-xs text-[var(--dash-text-2)]";
const ERROR = "text-sm text-[var(--dash-red)]";

/** Shown only when the request itself failed, never for a refusal. */
export const REQUEST_FAILED =
  "The request didn't reach StoreMink. Refresh the page and try again.";

const NEEDS_NOTE: readonly ComplaintOutcome[] = [
  "not_removed",
  "partly_removed",
];
const NOTE_MISSING = "Write a note for this outcome.";

type Answer =
  | { ok: true; message: string; warnings?: string[] }
  | { ok: false; error: string };

export type ComplaintActionsProps = {
  complaintId: string;
  reference: string;
  kind: ComplaintKind;
  /** The complainant's email address when the contact is one, else null. */
  email: string | null;
  acknowledged: boolean;
  actioned: boolean;
  resolved: boolean;
  erased: boolean;
};

type Open = "send" | "mark" | "kind" | "actioned" | "resolve" | "reopen" | null;

/** One dialog: a question, its fields, and one write behind its button. */
function ActionDialog({
  title,
  description,
  confirmLabel,
  children,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  children?: ReactNode;
  onSubmit: () => Promise<Answer | null>;
  onClose: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      try {
        const res = await onSubmit();
        if (res === null) return;
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
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {children}
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
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NoteField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  // The hint sits outside the label, so the field's name stays the label alone.
  const hintId = useId();
  return (
    <div>
      <label className="block">
        <span className={LABEL}>{label}</span>
        <textarea
          className="dash-input w-full"
          rows={3}
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

function KindDialog({
  props,
  onClose,
}: {
  props: ComplaintActionsProps;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<ComplaintKind>(props.kind);
  return (
    <ActionDialog
      title={`What kind of complaint is ${props.reference}?`}
      description="If the new kind is stricter, its deadlines apply from when the complaint reached us. A deadline never moves later."
      confirmLabel="Change kind"
      onClose={onClose}
      onSubmit={() => updateComplaintAction(props.complaintId, { kind })}
    >
      <fieldset className="grid gap-2">
        <legend className="sr-only">What is it?</legend>
        {COMPLAINT_KINDS.map((value) => {
          const { head, rest } = kindHelpParts(value);
          return (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-2 rounded-[var(--dash-radius-sm)] border px-3 py-2 text-sm pointer-coarse:min-h-11 ${
                kind === value
                  ? "border-[var(--dash-accent)] bg-[var(--dash-accent-soft)]"
                  : "border-[var(--dash-border-strong)]"
              }`}
            >
              <input
                type="radio"
                name="change-kind"
                value={value}
                checked={kind === value}
                onChange={() => setKind(value)}
                className="mt-1"
              />
              <span className="text-[var(--dash-text)]">
                <span className="font-medium">{head}:</span> {rest}
              </span>
            </label>
          );
        })}
      </fieldset>
    </ActionDialog>
  );
}

function ActionedDialog({
  props,
  onClose,
}: {
  props: ComplaintActionsProps;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const question =
    props.kind === "information_order"
      ? "What did we provide, and to whom?"
      : props.kind === "data_request"
        ? "How did we answer, and to whom?"
        : "Why is no removal needed?";
  return (
    <ActionDialog
      title={actionedWords(props.kind)}
      confirmLabel={actionedWords(props.kind)}
      onClose={onClose}
      onSubmit={() => markComplaintActionedAction(props.complaintId, note)}
    >
      <NoteField label={question} value={note} onChange={setNote} />
    </ActionDialog>
  );
}

function ResolveDialog({
  props,
  onClose,
}: {
  props: ComplaintActionsProps;
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<ComplaintOutcome | "">("");
  const [note, setNote] = useState("");
  const [email, setEmail] = useState(props.email !== null);
  const needsNote = outcome !== "" && NEEDS_NOTE.includes(outcome);
  return (
    <ActionDialog
      title={`Resolve ${props.reference}`}
      confirmLabel="Resolve"
      onClose={onClose}
      onSubmit={async () => {
        if (needsNote && !note.trim()) {
          return { ok: false, error: NOTE_MISSING };
        }
        return resolveComplaintAction(props.complaintId, {
          outcome,
          note,
          emailComplainant: props.email !== null && email,
        });
      }}
    >
      <fieldset>
        <legend className={LABEL}>Outcome</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {COMPLAINT_OUTCOMES.map((value) => (
            <label
              key={value}
              className={`flex cursor-pointer items-center gap-2 rounded-[var(--dash-radius-sm)] border px-3 py-2 text-sm pointer-coarse:min-h-11 ${
                outcome === value
                  ? "border-[var(--dash-accent)] bg-[var(--dash-accent-soft)]"
                  : "border-[var(--dash-border-strong)]"
              }`}
            >
              <input
                type="radio"
                name="outcome"
                value={value}
                checked={outcome === value}
                onChange={() => setOutcome(value)}
              />
              <span className="text-[var(--dash-text)]">
                {OUTCOME_LABEL[value]}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <NoteField
        label="Note"
        value={note}
        onChange={setNote}
        hint={
          needsNote
            ? "Say why. The complainant can appeal to the Grievance Appellate Committee."
            : undefined
        }
      />
      {props.email !== null ? (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--dash-text)] pointer-coarse:min-h-11">
          <input
            type="checkbox"
            checked={email}
            onChange={(e) => setEmail(e.target.checked)}
          />
          <span className="break-all">Email the outcome to {props.email}</span>
        </label>
      ) : null}
    </ActionDialog>
  );
}

function ReopenDialog({
  props,
  onClose,
}: {
  props: ComplaintActionsProps;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      title={`Reopen ${props.reference}?`}
      confirmLabel="Reopen"
      onClose={onClose}
      onSubmit={() => reopenComplaintAction(props.complaintId, note)}
    >
      <NoteField label="Note" value={note} onChange={setNote} />
    </ActionDialog>
  );
}

/** The buttons of design 6.4, by where the complaint stands. */
export function ComplaintActions(props: ComplaintActionsProps) {
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);

  if (props.erased) return null;
  const canAcknowledge = !props.acknowledged && !props.resolved;
  const canAct = !props.actioned && !props.resolved;

  return (
    <div className="flex flex-wrap gap-2">
      {canAcknowledge && props.email !== null ? (
        <button
          type="button"
          className={PRIMARY}
          onClick={() => setOpen("send")}
        >
          Send acknowledgement
        </button>
      ) : null}
      {canAcknowledge ? (
        <button type="button" className={BTN} onClick={() => setOpen("mark")}>
          Mark as acknowledged
        </button>
      ) : null}
      <button type="button" className={BTN} onClick={() => setOpen("kind")}>
        Change kind
      </button>
      {!props.resolved ? (
        <Link href={blockItemHref(props.reference)} className={BTN}>
          Block an item
        </Link>
      ) : null}
      {canAct ? (
        <button
          type="button"
          className={BTN}
          onClick={() => setOpen("actioned")}
        >
          {actionedWords(props.kind)}
        </button>
      ) : null}
      {!props.resolved ? (
        <button
          type="button"
          className={BTN}
          onClick={() => setOpen("resolve")}
        >
          Resolve
        </button>
      ) : (
        <button type="button" className={BTN} onClick={() => setOpen("reopen")}>
          Reopen
        </button>
      )}

      {open === "send" && props.email !== null ? (
        <ActionDialog
          title="Send acknowledgement"
          description={`Send the acknowledgement to ${props.email}? It confirms we received the complaint, gives the reference ${props.reference} with a copy of the complaint as we recorded it, and says when we will resolve it.`}
          confirmLabel="Send"
          onClose={close}
          onSubmit={() =>
            acknowledgeComplaintAction(props.complaintId, { sendEmail: true })
          }
        />
      ) : null}
      {open === "mark" ? (
        <ActionDialog
          title="Mark as acknowledged"
          description={`Mark ${props.reference} as acknowledged? Use this when you replied from the support mailbox.`}
          confirmLabel="Mark as acknowledged"
          onClose={close}
          onSubmit={() => acknowledgeComplaintAction(props.complaintId)}
        />
      ) : null}
      {open === "kind" ? <KindDialog props={props} onClose={close} /> : null}
      {open === "actioned" ? (
        <ActionedDialog props={props} onClose={close} />
      ) : null}
      {open === "resolve" ? (
        <ResolveDialog props={props} onClose={close} />
      ) : null}
      {open === "reopen" ? (
        <ReopenDialog props={props} onClose={close} />
      ) : null}
    </div>
  );
}
