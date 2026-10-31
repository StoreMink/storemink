"use client";

// ---------------------------------------------------------------------------
// The inbox's two small managers: the store's labels and its saved replies.
// Dialogs on the inbox screen rather than pages of their own, because both
// are edited WHILE working a conversation ("we need a Wholesale label", "I
// keep typing this") and a page away is where a thing stops being used.
// The dialog validates with the same pure rule the action re-runs
// (lib/whatsapp/inbox-workspace.ts); the action is the boundary.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { toast } from "sonner";
import { Bookmark, Pencil, Tag, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoTip } from "@/components/ui/info-tip";
import {
  deleteInboxCannedReply,
  deleteInboxLabel,
  getInboxWorkspace,
  saveInboxCannedReply,
  saveInboxLabel,
} from "@/app/actions/inbox-actions";
import {
  INBOX_CANNED_BODY_MAX,
  INBOX_CANNED_MAX,
  INBOX_CANNED_TITLE_MAX,
  INBOX_LABEL_COLORS,
  INBOX_LABEL_MAX,
  INBOX_LABEL_NAME_MAX,
  validateCannedReply,
  validateInboxLabel,
} from "@/lib/whatsapp/inbox-workspace";
import type {
  InboxCannedReply,
  InboxLabel,
  InboxWorkspace,
} from "@/lib/whatsapp/inbox-types";

