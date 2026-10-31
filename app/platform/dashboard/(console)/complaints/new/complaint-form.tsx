"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Search, X } from "lucide-react";
import { logComplaintAction } from "@/app/actions/takedown-actions";
import { listAllStores, type PlatformStoreRow } from "@/app/actions/platform";
import { COMPLAINT_KINDS, type ComplaintKind } from "@/lib/moderation/kinds";
import {
  computeDeadlines,
  deadlineLabel,
  deadlineStages,
  type DeadlineStage,
} from "@/lib/moderation/deadlines";
import { parseHost, ROOT_DOMAIN } from "@/lib/store/host";
import {
  CHANNEL_LABEL,
  FORM_CHANNELS,
  complaintHref,
  istDateTime,
  kindHelpParts,
} from "../complaints-console";

// ---------------------------------------------------------------------------
// Log a complaint (takedown design 6.3).
//
// ★ THE SERVER IS THE ONLY CHECK. Every error comes back from
// `logComplaintAction` with the sentence of design 6.3 and the field it
// belongs to, and is shown under that field; the form has no second copy of
// the limits that could disagree with it.
//
// ★ THE TIME IT REACHED US IS NEVER PREFILLED. Every deadline counts from it,
// so a default of "now" would quietly move a 3-hour order's deadline later by
// however long the operator took to log it. The field starts empty and its
// value is India time (the action reads a zoneless value as +05:30).
//
// ★ THE STORE SEARCH USES THE CONSOLE'S EXISTING STORE LIST
// (`listAllStores`, operator-gated): a name or an address on
// {slug}.storemink.com searches by name and slug; a custom domain is matched
// against the stores' connected domains.
// ---------------------------------------------------------------------------

const LABEL = "mb-1 block text-sm font-medium text-[var(--dash-text)]";
const HINT = "mt-1 block text-xs text-[var(--dash-text-2)]";
const ERROR = "mt-1 block text-sm text-[var(--dash-red)]";
const INPUT = "dash-input w-full pointer-coarse:min-h-11";

type Field =
  | "receivedAt"
  | "channel"
  | "kind"
  | "complainantName"
  | "complainantContact"
  | "actingFor"
  | "authorityRef"
  | "storeId"
  | "urls"
  | "summary";

const LOG_FAILED = "Could not log the complaint. Please try again.";
const SEARCH_DELAY_MS = 300;

/** "Crumb & Co (crumb.storemink.com)", as the complaints record it. */
function storeLabel(store: { name: string; slug: string }): string {
  return `${store.name || store.slug} (${store.slug}.${ROOT_DOMAIN})`;
}

/**
 * The host an address names, when the text is an address at all
 * ("https://crumb.storemink.com/shop/mug", "crumb.storemink.com", "acme.in").
 */
