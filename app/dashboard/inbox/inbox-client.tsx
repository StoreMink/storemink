"use client";

// ---------------------------------------------------------------------------
// The WhatsApp inbox screen (docs/whatsapp-commerce-plan.md §11).
//
// Two panes on a desktop — the conversation list and the open thread — and
// one at a time on a phone, where the thread is a sheet over the list (the
// Orders page's `use-mobile` pattern). The customer's orders and consent sit
// in a collapsible strip at the top of the thread rather than a third column,
// so the same layout holds at every width.
//
// ★ THE LIST AND THE THREAD POLL THROUGH THE ROUTE, NOT ACTIONS. A reply is
// a Server Action; Next queues actions one at a time per client, so a poll
// made with an action would sit in front of Send. `usePoll` brings the POS
// gates with it: no ticks while the tab is hidden or offline, and a quiet
// inbox backs off to two minutes.
//
// ★ THE WINDOW SHOWN HERE IS A HINT. The composer switches to templates when
// 24 hours have passed; the server checks again on Send and answers
// `window_closed` if the clock ran out between the two.
// ---------------------------------------------------------------------------

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  FileText,
  Lock,
  MessageCircle,
  Search,
  Send,
  Smartphone,
  X,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePoll } from "@/lib/pos/use-poll";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { formatWhen } from "@/lib/dates";
import { formatPrice } from "@/lib/pricing";
import {
  getInboxThread,
  markInboxRead,
  sendInboxReply,
  sendInboxTemplate,
  setInboxConversationStatus,
} from "@/app/actions/inbox-actions";
import {
  INBOX_REPLY_MAX_CHARS,
  type InboxConversationRow,
  type InboxFilter,
  type InboxListResult,
  type InboxMessageRow,
  type InboxTemplateOption,
  type InboxThread,
} from "@/lib/whatsapp/inbox-types";
import { ListPagination } from "../components/list-pagination";
import "./inbox.css";

const LIST_POLL_MS = 15_000;
const THREAD_POLL_MS = 8_000;

