"use client";

import { useState, useTransition } from "react";
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

export function DeleteThemeButton({
  projectId,
  themeId,
  name,
  revision,
  disabled,
}: {
  projectId: string;
  themeId: string;
  name: string;
  revision: number;
  disabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
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
        toast.success("Theme permanently deleted.");
        setOpen(false);
        router.push("/dashboard/themes/studio");
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
          setConfirmation("");
          setError(null);
          setOpen(true);
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" /> Delete permanently
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {name} permanently?</DialogTitle>
            <DialogDescription>
              This removes this project, its conversation, screenshots,
              generated versions, previews and published theme releases. It
              cannot be undone. Themes in use by a store cannot be deleted.
              Published images are retained because stores may reuse them.
            </DialogDescription>
          </DialogHeader>
          <label
            className="space-y-2 text-sm"
            htmlFor="delete-theme-confirmation"
          >
            <span>
              Type <strong>{themeId}</strong> to confirm
            </span>
            <input
              id="delete-theme-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={pending}
              autoComplete="off"
              className="w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <button
              type="button"
              disabled={pending}
              onClick={() => setOpen(false)}
              className="rounded-md border px-3 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending || confirmation !== themeId}
              onClick={remove}
              className="rounded-md bg-red-700 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {pending ? "Deleting…" : "Delete theme permanently"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