export function InboxManageButtons({
  workspace,
  canManage,
  onChanged,
}: {
  workspace: InboxWorkspace;
  canManage: boolean;
  onChanged: (next: InboxWorkspace) => void;
}) {
  const [open, setOpen] = useState<"labels" | "replies" | null>(null);
  if (!canManage) return null;

  async function refresh() {
    const r = await getInboxWorkspace();
    if (!r.error) onChanged(r.workspace);
  }

  return (
    <>
      <button
        type="button"
        className="dash-btn dash-btn-ghost dash-btn-sm shrink-0"
        onClick={() => setOpen("labels")}
      >
        <Tag className="h-4 w-4" />
        Labels
      </button>
      <button
        type="button"
        className="dash-btn dash-btn-ghost dash-btn-sm shrink-0"
        onClick={() => setOpen("replies")}
      >
        <Bookmark className="h-4 w-4" />
        Saved replies
      </button>
      <Dialog
        open={open === "labels"}
        onOpenChange={(o) => !o && setOpen(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Labels</DialogTitle>
            <DialogDescription>
              Tag conversations so your team can filter them.
            </DialogDescription>
          </DialogHeader>
          <LabelsEditor labels={workspace.labels} onChanged={refresh} />
        </DialogContent>
      </Dialog>
      <Dialog
        open={open === "replies"}
        onOpenChange={(o) => !o && setOpen(null)}
      >
        <DialogContent className="inbox-dialog-wide">
          <DialogHeader>
            <DialogTitle>Saved replies</DialogTitle>
            <DialogDescription>
              Type &ldquo;/&rdquo; in the message box to use one.
            </DialogDescription>
          </DialogHeader>
          <RepliesEditor
            replies={workspace.cannedReplies}
            onChanged={refresh}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function LabelsEditor({
  labels,
  onChanged,
}: {
  labels: InboxLabel[];
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<{
    id: string | null;
    name: string;
    color: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!editing || busy) return;
    const v = validateInboxLabel({ name: editing.name, color: editing.color });
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    setBusy(true);
    const r = await saveInboxLabel({
      id: editing.id,
      name: v.name,
      color: v.color,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? "Couldn't save the label.");
      return;
    }
    setEditing(null);
    await onChanged();
  }

  async function remove(label: InboxLabel) {
    if (busy) return;
    if (
      !window.confirm(
        `Delete the label "${label.name}"? It is removed from every conversation that carries it.`,
      )
    ) {
      return;
    }
    setBusy(true);
    const r = await deleteInboxLabel(label.id);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? "Couldn't delete the label.");
      return;
    }
    await onChanged();
  }

  const form = editing && (
    <form
      className="inbox-manage-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="inbox-field">
        <span>Name</span>
        <input
          value={editing.name}
          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          maxLength={INBOX_LABEL_NAME_MAX}
          autoFocus
        />
      </label>
      <label className="inbox-field">
        <span>Colour</span>
        <span className="inbox-swatches" role="radiogroup" aria-label="Colour">
          {INBOX_LABEL_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={editing.color === c}
              aria-label={c}
              className={`inbox-swatch is-${c} ${editing.color === c ? "is-on" : ""}`}
              onClick={() => setEditing({ ...editing, color: c })}
            />
          ))}
        </span>
      </label>
      <div className="inbox-manage-actions">
        <button
          type="button"
          className="dash-btn dash-btn-ghost dash-btn-sm"
          onClick={() => setEditing(null)}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="dash-btn dash-btn-primary dash-btn-sm"
          disabled={busy || !editing.name.trim()}
        >
          {editing.id ? "Save" : "Add label"}
        </button>
      </div>
    </form>
  );

  return (
    <div className="inbox-manage">
      {labels.length === 0 && !editing ? (
        <p className="inbox-note">No labels yet.</p>
      ) : (
        <ul className="inbox-manage-list">
          {labels.map((l) => (
            <li key={l.id}>
              {editing?.id === l.id ? (
                form
              ) : (
                <>
                  <span className={`inbox-chip is-${l.color}`}>{l.name}</span>
                  <span className="inbox-manage-row-actions">
                    <button
                      type="button"
                      className="inbox-icon-btn"
                      aria-label={`Edit ${l.name}`}
                      onClick={() =>
                        setEditing({ id: l.id, name: l.name, color: l.color })
                      }
                      disabled={busy}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="inbox-icon-btn"
                      aria-label={`Delete ${l.name}`}
                      onClick={() => remove(l)}
                      disabled={busy}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && editing.id === null ? (
        form
      ) : labels.length < INBOX_LABEL_MAX ? (
        <button
          type="button"
          className="dash-btn dash-btn-ghost dash-btn-sm self-start"
          onClick={() => setEditing({ id: null, name: "", color: "grey" })}
          disabled={busy || editing !== null}
        >
          Add a label
        </button>
      ) : (
        <p className="inbox-note">
          This store has {INBOX_LABEL_MAX} labels. Delete one to add another.
        </p>
      )}
    </div>
  );
}

function RepliesEditor({
  replies,
  onChanged,
}: {
  replies: InboxCannedReply[];
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<{
    id: string | null;
    shortcut: string;
    title: string;
    body: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!editing || busy) return;
    const v = validateCannedReply(editing);
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    setBusy(true);
    const r = await saveInboxCannedReply({
      id: editing.id,
      shortcut: v.shortcut,
      title: v.title,
      body: v.body,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? "Couldn't save the reply.");
      return;
    }
    setEditing(null);
    await onChanged();
  }

  async function remove(reply: InboxCannedReply) {
    if (busy) return;
    if (!window.confirm(`Delete the saved reply "/${reply.shortcut}"?`)) return;
    setBusy(true);
    const r = await deleteInboxCannedReply(reply.id);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? "Couldn't delete the reply.");
      return;
    }
    await onChanged();
  }

  const form = editing && (
    <form
      className="inbox-manage-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="inbox-manage-grid">
        <label className="inbox-field">
          <span>Shortcut</span>
          <span className="inbox-shortcut-input">
            <span aria-hidden="true">/</span>
            <input
              value={editing.shortcut}
              onChange={(e) =>
                setEditing({ ...editing, shortcut: e.target.value })
              }
              maxLength={30}
              autoFocus
            />
          </span>
        </label>
        <label className="inbox-field">
          <span>Title</span>
          <input
            value={editing.title}
            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            maxLength={INBOX_CANNED_TITLE_MAX}
          />
        </label>
      </div>
      <div className="inbox-field">
        <span className="flex items-center gap-1.5">
          <label htmlFor="saved-reply-body">Reply</label>
          <InfoTip label="About saved replies">
            Write {"{{name}}"} where the customer&rsquo;s first name should go.
          </InfoTip>
        </span>
        <textarea
          id="saved-reply-body"
          value={editing.body}
          onChange={(e) => setEditing({ ...editing, body: e.target.value })}
          maxLength={INBOX_CANNED_BODY_MAX}
          rows={4}
        />
      </div>
      <div className="inbox-manage-actions">
        <button
          type="button"
          className="dash-btn dash-btn-ghost dash-btn-sm"
          onClick={() => setEditing(null)}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="dash-btn dash-btn-primary dash-btn-sm"
          disabled={busy}
        >
          {editing.id ? "Save" : "Add reply"}
        </button>
      </div>
    </form>
  );

  return (
    <div className="inbox-manage">
      {replies.length === 0 && !editing ? (
        <p className="inbox-note">No saved replies yet.</p>
      ) : (
        <ul className="inbox-manage-list">
          {replies.map((r) => (
            <li key={r.id}>
              {editing?.id === r.id ? (
                form
              ) : (
                <>
                  <span className="inbox-manage-reply">
                    <span className="inbox-manage-reply-head">
                      <code>/{r.shortcut}</code> {r.title}
                    </span>
                    <span className="inbox-manage-reply-body">{r.body}</span>
                  </span>
                  <span className="inbox-manage-row-actions">
                    <button
                      type="button"
                      className="inbox-icon-btn"
                      aria-label={`Edit /${r.shortcut}`}
                      onClick={() =>
                        setEditing({
                          id: r.id,
                          shortcut: r.shortcut,
                          title: r.title,
                          body: r.body,
                        })
                      }
                      disabled={busy}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="inbox-icon-btn"
                      aria-label={`Delete /${r.shortcut}`}
                      onClick={() => remove(r)}
                      disabled={busy}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && editing.id === null ? (
        form
      ) : replies.length < INBOX_CANNED_MAX ? (
        <button
          type="button"
          className="dash-btn dash-btn-ghost dash-btn-sm self-start"
          onClick={() =>
            setEditing({ id: null, shortcut: "", title: "", body: "" })
          }
          disabled={busy || editing !== null}
        >
          Add a saved reply
        </button>
      ) : (
        <p className="inbox-note">
          This store has {INBOX_CANNED_MAX} saved replies. Delete one to add
          another.
        </p>
      )}
    </div>
  );
}
