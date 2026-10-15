// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
// The polls are the route's concern; here they would only race the assertions.
vi.mock("@/lib/pos/use-poll", () => ({ usePoll: () => undefined }));
vi.mock("@/app/actions/inbox-actions", () => ({
  getInboxThread: vi.fn(),
  markInboxRead: vi.fn(async () => ({ ok: true })),
  sendInboxReply: vi.fn(async () => ({ ok: true, messageId: "m" })),
  sendInboxTemplate: vi.fn(async () => ({ ok: true, messageId: "m" })),
  sendMinkDraft: vi.fn(async () => ({ ok: true, messageId: "m" })),
  discardMinkDraft: vi.fn(async () => ({ ok: true })),
  setInboxConversationStatus: vi.fn(async () => ({ ok: true })),
  assignInboxConversation: vi.fn(async (input: { adminId: string | null }) => ({
    ok: true,
    assignedAdminId: input.adminId,
  })),
  setInboxConversationLabels: vi.fn(async (input: { labelIds: string[] }) => ({
    ok: true,
    labelIds: input.labelIds,
  })),
  addInboxNote: vi.fn(async () => ({ ok: true, id: "n9" })),
  deleteInboxNote: vi.fn(async () => ({ ok: true })),
  getInboxWorkspace: vi.fn(),
}));
// The managers are their own component; here they would only add dialogs.
vi.mock("./inbox-manage", () => ({ InboxManageButtons: () => null }));

import { InboxClient } from "./inbox-client";
import {
  addInboxNote,
  assignInboxConversation,
  discardMinkDraft,
  getInboxThread,
  sendInboxReply,
  sendMinkDraft,
  setInboxConversationLabels,
} from "@/app/actions/inbox-actions";
import type {
  InboxListResult,
  InboxMessageRow,
  InboxThread,
  InboxWorkspace,
} from "@/lib/whatsapp/inbox-types";

const WS: InboxWorkspace = {
  me: { id: "admin-1", name: "Priya" },
  assignees: [
    { id: "admin-1", name: "Priya" },
    { id: "admin-2", name: "Arjun Mehta" },
  ],
  labels: [
    { id: "l1", name: "VIP", color: "purple" },
    { id: "l2", name: "Wholesale", color: "blue" },
  ],
  cannedReplies: [
    {
      id: "r1",
      shortcut: "hours",
      title: "Opening hours",
      body: "Hi {{name}}, 10 to 7.",
    },
    { id: "r2", shortcut: "ship", title: "Shipping", body: "Ships in 2 days." },
  ],
};

const CONV = "22222222-2222-4222-8222-222222222222";

const row = (over: Record<string, unknown> = {}) => ({
  id: CONV,
  status: "needs_reply" as const,
  unreadCount: 2,
  lastMessageAt: new Date().toISOString(),
  lastInboundAt: new Date().toISOString(),
  lastPreview: "Is it in stock?",
  contact: {
    id: "k1",
    phone: "+919876543210",
    phoneLabel: "+91 98765 43210",
    name: "Rohan",
    userId: null,
  },
  windowOpen: true,
  assignedAdminId: null,
  labelIds: [],
  ...over,
});

const list = (rows = [row()]): InboxListResult => ({
  rows,
  total: rows.length,
  counts: { needs_reply: 1, open: 0, closed: 0, all: 1 },
});

const thread = (over: Partial<InboxThread> = {}): InboxThread => ({
  conversation: row() as any,
  messages: [
    {
      id: "m1",
      direction: "in",
      source: "customer",
      kind: "text",
      body: "Is it in stock?",
      mediaUrl: null,
      mediaMime: null,
      mediaName: null,
      payload: null,
      status: "received",
      error: null,
      sentAt: new Date().toISOString(),
      sentBy: null,
      providerMessageId: "wamid.in1",
      quotedProviderId: null,
    },
  ],
  window: {
    open: true,
    closesAt: new Date(Date.now() + 3600_000).toISOString(),
  },
  customer: {
    consent: { updates: true, marketing: false },
    orders: [],
    credit: null,
  },
  minkDraft: null,
  ...over,
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => list() })),
  );
  vi.mocked(getInboxThread).mockResolvedValue({ thread: thread() });
});

