"use client";

import { useState, useTransition, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteThemeStudioProjectAction } from "@/app/actions/theme-studio-actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Delete a theme for good, behind a dialog that asks for its theme ID. The
// theme page opens the dialog from its "..." menu (DeleteThemeDialog); the
// server refuses, in a sentence shown in the dialog, while work holds it
// (migration 0161).
// ★ A theme stores use can be deleted (owner, 23 Nov 2026: "store which uses
//   this theme should remain as it is"): it leaves the library, and each of
//   those stores keeps the release it installed (migration 0289). The toast
//   says how many stores kept it.

export interface DeleteThemeProps {
  projectId: string;
  themeId: string;
  name: string;
  revision: number;
}

/** The toast after a deletion: whether any store kept the theme. */
export function deletedMessage(storesKept: number): string {
  if (storesKept <= 0) return "Theme deleted for good.";
  return storesKept === 1
    ? "Theme deleted. The store using it keeps it as it is."
    : `Theme deleted. The ${storesKept} stores using it keep it as it is.`;
}

/** The Delete dialog on its own, opened by a control elsewhere (the "..."
 * menu). `returnFocusTo` gets focus back when it closes. */
export function DeleteThemeDialog({
  projectId,
  themeId,
  name,
  revision,
  open,
  onOpenChange,
  returnFocusTo,
}: DeleteThemeProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Every opening starts clean, however it was opened.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setConfirmation("");
      setError(null);
    }
  }
  function remove() {
    startTransition(async () => {
      try {
        const result = await deleteThemeStudioProjectAction({
          projectId,
          expectedRevision: revision,
          confirmation,
        });
        if (!result.ok) {
          setError(result.error ?? "The theme could not be deleted.");
          return;
        }
        toast.success(deletedMessage(result.storesKept ?? 0));
        onOpenChange(false);
        router.push("/dashboard/themes/studio");
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
          <DialogTitle>Delete {name} for good?</DialogTitle>
          <DialogDescription>
            This erases the theme, its chat, designs and checks, and takes it
            out of the theme library, so no new store can choose it. Stores
            already using it keep it exactly as it is, pictures included. It
            can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <label
          className="grid gap-2 text-sm"
          htmlFor="delete-theme-confirmation"
        >
          <span>
            Type <strong>{themeId}</strong> to confirm
          </span>
          {/* Compared exactly (here and in the database): a phone's
              keyboard must not capitalise or correct "aurora" into
              "Aurora". */}
          <input
            id="delete-theme-confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={pending}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={
              confirmation && confirmation !== themeId
                ? "delete-theme-mismatch"
                : undefined
            }
            className="dash-input w-full"
          />
        </label>
        {confirmation && confirmation !== themeId ? (
          <p id="delete-theme-mismatch" className="studio-reason">
            That doesn&apos;t match yet: type {themeId} exactly.
          </p>
        ) : null}
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
            disabled={pending || confirmation !== themeId}
            onClick={remove}
            className="dash-btn dash-btn-primary"
          >
            {pending ? "Deleting…" : "Delete theme permanently"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A Delete button with its dialog. */
export function DeleteThemeButton({
  disabled,
  ...props
}: DeleteThemeProps & { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="dash-btn dash-btn-ghost"
      >
        <Trash2 aria-hidden="true" className="h-4 w-4" /> Delete permanently
      </button>
      <DeleteThemeDialog {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}
