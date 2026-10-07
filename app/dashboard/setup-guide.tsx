"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  Lock,
  RefreshCw,
  Rocket,
} from "lucide-react";
import {
  launchStore,
  regenerateStorefrontPassword,
} from "@/app/actions/launch-actions";
import type { LaunchChecklistItem } from "@/lib/store/launch-checklist-rules";

/**
 * The Shopify-shaped setup guide: ONE card. Its head carries what the owner
 * is waiting on (the password that keeps the shop private, and Go live); its
 * body is the required tasks as an accordion in which exactly one task — the
 * first unfinished one — is open, showing what to do and a button that goes
 * there. Recommended tasks exist only once the required ones are all done,
 * and fold away so the card never reads as a wall.
 *
 * Every tick is computed server-side from the store's own rows and handed in;
 * the client decides nothing about completion. Everything it DOES goes through
 * a server action that re-checks who is pressing and whether the checklist is
 * really complete.
 */
export function SetupGuide({
  items,
  requiredDone,
  requiredTotal,
  ready,
  missing,
  canLaunch,
  password,
  previewUrl,
}: {
  items: LaunchChecklistItem[];
  requiredDone: number;
  requiredTotal: number;
  ready: boolean;
  missing: string[];
  canLaunch: boolean;
  password: string | null;
  previewUrl: string;
}) {
  const required = items.filter((i) => i.required);
  const recommended = items.filter((i) => !i.required);
  const recommendedDone = recommended.filter((i) => i.done).length;
  const firstOpen = required.find((i) => !i.done)?.key ?? null;
  const [open, setOpen] = useState<string | null>(firstOpen);
  const [showRecommended, setShowRecommended] = useState(false);
  const pct = Math.round((requiredDone / Math.max(requiredTotal, 1)) * 100);

  return (
    <section className="dash-card overflow-hidden p-0">
      <GoLiveHead
        ready={ready}
        missing={missing}
        canLaunch={canLaunch}
        password={password}
        previewUrl={previewUrl}
      />

      <div className="flex flex-col gap-3 px-5 pt-4 pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-[15px] font-bold tracking-tight text-[var(--dash-text)]">
            Before you go live
          </h2>
          <span className="text-[12.5px] font-medium text-[var(--dash-text-3)]">
            {requiredDone} of {requiredTotal} done
          </span>
        </div>
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-[var(--dash-surface-2)]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Required setup progress"
        >
          <div
            className="h-full rounded-full bg-[var(--dash-accent)] transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <ul className="flex flex-col">
        {required.map((item) => (
          <TaskRow
            key={item.key}
            item={item}
            open={open === item.key}
            onToggle={() => setOpen(open === item.key ? null : item.key)}
          />
        ))}
      </ul>

      {ready && recommended.length > 0 && (
        <div className="border-t border-[var(--dash-border)]">
          <button
            type="button"
            onClick={() => setShowRecommended((v) => !v)}
            aria-expanded={showRecommended}
            className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors hover:bg-[var(--dash-surface-2)]"
          >
            <span className="flex flex-col">
              <span className="text-[13.5px] font-semibold text-[var(--dash-text)]">
                Recommended
              </span>
              <span className="text-[12px] text-[var(--dash-text-3)]">
                {recommendedDone} of {recommended.length} done · optional,
                nothing here holds the store back
              </span>
            </span>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-[var(--dash-text-3)] transition-transform ${
                showRecommended ? "rotate-180" : ""
              }`}
            />
          </button>
          {showRecommended && (
            <ul className="flex flex-col border-t border-[var(--dash-border)]">
              {recommended.map((item) => (
                <TaskRow
                  key={item.key}
                  item={item}
                  open={open === item.key}
                  onToggle={() => setOpen(open === item.key ? null : item.key)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function TaskRow({
  item,
  open,
  onToggle,
}: {
  item: LaunchChecklistItem;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="border-t border-[var(--dash-border)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full items-start gap-3 px-5 py-3 text-left transition-colors ${
          open
            ? "bg-[var(--dash-surface-2)]"
            : "hover:bg-[var(--dash-surface-2)]"
        }`}
      >
        <span
          aria-hidden
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
            item.done
              ? "border-[var(--dash-green)] bg-[var(--dash-green)] text-white"
              : "border-dashed border-[var(--dash-text-3)]"
          }`}
        >
          {item.done && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
        <span
          className={`flex-1 text-[13.5px] ${
            item.done
              ? "text-[var(--dash-text-3)] line-through decoration-[var(--dash-border)]"
              : "font-semibold text-[var(--dash-text)]"
          }`}
        >
          {item.title}
        </span>
        <ChevronRight
          className={`mt-0.5 h-4 w-4 shrink-0 text-[var(--dash-text-3)] transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-3 bg-[var(--dash-surface-2)] px-5 pb-4 pl-[52px]">
          <p className="text-[13px] leading-snug text-[var(--dash-text-2)]">
            {item.description}
          </p>
          <div>
            <Link
              href={item.href}
              className={`dash-btn dash-btn-sm ${item.done ? "dash-btn-ghost" : "dash-btn-primary"}`}
            >
              {item.done ? "Review" : item.action}
            </Link>
          </div>
        </div>
      )}
    </li>
  );
}

function GoLiveHead({
  ready,
  missing,
  canLaunch,
  password,
  previewUrl,
}: {
  ready: boolean;
  missing: string[];
  canLaunch: boolean;
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
    <div className="flex flex-col gap-3 border-b border-[var(--dash-border)] bg-[var(--dash-surface)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--dash-surface-2)] text-[var(--dash-text-2)]">
          <Lock className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-[var(--dash-text)]">
            Your store is password protected
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[var(--dash-text-3)]">
            <span>Password</span>
            <code className="rounded-md bg-[var(--dash-surface-2)] px-2 py-0.5 font-mono text-[12.5px] tracking-wide text-[var(--dash-text)]">
              {shown ?? "unavailable"}
            </code>
            <button
              type="button"
              onClick={copy}
              disabled={!shown}
              className="inline-flex items-center gap-1 font-medium text-[var(--dash-text-2)] hover:text-[var(--dash-text)] disabled:opacity-50"
              aria-label="Copy store password"
            >
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
            {canLaunch && (
              <button
                type="button"
                onClick={rotate}
                disabled={rotating}
                className="inline-flex items-center gap-1 font-medium text-[var(--dash-text-2)] hover:text-[var(--dash-text)] disabled:opacity-50"
              >
                {rotating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                New
              </button>
            )}
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-[var(--dash-text-2)] hover:text-[var(--dash-text)]"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Preview
            </a>
          </div>
        </div>
      </div>
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
        className="dash-btn dash-btn-primary shrink-0 self-start sm:self-center"
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Rocket className="h-4 w-4" />
        )}
        Go live
      </button>
    </div>
  );
}
