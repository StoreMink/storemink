"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  deleteWhatsAppTemplate,
  refreshWhatsAppTemplates,
  submitWhatsAppTemplate,
  type WhatsAppTemplateManagerView,
} from "@/app/actions/whatsapp-provider-actions";
import type { ManagedTemplate } from "@/lib/whatsapp/templates";
import {
  CUSTOM_BUTTON_LABELS,
  CUSTOM_BUTTON_TYPES,
  CUSTOM_TEMPLATE_CATEGORIES,
  CUSTOM_TEMPLATE_LIMITS,
  TEMPLATE_LANGUAGES,
  templateNameFromTitle,
  validateCustomTemplate,
  type CustomButtonType,
  type CustomTemplateCategory,
} from "@/lib/whatsapp/custom-template";
import {
  bodyPlaceholders,
  renderWhatsAppBody,
} from "@/lib/whatsapp/template-catalog";

// ---------------------------------------------------------------------------
// The template manager. One list of every template the number holds, with
// Meta's status and reason; one editor for the merchant's own. The editor
// runs validateCustomTemplate before sending exactly as the save action does,
// so the refusal a merchant sees is the one the server would give.
//
// ★ THE PLACEHOLDER FIELDS FOLLOW THE BODY. Typing {{2}} into the message
// adds a second label-and-sample row; deleting it removes the row. A merchant
// never has to count placeholders in two places.
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  APPROVED: { label: "Approved", tone: "text-emerald-700 bg-emerald-50" },
  PENDING: { label: "In review", tone: "text-amber-700 bg-amber-50" },
  IN_APPEAL: { label: "In appeal", tone: "text-amber-700 bg-amber-50" },
  REJECTED: { label: "Rejected", tone: "text-red-700 bg-red-50" },
  PAUSED: { label: "Paused by Meta", tone: "text-red-700 bg-red-50" },
  DISABLED: { label: "Disabled by Meta", tone: "text-red-700 bg-red-50" },
  PENDING_DELETION: {
    label: "Being deleted",
    tone: "text-[var(--dash-text-3)] bg-[rgba(17,24,39,0.06)]",
  },
  DELETED: {
    label: "Deleted",
    tone: "text-[var(--dash-text-3)] bg-[rgba(17,24,39,0.06)]",
  },
  LIMIT_EXCEEDED: { label: "Limit reached", tone: "text-red-700 bg-red-50" },
};

function statusOf(status: string) {
  return (
    STATUS_LABEL[status] ?? {
      label: status.toLowerCase().replace(/_/g, " "),
      tone: "text-[var(--dash-text-3)] bg-[rgba(17,24,39,0.06)]",
    }
  );
}

