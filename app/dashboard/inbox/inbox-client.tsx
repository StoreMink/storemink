"use client";

// ---------------------------------------------------------------------------
// The WhatsApp inbox screen (docs/whatsapp-commerce-plan.md §11).
//
// Laid out like WhatsApp: one card with the conversation list and the open
// chat side by side on a desktop, and one at a time on a phone, where the
// chat opens full screen over the list (the Orders page's `use-mobile`
// pattern). The customer's orders and consent sit in a collapsible panel under
// the chat header rather than a third column, so the same layout holds at
// every width.
//
// ★ THE PAGE IS A FIXED HEIGHT; ONLY THE MESSAGES SCROLL (inbox.css). The
// chat opens at the newest message, follows new ones while the reader is at
// the bottom, and leaves them alone (with a jump-to-latest button) once they
// have scrolled up to read history.
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
  useLayoutEffect,
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
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronDown,
  FileText,
  Info,
  Lock,
  MessageCircle,
  Search,
  Send,
  Smartphone,
  User,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePoll } from "@/lib/pos/use-poll";
import { isTouchPrimary } from "@/lib/pos/keyboard-wedge";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
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
      <span className="inbox-empty-icon">
        <MessageCircle className="h-7 w-7" />
      </span>
      <p className="inbox-empty-title">Choose a conversation</p>
      <p>Messages from your customers on WhatsApp appear on the left.</p>
    </div>
  );

  return (
    <div className="dash-page-enter inbox-page">
      <header className="dash-page-header row inbox-page-header">
        <div>
          <h1>Inbox</h1>
          <p>Customer conversations on your WhatsApp number.</p>
        </div>
      </header>

      {/* `has-thread` lets a narrow card show one pane at a time (inbox.css);
          on a phone the chat is a sheet instead, so the list stays put. */}
      <div
        className={`dash-card inbox-shell ${
          selectedId && !isMobile ? "has-thread" : ""
        }`}
      >
        <section className="inbox-list" aria-label="Conversations">
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
          <section className="inbox-thread" aria-label="Conversation">
            {threadPane}
          </section>
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
        aria-current={active ? "true" : undefined}
        className={`inbox-row ${active ? "is-active" : ""} ${
          row.status === "needs_reply" ? "needs-reply" : ""
        } ${row.unreadCount > 0 ? "has-unread" : ""}`}
      >
        <Avatar name={row.contact.name} seed={row.contact.id} />
        <span className="inbox-row-body">
          <span className="inbox-row-top">
            <span className="inbox-row-name">{name}</span>
            <span className="inbox-row-when">
              {row.lastMessageAt ? shortWhen(row.lastMessageAt) : ""}
            </span>
          </span>
          <span className="inbox-row-bottom">
            <span className="inbox-row-preview">{row.lastPreview ?? "-"}</span>
            {row.unreadCount > 0 ? (
              <span className="inbox-row-unread">{row.unreadCount}</span>
            ) : row.status === "closed" ? (
              <span className="inbox-row-closed">Closed</span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Initials on a soft colour fixed by the contact, or a person outline when
 *  WhatsApp gave no name (WhatsApp's own look for an unknown sender). */
function Avatar({
  name,
  seed,
  small = false,
}: {
  name: string | null;
  seed: string;
  small?: boolean;
}) {
  const [bg, fg] = AVATAR_COLOURS[hashString(seed) % AVATAR_COLOURS.length];
  const letters = initials(name);
  return (
    <span
      className={`inbox-avatar ${small ? "is-sm" : ""}`}
      style={{ background: bg, color: fg }}
      aria-hidden="true"
    >
      {letters ?? <User className={small ? "h-5 w-5" : "h-6 w-6"} />}
    </span>
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
  const [showJump, setShowJump] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // What the scroll position was last settled for, and whether the reader is
  // at the bottom. Refs, so a scroll does not re-render the thread.
  const settled = useRef<{ id: string | null; count: number }>({
    id: null,
    count: 0,
  });
  const atBottom = useRef(true);

  const count = thread?.messages.length ?? 0;
  const lastOut = thread?.messages[count - 1]?.direction === "out";

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    // The scroll event this causes hides the jump button (onScroll).
    atBottom.current = true;
  }, []);

  // ★ Open at the newest message; follow new ones only while the reader is at
  // the bottom, or when the newest is our own reply. Someone scrolled up to
  // read history is left where they are. Before paint, so a chat never flashes
  // open at the top.
  useLayoutEffect(() => {
    if (!thread || !scroller.current) return;
    const opened = settled.current.id !== conversationId;
    const grew = count > settled.current.count;
    if (opened || (grew && (atBottom.current || lastOut))) toBottom();
    settled.current = { id: conversationId, count };
  }, [thread, conversationId, count, lastOut, toBottom]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < 80;
    const jump = distance > 240;
    setShowJump((was) => (was === jump ? was : jump));
  };

  // A photo that finishes loading after the chat opened pushes the newest
  // message down; keep it in view if the reader was there.
  const onMediaLoad = useCallback(() => {
    if (atBottom.current) toBottom();
  }, [toBottom]);

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
          aria-label="Back to conversations"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Avatar name={c.contact.name} seed={c.contact.id} small />
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
        <div className="inbox-thread-actions">
          <button
            type="button"
            className="inbox-text-btn"
            onClick={() => setShowCustomer((v) => !v)}
            aria-expanded={showCustomer}
            aria-label="Customer details"
          >
            <Info className="h-3.5 w-3.5" />
            <span className="inbox-text-label">Details</span>
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
        </div>
      </header>

      {showCustomer && <CustomerStrip thread={thread} />}

      <div className="inbox-messages-wrap">
        <div
          className="inbox-messages"
          ref={scroller}
          onScroll={onScroll}
          role="log"
          aria-label={`Messages with ${name}`}
        >
          {thread.messages.length === 0 ? (
            <p className="inbox-note">No messages yet.</p>
          ) : (
            <MessageList messages={thread.messages} onMediaLoad={onMediaLoad} />
          )}
        </div>
        {showJump && (
          <button
            type="button"
            className="inbox-jump"
            onClick={() => toBottom(true)}
            aria-label="Go to the latest message"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
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

/** Messages grouped by day, each day under its own date pill, and a run of
 *  messages from one side within a few minutes drawn as one block (only the
 *  first bubble carries the tail and the sender label). */
function MessageList({
  messages,
  onMediaLoad,
}: {
  messages: InboxMessageRow[];
  onMediaLoad: () => void;
}) {
  const days = useMemo(() => groupByDay(messages), [messages]);
  return (
    <>
      {days.map((day) => (
        <section key={day.key} className="inbox-day" aria-label={day.label}>
          <span className="inbox-day-label">{day.label}</span>
          {day.messages.map((m, i) => {
            const prev = day.messages[i - 1];
            const continues =
              !!prev &&
              prev.direction === m.direction &&
              new Date(m.sentAt).getTime() - new Date(prev.sentAt).getTime() <
                RUN_GAP_MS;
            const label = senderLabel(m);
            const showLabel =
              label !== null && (!continues || senderLabel(prev) !== label);
            return (
              <Bubble
                key={m.id}
                m={m}
                continues={continues}
                showLabel={showLabel}
                onMediaLoad={onMediaLoad}
              />
            );
          })}
        </section>
      ))}
    </>
  );
}

function Bubble({
  m,
  continues,
  showLabel,
  onMediaLoad,
}: {
  m: InboxMessageRow;
  continues: boolean;
  showLabel: boolean;
  onMediaLoad: () => void;
}) {
  const out = m.direction === "out";
  const intent =
    m.payload && typeof m.payload.intent === "string" ? m.payload.intent : null;
  const inboundError = Boolean(m.error && !out);
  const outboundError = Boolean(out && m.status === "failed" && m.error);
  // ★ The time sits over the end of the last line only when the text IS the
  // last line; a flag or an error under it gets the time on its own row.
  const tailMeta =
    Boolean(m.body) && !intent && !inboundError && !outboundError;
  const hasMedia = Boolean(m.mediaUrl);
  return (
    <div
      className={`inbox-bubble-row ${out ? "is-out" : "is-in"} ${
        continues ? "is-cont" : ""
      }`}
    >
      <div
        className={`inbox-bubble ${m.status === "failed" ? "is-failed" : ""} ${
          tailMeta ? "has-tail-meta" : ""
        } ${hasMedia ? "has-media" : ""}`}
      >
        {showLabel && <SenderLabel m={m} />}
        <Media m={m} onLoad={onMediaLoad} />
        {m.body && (
          <p className="inbox-bubble-text">
            {m.body}
            {tailMeta && (
              <span className="inbox-bubble-spacer" aria-hidden="true" />
            )}
          </p>
        )}
        {intent === "stop" && (
          <span className="inbox-bubble-flag">Opted out of offers</span>
        )}
        {intent === "start" && (
          <span className="inbox-bubble-flag">Opted back in to offers</span>
        )}
        {inboundError && <span className="inbox-bubble-error">{m.error}</span>}
        {outboundError && <span className="inbox-bubble-error">{m.error}</span>}
        <span className="inbox-bubble-meta">
          <time dateTime={m.sentAt} title={fullWhen(m.sentAt)}>
            {timeOnly(m.sentAt)}
          </time>
          {out && <Ticks status={m.status} />}
        </span>
      </div>
    </div>
  );
}

/** Who sent an outbound message, when it is worth saying; null for the
 *  customer's own messages and the shop's unnamed automation. */
function senderLabel(m: InboxMessageRow): string | null {
  if (m.direction !== "out") return null;
  if (m.source === "phone_app") return "From your phone";
  if (m.source === "template") {
    return m.sentBy ? `Template · ${m.sentBy}` : "Order update";
  }
  if (m.source === "automation") return "Automatic reply";
  if (m.source === "dashboard" && m.sentBy) return m.sentBy;
  return null;
}

function SenderLabel({ m }: { m: InboxMessageRow }) {
  const label = senderLabel(m);
  if (!label) return null;
  return (
    <span className="inbox-bubble-source">
      {m.source === "phone_app" && <Smartphone className="h-3 w-3" />}
      {m.source === "template" && <FileText className="h-3 w-3" />}
      {label}
    </span>
  );
}

function Media({ m, onLoad }: { m: InboxMessageRow; onLoad: () => void }) {
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
        <img
          src={m.mediaUrl}
          alt={m.body ?? "Photo"}
          className="inbox-media"
          onLoad={onLoad}
        />
      </a>
    );
  }
  if (m.kind === "video") {
    return (
      <video
        src={m.mediaUrl}
        controls
        className="inbox-media"
        onLoadedMetadata={onLoad}
      />
    );
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
  const box = useRef<HTMLTextAreaElement>(null);

  // The box grows with what is typed, up to its CSS max-height, then scrolls.
  // ★ Only from a real measurement: a box measured while hidden (or before
  // layout) reports 0, and writing that would collapse it to nothing.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [text]);

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
              You can reply freely for {remaining}.
              <span className="inbox-window-more">
                {" "}
                The customer&rsquo;s next message restarts the 24 hours.
              </span>
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
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends on a keyboard; on a phone it is a new line and
              // the button sends, as in WhatsApp.
              if (e.key === "Enter" && !e.shiftKey && !isTouchPrimary()) {
                e.preventDefault();
                if (text.trim()) void send();
              }
            }}
            placeholder="Type a message"
            title="Enter to send, Shift+Enter for a new line"
            rows={1}
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

const TIME_ZONE = "Asia/Kolkata";

/** Messages closer together than this, from the same side, read as one run. */
const RUN_GAP_MS = 5 * 60_000;

/** Soft background and a text colour that reads on it (≥ 4.5:1). */
const AVATAR_COLOURS: [string, string][] = [
  ["#dbeafe", "#1e40af"],
  ["#dcfce7", "#166534"],
  ["#fef3c7", "#92400e"],
  ["#fce7f3", "#9d174d"],
  ["#ede9fe", "#5b21b6"],
  ["#e0f2fe", "#075985"],
  ["#ffedd5", "#9a3412"],
  ["#e2e8f0", "#334155"],
];

function hashString(value: string): number {
  let h = 5381;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Up to two letters from a name; null when there is no name to take them
 *  from (WhatsApp sent none, or it is only a number). */
function initials(name: string | null): string | null {
  const words = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w));
  if (words.length === 0) return null;
  const first = Array.from(words[0])[0] ?? "";
  const last =
    words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";
  return (first + last).toUpperCase();
}

function dayKey(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TIME_ZONE });
}

/** "Today", "Yesterday", a weekday within the week, else the date. */
function dayLabel(d: Date): string {
  const now = Date.now();
  const key = dayKey(d);
  if (key === dayKey(new Date(now))) return "Today";
  if (key === dayKey(new Date(now - 86_400_000))) return "Yesterday";
  if (now - d.getTime() < 6 * 86_400_000) {
    return d.toLocaleDateString("en-IN", {
      weekday: "long",
      timeZone: TIME_ZONE,
    });
  }
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: TIME_ZONE,
  });
}

function groupByDay(
  messages: InboxMessageRow[],
): { key: string; label: string; messages: InboxMessageRow[] }[] {
  const days: { key: string; label: string; messages: InboxMessageRow[] }[] =
    [];
  for (const m of messages) {
    const d = new Date(m.sentAt);
    const key = Number.isNaN(d.getTime()) ? "unknown" : dayKey(d);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = {
        key,
        label: key === "unknown" ? "Earlier" : dayLabel(d),
        messages: [],
      };
      days.push(day);
    }
    day.messages.push(m);
  }
  return days;
}

function timeOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  });
}

function fullWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  });
}

function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const key = dayKey(d);
  if (key === dayKey(new Date())) return timeOnly(iso);
  if (key === dayKey(new Date(Date.now() - 86_400_000))) return "Yesterday";
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: TIME_ZONE,
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