describe("InboxClient", () => {
  it("lists conversations with the unread count, and asks you to choose one", () => {
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={null}
      />,
    );
    expect(screen.getByText("Rohan")).toBeInTheDocument();
    expect(screen.getByText("Is it in stock?")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Choose a conversation")).toBeInTheDocument();
  });

  it("opening a conversation loads the thread, marks it read and offers a reply inside the window", async () => {
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Rohan/ }));
    await waitFor(() => expect(getInboxThread).toHaveBeenCalledWith(CONV));
    expect(await screen.findByLabelText("Reply")).toBeInTheDocument();
    expect(screen.getByText(/You can reply freely for/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Yes, in stock" },
    });
    fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Enter" });
    await waitFor(() =>
      expect(sendInboxReply).toHaveBeenCalledWith({
        conversationId: CONV,
        text: "Yes, in stock",
        replyToMessageId: null,
      }),
    );
  });

  it("★ outside the window the composer offers templates, not a text box", async () => {
    vi.mocked(getInboxThread).mockResolvedValue({
      thread: thread({ window: { open: false, closesAt: null } }),
    });
    render(
      <InboxClient
        initial={list([row({ windowOpen: false })])}
        templates={[
          {
            id: "t1",
            name: "sm_order_ready_customer_v1",
            language: "en",
            body: "Hi {{1}}",
            variables: ["customer_name"],
          },
        ]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={CONV}
      />,
    );
    expect(
      await screen.findByText(/only an approved template/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Template")).toBeInTheDocument();
  });

  it("a viewer without manage reads but cannot reply", async () => {
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage={false}
        channelLive
        initialConversationId={CONV}
      />,
    );
    expect(
      await screen.findByText(/read this conversation but not reply/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
  });

  it("groups messages under day labels and draws a run as one block", async () => {
    // Pinned to India's calendar days, which is what the labels follow, so
    // the test reads the same whatever time it runs.
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
    });
    const at = (dayOffset: number, hhmm: string) =>
      new Date(
        new Date(`${today}T${hhmm}:00+05:30`).getTime() +
          dayOffset * 86_400_000,
      ).toISOString();
    const base = thread().messages[0];
    vi.mocked(getInboxThread).mockResolvedValue({
      thread: thread({
        messages: [
          { ...base, id: "a", body: "Old question", sentAt: at(-1, "12:00") },
          { ...base, id: "b", body: "First today", sentAt: at(0, "00:01") },
          {
            ...base,
            id: "c",
            body: "Second, a minute later",
            sentAt: at(0, "00:02"),
          },
          {
            ...base,
            id: "d",
            direction: "out",
            source: "automation",
            status: "sent",
            body: "Order ORD1 is confirmed.",
            sentAt: at(0, "00:03"),
          },
        ],
      }),
    });
    const { container } = render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={CONV}
      />,
    );
    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    const rows = container.querySelectorAll(".inbox-bubble-row");
    // The second of two messages a minute apart continues the run; the first
    // of each day, and a change of side, start a new one.
    expect(
      Array.from(rows).map((r) => r.classList.contains("is-cont")),
    ).toEqual([false, false, true, false]);
    // An automatic answer says so, so staff can tell it was not a person.
    expect(screen.getByText("Automatic reply")).toBeInTheDocument();
  });

  it("★ on a touch screen Enter is a new line and the button sends", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.mocked(sendInboxReply).mockClear();
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={CONV}
      />,
    );
    const box = await screen.findByLabelText("Reply");
    fireEvent.change(box, { target: { value: "Line one" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(sendInboxReply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendInboxReply).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });

  it("tells the card a chat is open, so a narrow card shows one pane", async () => {
    const { container } = render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={null}
      />,
    );
    const shell = container.querySelector(".inbox-shell")!;
    expect(shell.classList.contains("has-thread")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Rohan/ }));
    expect(shell.classList.contains("has-thread")).toBe(true);
    // The back arrow returns to the list.
    fireEvent.click(
      await screen.findByRole("button", { name: "Back to conversations" }),
    );
    expect(shell.classList.contains("has-thread")).toBe(false);
  });

  it("a paused number says so instead of offering a box that always fails", async () => {
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive={false}
        initialConversationId={CONV}
      />,
    );
    expect(
      await screen.findByText(/paused or needs reconnecting/),
    ).toBeInTheDocument();
  });
});

