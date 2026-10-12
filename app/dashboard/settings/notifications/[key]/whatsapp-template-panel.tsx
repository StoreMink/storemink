"use client";

// ---------------------------------------------------------------------------
// The WhatsApp tab. Like the SMS tab it is NOT the generic template editor,
// and for a stronger reason: the merchant does not author this copy at all.
// StoreMink registers one template per notification on the merchant's number
// (lib/whatsapp/template-catalog.ts) and Meta approves the wording; what this
// tab shows is that wording, and where Meta's review stands. A merchant who
// wants different copy writes it in WhatsApp Manager — the template manager
// that points an event at it is a later slice.
//
// ★ THE STATUS IS THE SWITCH. The channel checkbox above can be on while the
// template is still in review; nothing sends until Meta approves, and this is
// where the merchant can see which it is.
// ---------------------------------------------------------------------------

import Link from "next/link";
import { MessageCircle } from "lucide-react";
import type { WhatsAppEventTemplate } from "@/app/actions/whatsapp-provider-actions";
import { renderWhatsAppBody } from "@/lib/whatsapp/template-catalog";

const STATUS_COPY: Record<
  string,
  { label: string; tone: string; note: string }
> = {
  APPROVED: {
    label: "Approved",
    tone: "text-emerald-700 bg-emerald-50 dark:bg-emerald-950/30",
    note: "Meta approved this wording. Messages send as soon as the WhatsApp box above is ticked.",
  },
  PENDING: {
    label: "In review",
    tone: "text-amber-700 bg-amber-50 dark:bg-amber-950/30",
    note: "Meta is reviewing the wording - usually within a day. Nothing sends until it is approved.",
  },
  IN_APPEAL: {
    label: "In appeal",
    tone: "text-amber-700 bg-amber-50 dark:bg-amber-950/30",
    note: "The template is under appeal at Meta. Nothing sends until it is approved.",
  },
  REJECTED: {
    label: "Rejected",
    tone: "text-red-700 bg-red-50 dark:bg-red-950/30",
    note: "Meta turned this wording down, so this message cannot send on WhatsApp.",
  },
  PAUSED: {
    label: "Paused by Meta",
    tone: "text-red-700 bg-red-50 dark:bg-red-950/30",
    note: "Meta paused this template because customers reported or blocked it. It resumes on Meta's schedule.",
  },
  DISABLED: {
    label: "Disabled by Meta",
    tone: "text-red-700 bg-red-50 dark:bg-red-950/30",
    note: "Meta disabled this template. This message cannot send on WhatsApp.",
  },
  missing: {
    label: "Not set up",
    tone: "text-[var(--dash-text-3)] bg-[rgba(17,24,39,0.06)]",
    note: "This template has not been sent to Meta yet. Open Channels → WhatsApp and choose Set up templates.",
  },
};

export function WhatsAppTemplatePanel({
  audience,
  templates,
  connected,
  variables,
}: {
  audience: "team" | "customer";
  templates: WhatsAppEventTemplate[];
  connected: boolean;
  /** The event's variables, for a sample rendering of the wording. */
  variables: { name: string; sample: string }[];
}) {
  // The plain wording first; a variant (the COD confirmation) after it, with
  // what decides when it is used, since it replaces the plain one then.
  const shown = templates
    .filter((t) => t.audience === audience)
    .sort((a, b) => Number(Boolean(a.variant)) - Number(Boolean(b.variant)));

  return (
    <div className="space-y-4 px-5 py-4">
      {!connected && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] text-[#5b6472] dark:border-amber-900/40 dark:bg-amber-950/30">
          <p className="text-[13px] font-semibold text-[var(--dash-text)]">
            WhatsApp isn&apos;t connected for this store
          </p>
          <p className="mt-1">
            Connect your own number under{" "}
            <Link href="/dashboard/channels" className="underline">
              Channels
            </Link>{" "}
            first. It needs the Basic plan or above.
          </p>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="text-[13px] text-[var(--dash-text-3)]">
          <MessageCircle className="mr-1.5 inline h-4 w-4 opacity-50" />
          This notification has no WhatsApp message for{" "}
          {audience === "team" ? "your team" : "customers"} yet.
        </p>
      ) : (
        shown.map((template) => (
          <div key={template.name} className="space-y-2">
            {template.variant === "cod_confirm" && (
              <div className="text-[12px] text-[var(--dash-text-3)]">
                <p className="text-[13px] font-semibold text-[var(--dash-text)]">
                  Cash-on-delivery orders
                </p>
                <p className="mt-0.5">
                  Sent instead of the message above for website cash-on-delivery
                  orders when{" "}
                  <Link href="/dashboard/channels" className="underline">
                    Ask cash-on-delivery customers to confirm on WhatsApp
                  </Link>{" "}
                  is on. Confirm order marks the order confirmed; Cancel order
                  cancels it if it hasn&apos;t shipped.
                </p>
              </div>
            )}
            <WhatsAppTemplateCard template={template} variables={variables} />
          </div>
        ))
      )}

      <p className="text-[12px] text-[var(--dash-text-3)]">
        Customers receive WhatsApp updates only if they ticked the box at
        checkout. Team members receive them on the mobile number on their
        account.
      </p>
    </div>
  );
}

function WhatsAppTemplateCard({
  template,
  variables,
}: {
  template: WhatsAppEventTemplate;
  variables: { name: string; sample: string }[];
}) {
  const status = STATUS_COPY[template.status] ?? {
    label: template.status.toLowerCase().replace(/_/g, " "),
    tone: "text-[var(--dash-text-3)] bg-[rgba(17,24,39,0.06)]",
    note: "Meta reported a state this page does not describe yet. Refresh from Channels → WhatsApp.",
  };
  // The sample uses the console's own example values, so the preview reads as
  // a message rather than as a template with numbered holes.
  const samples = new Map(variables.map((v) => [v.name, v.sample]));
  // Placeholders are positional: `variables[i]` names the value in `{{i+1}}`.
  const preview = renderWhatsAppBody(
    template.body,
    template.variables.map((name) => samples.get(name) ?? "…"),
  );

  return (
    <div className="rounded-lg border border-[var(--dash-border)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--dash-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-[#25D366]" />
          <span className="font-mono text-[12px] text-[var(--dash-text-2)]">
            {template.name}
          </span>
        </div>
        <span
          className={`rounded px-2 py-0.5 text-[11px] font-semibold ${status.tone}`}
        >
          {status.label}
        </span>
      </div>
      <div className="px-4 py-3">
        <p className="whitespace-pre-wrap text-[13px] text-[var(--dash-text)]">
          {preview}
        </p>
        {template.buttons.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2" aria-label="Buttons">
            {template.buttons.map((label) => (
              <span
                key={label}
                className="rounded-md border border-[var(--dash-border)] px-2.5 py-1 text-[12px] font-medium text-[#128C7E]"
              >
                {label}
              </span>
            ))}
          </div>
        )}
        <p className="mt-3 text-[12px] text-[var(--dash-text-3)]">
          {status.note}
        </p>
        {template.rejectionReason && (
          <p className="mt-2 text-[12px] text-red-700 dark:text-red-400">
            Meta&apos;s reason: {template.rejectionReason}
          </p>
        )}
        {template.syncError && (
          <p className="mt-2 text-[12px] text-amber-700 dark:text-amber-400">
            {template.syncError}
          </p>
        )}
      </div>
    </div>
  );
}