const FILTERS: { key: InboxFilter; label: string }[] = [
  { key: "needs_reply", label: "Needs reply" },
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

export function InboxClient({
  initial,
  templates,
  canManage,
  channelLive,
  initialConversationId,
}: {
  initial: InboxListResult & { error?: string };
  templates: InboxTemplateOption[];
  canManage: boolean;
  /** False while the number is paused or needs reconnecting: reading works,
   *  sending is refused, and the composer says why. */
  channelLive: boolean;
  initialConversationId: string | null;
}) {
  const isMobile = useIsMobile();
  const router = useRouter();
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<InboxListResult & { error?: string }>(
    initial,
  );
  const [listBusy, startList] = useTransition();
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConversationId,
  );
  // The loaded thread and any load error are KEYED on the conversation they
  // belong to and derived against `selectedId` at render, so switching
  // conversations needs no reset — and the effect below sets state only from
  // its callback, never synchronously.
  const [loaded, setLoaded] = useState<InboxThread | null>(null);
  const [loadError, setLoadError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const thread =
    loaded && loaded.conversation.id === selectedId ? loaded : null;
  const threadError = loadError?.id === selectedId ? loadError.message : null;

  // ── List ────────────────────────────────────────────────────────────────
  const fetchList = useCallback(
    async (signal?: AbortSignal) => {
      const params = new URLSearchParams({
        need: "list",
        filter,
        q,
        page: String(page),
      });
      const res = await fetch(`/api/dashboard/inbox/live?${params}`, {
        signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as InboxListResult;
    },
    [filter, q, page],
  );

  // A filter, search or page change refreshes at once.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    let cancelled = false;
    startList(async () => {
      try {
        const next = await fetchList();
        if (!cancelled) setList(next);
      } catch {
        /* the poll will try again */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchList]);

  usePoll(
    async ({ signal, isCurrent }) => {
      const next = await fetchList(signal);
      if (!isCurrent()) return;
      const changed = JSON.stringify(next) !== JSON.stringify(list);
      if (changed) setList(next);
      return changed;
    },
    { ms: LIST_POLL_MS, backOff: true },
  );

  // ── Thread ──────────────────────────────────────────────────────────────
  const loadThread = useCallback(async (id: string, signal?: AbortSignal) => {
    const res = await fetch(
      `/api/dashboard/inbox/live?need=thread&id=${encodeURIComponent(id)}`,
      { signal, cache: "no-store" },
    );
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as { thread: InboxThread | null; error?: string };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void getInboxThread(selectedId).then((r) => {
      if (cancelled) return;
      if (!r.thread) {
        setLoadError({ id: selectedId, message: r.error ?? "Not found." });
        return;
      }
      setLoaded(r.thread);
      if (r.thread.conversation.unreadCount > 0) {
        void markInboxRead(selectedId);
        setList((l) => ({
          ...l,
          rows: l.rows.map((row) =>
            row.id === selectedId ? { ...row, unreadCount: 0 } : row,
          ),
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  usePoll(
    async ({ signal, isCurrent }) => {
      if (!selectedId) return false;
      const r = await loadThread(selectedId, signal);
      if (!isCurrent() || !r.thread) return false;
      const changed = JSON.stringify(r.thread) !== JSON.stringify(thread);
      if (changed) setLoaded(r.thread);
      return changed;
    },
    { ms: THREAD_POLL_MS, enabled: Boolean(selectedId), backOff: true },
  );

  const refreshThread = useCallback(async () => {
    if (!selectedId) return;
    const r = await getInboxThread(selectedId);
    if (r.thread) setLoaded(r.thread);
    // The list's preview and status move too.
    fetchList()
      .then(setList)
      .catch(() => undefined);
  }, [selectedId, fetchList]);

  const select = (id: string | null) => {
    setSelectedId(id);
    const url = id
      ? `/dashboard/inbox?c=${encodeURIComponent(id)}`
      : "/dashboard/inbox";
    window.history.replaceState(null, "", url);
  };

  const threadPane = selectedId ? (
    <ThreadPane
      conversationId={selectedId}
      thread={thread}
      error={threadError}
      templates={templates}
      canManage={canManage}
      channelLive={channelLive}
      onClose={() => select(null)}
      onChanged={refreshThread}
      onStatus={(status) => {
        setList((l) => ({
          ...l,
          rows: l.rows.map((row) =>
            row.id === selectedId ? { ...row, status } : row,
          ),
        }));
        router.refresh();
      }}
    />
  ) : (
    <div className="inbox-empty">
      <MessageCircle className="h-6 w-6 opacity-30" />
      <p>Choose a conversation</p>
    </div>
  );

  return (
    <div className="dash-page-enter inbox-page">
      <header className="dash-page-header row">
        <div>
          <h1>Inbox</h1>
          <p>Customer conversations on your WhatsApp number.</p>
        </div>
      </header>

      <div className="inbox-layout">
        <section className="dash-card inbox-list">
          <div className="inbox-list-head">
            <form
              className="inbox-search"
              onSubmit={(e) => {
                e.preventDefault();
                setPage(1);
                setQ(
                  (
                    e.currentTarget.elements.namedItem("q") as HTMLInputElement
                  ).value.trim(),
                );
              }}
            >
              <Search className="h-4 w-4" />
              <input
                name="q"
                defaultValue={q}
                placeholder="Search name or number"
                aria-label="Search conversations"
              />
            </form>
            <div className="inbox-filters" role="tablist" aria-label="Filter">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.key}
                  className={`inbox-filter ${filter === f.key ? "is-active" : ""}`}
                  onClick={() => {
                    setFilter(f.key);
                    setPage(1);
                  }}
                >
                  {f.label}
                  <span className="inbox-filter-count">
                    {list.counts[f.key]}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {list.error ? (
            <p className="inbox-note is-error">{list.error}</p>
          ) : list.rows.length === 0 ? (
            <p className="inbox-note">
              {q || filter !== "all"
                ? "No conversations match."
                : "No messages yet. Customers who reply to an order update, scan your QR code or tap the chat button will appear here."}
            </p>
          ) : (
            <ul className={`inbox-rows ${listBusy ? "is-busy" : ""}`}>
              {list.rows.map((row) => (
                <ConversationRow
                  key={row.id}
                  row={row}
                  active={row.id === selectedId}
                  onSelect={() => select(row.id)}
                />
              ))}
            </ul>
          )}
          <ListPagination
            page={page}
            pageSize={30}
            total={list.total}
            onPage={setPage}
          />
        </section>

        {isMobile ? (
          selectedId && (
            <Sheet
              open
              onOpenChange={(open) => {
                if (!open) select(null);
              }}
            >
              <SheetContent
                className="dashboard-shell inbox-sheet"
                showCloseButton={false}
              >
                <SheetTitle className="sr-only">Conversation</SheetTitle>
                {threadPane}
              </SheetContent>
            </Sheet>
          )
        ) : (
          <section className="dash-card inbox-thread">{threadPane}</section>
        )}
      </div>
    </div>
  );
}

function ConversationRow({
  row,
  active,
  onSelect,
}: {
  row: InboxConversationRow;
  active: boolean;
  onSelect: () => void;
}) {
  const name = row.contact.name ?? row.contact.phoneLabel;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`inbox-row ${active ? "is-active" : ""} ${
          row.status === "needs_reply" ? "needs-reply" : ""
        }`}
      >
        <span className="inbox-row-top">
          <span className="inbox-row-name">{name}</span>
          <span className="inbox-row-when">
            {row.lastMessageAt ? shortWhen(row.lastMessageAt) : ""}
          </span>
        </span>
        <span className="inbox-row-bottom">
          <span className="inbox-row-preview">{row.lastPreview ?? "—"}</span>
          {row.unreadCount > 0 ? (
            <span className="inbox-row-unread">{row.unreadCount}</span>
          ) : row.status === "closed" ? (
            <span className="inbox-row-closed">Closed</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

// ── The open thread ───────────────────────────────────────────────────────

function ThreadPane({
  conversationId,
  thread,
  error,
  templates,
  canManage,
  channelLive,
  onClose,
  onChanged,
  onStatus,
}: {
  conversationId: string;
  thread: InboxThread | null;
  error: string | null;
  templates: InboxTemplateOption[];
  canManage: boolean;
  channelLive: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onStatus: (status: "open" | "closed") => void;
}) {
  const [showCustomer, setShowCustomer] = useState(false);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  // Stick to the newest message when one arrives; leave the reader alone
  // otherwise.
  useEffect(() => {
    const el = scroller.current;
    const count = thread?.messages.length ?? 0;
    if (!el) return;
    if (count !== lastCount.current) {
      el.scrollTop = el.scrollHeight;
      lastCount.current = count;
    }
  }, [thread?.messages.length, conversationId]);

  if (error) {
    return (
      <div className="inbox-empty">
        <p>{error}</p>
        <button type="button" className="inbox-link" onClick={onClose}>
          Back to the list
        </button>
      </div>
    );
  }
  if (!thread) {
    return (
      <div className="inbox-empty">
        <p>Opening…</p>
      </div>
    );
  }

  const c = thread.conversation;
  const name = c.contact.name ?? c.contact.phoneLabel;

  async function setStatus(status: "open" | "closed") {
    setBusy(true);
    const r = await setInboxConversationStatus(conversationId, status);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? "Couldn't update the conversation.");
      return;
    }
    onStatus(status);
    await onChanged();
  }

  return (
    <div className="inbox-thread-inner">
      <header className="inbox-thread-head">
        <button
          type="button"
          className="inbox-icon-btn inbox-thread-back"
          onClick={onClose}
          aria-label="Back"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="inbox-thread-who">
          <p className="inbox-thread-name">{name}</p>
          <p className="inbox-thread-sub">
            {c.contact.name ? `${c.contact.phoneLabel} · ` : ""}
            {c.status === "needs_reply"
              ? "Waiting for your reply"
              : c.status === "closed"
                ? "Closed"
                : "Open"}
          </p>
        </div>
        <button
          type="button"
          className="inbox-text-btn"
          onClick={() => setShowCustomer((v) => !v)}
          aria-expanded={showCustomer}
        >
          Details
          {showCustomer ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
        {canManage &&
          (c.status === "closed" ? (
            <button
              type="button"
              className="inbox-text-btn"
              disabled={busy}
              onClick={() => setStatus("open")}
            >
              Reopen
            </button>
          ) : (
            <button
              type="button"
              className="inbox-text-btn"
              disabled={busy}
              onClick={() => setStatus("closed")}
            >
              Close
            </button>
          ))}
      </header>

      {showCustomer && <CustomerStrip thread={thread} />}

      <div className="inbox-messages" ref={scroller}>
        {thread.messages.length === 0 ? (
          <p className="inbox-note">No messages yet.</p>
        ) : (
          thread.messages.map((m) => <Bubble key={m.id} m={m} />)
        )}
      </div>

      <Composer
        key={conversationId}
        conversationId={conversationId}
        windowOpen={thread.window.open}
        closesAt={thread.window.closesAt}
        templates={templates}
        canManage={canManage}
        channelLive={channelLive}
        onSent={onChanged}
      />
    </div>
  );
}

function CustomerStrip({ thread }: { thread: InboxThread }) {
  const { customer, conversation } = thread;
  return (
    <div className="inbox-customer">
      <div className="inbox-customer-col">
        <p className="inbox-customer-label">Agreed to</p>
        <p className="inbox-customer-value">
          {customer.consent.updates ? "Order updates" : "No order updates"}
          {" · "}
          {customer.consent.marketing ? "Offers" : "No offers"}
        </p>
        {conversation.contact.userId ? (
          <>
            <p className="inbox-customer-label">Store credit</p>
            <p className="inbox-customer-value">
              {formatPrice(customer.credit ?? 0)}
            </p>
            <Link
              href={`/dashboard/users/${encodeURIComponent(conversation.contact.userId)}`}
              className="inbox-link"
            >
              Customer profile
            </Link>
          </>
        ) : (
          <p className="inbox-customer-hint">
            No account on this store with this number.
          </p>
        )}
      </div>
      <div className="inbox-customer-col">
        <p className="inbox-customer-label">Recent orders</p>
        {customer.orders.length === 0 ? (
          <p className="inbox-customer-hint">None yet.</p>
        ) : (
          <ul className="inbox-orders">
            {customer.orders.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/dashboard/orders?q=${encodeURIComponent(o.orderRef)}`}
                  className="inbox-link"
                >
                  {o.orderRef}
                </Link>
                <span>
                  {formatPrice(o.total)} · {labelStatus(o.status)} ·{" "}
                  {shortWhen(o.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Bubble({ m }: { m: InboxMessageRow }) {
  const out = m.direction === "out";
  const intent =
    m.payload && typeof m.payload.intent === "string" ? m.payload.intent : null;
  return (
    <div className={`inbox-bubble-row ${out ? "is-out" : "is-in"}`}>
      <div
        className={`inbox-bubble ${m.status === "failed" ? "is-failed" : ""}`}
      >
        {m.source === "phone_app" && (
          <span className="inbox-bubble-source">
            <Smartphone className="h-3 w-3" /> From your phone
          </span>
        )}
        {m.source === "template" && (
          <span className="inbox-bubble-source">
            <FileText className="h-3 w-3" />{" "}
            {m.sentBy ? `Template · ${m.sentBy}` : "Order update"}
          </span>
        )}
        {m.source === "dashboard" && m.sentBy && (
          <span className="inbox-bubble-source">{m.sentBy}</span>
        )}
        <Media m={m} />
        {m.body && <p className="inbox-bubble-text">{m.body}</p>}
        {intent === "stop" && (
          <span className="inbox-bubble-flag">Opted out of offers</span>
        )}
        {intent === "start" && (
          <span className="inbox-bubble-flag">Opted back in to offers</span>
        )}
        {m.error && !out && (
          <span className="inbox-bubble-error">{m.error}</span>
        )}
        <span className="inbox-bubble-meta">
          {formatWhen(m.sentAt)}
          {out && <Ticks status={m.status} />}
        </span>
        {out && m.status === "failed" && m.error && (
          <span className="inbox-bubble-error">{m.error}</span>
        )}
      </div>
    </div>
  );
}

function Media({ m }: { m: InboxMessageRow }) {
  if (!m.mediaUrl) {
    if (
      m.kind === "image" ||
      m.kind === "video" ||
      m.kind === "audio" ||
      m.kind === "document" ||
      m.kind === "sticker"
    ) {
      return (
        <span className="inbox-bubble-source">
          {m.kind === "image"
            ? "📷 Photo"
            : m.kind === "video"
              ? "🎥 Video"
              : m.kind === "audio"
                ? "🎤 Voice message"
                : m.kind === "document"
                  ? `📄 ${m.mediaName ?? "Document"}`
                  : "Sticker"}
          {m.error ? " (not saved)" : " (saving…)"}
        </span>
      );
    }
    return null;
  }
  if (m.kind === "image" || m.kind === "sticker") {
    return (
      <a href={m.mediaUrl} target="_blank" rel="noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element -- a customer's
            photo from our bucket; next/image would need a remote pattern per
            size and gains nothing in a chat thread. */}
        <img src={m.mediaUrl} alt={m.body ?? "Photo"} className="inbox-media" />
      </a>
    );
  }
  if (m.kind === "video") {
    return <video src={m.mediaUrl} controls className="inbox-media" />;
  }
  if (m.kind === "audio") {
    return <audio src={m.mediaUrl} controls className="inbox-audio" />;
  }
  return (
    <a
      href={m.mediaUrl}
      target="_blank"
      rel="noreferrer"
      className="inbox-link"
    >
      📄 {m.mediaName ?? "Document"}
    </a>
  );
}

function Ticks({ status }: { status: string }) {
  if (status === "failed") {
    return (
      <AlertTriangle className="inbox-tick is-failed" aria-label="Failed" />
    );
  }
  if (status === "read") {
    return <CheckCheck className="inbox-tick is-read" aria-label="Read" />;
  }
  if (status === "delivered") {
    return <CheckCheck className="inbox-tick" aria-label="Delivered" />;
  }
  return <Check className="inbox-tick" aria-label="Sent" />;
}

// ── Composer ──────────────────────────────────────────────────────────────

function Composer({
  conversationId,
  windowOpen,
  closesAt,
  templates,
  canManage,
  channelLive,
  onSent,
}: {
  conversationId: string;
  windowOpen: boolean;
  closesAt: string | null;
  templates: InboxTemplateOption[];
  canManage: boolean;
  channelLive: boolean;
  onSent: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [forceTemplate, setForceTemplate] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [values, setValues] = useState<string[]>([]);
  const [, tick] = useState(0);

  // Re-render each minute so the countdown and the 24-hour switch move.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  // Draft state is per conversation: ThreadPane keys this component on the
  // conversation id, so switching threads remounts it with an empty box.
  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templates, templateId],
  );
  const chooseTemplate = (id: string) => {
    setTemplateId(id);
    const next = templates.find((t) => t.id === id);
    setValues(next ? next.variables.map(() => "") : []);
  };

  if (!canManage) {
    return (
      <div className="inbox-composer is-locked">
        <Lock className="h-4 w-4" />
        <span>You can read this conversation but not reply.</span>
      </div>
    );
  }
  if (!channelLive) {
    return (
      <div className="inbox-composer is-locked">
        <Lock className="h-4 w-4" />
        <span>
          Your WhatsApp number is paused or needs reconnecting. Resume it under
          Settings → Channels to reply.
        </span>
      </div>
    );
  }

  const useTemplate = !windowOpen || forceTemplate;
  const remaining = closesAt ? countdown(closesAt) : null;

  async function send() {
    if (sending) return;
    setSending(true);
    const r = useTemplate
      ? await sendInboxTemplate({ conversationId, templateId, values })
      : await sendInboxReply({ conversationId, text });
    setSending(false);
    if (!r.ok) {
      toast.error(r.error ?? "Couldn't send.");
      if (r.code === "window_closed") setForceTemplate(true);
      if (r.messageId) await onSent();
      return;
    }
    setText("");
    setTemplateId("");
    setForceTemplate(false);
    await onSent();
  }

  return (
    <div className="inbox-composer">
      <div className="inbox-window">
        {windowOpen ? (
          <>
            <span>
              You can reply freely for {remaining}. The customer&rsquo;s next
              message restarts the 24 hours.
            </span>
            {templates.length > 0 && (
              <button
                type="button"
                className="inbox-link"
                onClick={() => setForceTemplate((v) => !v)}
              >
                {forceTemplate ? "Write a message" : "Send a template"}
              </button>
            )}
          </>
        ) : (
          <span>
            More than 24 hours since the customer last wrote. WhatsApp allows
            only an approved template until they message again.
          </span>
        )}
      </div>

      {useTemplate ? (
        <div className="inbox-template">
          {templates.length === 0 ? (
            <p className="inbox-note">
              No approved customer templates yet. They appear here once Meta
              approves them (Settings → Channels → WhatsApp).
            </p>
          ) : (
            <>
              <select
                value={templateId}
                onChange={(e) => chooseTemplate(e.target.value)}
                aria-label="Template"
                className="inbox-select"
              >
                <option value="">Choose a template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {template && (
                <>
                  <p className="inbox-template-body">{template.body}</p>
                  {template.variables.map((v, i) => (
                    <label key={v} className="inbox-field">
                      <span>{labelVariable(v)}</span>
                      <input
                        value={values[i] ?? ""}
                        onChange={(e) =>
                          setValues((all) =>
                            all.map((x, j) => (j === i ? e.target.value : x)),
                          )
                        }
                        maxLength={200}
                      />
                    </label>
                  ))}
                </>
              )}
              <div className="inbox-composer-actions">
                <button
                  type="button"
                  className="inbox-send"
                  disabled={
                    sending || !template || values.some((v) => !v.trim())
                  }
                  onClick={send}
                >
                  <Send className="h-4 w-4" /> Send template
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="inbox-compose-row">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (text.trim()) void send();
              }
            }}
            placeholder="Type a reply… (Enter to send, Shift+Enter for a new line)"
            rows={2}
            maxLength={INBOX_REPLY_MAX_CHARS}
            aria-label="Reply"
          />
          <button
            type="button"
            className="inbox-send"
            disabled={sending || !text.trim()}
            onClick={send}
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) ===
    now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  return sameDay
    ? d.toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : d.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        timeZone: "Asia/Kolkata",
      });
}

function countdown(closesAt: string): string {
  const ms = new Date(closesAt).getTime() - Date.now();
  if (ms <= 0) return "a moment";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 1) return `${h} h ${m} min`;
  return `${Math.max(1, m)} min`;
}

function labelVariable(name: string): string {
  return name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function labelStatus(status: string): string {
  return status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