describe("InboxClient: Mink's draft", () => {
  const DRAFT = "44444444-4444-4444-8444-444444444444";
  const draft = (over: Record<string, unknown> = {}) => ({
    id: DRAFT,
    text: "Yes, the Almond Shake is ₹120 and in stock.",
    reason: "price in facts",
    facts: ["Almond Shake", "Refund Policy"],
    mode: "drafts" as const,
    charged: false,
    createdAt: new Date().toISOString(),
    ...over,
  });

  it("★ shows the draft above the composer with what it drew on, editable, and sends it as edited", async () => {
    vi.mocked(getInboxThread).mockResolvedValue({
      thread: thread({ minkDraft: draft() }),
    });
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={CONV}
      />,
    );
    const box = await screen.findByLabelText("Mink AI draft");
    expect(screen.getByText("Mink drafted a reply")).toBeInTheDocument();
    expect(
      screen.getByText(/Based on: Almond Shake · Refund Policy/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Sending uses 1 Mink credit/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "Yes, ₹120, in stock today." } });
    fireEvent.click(screen.getByRole("button", { name: "Send Mink's draft" }));
    await waitFor(() =>
      expect(sendMinkDraft).toHaveBeenCalledWith({
        conversationId: CONV,
        draftId: DRAFT,
        text: "Yes, ₹120, in stock today.",
      }),
    );
    // The composer is still its own, empty box.
    expect(screen.getByLabelText("Reply")).toHaveValue("");
  });

  it("a hand-over reads as one, a charged draft says sending is free, and Discard discards", async () => {
    vi.mocked(getInboxThread).mockResolvedValue({
      thread: thread({ minkDraft: draft({ mode: "helps", charged: true }) }),
    });
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={CONV}
      />,
    );
    expect(
      await screen.findByText("Mink handed this one to you"),
    ).toBeInTheDocument();
    expect(screen.getByText(/sending uses no credit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(discardMinkDraft).toHaveBeenCalledWith({
        conversationId: CONV,
        draftId: DRAFT,
      }),
    );
  });

  it("★ a viewer never sees the draft, and a closed window cannot send it", async () => {
    vi.mocked(getInboxThread).mockResolvedValue({
      thread: thread({ minkDraft: draft() }),
    });
    const { unmount } = render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage={false}
        channelLive
        initialConversationId={CONV}
      />,
    );
    await screen.findByText("Is it in stock?");
    expect(screen.queryByLabelText("Mink AI draft")).toBeNull();
    unmount();

    vi.mocked(getInboxThread).mockResolvedValue({
      thread: thread({
        minkDraft: draft(),
        window: { open: false, closesAt: null },
      }),
    });
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={CONV}
      />,
    );
    await screen.findByLabelText("Mink AI draft");
    expect(
      screen.getByRole("button", { name: "Send Mink's draft" }),
    ).toBeDisabled();
    expect(screen.getByText(/24-hour window has closed/)).toBeInTheDocument();
  });

  it("labels Mink's own answer, and a person's send of a draft, in the thread", async () => {
    vi.mocked(getInboxThread).mockResolvedValue({
      thread: thread({
        messages: [
          ...thread().messages,
          {
            id: "m2",
            direction: "out",
            source: "automation",
            kind: "text",
            body: "Yes, in stock.",
            mediaUrl: null,
            mediaMime: null,
            mediaName: null,
            payload: { mink: true, answerId: DRAFT },
            status: "sent",
            error: null,
            sentAt: new Date().toISOString(),
            sentBy: null,
            providerMessageId: null,
            quotedProviderId: null,
          },
          {
            id: "m3",
            direction: "out",
            source: "dashboard",
            kind: "text",
            body: "And ₹120.",
            mediaUrl: null,
            mediaMime: null,
            mediaName: null,
            payload: { mink: true, answerId: DRAFT },
            status: "sent",
            error: null,
            sentAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            sentBy: "Priya",
            providerMessageId: null,
            quotedProviderId: null,
          },
        ],
      }),
    });
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={CONV}
      />,
    );
    expect(await screen.findByText("Mink AI")).toBeInTheDocument();
    expect(screen.getByText("Priya · from a Mink draft")).toBeInTheDocument();
  });
});

