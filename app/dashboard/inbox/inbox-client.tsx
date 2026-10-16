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
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Bookmark,
  Check,
  CheckCheck,
  ChevronDown,
  FileText,
  Info,
  Lock,
  MessageCircle,
  Paperclip,
  Reply,
  Search,
  Send,
  Settings2,
  Smartphone,
  Sparkles,
  StickyNote,
  Tag,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePoll } from "@/lib/pos/use-poll";
import { isTouchPrimary } from "@/lib/pos/keyboard-wedge";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { formatPrice } from "@/lib/pricing";
import {
  addInboxNote,
  assignInboxConversation,
  deleteInboxNote,
  discardMinkDraft,
  getInboxThread,
  markInboxRead,
  sendInboxReply,
  sendInboxTemplate,
  sendMinkDraft,
  setInboxConversationLabel,
  setInboxConversationStatus,
} from "@/app/actions/inbox-actions";
import {
  INBOX_MEDIA_ACCEPT,
  INBOX_NOTE_SOURCE,
  INBOX_REPLY_MAX_CHARS,
  type InboxCannedReply,
  type InboxConversationRow,
  type InboxFilter,
  type InboxLabel,
  type InboxListResult,
  type InboxMessageRow,
  type InboxMinkDraft,
  type InboxSendResult,
  type InboxThread,
  type InboxWorkspace,
} from "@/lib/whatsapp/inbox-types";
import {
  INBOX_CAPTION_MAX,
  INBOX_NOTE_MAX,
  fillCannedReply,
  splitSnippet,
  templateBlockedReason,
  type InboxReplyTemplate,
} from "@/lib/whatsapp/inbox-workspace";
import { ListPagination } from "../components/list-pagination";
import { InboxManageButtons } from "./inbox-manage";
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
  workspace: initialWorkspace,
  canManage,
  channelLive,
  initialConversationId,
}: {
  initial: InboxListResult & { error?: string };
  templates: InboxReplyTemplate[];
  /** The team, the labels and the saved replies of this store. */
  workspace: InboxWorkspace;
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
  const [assignee, setAssignee] = useState("");
  const [label, setLabel] = useState("");
  const [workspace, setWorkspace] = useState(initialWorkspace);
  // ★ The label filter counts only while its label exists. Deleting the label
  // the list was filtered by left every fetch filtering on nothing ("No
  // conversations match."), and with the last label gone the select that
  // could clear it was hidden as well.
  const labelFilter = workspace.labels.some((l) => l.id === label) ? label : "";
  // A search hit INSIDE a conversation: the message to scroll to once the
  // thread opens, keyed on the conversation it belongs to.
  const [jump, setJump] = useState<{ id: string; messageId: string } | null>(
    null,
  );
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
  // ★ THE QUERY IS ALSO THE IDENTITY OF A RESULT. A read started before a
  // tab, page or search change (the refresh after a Send, the poll) can land
  // after it, and its rows answer the old query: shown under the new tab,
  // they stayed until the next poll. A result is shown only while its query
  // is still the one on screen.
  const listQuery = useMemo(
    () =>
      new URLSearchParams({
        need: "list",
        filter,
        q,
        page: String(page),
        assignee,
        label: labelFilter,
      }).toString(),
    [filter, q, page, assignee, labelFilter],
  );
  const listQueryRef = useRef(listQuery);
  useLayoutEffect(() => {
    listQueryRef.current = listQuery;
  }, [listQuery]);

  const fetchList = useCallback(async (query: string, signal?: AbortSignal) => {
    const res = await fetch(`/api/dashboard/inbox/live?${query}`, {
      signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(String(res.status));
    return { query, result: (await res.json()) as InboxListResult };
  }, []);
  const acceptList = useCallback(
    (r: { query: string; result: InboxListResult }) => {
      if (r.query === listQueryRef.current) setList(r.result);
    },
    [],
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
        const next = await fetchList(listQuery);
        if (!cancelled) acceptList(next);
      } catch {
        /* the poll will try again */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [listQuery, fetchList, acceptList]);

  usePoll(
    async ({ signal, isCurrent }) => {
      const next = await fetchList(listQueryRef.current, signal);
      if (!isCurrent() || next.query !== listQueryRef.current) return;
      const changed = JSON.stringify(next.result) !== JSON.stringify(list);
      if (changed) setList(next.result);
      return changed;
    },
    { ms: LIST_POLL_MS, backOff: true },
  );

  // ── Thread ──────────────────────────────────────────────────────────────
  // ★ THE CONVERSATION ON SCREEN NOW, for reads that land later. A read for A
  // (the poll, the refresh after a Send) landing after B was opened replaced
  // B's thread: B showed "Opening…" until the next poll, and clicking B again
  // did nothing. Written where the selection changes; every thread read is
  // dropped unless its conversation is still this one.
  const selectedRef = useRef(selectedId);

  /** Show a thread that loaded, and drop any failure to load it before. */
  const showThread = useCallback((next: InboxThread) => {
    setLoaded(next);
    setLoadError((e) => (e?.id === next.conversation.id ? null : e));
  }, []);

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
    void getInboxThread(selectedId).then(
      (r) => {
        if (cancelled) return;
        if (!r.thread) {
          setLoadError({ id: selectedId, message: r.error ?? "Not found." });
          return;
        }
        showThread(r.thread);
        if (r.thread.conversation.unreadCount > 0) {
          void markInboxRead(selectedId);
          setList((l) => ({
            ...l,
            rows: l.rows.map((row) =>
              row.id === selectedId ? { ...row, unreadCount: 0 } : row,
            ),
          }));
        }
      },
      () => {
        // The poll tries again, and a thread that then loads clears this.
        if (!cancelled) {
          setLoadError({
            id: selectedId,
            message: "Couldn't load the conversation.",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedId, showThread]);

  usePoll(
    async ({ signal, isCurrent }) => {
      const id = selectedRef.current;
      if (!id) return false;
      const r = await loadThread(id, signal);
      if (!isCurrent() || selectedRef.current !== id || !r.thread) return false;
      const changed =
        threadError !== null ||
        JSON.stringify(r.thread) !== JSON.stringify(thread);
      if (changed) showThread(r.thread);
      return changed;
    },
    { ms: THREAD_POLL_MS, enabled: Boolean(selectedId), backOff: true },
  );

  const refreshThread = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    const r = await getInboxThread(id).catch(() => null);
    if (r?.thread && selectedRef.current === id) showThread(r.thread);
    // The list's preview and status move too, for the query on screen now.
    fetchList(listQueryRef.current)
      .then(acceptList)
      .catch(() => undefined);
  }, [fetchList, acceptList, showThread]);

  const select = (id: string | null, messageId?: string | null) => {
    selectedRef.current = id;
    setSelectedId(id);
    setJump(id && messageId ? { id, messageId } : null);
    const url = id
      ? `/dashboard/inbox?c=${encodeURIComponent(id)}`
      : "/dashboard/inbox";
    window.history.replaceState(null, "", url);
  };

  const patchRow = (patch: Partial<InboxConversationRow>) =>
    setList((l) => ({
      ...l,
      rows: l.rows.map((row) =>
        row.id === selectedId ? { ...row, ...patch } : row,
      ),
    }));

  const threadPane = selectedId ? (
    <ThreadPane
      // ★ One pane per conversation: what is picked in one (the quote a
      // reply will carry, the open panels, a busy button) must not carry
      // over to the next. A quote picked in A sat over B's composer, and the
      // server then dropped A's message id and sent B's reply unquoted.
      key={selectedId}
      conversationId={selectedId}
      thread={thread}
      error={threadError}
      templates={templates}
      workspace={workspace}
      canManage={canManage}
      channelLive={channelLive}
      jumpToMessageId={jump?.id === selectedId ? jump.messageId : null}
      onClose={() => select(null)}
      onChanged={refreshThread}
      onRow={patchRow}
      onStatus={(status) => {
        patchRow({ status });
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
        <div className="inbox-page-actions">
          <InboxManageButtons
            workspace={workspace}
            canManage={canManage}
            onChanged={setWorkspace}
          />
          <Link
            href="/dashboard/inbox/settings"
            className="dash-btn dash-btn-ghost dash-btn-sm shrink-0"
          >
            <Settings2 className="h-4 w-4" />
            Automatic replies
          </Link>
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
                placeholder="Search name, number or message"
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
            {(workspace.assignees.length > 0 ||
              workspace.labels.length > 0) && (
              <div className="inbox-tools">
                <select
                  className="inbox-select is-sm"
                  value={assignee}
                  onChange={(e) => {
                    setAssignee(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Assigned to"
                >
                  <option value="">Anyone</option>
                  <option value="me">Mine</option>
                  <option value="unassigned">Unassigned</option>
                  {workspace.assignees
                    .filter((a) => a.id !== workspace.me.id)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
                {workspace.labels.length > 0 && (
                  <select
                    className="inbox-select is-sm"
                    value={labelFilter}
                    onChange={(e) => {
                      setLabel(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Label"
                  >
                    <option value="">Any label</option>
                    {workspace.labels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>

          {list.error ? (
            <p className="inbox-note is-error">{list.error}</p>
          ) : list.rows.length === 0 ? (
            <p className="inbox-note">
              {q || filter !== "all" || assignee || labelFilter
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
                  workspace={workspace}
                  onSelect={() => select(row.id, row.match?.messageId)}
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
  workspace,
  onSelect,
}: {
  row: InboxConversationRow;
  active: boolean;
  workspace: InboxWorkspace;
  onSelect: () => void;
}) {
  const name = row.contact.name ?? row.contact.phoneLabel;
  const labels = labelsOf(row.labelIds, workspace.labels);
  const assignee = row.assignedAdminId
    ? (workspace.assignees.find((a) => a.id === row.assignedAdminId) ?? null)
    : null;
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
            {row.match ? (
              <span className="inbox-row-preview inbox-row-snippet">
                {splitSnippet(row.match.snippet).map((part, i) =>
                  part.hit ? <mark key={i}>{part.text}</mark> : part.text,
                )}
              </span>
            ) : (
              <span className="inbox-row-preview">
                {row.lastPreview ?? "-"}
              </span>
            )}
            {row.unreadCount > 0 ? (
              <span className="inbox-row-unread">{row.unreadCount}</span>
            ) : row.status === "closed" ? (
              <span className="inbox-row-closed">Closed</span>
            ) : null}
          </span>
          {(labels.length > 0 || assignee || row.assignedAdminId) && (
            <span className="inbox-row-tags">
              {labels.map((l) => (
                <span
                  key={l.id}
                  className={`inbox-dot is-${l.color}`}
                  title={l.name}
                  aria-label={l.name}
                />
              ))}
              {row.assignedAdminId && (
                <span
                  className="inbox-row-assignee"
                  title={`Assigned to ${assignee?.name ?? "somebody no longer on the store"}`}
                >
                  {assignee
                    ? assignee.id === workspace.me.id
                      ? "Me"
                      : (initials(assignee.name) ?? "?")
                    : "?"}
                </span>
              )}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** The store's labels among a conversation's ids, in the store's order. */
function labelsOf(ids: string[], all: InboxLabel[]): InboxLabel[] {
  if (ids.length === 0) return [];
  const set = new Set(ids);
  return all.filter((l) => set.has(l.id));
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
  workspace,
  canManage,
  channelLive,
  jumpToMessageId,
  onClose,
  onChanged,
  onRow,
  onStatus,
}: {
  conversationId: string;
  thread: InboxThread | null;
  error: string | null;
  templates: InboxReplyTemplate[];
  workspace: InboxWorkspace;
  canManage: boolean;
  channelLive: boolean;
  /** A search hit to scroll to once the thread is open. */
  jumpToMessageId: string | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
  /** The list's copy of this conversation changed (labels, assignee). */
  onRow: (patch: Partial<InboxConversationRow>) => void;
  onStatus: (status: "open" | "closed") => void;
}) {
  const [showCustomer, setShowCustomer] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showJump, setShowJump] = useState(false);
  // The message a reply will quote, chosen with the bubble's Reply button.
  // Per conversation, like everything here: the pane is keyed on it.
  const [replyTo, setReplyTo] = useState<InboxMessageRow | null>(null);
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

  // ★ A search hit opens the chat AT the matching message, not at the end,
  // and marks it; an older hit beyond the loaded 200 is simply not there,
  // and the chat opens at the end as usual.
  const jumped = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!thread || !jumpToMessageId) return;
    const key = `${conversationId}:${jumpToMessageId}`;
    if (jumped.current === key) return;
    const el = scroller.current?.querySelector<HTMLElement>(
      `[data-message-id="${jumpToMessageId}"]`,
    );
    if (!el) return;
    jumped.current = key;
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center" });
    }
    el.classList.add("is-hit");
    atBottom.current = false;
  }, [thread, conversationId, jumpToMessageId]);

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
  const applied = labelsOf(c.labelIds, workspace.labels);
  const assignee = c.assignedAdminId
    ? (workspace.assignees.find((a) => a.id === c.assignedAdminId) ?? null)
    : null;

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

  async function assign(adminId: string) {
    setBusy(true);
    const r = await assignInboxConversation({
      conversationId,
      adminId: adminId || null,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? "Couldn't assign the conversation.");
      return;
    }
    onRow({ assignedAdminId: r.assignedAdminId ?? null });
    await onChanged();
  }

  // ★ ONE LABEL ON OR OFF, NEVER THE WHOLE SET. The full set built from this
  // screen's copy of the thread deleted whatever that copy lacked: a quick
  // second click before the refresh landed, or a teammate's label not yet
  // polled, was silently removed. The chips also stay busy until the thread
  // is read again, so the next click starts from what the server holds.
  async function toggleLabel(labelId: string) {
    setBusy(true);
    try {
      const r = await setInboxConversationLabel({
        conversationId,
        labelId,
        on: !c.labelIds.includes(labelId),
      });
      if (!r.ok) {
        toast.error(r.error ?? "Couldn't update the labels.");
      } else if (r.labelIds) {
        onRow({ labelIds: r.labelIds });
      }
      await onChanged();
    } catch {
      toast.error("Couldn't update the labels.");
    } finally {
      setBusy(false);
    }
  }

  async function removeNote(noteId: string) {
    const r = await deleteInboxNote(noteId);
    if (!r.ok) {
      toast.error(r.error ?? "Couldn't delete the note.");
      return;
    }
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
            {!canManage && c.assignedAdminId
              ? ` · ${assignee ? `Assigned to ${assignee.name}` : "Assigned"}`
              : ""}
          </p>
          {applied.length > 0 && (
            <span className="inbox-thread-labels" aria-label="Labels">
              {applied.map((l) => (
                <span key={l.id} className={`inbox-chip is-sm is-${l.color}`}>
                  {l.name}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="inbox-thread-actions">
          {canManage && workspace.assignees.length > 0 && (
            <select
              className="inbox-select is-sm inbox-assignee"
              value={c.assignedAdminId ?? ""}
              onChange={(e) => assign(e.target.value)}
              disabled={busy}
              aria-label="Assigned to"
            >
              <option value="">Unassigned</option>
              {workspace.assignees.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id === workspace.me.id ? "Me" : a.name}
                </option>
              ))}
              {c.assignedAdminId && !assignee && (
                <option value={c.assignedAdminId}>Somebody who left</option>
              )}
            </select>
          )}
          {canManage && (
            <button
              type="button"
              className="inbox-text-btn"
              onClick={() => setShowLabels((v) => !v)}
              aria-expanded={showLabels}
              aria-label="Labels"
            >
              <Tag className="h-3.5 w-3.5" />
              <span className="inbox-text-label">Label</span>
            </button>
          )}
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

      {showLabels && canManage && (
        <div className="inbox-labels-bar" role="group" aria-label="Labels">
          {workspace.labels.length === 0 ? (
            <span className="inbox-customer-hint">
              No labels yet. Add some with the Labels button above the inbox.
            </span>
          ) : (
            workspace.labels.map((l) => {
              const on = c.labelIds.includes(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  className={`inbox-chip is-${l.color} ${on ? "is-on" : "is-off"}`}
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => toggleLabel(l.id)}
                >
                  {l.name}
                </button>
              );
            })
          )}
        </div>
      )}

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
            <MessageList
              messages={thread.messages}
              contactName={name}
              canManage={canManage}
              onMediaLoad={onMediaLoad}
              onReply={canManage ? setReplyTo : null}
              onDeleteNote={canManage ? removeNote : null}
            />
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

      {thread.minkDraft && canManage && (
        <MinkDraftCard
          key={thread.minkDraft.id}
          conversationId={conversationId}
          draft={thread.minkDraft}
          windowOpen={thread.window.open}
          channelLive={channelLive}
          onChanged={onChanged}
        />
      )}

      <Composer
        key={conversationId}
        conversationId={conversationId}
        windowOpen={thread.window.open}
        closesAt={thread.window.closesAt}
        templates={templates}
        offersInForce={thread.customer.consent.marketing}
        cannedReplies={workspace.cannedReplies}
        contactName={c.contact.name}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        canManage={canManage}
        channelLive={channelLive}
        onSent={async () => {
          setReplyTo(null);
          await onChanged();
        }}
      />
    </div>
  );
}

/**
 * A reply Mink wrote and did not send: shown above the composer with what it
 * drew on, editable, with Send (one Mink credit) and Discard. It is NOT the
 * composer: a person writing their own reply leaves the draft where it is,
 * and sending their own reply discards it.
 */
function MinkDraftCard({
  conversationId,
  draft,
  windowOpen,
  channelLive,
  onChanged,
}: {
  conversationId: string;
  draft: InboxMinkDraft;
  windowOpen: boolean;
  channelLive: boolean;
  onChanged: () => Promise<void>;
}) {
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState(false);
  const canSend = windowOpen && channelLive && text.trim().length > 0;

  async function send() {
    if (busy || !canSend) return;
    setBusy(true);
    const r = await sendMinkDraft({ conversationId, draftId: draft.id, text });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? "Couldn't send the draft.");
      if (r.code === "gone" || r.messageId) await onChanged();
      return;
    }
    toast.success("Sent.");
    await onChanged();
  }

  async function discard() {
    if (busy) return;
    setBusy(true);
    const r = await discardMinkDraft({ conversationId, draftId: draft.id });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? "Couldn't discard the draft.");
      return;
    }
    await onChanged();
  }

  return (
    <section className="inbox-mink" aria-label="Mink AI suggestion">
      <div className="inbox-mink-head">
        <Sparkles className="h-3.5 w-3.5" />
        <span>
          {draft.mode === "helps"
            ? "Mink handed this one to you"
            : "Mink drafted a reply"}
        </span>
        {draft.reason && (
          <span className="inbox-mink-reason" title={draft.reason}>
            {draft.reason}
          </span>
        )}
      </div>
      {draft.facts.length > 0 && (
        <p className="inbox-mink-facts">Based on: {draft.facts.join(" · ")}</p>
      )}
      <textarea
        className="inbox-mink-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(6, Math.max(2, text.split("\n").length))}
        maxLength={INBOX_REPLY_MAX_CHARS}
        aria-label="Mink AI draft"
        disabled={busy}
      />
      <div className="inbox-mink-actions">
        <span className="inbox-mink-note">
          {!channelLive
            ? "Your WhatsApp number is paused, so this can't be sent."
            : !windowOpen
              ? "The 24-hour window has closed; only a template can be sent now."
              : draft.charged
                ? "Already paid for: sending uses no credit."
                : "Sending uses 1 Mink credit."}
        </span>
        <button
          type="button"
          className="inbox-text-btn"
          disabled={busy}
          onClick={discard}
        >
          Discard
        </button>
        <button
          type="button"
          className="inbox-send inbox-mink-send"
          disabled={busy || !canSend}
          onClick={send}
          aria-label="Send Mink's draft"
        >
          <Send className="h-4 w-4" /> Send
        </button>
      </div>
    </section>
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
  contactName,
  canManage,
  onMediaLoad,
  onReply,
  onDeleteNote,
}: {
  messages: InboxMessageRow[];
  contactName: string;
  canManage: boolean;
  onMediaLoad: () => void;
  onReply: ((m: InboxMessageRow) => void) | null;
  onDeleteNote: ((id: string) => void) | null;
}) {
  const days = useMemo(() => groupByDay(messages), [messages]);
  // Quoted replies name the message they answer by Meta's id.
  const byProvider = useMemo(() => {
    const map = new Map<string, InboxMessageRow>();
    for (const m of messages) {
      if (m.providerMessageId) map.set(m.providerMessageId, m);
    }
    return map;
  }, [messages]);
  return (
    <>
      {days.map((day) => (
        <section key={day.key} className="inbox-day" aria-label={day.label}>
          <span className="inbox-day-label">{day.label}</span>
          {day.messages.map((m, i) => {
            if (m.source === INBOX_NOTE_SOURCE) {
              return (
                <NoteBubble
                  key={m.id}
                  m={m}
                  onDelete={canManage && onDeleteNote ? onDeleteNote : null}
                />
              );
            }
            const prev = day.messages[i - 1];
            const continues =
              !!prev &&
              prev.source !== INBOX_NOTE_SOURCE &&
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
                quoted={
                  m.quotedProviderId
                    ? (byProvider.get(m.quotedProviderId) ?? null)
                    : null
                }
                contactName={contactName}
                continues={continues}
                showLabel={showLabel}
                onMediaLoad={onMediaLoad}
                onReply={m.providerMessageId && onReply ? onReply : null}
              />
            );
          })}
        </section>
      ))}
    </>
  );
}

/** A private note between the messages it was written between: a yellow
 *  card, never a bubble, so nobody mistakes it for something the customer
 *  received. */
function NoteBubble({
  m,
  onDelete,
}: {
  m: InboxMessageRow;
  onDelete: ((id: string) => void) | null;
}) {
  return (
    <div className="inbox-note-row" data-message-id={m.id}>
      <div className="inbox-note-card">
        <span className="inbox-note-head">
          <StickyNote className="h-3 w-3" />
          Note{m.sentBy ? ` · ${m.sentBy}` : ""}
          <time dateTime={m.sentAt} title={fullWhen(m.sentAt)}>
            {timeOnly(m.sentAt)}
          </time>
          {onDelete && (
            <button
              type="button"
              className="inbox-note-delete"
              onClick={() => {
                if (window.confirm("Delete this note?")) onDelete(m.id);
              }}
              aria-label="Delete note"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
        <p className="inbox-bubble-text">{m.body}</p>
      </div>
    </div>
  );
}

/** One line that says what a message was, for a quote strip or a reply-to
 *  bar: its text, or its kind when it had none. */
function messageGist(m: InboxMessageRow): string {
  if (m.body) return m.body.split(/\r?\n/)[0] ?? "";
  if (m.kind === "image") return "📷 Photo";
  // The list's preview (inbox-parse.ts previewOf) and the bubble say Sticker.
  if (m.kind === "sticker") return "Sticker";
  if (m.kind === "video") return "🎥 Video";
  if (m.kind === "audio") return "🎤 Voice message";
  if (m.kind === "document") return `📄 ${m.mediaName ?? "Document"}`;
  if (m.kind === "location") return "📍 Location";
  return "Message";
}

function Bubble({
  m,
  quoted,
  contactName,
  continues,
  showLabel,
  onMediaLoad,
  onReply,
}: {
  m: InboxMessageRow;
  /** The message this one replied to, when it is in the loaded thread. */
  quoted: InboxMessageRow | null;
  contactName: string;
  continues: boolean;
  showLabel: boolean;
  onMediaLoad: () => void;
  onReply: ((m: InboxMessageRow) => void) | null;
}) {
  const out = m.direction === "out";
  const intent =
    m.payload && typeof m.payload.intent === "string" ? m.payload.intent : null;
  // The store's menu, as it was sent: the buttons under the text.
  const buttons = out ? menuButtonsOf(m) : [];
  // A customer's tap on one of them: their words are the button's label.
  const tapped =
    !out && m.kind === "interactive" && m.payload?.replyType === "button";
  const inboundError = Boolean(m.error && !out);
  const outboundError = Boolean(out && m.status === "failed" && m.error);
  // ★ The time sits over the end of the last line only when the text IS the
  // last line; a flag, buttons or an error under it get the time on their
  // own row.
  const tailMeta =
    Boolean(m.body) &&
    !intent &&
    !tapped &&
    buttons.length === 0 &&
    !inboundError &&
    !outboundError;
  const hasMedia = Boolean(m.mediaUrl);
  return (
    <div
      className={`inbox-bubble-row ${out ? "is-out" : "is-in"} ${
        continues ? "is-cont" : ""
      }`}
      data-message-id={m.id}
    >
      <div
        className={`inbox-bubble ${m.status === "failed" ? "is-failed" : ""} ${
          tailMeta ? "has-tail-meta" : ""
        } ${hasMedia ? "has-media" : ""}`}
      >
        {showLabel && <SenderLabel m={m} />}
        {m.quotedProviderId && (
          <span className="inbox-quote">
            <span className="inbox-quote-who">
              {quoted
                ? quoted.direction === "out"
                  ? "You"
                  : contactName
                : "Earlier message"}
            </span>
            {quoted && (
              <span className="inbox-quote-text">{messageGist(quoted)}</span>
            )}
          </span>
        )}
        {onReply && (
          <button
            type="button"
            className="inbox-bubble-reply"
            onClick={() => onReply(m)}
            aria-label="Reply to this message"
            title="Reply"
          >
            <Reply className="h-3.5 w-3.5" />
          </button>
        )}
        <Media m={m} onLoad={onMediaLoad} />
        {m.body && (
          <p className="inbox-bubble-text">
            {m.body}
            {tailMeta && (
              <span className="inbox-bubble-spacer" aria-hidden="true" />
            )}
          </p>
        )}
        {buttons.length > 0 && (
          <span className="inbox-bubble-buttons" aria-label="Menu buttons">
            {buttons.map((b) => (
              <span key={b.id} className="inbox-bubble-button">
                {b.title}
              </span>
            ))}
          </span>
        )}
        {tapped && <span className="inbox-bubble-flag">Tapped a button</span>}
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

/** The reply buttons a sent menu carried, read back off the stored row. */
function menuButtonsOf(m: InboxMessageRow): { id: string; title: string }[] {
  if (m.kind !== "interactive" || !Array.isArray(m.payload?.buttons)) return [];
  const out: { id: string; title: string }[] = [];
  for (const b of m.payload.buttons as unknown[]) {
    if (!b || typeof b !== "object") continue;
    const { id, title } = b as { id?: unknown; title?: unknown };
    if (typeof id === "string" && typeof title === "string" && title) {
      out.push({ id, title });
    }
  }
  return out;
}

/** Who sent an outbound message, when it is worth saying; null for the
 *  customer's own messages and the shop's unnamed automation. */
function senderLabel(m: InboxMessageRow): string | null {
  if (m.direction !== "out") return null;
  if (m.source === "phone_app") return "From your phone";
  if (m.source === "template") {
    return m.sentBy ? `Template · ${m.sentBy}` : "Order update";
  }
  const mink = m.payload?.mink === true;
  if (m.source === "automation") return mink ? "Mink AI" : "Automatic reply";
  if (m.source === "dashboard" && m.sentBy) {
    return mink ? `${m.sentBy} · from a Mink draft` : m.sentBy;
  }
  return null;
}

function SenderLabel({ m }: { m: InboxMessageRow }) {
  const label = senderLabel(m);
  if (!label) return null;
  return (
    <span className="inbox-bubble-source">
      {m.source === "phone_app" && <Smartphone className="h-3 w-3" />}
      {m.source === "template" && <FileText className="h-3 w-3" />}
      {m.payload?.mink === true && <Sparkles className="h-3 w-3" />}
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
            photo through our own gated route (same origin, relative URL);
            next/image would resize what the route already serves and gains
            nothing in a chat thread. */}
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
  offersInForce,
  cannedReplies,
  contactName,
  replyTo,
  onClearReply,
  canManage,
  channelLive,
  onSent,
}: {
  conversationId: string;
  windowOpen: boolean;
  closesAt: string | null;
  templates: InboxReplyTemplate[];
  /** The customer's yes to offers is in force (`consented()`, on the
   *  server): a MARKETING template can go to them. */
  offersInForce: boolean;
  cannedReplies: InboxCannedReply[];
  contactName: string | null;
  /** The message the next reply quotes, or null. */
  replyTo: InboxMessageRow | null;
  onClearReply: () => void;
  canManage: boolean;
  channelLive: boolean;
  onSent: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [forceTemplate, setForceTemplate] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [values, setValues] = useState<string[]>([]);
  // "note": the box writes a private note rather than a message.
  const [mode, setMode] = useState<"message" | "note">("message");
  // A photo or PDF chosen for the next send; the box is then its caption.
  const [attachment, setAttachment] = useState<File | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [, tick] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // The saved-reply picker: open on "/", or on the bookmark button. "/" at
  // the start filters by shortcut or title; choosing one fills the box with
  // the customer's name in place.
  const slashQuery = text.startsWith("/")
    ? (text.slice(1).split(/\s/)[0]?.toLowerCase() ?? "")
    : null;
  const pickerVisible =
    cannedReplies.length > 0 && (pickerOpen || slashQuery !== null);
  const pickerItems = useMemo(() => {
    if (!pickerVisible) return [];
    const needle = slashQuery ?? "";
    return cannedReplies
      .filter(
        (r) =>
          !needle ||
          r.shortcut.startsWith(needle) ||
          r.title.toLowerCase().includes(needle),
      )
      .slice(0, 8);
  }, [cannedReplies, pickerVisible, slashQuery]);
  const pick = (r: InboxCannedReply) => {
    setText(fillCannedReply(r.body, { name: contactName }));
    setPickerOpen(false);
    box.current?.focus();
  };

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
  // ★ A MARKETING template this customer cannot get is shown, greyed out
  // with the reason, rather than offered as a Send that always fails. The
  // reason comes from the same rule the send action applies at the boundary.
  const blockedFor = (t: InboxReplyTemplate) =>
    templateBlockedReason(t.category, { inForce: offersInForce });
  const offersReason =
    templates.map(blockedFor).find((r): r is string => r !== null) ?? null;
  const templateBlocked = template ? blockedFor(template) : null;
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

  // The mode switch sits above whatever the composer shows: a note can be
  // written whether or not the number can send right now.
  const modeSwitch = (
    <div className="inbox-mode" role="tablist" aria-label="Write">
      <button
        type="button"
        role="tab"
        aria-selected={mode === "message"}
        className={`inbox-mode-tab ${mode === "message" ? "is-active" : ""}`}
        onClick={() => setMode("message")}
      >
        Message
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "note"}
        className={`inbox-mode-tab is-note ${mode === "note" ? "is-active" : ""}`}
        onClick={() => setMode("note")}
      >
        <StickyNote className="h-3.5 w-3.5" /> Note
      </button>
    </div>
  );

  if (mode === "note") {
    return (
      <NoteComposer
        key="note"
        conversationId={conversationId}
        modeSwitch={modeSwitch}
        onSaved={onSent}
      />
    );
  }

  if (!channelLive) {
    return (
      <div className="inbox-composer is-locked">
        {modeSwitch}
        <span className="inbox-locked-line">
          <Lock className="h-4 w-4" />
          Your WhatsApp number is paused or needs reconnecting. Resume it under
          Settings → Channels to reply.
        </span>
      </div>
    );
  }

  const useTemplate = !windowOpen || forceTemplate;
  const remaining = closesAt ? countdown(closesAt) : null;

  async function sendFile(file: File): Promise<InboxSendResult> {
    const form = new FormData();
    form.set("conversationId", conversationId);
    form.set("file", file, file.name);
    form.set("caption", text);
    if (replyTo) form.set("replyTo", replyTo.id);
    try {
      const res = await fetch("/api/dashboard/inbox/media", {
        method: "POST",
        body: form,
      });
      const body = (await res
        .json()
        .catch(() => null)) as InboxSendResult | null;
      if (body && typeof body.ok === "boolean") return body;
      return { ok: false, error: `Couldn't send the file (${res.status}).` };
    } catch {
      return {
        ok: false,
        error: "Couldn't send the file. Check your connection.",
      };
    }
  }

  async function send() {
    if (sending) return;
    setSending(true);
    const r = useTemplate
      ? await sendInboxTemplate({ conversationId, templateId, values })
      : attachment
        ? await sendFile(attachment)
        : await sendInboxReply({
            conversationId,
            text,
            replyToMessageId: replyTo?.id ?? null,
          });
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
    setAttachment(null);
    await onSent();
  }

  const chooseFile = (file: File | null) => {
    setAttachment(file);
    if (file) setForceTemplate(false);
  };

  return (
    <div className="inbox-composer">
      {modeSwitch}
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
                {templates.map((t) => {
                  const blocked = blockedFor(t) !== null;
                  return (
                    <option key={t.id} value={t.id} disabled={blocked}>
                      {blocked
                        ? `${t.name} (marketing: not available)`
                        : t.name}
                    </option>
                  );
                })}
              </select>
              {offersReason && (
                <p className="inbox-customer-hint">{offersReason}</p>
              )}
              {template && (
                <>
                  {template.headerText ? (
                    <p className="inbox-template-body inbox-template-header">
                      {template.headerText}
                    </p>
                  ) : null}
                  <p className="inbox-template-body">{template.body}</p>
                  {template.footerText ? (
                    <p className="inbox-template-body inbox-template-footer">
                      {template.footerText}
                    </p>
                  ) : null}
                  {template.buttons && template.buttons.length > 0 ? (
                    <span className="inbox-bubble-buttons" aria-label="Buttons">
                      {template.buttons.map((b) => (
                        <span key={b.text} className="inbox-bubble-button">
                          {b.text}
                        </span>
                      ))}
                    </span>
                  ) : null}
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
                    sending ||
                    !template ||
                    templateBlocked !== null ||
                    values.some((v) => !v.trim())
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
        <>
          {replyTo && (
            <div className="inbox-replyto">
              <Reply className="h-3.5 w-3.5" />
              <span className="inbox-replyto-text">
                <span className="inbox-quote-who">
                  Replying to{" "}
                  {replyTo.direction === "out"
                    ? "you"
                    : (contactName ?? "the customer")}
                </span>
                {messageGist(replyTo)}
              </span>
              <button
                type="button"
                className="inbox-icon-btn is-sm"
                onClick={onClearReply}
                aria-label="Don't quote this message"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {attachment && (
            <div className="inbox-attachment">
              <Paperclip className="h-3.5 w-3.5" />
              <span className="inbox-attachment-name">
                {attachment.name}
                <span className="inbox-attachment-size">
                  {" "}
                  · {fileSize(attachment.size)}
                </span>
              </span>
              <button
                type="button"
                className="inbox-icon-btn is-sm"
                onClick={() => chooseFile(null)}
                aria-label="Remove the file"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {pickerVisible && (
            <ul
              className="inbox-canned"
              role="listbox"
              aria-label="Saved replies"
            >
              {pickerItems.length === 0 ? (
                <li className="inbox-canned-empty">No saved reply matches.</li>
              ) : (
                pickerItems.map((r) => (
                  <li key={r.id} role="option" aria-selected={false}>
                    <button type="button" onClick={() => pick(r)}>
                      <code>/{r.shortcut}</code>
                      <span className="inbox-canned-title">{r.title}</span>
                      <span className="inbox-canned-body">{r.body}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
          <div className="inbox-compose-row">
            <input
              ref={fileInput}
              type="file"
              accept={INBOX_MEDIA_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                chooseFile(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="inbox-icon-btn inbox-attach"
              onClick={() => fileInput.current?.click()}
              disabled={sending}
              aria-label="Attach a photo or PDF"
              title="Photo or PDF"
            >
              <Paperclip className="h-5 w-5" />
            </button>
            {cannedReplies.length > 0 && (
              <button
                type="button"
                className="inbox-icon-btn inbox-attach"
                onClick={() => setPickerOpen((v) => !v)}
                disabled={sending}
                aria-label="Saved replies"
                aria-expanded={pickerVisible}
                title="Saved replies (or type /)"
              >
                <Bookmark className="h-5 w-5" />
              </button>
            )}
            <textarea
              ref={box}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Mid-word in an input method: every key, Enter and Escape
                // included, belongs to the IME, never to the picker or Send.
                if (isComposing(e)) return;
                if (e.key === "Escape" && pickerVisible) {
                  setPickerOpen(false);
                  if (slashQuery !== null) setText("");
                  return;
                }
                // Enter with the picker open takes the first saved reply.
                if (e.key === "Enter" && !e.shiftKey && pickerVisible) {
                  e.preventDefault();
                  const first = pickerItems[0];
                  if (first) pick(first);
                  return;
                }
                // Enter sends on a keyboard; on a phone it is a new line and
                // the button sends, as in WhatsApp.
                if (e.key === "Enter" && !e.shiftKey && !isTouchPrimary()) {
                  e.preventDefault();
                  if (text.trim() || attachment) void send();
                }
              }}
              placeholder={
                attachment ? "Add a caption (optional)" : "Type a message"
              }
              title="Enter to send, Shift+Enter for a new line"
              rows={1}
              maxLength={attachment ? INBOX_CAPTION_MAX : INBOX_REPLY_MAX_CHARS}
              aria-label="Reply"
            />
            <button
              type="button"
              className="inbox-send"
              disabled={sending || (!text.trim() && !attachment)}
              onClick={send}
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The composer in note mode: a yellow box whose text goes to the thread as
 *  a private note and never to the customer. */
function NoteComposer({
  conversationId,
  modeSwitch,
  onSaved,
}: {
  conversationId: string;
  modeSwitch: ReactNode;
  onSaved: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy || !text.trim()) return;
    setBusy(true);
    const r = await addInboxNote({ conversationId, body: text });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? "Couldn't save the note.");
      return;
    }
    setText("");
    await onSaved();
  }

  return (
    <div className="inbox-composer is-note">
      {modeSwitch}
      <div className="inbox-window">
        <span>
          Only your team sees a note. The customer is not sent anything.
        </span>
      </div>
      <div className="inbox-compose-row">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isComposing(e)) return;
            if (e.key === "Enter" && !e.shiftKey && !isTouchPrimary()) {
              e.preventDefault();
              void save();
            }
          }}
          placeholder="Write a private note"
          rows={2}
          maxLength={INBOX_NOTE_MAX}
          aria-label="Note"
          disabled={busy}
        />
        <button
          type="button"
          className="inbox-send is-note"
          disabled={busy || !text.trim()}
          onClick={save}
          aria-label="Add note"
        >
          <StickyNote className="h-4 w-4" /> Add
        </button>
      </div>
    </div>
  );
}

/**
 * ★ AN INPUT METHOD IS MID-WORD. Typing Hindi in transliteration, Japanese or
 * Chinese, Enter CONFIRMS the candidate; read as Send it sent half-typed text
 * to the customer. `isComposing` is the standard signal; Safari reports the
 * confirming keydown with keyCode 229 instead, after composition has ended.
 */
function isComposing(e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
