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
  setInboxConversationStatus: vi.fn(async () => ({ ok: true })),
}));

import { InboxClient } from "./inbox-client";
import { getInboxThread, sendInboxReply } from "@/app/actions/inbox-actions";
import type { InboxListResult, InboxThread } from "@/lib/whatsapp/inbox-types";

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

  it("a paused number says so instead of offering a box that always fails", async () => {
    render(
      <InboxClient
        initial={list()}
        templates={[]}
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