describe("InboxClient: working as a team (slice 6)", () => {
  const out = (over: Partial<InboxMessageRow>): InboxMessageRow => ({
    id: "o1",
    direction: "out",
    source: "dashboard",
    kind: "text",
    body: "Yes, in stock",
    mediaUrl: null,
    mediaMime: null,
    mediaName: null,
    payload: null,
    status: "sent",
    error: null,
    sentAt: new Date(Date.now() + 60_000).toISOString(),
    sentBy: "Priya",
    providerMessageId: "wamid.out1",
    quotedProviderId: null,
    ...over,
  });

  it("the assignee and label filters go to the list route", async () => {
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={null}
      />,
    );
    fireEvent.change(screen.getByLabelText("Assigned to"), {
      target: { value: "me" },
    });
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some((c) => String(c[0]).includes("assignee=me")),
      ).toBe(true),
    );
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "l2" },
    });
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some((c) => String(c[0]).includes("label=l2")),
      ).toBe(true),
    );
  });

  it("a row shows its labels, its assignee and a search hit's line", () => {
    render(
      <InboxClient
        initial={list([
          row({
            labelIds: ["l1"],
            assignedAdminId: "admin-2",
            match: { messageId: "m1", snippet: "is it in «stock»?" },
          }),
        ])}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={null}
      />,
    );
    expect(screen.getByLabelText("VIP")).toBeInTheDocument();
    expect(screen.getByTitle("Assigned to Arjun Mehta")).toHaveTextContent(
      "AM",
    );
    expect(screen.getByText("stock").tagName).toBe("MARK");
  });

  it("★ assigning and labelling from the thread call the actions and update the row", async () => {
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={CONV}
      />,
    );
    await screen.findByLabelText("Reply");
    // The thread's assignee select (the list's filter has the same label).
    const selects = screen.getAllByLabelText("Assigned to");
    const threadSelect = selects[selects.length - 1]!;
    fireEvent.change(threadSelect, { target: { value: "admin-2" } });
    await waitFor(() =>
      expect(assignInboxConversation).toHaveBeenCalledWith({
        conversationId: CONV,
        adminId: "admin-2",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Labels" }));
    fireEvent.click(screen.getByRole("button", { name: "Wholesale" }));
    await waitFor(() =>
      expect(setInboxConversationLabels).toHaveBeenCalledWith({
        conversationId: CONV,
        labelIds: ["l2"],
      }),
    );
  });

  it("★ a note reads as a note, and the Note tab writes one without sending", async () => {
    vi.mocked(getInboxThread).mockResolvedValue({
      thread: thread({
        messages: [
          ...thread().messages,
          out({
            id: "n1",
            source: "note",
            kind: "note",
            body: "Regular, wants bulk pricing",
            status: "note",
            providerMessageId: null,
          }),
        ],
      }),
    });
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={CONV}
      />,
    );
    expect(
      await screen.findByText("Regular, wants bulk pricing"),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Note · Priya/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Note/ }));
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "Call back Monday" },
    });
    fireEvent.keyDown(screen.getByLabelText("Note"), { key: "Enter" });
    await waitFor(() =>
      expect(addInboxNote).toHaveBeenCalledWith({
        conversationId: CONV,
        body: "Call back Monday",
      }),
    );
    expect(sendInboxReply).not.toHaveBeenCalled();
  });

  it("★ a reply can quote a message, and a quote is drawn with who said it", async () => {
    vi.mocked(getInboxThread).mockResolvedValue({
      thread: thread({
        messages: [
          ...thread().messages,
          out({ quotedProviderId: "wamid.in1" }),
        ],
      }),
    });
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={CONV}
      />,
    );
    await screen.findByLabelText("Reply");
    // The sent reply quotes the customer's message: their name and its text.
    expect(
      screen.getByText("Rohan", { selector: ".inbox-quote-who" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Reply to this message" })[0]!,
    );
    expect(screen.getByText(/Replying to Rohan/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Yes" },
    });
    fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Enter" });
    await waitFor(() =>
      expect(sendInboxReply).toHaveBeenCalledWith({
        conversationId: CONV,
        text: "Yes",
        replyToMessageId: "m1",
      }),
    );
  });

  it("★ '/' opens the saved replies, Enter takes the first, with the customer's name filled in", async () => {
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={CONV}
      />,
    );
    const box = await screen.findByLabelText("Reply");
    fireEvent.change(box, { target: { value: "/ho" } });
    expect(
      screen.getByRole("listbox", { name: "Saved replies" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Shipping")).not.toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Enter" });
    expect((box as HTMLTextAreaElement).value).toBe("Hi Rohan, 10 to 7.");
    expect(sendInboxReply).not.toHaveBeenCalled();
  });

  it("★ a chosen file goes to the media route with the caption, never through the text action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/inbox/media")
          ? {
              ok: true,
              status: 200,
              json: async () => ({ ok: true, messageId: "m" }),
            }
          : { ok: true, json: async () => list() },
      ),
    );
    render(
      <InboxClient
        initial={list()}
        templates={[]}
        workspace={WS}
        canManage
        channelLive
        initialConversationId={CONV}
      />,
    );
    await screen.findByLabelText("Reply");
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([new Uint8Array([1, 2, 3])], "size-chart.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText("size-chart.pdf")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Here you go" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find((c) => String(c[0]).includes("/inbox/media"));
      expect(call).toBeTruthy();
      const body = (call![1] as RequestInit).body as FormData;
      expect(body.get("conversationId")).toBe(CONV);
      expect(body.get("caption")).toBe("Here you go");
      expect((body.get("file") as File).name).toBe("size-chart.pdf");
    });
    expect(sendInboxReply).not.toHaveBeenCalled();
  });

  it("a viewer sees labels and the assignee but no controls", async () => {
    render(
      <InboxClient
        initial={list([row({ labelIds: ["l1"], assignedAdminId: "admin-2" })])}
        templates={[]}
        workspace={WS}
        canManage={false}
        channelLive
        initialConversationId={null}
      />,
    );
    vi.mocked(getInboxThread).mockResolvedValue({
      thread: thread({
        conversation: row({
          labelIds: ["l1"],
          assignedAdminId: "admin-2",
        }) as any,
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: /Rohan/ }));
    expect(
      await screen.findByText(/Assigned to Arjun Mehta/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Labels" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Note/ })).not.toBeInTheDocument();
  });
});