function hostOf(text: string): string | null {
  if (/\s/.test(text) || !text.includes(".")) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The stores a search names: by name or slug, or by an address. */
export async function findStores(query: string): Promise<PlatformStoreRow[]> {
  const text = query.trim();
  if (text.length < 2) return [];
  const host = hostOf(text);
  if (host) {
    const where = parseHost(host);
    if (where.type === "store-subdomain") {
      const rows = await listAllStores(where.slug);
      const exact = rows.filter((row) => row.slug === where.slug);
      return exact.length > 0 ? exact : rows;
    }
    if (where.type === "custom-domain") {
      const bare = where.domain.replace(/^www\./, "");
      const rows = await listAllStores("");
      return rows.filter((row) => {
        const domain = (row.custom_domain ?? "").toLowerCase();
        return domain === bare || domain === `www.${bare}`;
      });
    }
  }
  return listAllStores(text);
}

/** The live deadline line under the form (design 6.3). */
export function deadlineLine(kind: ComplaintKind, receivedAt: string): string {
  if (!receivedAt) return "";
  const received = new Date(
    /[zZ]|[+-]\d{2}:?\d{2}$/.test(receivedAt)
      ? receivedAt
      : `${receivedAt}${receivedAt.length === 16 ? ":00" : ""}+05:30`,
  );
  if (!Number.isFinite(received.getTime())) return "";
  const due = computeDeadlines(kind, received);
  const at: Record<DeadlineStage, Date> = {
    acknowledge: due.acknowledgeDueAt,
    act: due.actionDueAt,
    resolve: due.resolveDueAt,
  };
  return deadlineStages(kind)
    .map((stage) => `${deadlineLabel(kind, stage)} ${istDateTime(at[stage])}.`)
    .join(" ");
}

export function ComplaintForm({ maxReceivedAt }: { maxReceivedAt: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [receivedAt, setReceivedAt] = useState("");
  const [channel, setChannel] = useState("");
  const [kind, setKind] = useState<ComplaintKind | "">("");
  const [complainantName, setName] = useState("");
  const [complainantContact, setContact] = useState("");
  const [actingFor, setActingFor] = useState("");
  const [authorityRef, setAuthorityRef] = useState("");
  const [urls, setUrls] = useState("");
  const [summary, setSummary] = useState("");
  const [store, setStore] = useState<{ id: string; label: string } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlatformStoreRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const searchRun = useRef(0);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A search started by typing: debounced, and only the newest one's answer
  // is kept. Leaving the page stops a pending search.
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );

  function search(value: string) {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const run = ++searchRun.current;
    const text = value.trim();
    if (text.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      findStores(text)
        .then((rows) => {
          if (searchRun.current === run) setResults(rows);
        })
        .catch(() => {
          if (searchRun.current === run) setResults([]);
        })
        .finally(() => {
          if (searchRun.current === run) setSearching(false);
        });
    }, SEARCH_DELAY_MS);
  }

  function chooseStore(next: { id: string; label: string } | null) {
    ++searchRun.current;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setStore(next);
    setQuery("");
    setResults(null);
    setSearching(false);
  }

  const live = useMemo(
    () => (kind ? deadlineLine(kind, receivedAt) : ""),
    [kind, receivedAt],
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    setFormError(null);
    start(async () => {
      try {
        const res = await logComplaintAction({
          receivedAt,
          channel,
          kind,
          complainantName,
          complainantContact,
          actingFor,
          authorityRef,
          storeId: store?.id ?? null,
          urls,
          summary,
        });
        if (!res.ok) {
          const field = res.field as Field | undefined;
          if (field) setErrors({ [field]: res.error });
          else setFormError(res.error);
          return;
        }
        toast.success(res.message);
        router.push(complaintHref(res.ref));
      } catch {
        setFormError(LOG_FAILED);
      }
    });
  }

  const describe = (field: Field, hint: boolean) =>
    [hint ? `${field}-hint` : "", errors[field] ? `${field}-error` : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  const fieldError = (field: Field) =>
    errors[field] ? (
      <span id={`${field}-error`} role="alert" className={ERROR}>
        {errors[field]}
      </span>
    ) : null;

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <div className="dash-card space-y-5 p-5">
        <div>
          <label className="block">
            <span className={LABEL}>When did it reach us?</span>
            <input
              type="datetime-local"
              className={INPUT}
              value={receivedAt}
              max={maxReceivedAt}
              onChange={(e) => setReceivedAt(e.target.value)}
              disabled={pending}
              aria-describedby={describe("receivedAt", true)}
            />
          </label>
          <span id="receivedAt-hint" className={HINT}>
            The time on the email, letter or order, in India time. Every
            deadline counts from this time, not from when you log it.
          </span>
          {fieldError("receivedAt")}
        </div>

        <fieldset aria-describedby={describe("channel", false)}>
          <legend className={LABEL}>How did it reach us?</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {FORM_CHANNELS.map((value) => (
              <label
                key={value}
                className={`flex cursor-pointer items-center gap-2 rounded-[var(--dash-radius-sm)] border px-3 py-2 text-sm pointer-coarse:min-h-11 ${
                  channel === value
                    ? "border-[var(--dash-accent)] bg-[var(--dash-accent-soft)]"
                    : "border-[var(--dash-border-strong)]"
                }`}
              >
                <input
                  type="radio"
                  name="channel"
                  value={value}
                  checked={channel === value}
                  onChange={() => setChannel(value)}
                  disabled={pending}
                />
                <span className="text-[var(--dash-text)]">
                  {CHANNEL_LABEL[value]}
                </span>
              </label>
            ))}
          </div>
          {fieldError("channel")}
        </fieldset>

        <fieldset aria-describedby={describe("kind", false)}>
          <legend className={LABEL}>What is it?</legend>
          <div className="grid gap-2">
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
                    name="kind"
                    value={value}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                    disabled={pending}
                    className="mt-1"
                  />
                  <span className="text-[var(--dash-text)]">
                    <span className="font-medium">{head}:</span> {rest}
                  </span>
                </label>
              );
            })}
          </div>
          {fieldError("kind")}
        </fieldset>
      </div>

      <div className="dash-card space-y-5 p-5">
        <div>
          <label className="block">
            <span className={LABEL}>Their name</span>
            <input
              className={INPUT}
              value={complainantName}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
              autoComplete="off"
              aria-describedby={describe("complainantName", false)}
            />
          </label>
          {fieldError("complainantName")}
        </div>

        <div>
          <label className="block">
            <span className={LABEL}>How to reach them</span>
            <input
              className={INPUT}
              value={complainantContact}
              onChange={(e) => setContact(e.target.value)}
              disabled={pending}
              autoComplete="off"
              aria-describedby={describe("complainantContact", true)}
            />
          </label>
          <span id="complainantContact-hint" className={HINT}>
            An email address or a phone number.
          </span>
          {fieldError("complainantContact")}
        </div>

        <div>
          <label className="block">
            <span className={LABEL}>Acting for someone else?</span>
            <input
              className={INPUT}
              value={actingFor}
              onChange={(e) => setActingFor(e.target.value)}
              disabled={pending}
              autoComplete="off"
              aria-describedby={describe("actingFor", true)}
            />
          </label>
          <span id="actingFor-hint" className={HINT}>
            Who, and how they are related. Leave empty if they complain for
            themselves.
          </span>
          {fieldError("actingFor")}
        </div>

        <div>
          <label className="block">
            <span className={LABEL}>Order or reference number</span>
            <input
              className={INPUT}
              value={authorityRef}
              onChange={(e) => setAuthorityRef(e.target.value)}
              disabled={pending}
              autoComplete="off"
              aria-describedby={describe("authorityRef", true)}
            />
          </label>
          <span id="authorityRef-hint" className={HINT}>
            For an order: who issued it, its number and date, and the law it
            names.
          </span>
          {fieldError("authorityRef")}
        </div>
      </div>

      <div className="dash-card space-y-5 p-5">
        <div>
          <label htmlFor="complaint-store" className={LABEL}>
            Store
          </label>
          {store ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="dash-badge dash-badge-blue max-w-full break-all">
                {store.label}
              </span>
              <button
                type="button"
                onClick={() => chooseStore(null)}
                disabled={pending}
                className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
              >
                <X aria-hidden className="h-4 w-4" />
                Clear
              </button>
            </div>
          ) : (
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--dash-text-3)]"
              />
              <input
                id="complaint-store"
                className={`${INPUT} pl-9`}
                value={query}
                onChange={(e) => search(e.target.value)}
                disabled={pending}
                autoComplete="off"
                aria-describedby={describe("storeId", true)}
              />
            </div>
          )}
          <span id="storeId-hint" className={HINT}>
            Search by name or address. Leave empty if it is about StoreMink
            itself.
          </span>
          {!store && searching ? (
            <span className="mt-2 inline-flex items-center gap-2 text-xs text-[var(--dash-text-2)]">
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
              Searching
            </span>
          ) : null}
          {!store && !searching && results !== null ? (
            results.length === 0 ? (
              <span className={HINT} role="status">
                No store matches.
              </span>
            ) : (
              <ul className="mt-2 divide-y divide-[var(--dash-border)] rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)]">
                {results.slice(0, 8).map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() =>
                        chooseStore({ id: row.id, label: storeLabel(row) })
                      }
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--dash-surface-2)] pointer-coarse:min-h-11"
                    >
                      <span className="block font-medium text-[var(--dash-text)]">
                        {row.name || row.slug}
                      </span>
                      <span className="block text-xs text-[var(--dash-text-2)]">
                        {row.slug}.{ROOT_DOMAIN}
                        {row.custom_domain ? ` · ${row.custom_domain}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          {fieldError("storeId")}
        </div>

        <div>
          <label className="block">
            <span className={LABEL}>Web addresses</span>
            <textarea
              className="dash-input w-full"
              rows={3}
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              disabled={pending}
              aria-describedby={describe("urls", true)}
            />
          </label>
          <span id="urls-hint" className={HINT}>
            One per line.
          </span>
          {fieldError("urls")}
        </div>

        <div>
          <label className="block">
            <span className={LABEL}>What do they ask for?</span>
            <textarea
              className="dash-input w-full"
              rows={5}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              disabled={pending}
              aria-describedby={describe("summary", true)}
            />
          </label>
          <span id="summary-hint" className={HINT}>
            In your own words. Never paste an intimate image, a password or a
            card number.
          </span>
          {fieldError("summary")}
        </div>
      </div>

      {live ? (
        <p
          aria-live="polite"
          className="rounded-[var(--dash-radius-sm)] bg-[var(--dash-surface-2)] px-3 py-2 text-sm font-medium text-[var(--dash-text)]"
        >
          {live}
        </p>
      ) : null}

      {formError ? (
        <p role="alert" className="text-sm text-[var(--dash-red)]">
          {formError}
        </p>
      ) : null}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="dash-btn dash-btn-primary pointer-coarse:min-h-11"
        >
          {pending ? (
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          ) : null}
          Log complaint
        </button>
      </div>
    </form>
  );
}
