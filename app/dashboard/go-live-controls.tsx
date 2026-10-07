"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, ExternalLink, Loader2, RefreshCw, Rocket } from "lucide-react";
import {
  launchStore,
  regenerateStorefrontPassword,
} from "@/app/actions/launch-actions";

/**
 * The owner's half of the go-live card: the password that protects the shop
 * until it opens, and the Go live button. Everything it shows is passed in by
 * the server component; everything it DOES goes through a server action that
 * re-checks who is pressing and whether the checklist is really complete.
 */
export function GoLiveControls({
  canLaunch,
  ready,
  missing,
  password,
  previewUrl,
}: {
  canLaunch: boolean;
  ready: boolean;
  missing: string[];
  password: string | null;
  previewUrl: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rotating, startRotate] = useTransition();
  const [shown, setShown] = useState(password);

  function copy() {
    if (!shown) return;
    navigator.clipboard
      ?.writeText(shown)
      .then(() => toast.success("Password copied"))
      .catch(() => toast.error("Couldn't copy — select it and copy by hand."));
  }

  function goLive() {
    start(async () => {
      const res = await launchStore();
      if (res.error) {
        toast.error(
          res.missing?.length
            ? `${res.error} Still to do: ${res.missing.join(", ")}.`
            : res.error,
        );
        return;
      }
      toast.success("Your store is open to customers.");
      router.refresh();
    });
  }

  function rotate() {
    startRotate(async () => {
      const res = await regenerateStorefrontPassword();
      if (res.error || !res.password) {
        toast.error(res.error ?? "Couldn't change the password.");
        return;
      }
      setShown(res.password);
      toast.success(
        "New password set. Anyone using the old one is signed out.",
      );
    });
  }

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--dash-border)] pt-4">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--dash-text-2)]">
        <span>Store password</span>
        <code className="rounded-md bg-[var(--dash-surface-2)] px-2 py-1 font-mono text-[13px] tracking-wide text-[var(--dash-text)]">
          {shown ?? "unavailable"}
        </code>
        <button
          type="button"
          onClick={copy}
          disabled={!shown}
          className="dash-btn dash-btn-ghost dash-btn-sm"
          aria-label="Copy store password"
        >
          <Copy className="h-3.5 w-3.5" /> Copy
        </button>
        {canLaunch && (
          <button
            type="button"
            onClick={rotate}
            disabled={rotating}
            className="dash-btn dash-btn-ghost dash-btn-sm"
          >
            {rotating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            New password
          </button>
        )}
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="dash-btn dash-btn-ghost dash-btn-sm"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Preview store
        </a>
      </div>
      <p className="text-[12.5px] leading-snug text-[var(--dash-text-3)]">
        Visitors see a password page until you go live. You and your staff see
        the real shop when signed in; share the password with anyone else who
        should preview it.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={goLive}
          disabled={!canLaunch || !ready || pending}
          title={
            !canLaunch
              ? "Only the store owner can open the store."
              : ready
                ? "Open the store to customers"
                : `Still to do: ${missing.join(", ")}`
          }
          className="dash-btn dash-btn-primary"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Rocket className="h-4 w-4" />
          )}
          Go live
        </button>
        {!ready && (
          <span className="text-[12.5px] text-[var(--dash-text-3)]">
            Finish the required steps above to open the store.
          </span>
        )}
        {ready && !canLaunch && (
          <span className="text-[12.5px] text-[var(--dash-text-3)]">
            Everything is ready. The store owner can open the store.
          </span>
        )}
      </div>
    </div>
  );
}