function languageLabel(code: string): string {
  return TEMPLATE_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

/** A catalogue template's event, as a merchant reads it. */
function eventLabel(t: ManagedTemplate): string {
  if (!t.eventKey) return "Yours";
  const who = t.audience === "team" ? "to your team" : "to the customer";
  return `${t.eventKey.replace(/[._]/g, " ")}, ${who}`;
}

interface ButtonDraft {
  key: string;
  type: CustomButtonType;
  text: string;
  url: string;
  phone: string;
}

interface Draft {
  title: string;
  name: string;
  nameTouched: boolean;
  language: string;
  category: CustomTemplateCategory;
  headerText: string;
  body: string;
  variables: { name: string; sample: string }[];
  footerText: string;
  buttons: ButtonDraft[];
}

const EMPTY_DRAFT: Draft = {
  title: "",
  name: "",
  nameTouched: false,
  language: "en",
  category: "UTILITY",
  headerText: "",
  body: "",
  variables: [],
  footerText: "",
  buttons: [],
};

let buttonKey = 0;

function toInput(d: Draft) {
  return {
    name: d.name,
    language: d.language,
    category: d.category,
    headerText: d.headerText,
    body: d.body,
    variables: d.variables,
    footerText: d.footerText,
    buttons: d.buttons.map((b) =>
      b.type === "quick_reply"
        ? { type: b.type, text: b.text }
        : b.type === "url"
          ? { type: b.type, text: b.text, url: b.url }
          : { type: b.type, text: b.text, phone: b.phone },
    ),
  };
}

function TemplateEditor({
  onSubmitted,
  onCancel,
}: {
  onSubmitted: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [isPending, startTransition] = useTransition();
  const L = CUSTOM_TEMPLATE_LIMITS;
  const patch = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));

  const slots = useMemo(() => bodyPlaceholders(draft.body), [draft.body]);
  // The placeholder rows track the body: as many rows as {{n}} slots.
  const variables = useMemo(() => {
    const out = [...draft.variables];
    while (out.length < slots.length) out.push({ name: "", sample: "" });
    return out.slice(0, slots.length);
  }, [draft.variables, slots.length]);

  const preview = renderWhatsAppBody(
    draft.body,
    variables.map((v) => v.sample || "…"),
  );

  const submit = () => {
    const checked = validateCustomTemplate(toInput({ ...draft, variables }));
    if (!checked.ok) {
      toast.error(checked.error);
      return;
    }
    startTransition(async () => {
      const r = await submitWhatsAppTemplate(checked.template);
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success(
        r.status === "APPROVED"
          ? "Meta approved the template."
          : "Sent to Meta for review. It usually answers within a day.",
      );
      onSubmitted();
    });
  };

  const setButton = (key: string, next: Partial<ButtonDraft>) =>
    patch({
      buttons: draft.buttons.map((b) =>
        b.key === key ? { ...b, ...next } : b,
      ),
    });

  return (
    <section className="dash-card">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title">New template</div>
          <div className="dash-card-sub max-w-xl">
            Meta reviews the exact words, usually within a day. Write
            placeholders as {"{{1}}"}, {"{{2}}"} for the parts you will fill in
            when you send it.
          </div>
        </div>
      </div>
      <div className="dash-card-body flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-[var(--dash-text-3)]">Title</span>
            <input
              type="text"
              className="dash-input w-full"
              aria-label="Template title"
              value={draft.title}
              maxLength={64}
              disabled={isPending}
              onChange={(e) =>
                patch({
                  title: e.target.value,
                  name: draft.nameTouched
                    ? draft.name
                    : templateNameFromTitle(e.target.value),
                })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-[var(--dash-text-3)]">
              Name at Meta (lower-case, underscores)
            </span>
            <input
              type="text"
              className="dash-input w-full font-mono"
              aria-label="Template name"
              value={draft.name}
              maxLength={L.nameMaxChars}
              disabled={isPending}
              onChange={(e) =>
                patch({ name: e.target.value, nameTouched: true })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-[var(--dash-text-3)]">Language</span>
            <select
              className="dash-input w-full"
              aria-label="Template language"
              value={draft.language}
              disabled={isPending}
              onChange={(e) => patch({ language: e.target.value })}
            >
              {TEMPLATE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-[var(--dash-text-3)]">Kind</span>
            <select
              className="dash-input w-full"
              aria-label="Template category"
              value={draft.category}
              disabled={isPending}
              onChange={(e) =>
                patch({ category: e.target.value as CustomTemplateCategory })
              }
            >
              {CUSTOM_TEMPLATE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c === "UTILITY"
                    ? "Utility (about an order or account)"
                    : "Marketing (an offer or news)"}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-[13px]">
          <span className="text-[var(--dash-text-3)]">Header (optional)</span>
          <input
            type="text"
            className="dash-input w-full"
            aria-label="Template header"
            value={draft.headerText}
            maxLength={L.headerMaxChars}
            disabled={isPending}
            onChange={(e) => patch({ headerText: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1 text-[13px]">
          <span className="text-[var(--dash-text-3)]">Message</span>
          <textarea
            className="dash-input w-full"
            rows={4}
            aria-label="Template message"
            value={draft.body}
            maxLength={L.bodyMaxChars}
            disabled={isPending}
            onChange={(e) => patch({ body: e.target.value })}
          />
          <span className="text-right text-[12px] text-[var(--dash-text-3)]">
            {draft.body.length} / {L.bodyMaxChars}
          </span>
        </label>

        {slots.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="text-[13px] font-semibold">Placeholders</div>
            {slots.map((n, i) => (
              <div key={n} className="grid gap-2 sm:grid-cols-[6rem_1fr_1fr]">
                <span className="self-center font-mono text-[13px]">
                  {"{{"}
                  {n}
                  {"}}"}
                </span>
                <input
                  type="text"
                  className="dash-input w-full"
                  aria-label={`Placeholder ${n} label`}
                  placeholder="label, e.g. customer_name"
                  value={variables[i]?.name ?? ""}
                  maxLength={L.variableNameMaxChars}
                  disabled={isPending}
                  onChange={(e) =>
                    patch({
                      variables: variables.map((v, j) =>
                        j === i ? { ...v, name: e.target.value } : v,
                      ),
                    })
                  }
                />
                <input
                  type="text"
                  className="dash-input w-full"
                  aria-label={`Placeholder ${n} sample`}
                  placeholder="sample for Meta, e.g. Rohan"
                  value={variables[i]?.sample ?? ""}
                  maxLength={L.sampleMaxChars}
                  disabled={isPending}
                  onChange={(e) =>
                    patch({
                      variables: variables.map((v, j) =>
                        j === i ? { ...v, sample: e.target.value } : v,
                      ),
                    })
                  }
                />
              </div>
            ))}
          </div>
        ) : null}

        <label className="flex flex-col gap-1 text-[13px]">
          <span className="text-[var(--dash-text-3)]">Footer (optional)</span>
          <input
            type="text"
            className="dash-input w-full"
            aria-label="Template footer"
            value={draft.footerText}
            maxLength={L.footerMaxChars}
            disabled={isPending}
            onChange={(e) => patch({ footerText: e.target.value })}
          />
        </label>

        <div className="flex flex-col gap-2">
          <div className="text-[13px] font-semibold">
            Buttons (up to {L.maxButtons})
          </div>
          {draft.buttons.map((b, i) => (
            <div
              key={b.key}
              className="flex flex-wrap items-end gap-2 rounded-[10px] border border-[rgba(17,24,39,0.08)] p-3"
            >
              <select
                className="dash-input w-40"
                aria-label={`Button ${i + 1} type`}
                value={b.type}
                disabled={isPending}
                onChange={(e) =>
                  setButton(b.key, { type: e.target.value as CustomButtonType })
                }
              >
                {CUSTOM_BUTTON_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CUSTOM_BUTTON_LABELS[t]}
                  </option>
                ))}
              </select>
              <input
                type="text"
                className="dash-input w-44"
                aria-label={`Button ${i + 1} label`}
                placeholder="Label"
                value={b.text}
                maxLength={L.buttonTextMaxChars}
                disabled={isPending}
                onChange={(e) => setButton(b.key, { text: e.target.value })}
              />
              {b.type === "url" ? (
                <input
                  type="url"
                  className="dash-input min-w-0 flex-1"
                  aria-label={`Button ${i + 1} link`}
                  placeholder="https://…"
                  value={b.url}
                  disabled={isPending}
                  onChange={(e) => setButton(b.key, { url: e.target.value })}
                />
              ) : null}
              {b.type === "phone" ? (
                <input
                  type="tel"
                  className="dash-input w-48"
                  aria-label={`Button ${i + 1} phone`}
                  placeholder="+91 98765 43210"
                  value={b.phone}
                  disabled={isPending}
                  onChange={(e) => setButton(b.key, { phone: e.target.value })}
                />
              ) : null}
              <button
                type="button"
                className="dash-btn dash-btn-ghost dash-btn-sm"
                aria-label={`Remove button ${i + 1}`}
                disabled={isPending}
                onClick={() =>
                  patch({
                    buttons: draft.buttons.filter((x) => x.key !== b.key),
                  })
                }
              >
                Remove
              </button>
            </div>
          ))}
          {draft.buttons.length < L.maxButtons ? (
            <div>
              <button
                type="button"
                className="dash-btn dash-btn-ghost dash-btn-sm"
                disabled={isPending}
                onClick={() =>
                  patch({
                    buttons: [
                      ...draft.buttons,
                      {
                        key: `k${++buttonKey}`,
                        type: "quick_reply",
                        text: "",
                        url: "",
                        phone: "",
                      },
                    ],
                  })
                }
              >
                Add a button
              </button>
            </div>
          ) : null}
          <p className="text-[12px] text-[var(--dash-text-3)]">
            Quick replies come first. A picture header, a link with a
            placeholder or a copy-code button can&apos;t be sent from the inbox,
            so they aren&apos;t offered here.
          </p>
        </div>

        <div>
          <div className="mb-1 text-[13px] font-semibold">Preview</div>
          <div className="rounded-[10px] bg-[rgba(17,24,39,0.04)] px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-line">
            {draft.headerText ? (
              <div className="font-semibold">{draft.headerText}</div>
            ) : null}
            <div>{preview || "Your message appears here."}</div>
            {draft.footerText ? (
              <div className="text-[12px] text-[var(--dash-text-3)]">
                {draft.footerText}
              </div>
            ) : null}
            {draft.buttons.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {draft.buttons.map((b) => (
                  <span
                    key={b.key}
                    className="rounded-full border border-[rgba(17,24,39,0.16)] px-3 py-0.5 text-[12px] font-semibold"
                  >
                    {b.text || "Button"}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending}>
            {isPending ? "Sending…" : "Send to Meta for review"}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function TemplatesClient({
  view,
}: {
  view: WhatsAppTemplateManagerView;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const canSubmit =
    view.canManage && view.connected && view.status === "connected";

  const refresh = async () => {
    setBusy("refresh");
    const r = await refreshWhatsAppTemplates();
    setBusy(null);
    if (r.error) toast.error(r.error);
    else {
      toast.success("Statuses refreshed from Meta.");
      router.refresh();
    }
  };

  const remove = async (t: ManagedTemplate) => {
    if (
      !window.confirm(
        `Delete "${t.name}" (${languageLabel(t.language)})? Meta forgets it too, and the inbox can no longer send it.`,
      )
    ) {
      return;
    }
    setBusy(t.id);
    const r = await deleteWhatsAppTemplate(t.id);
    setBusy(null);
    if (r.error) toast.error(r.error);
    else {
      toast.success("Template deleted.");
      router.refresh();
    }
  };

  if (!view.connected) {
    return (
      <div className="dash-card max-w-3xl p-8 text-center text-sm text-[var(--dash-ink-2)]">
        Connect a WhatsApp number under Channels to see its templates.
      </div>
    );
  }

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-[var(--dash-text-3)]">
          {view.templates.length} template
          {view.templates.length === 1 ? "" : "s"}. Meta usually answers a
          review within a day; press Refresh to read its latest answer.
        </p>
        <div className="flex gap-2">
          {view.canManage ? (
            <button
              type="button"
              className="dash-btn dash-btn-ghost dash-btn-sm"
              onClick={refresh}
              disabled={busy !== null}
            >
              {busy === "refresh" ? "Refreshing…" : "Refresh from Meta"}
            </button>
          ) : null}
          {canSubmit && !editing ? (
            <Button size="sm" onClick={() => setEditing(true)}>
              New template
            </Button>
          ) : null}
        </div>
      </div>

      {view.status === "needs_reauth" ? (
        <p className="dash-card p-4 text-[13px] text-amber-700">
          Meta no longer accepts this connection. Reconnect WhatsApp under
          Channels before adding a template.
        </p>
      ) : null}

      {editing ? (
        <TemplateEditor
          onSubmitted={() => {
            setEditing(false);
            router.refresh();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : null}

      <ul className="flex flex-col gap-3" aria-label="Templates">
        {view.templates.map((t) => {
          const status = statusOf(t.status);
          return (
            <li key={t.id} className="dash-card">
              <div className="dash-card-body flex flex-col gap-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[13px] font-semibold">
                        {t.name}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${status.tone}`}
                      >
                        {status.label}
                      </span>
                      {t.sendableFromInbox ? (
                        <span className="rounded-full bg-[rgba(17,24,39,0.06)] px-2 py-0.5 text-[11.5px] text-[var(--dash-text-3)]">
                          Sendable from Inbox
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-[12px] text-[var(--dash-text-3)]">
                      {languageLabel(t.language)} · {t.category.toLowerCase()} ·{" "}
                      {eventLabel(t)}
                    </div>
                  </div>
                  {view.canManage && !t.catalogue ? (
                    <button
                      type="button"
                      className="dash-btn dash-btn-ghost dash-btn-sm shrink-0"
                      aria-label={`Delete ${t.name}`}
                      onClick={() => remove(t)}
                      disabled={busy !== null}
                    >
                      {busy === t.id ? "Deleting…" : "Delete"}
                    </button>
                  ) : null}
                </div>
                <div className="rounded-[10px] bg-[rgba(17,24,39,0.04)] px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-line">
                  {t.headerText ? (
                    <div className="font-semibold">{t.headerText}</div>
                  ) : null}
                  <div>{t.body}</div>
                  {t.footerText ? (
                    <div className="text-[12px] text-[var(--dash-text-3)]">
                      {t.footerText}
                    </div>
                  ) : null}
                  {t.buttons.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {t.buttons.map((b, i) => (
                        <span
                          key={`${b.text}-${i}`}
                          className="rounded-full border border-[rgba(17,24,39,0.16)] px-3 py-0.5 text-[12px] font-semibold"
                        >
                          {b.text}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                {t.rejectionReason ? (
                  <p className="text-[12px] text-red-700">
                    Meta&apos;s reason: {t.rejectionReason}
                  </p>
                ) : null}
                {t.syncError ? (
                  <p className="text-[12px] text-amber-700">{t.syncError}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
