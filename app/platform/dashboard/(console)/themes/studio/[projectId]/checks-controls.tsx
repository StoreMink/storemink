"use client";

import { useState } from "react";
import { Copy, MessageSquarePlus, Wrench } from "lucide-react";
import { copyDetailsText, type StudioCopyDetails } from "../studio-words";
import { useStudioIntent, useStudioPage } from "./studio-tabs";

// ---------------------------------------------------------------------------
// The Checks tab's buttons (wave TS-2, builder 2C; plan section 4, "Fix it"
// by kind). The tab itself renders on the server; these are its client
// parts, and they reach the page through useStudioPage().
//
// ★ "DESCRIBE A FIX" NEVER SENDS. It puts the server's draft (serious
// findings only, Design-N words, no run id: acceptance-repair.ts
// describeFixDraft) in the chat for the operator to read, change and send.
// ★ STOREMINK'S OWN FINDINGS get no fix button: "Copy details for an
// engineer" puts one fact per line on the clipboard (copyDetailsText), the
// only place besides Technical details and the Log tab where a code or a
// build appears.
// ★ AN INTENT NEVER ACTS BY ITSELF beyond the draft (contract 6.5):
// `do=describe_fix` puts the draft in the chat, `do=copy_details` opens
// Technical details and moves focus to the first Copy details button.
// ---------------------------------------------------------------------------

/** Copy one problem's details for an engineer, with what happened beside
 * the button (never a tooltip). */
export function CopyDetailsButton({
  details,
  label = "Copy details",
  id,
}: {
  details: StudioCopyDetails;
  label?: string;
  id?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(copyDetailsText(details));
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <span className="studio-action">
      <button
        id={id}
        type="button"
        className="dash-btn dash-btn-ghost dash-btn-sm"
        onClick={() => void copy()}
      >
        <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        {label}
      </button>
      <span role="status" className="studio-reason">
        {state === "copied"
          ? "Copied. Paste it into a message for an engineer."
          : state === "failed"
            ? "This browser didn't allow copying. The same details are under Technical details."
            : ""}
      </span>
    </span>
  );
}

/** "Describe a fix": the draft goes into the chat; the operator sends it. */
export function DescribeFixButton({
  draft,
  blockedReason,
  id,
}: {
  draft: string;
  /** Why a change can't be sent now; the button waits, with this under it. */
  blockedReason: string | null;
  id?: string;
}) {
  const api = useStudioPage();
  const [put, setPut] = useState(false);
  return (
    <span className="studio-action">
      <button
        id={id}
        type="button"
        className="dash-btn dash-btn-primary"
        disabled={blockedReason !== null}
        onClick={() => {
          api.putInChat(draft);
          setPut(true);
        }}
      >
        <Wrench aria-hidden="true" className="h-4 w-4" />
        Describe a fix
      </button>
      <span role="status" className="studio-reason">
        {blockedReason ??
          (put
            ? "The summary is in the chat. Read it, change anything you like, then send it."
            : "Puts a short summary in the chat for you to read and send.")}
      </span>
    </span>
  );
}

/** "Describe a change" for a matter of taste: it opens the chat, empty, for
 * the operator's own words (a warning never writes a draft). */
export function DescribeChangeButton({
  blockedReason,
}: {
  blockedReason: string | null;
}) {
  const api = useStudioPage();
  return (
    <span className="studio-action">
      <button
        type="button"
        className="dash-btn dash-btn-ghost dash-btn-sm"
        disabled={blockedReason !== null}
        onClick={() => api.putInChat("")}
      >
        <MessageSquarePlus aria-hidden="true" className="h-3.5 w-3.5" />
        Describe a change
      </button>
      {blockedReason ? (
        <span className="studio-reason">{blockedReason}</span>
      ) : null}
    </span>
  );
}

/**
 * The Checks tab's intents (contract 6.5). `describe_fix` puts the draft in
 * the chat when there is one and a change can be sent, and otherwise moves
 * focus to Must fix; `copy_details` opens Technical details and moves focus
 * to the first Copy details button.
 */
export function ChecksIntent({
  draft,
  blocked,
  mustFixId,
  technicalId,
  copyTargetId,
}: {
  draft: string | null;
  blocked: boolean;
  mustFixId: string;
  technicalId: string;
  copyTargetId: string | null;
}) {
  const api = useStudioPage();
  useStudioIntent(["describe_fix", "copy_details"], (kind) => {
    if (kind === "describe_fix") {
      if (draft && !blocked) api.putInChat(draft);
      else document.getElementById(mustFixId)?.focus();
      return;
    }
    const details = document.getElementById(technicalId);
    if (details instanceof HTMLDetailsElement) details.open = true;
    const target =
      (copyTargetId ? document.getElementById(copyTargetId) : null) ??
      details?.querySelector<HTMLElement>("summary") ??
      null;
    target?.focus();
  });
  return null;
}
