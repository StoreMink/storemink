// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import {
  ChatProvider,
  useChat,
  useMinkDock,
  useMinkVoice,
  type MinkVoiceComposer,
} from "./chat-context";
import type { MinkVoiceModeInput } from "./mink-voice-mode";
import { MinkPageSuggestion } from "./mink-page-suggestion";
import { takeMinkOpener } from "./mink-opener";

// The dashboard address (`?chat=<id>`, B20). Empty unless a test sets it,
// so the provider behaves as it does on any other dashboard page.
const address = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useSearchParams: () => new URLSearchParams(address.search),
  };
});

// The loop itself is tested on its own; here it only reveals the `send` the
// provider hands it, which is the glue under test.
const loop = vi.hoisted(() => ({
  input: null as MinkVoiceModeInput | null,
}));
vi.mock("./mink-voice-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mink-voice-mode")>();
  return {
    ...actual,
    useMinkVoiceMode: (input: MinkVoiceModeInput) => {
      loop.input = input;
      return actual.useMinkVoiceMode(input);
    },
  };
});

function streamBody() {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'event: message\ndata: {"role":"assistant","text":"Done.","artifacts":[]}\n\n' +
            "event: done\ndata: {}\n\n",
        ),
      );
      controller.close();
    },
  });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url === "/api/mink/conversations")
    return Response.json({ conversations: [] });
  if (url === "/api/mink/stream")
    return new Response(streamBody(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  return new Response(null, { status: 404 });
});

function Composer({ composer }: { composer: MinkVoiceComposer }) {
  const { registerComposer } = useMinkVoice();
  useEffect(() => registerComposer(composer), [registerComposer, composer]);
  return null;
}

beforeEach(() => {
  loop.input = null;
  address.search = "";
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const streamRequests = () =>
  (fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>)
    .filter(([input]) => String(input) === "/api/mink/stream")
    .map(([, init]) => JSON.parse(String(init?.body)));

describe("★★ ChatProvider routes a spoken turn through the composer", () => {
  it("lets the composer carry the turn when it has something staged", async () => {
    const composer = vi.fn<MinkVoiceComposer>(async (transcript, deliver) =>
      deliver(`Draft ${transcript}`),
    );
    render(
      <ChatProvider minkEnabled>
        <Composer composer={composer} />
      </ChatProvider>,
    );
    await waitFor(() => expect(loop.input).not.toBeNull());
    let taken: boolean | Promise<boolean> | undefined;
    await act(async () => {
      taken = await loop.input?.send("and more", { voice: true });
    });
    expect(taken).toBe(true);
    expect(composer).toHaveBeenCalledWith("and more", expect.any(Function));
    await waitFor(() => expect(streamRequests()).toHaveLength(1));
    expect(streamRequests()[0].message).toBe("Draft and more");
    expect(streamRequests()[0].context.voice).toBe(true);
  });

  it("sends the transcript itself when the composer has nothing staged, or none is mounted", async () => {
    const composer = vi.fn<MinkVoiceComposer>(() => null);
    const view = render(
      <ChatProvider minkEnabled>
        <Composer composer={composer} />
      </ChatProvider>,
    );
    await waitFor(() => expect(loop.input).not.toBeNull());
    let taken: boolean | Promise<boolean> | undefined;
    act(() => {
      taken = loop.input?.send("Sales?", { voice: true });
    });
    expect(taken).toBe(true);
    await waitFor(() => expect(streamRequests()).toHaveLength(1));
    expect(streamRequests()[0].message).toBe("Sales?");
    view.unmount();

    // With no composer at all.
    render(<ChatProvider minkEnabled>{null}</ChatProvider>);
    await waitFor(() => expect(loop.input).not.toBeNull());
    await waitFor(() => expect(loop.input?.isReplying).toBe(false));
    act(() => {
      taken = loop.input?.send("Orders?", { voice: true });
    });
    expect(taken).toBe(true);
    await waitFor(() => expect(streamRequests()).toHaveLength(2));
    expect(streamRequests()[1].message).toBe("Orders?");
  });
});

describe("★★ ChatProvider: which chat a question goes into", () => {
  const CHAT_ID = "11111111-1111-4111-8111-111111111111";
  const chat = { current: null as ReturnType<typeof useChat> | null };
  function Probe() {
    const value = useChat();
    useEffect(() => {
      chat.current = value;
    });
    return null;
  }

  /** History holds one chat; the answer can be held back to keep Mink busy. */
  function stub(options: { holdAnswer?: boolean } = {}) {
    const requests: Array<{ message: string; conversationId?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/mink/conversations")
          return Response.json({
            conversations: [
              {
                id: CHAT_ID,
                title: "Last week's stock",
                lastMessageAt: "2026-10-12T10:00:00.000Z",
                createdAt: "2026-10-12T09:59:00.000Z",
              },
            ],
          });
        if (url === `/api/mink/conversations/${CHAT_ID}`)
          return Response.json({
            conversation: {
              id: CHAT_ID,
              title: "Last week's stock",
              messages: [
                { id: "old-1", role: "user", text: "Stock?" },
                { id: "old-2", role: "assistant", text: "All good." },
              ],
            },
          });
        if (url === "/api/mink/stream") {
          requests.push(JSON.parse(String(init?.body)));
          if (options.holdAnswer)
            return new Promise<Response>(() => {
              // Mink is still answering.
            });
          return new Response(streamBody(), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (url === "/api/mink/credits")
          return new Response(null, { status: 404 });
        return new Response(null, { status: 404 });
      }),
    );
    return requests;
  }

  function rememberChat(minutesAgo: number) {
    window.sessionStorage.setItem(
      "storemink:mink-active-chat",
      JSON.stringify({
        id: CHAT_ID,
        lastActivityAt: Date.now() - minutesAgo * 60_000,
      }),
    );
  }

  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    chat.current = null;
  });

  it("a question from Home starts a new chat, not one more turn of the last", async () => {
    rememberChat(5);
    const requests = stub();
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() =>
      expect(chat.current?.activeConversationId).toBe(CHAT_ID),
    );

    act(() => chat.current?.startExpandedChat("How were sales today?"));

    await waitFor(() => expect(chat.current?.isReplying).toBe(false));
    expect(chat.current?.isChatOpen).toBe(true);
    expect(chat.current?.isExpanded).toBe(true);
    expect(chat.current?.messages.map((message) => message.text)).toEqual([
      "How were sales today?",
      "Done.",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.message).toBe("How were sales today?");
    expect(requests[0]?.conversationId).toBeUndefined();
  });

  it("while Mink is still answering, the question waits in the box instead", async () => {
    const requests = stub({ holdAnswer: true });
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(chat.current?.conversations).toHaveLength(1));
    act(() => chat.current?.send("Stock?"));
    await waitFor(() => expect(chat.current?.isReplying).toBe(true));

    act(() => chat.current?.startExpandedChat("How were sales today?"));

    expect(chat.current?.input).toBe("How were sales today?");
    expect(chat.current?.isReplying).toBe(true);
    expect(chat.current?.messages.map((message) => message.text)).toEqual([
      "Stock?",
    ]);
    expect(requests).toHaveLength(1);
  });

  it("opening Mink continues a recent chat and starts a new one after hours away", async () => {
    rememberChat(5);
    stub();
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() =>
      expect(chat.current?.activeConversationId).toBe(CHAT_ID),
    );

    act(() => chat.current?.toggleChat());
    expect(chat.current?.isChatOpen).toBe(true);
    expect(chat.current?.activeConversationId).toBe(CHAT_ID);
    act(() => chat.current?.toggleChat());
    expect(chat.current?.isChatOpen).toBe(false);

    const later = Date.now() + 3 * 60 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    act(() => chat.current?.toggleChat());

    expect(chat.current?.isChatOpen).toBe(true);
    expect(chat.current?.activeConversationId).toBeNull();
    expect(chat.current?.messages).toEqual([]);
    expect(chat.current?.conversations).toHaveLength(1);
  });

  it("the top-bar bar asks in the side panel, in a new chat, never the full view", async () => {
    rememberChat(5);
    const requests = stub();
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() =>
      expect(chat.current?.activeConversationId).toBe(CHAT_ID),
    );
    const before = chat.current?.focusComposerOnOpen ?? 0;

    act(() => chat.current?.startChat("  Which orders are waiting?  "));

    await waitFor(() => expect(chat.current?.isReplying).toBe(false));
    expect(chat.current?.isChatOpen).toBe(true);
    expect(chat.current?.isExpanded).toBe(false);
    expect(chat.current?.focusComposerOnOpen).toBe(before + 1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.message).toBe("Which orders are waiting?");
    expect(requests[0]?.conversationId).toBeUndefined();
  });

  it("while Mink is still answering, the bar's question waits in the box", async () => {
    const requests = stub({ holdAnswer: true });
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(chat.current?.conversations).toHaveLength(1));
    act(() => chat.current?.send("Stock?"));
    await waitFor(() => expect(chat.current?.isReplying).toBe(true));

    const before = chat.current?.focusComposerOnOpen ?? 0;
    act(() => chat.current?.startChat("How were sales today?"));

    expect(chat.current?.input).toBe("How were sales today?");
    expect(chat.current?.isChatOpen).toBe(true);
    expect(chat.current?.isExpanded).toBe(false);
    expect(chat.current?.focusComposerOnOpen).toBe(before + 1);
    expect(requests).toHaveLength(1);
  });

  it("an empty question opens the panel on the current chat without sending", async () => {
    rememberChat(5);
    const requests = stub();
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() =>
      expect(chat.current?.activeConversationId).toBe(CHAT_ID),
    );

    act(() => chat.current?.startChat("   "));

    expect(chat.current?.isChatOpen).toBe(true);
    expect(chat.current?.isExpanded).toBe(false);
    expect(chat.current?.activeConversationId).toBe(CHAT_ID);
    expect(requests).toHaveLength(0);
  });

  it("★ a draft in the panel's box survives a question asked from elsewhere", async () => {
    rememberChat(5);
    const requests = stub();
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() =>
      expect(chat.current?.activeConversationId).toBe(CHAT_ID),
    );
    act(() => chat.current?.setInput("Half a question about"));

    act(() => chat.current?.startChat("Which orders are waiting?"));

    await waitFor(() => expect(chat.current?.isReplying).toBe(false));
    expect(requests[0]?.message).toBe("Which orders are waiting?");
    expect(chat.current?.input).toBe("Half a question about");
  });

  it("★ while Mink answers, the question waits after the draft, never over it", async () => {
    const requests = stub({ holdAnswer: true });
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(chat.current?.conversations).toHaveLength(1));
    act(() => chat.current?.send("Stock?"));
    await waitFor(() => expect(chat.current?.isReplying).toBe(true));
    act(() => chat.current?.setInput("Also check"));

    act(() => chat.current?.startChat("How were sales today?"));

    expect(chat.current?.input).toBe("Also check\n\nHow were sales today?");
    expect(requests).toHaveLength(1);
  });

  it("startChat with expanded asks in the full view", async () => {
    stub();
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(chat.current?.conversations).toHaveLength(1));
    act(() => chat.current?.startChat("Stock?", { expanded: true }));
    expect(chat.current?.isChatOpen).toBe(true);
    expect(chat.current?.isExpanded).toBe(true);
  });

  it("openChat can open without moving focus to the composer (a tap on a touch screen)", async () => {
    stub();
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(chat.current?.conversations).toHaveLength(1));
    const before = chat.current?.focusComposerOnOpen ?? 0;
    act(() => chat.current?.openChat({ focusComposer: false }));
    expect(chat.current?.isChatOpen).toBe(true);
    expect(chat.current?.focusComposerOnOpen).toBe(before);
    act(() => chat.current?.closeChat());
    act(() => chat.current?.openChat());
    expect(chat.current?.focusComposerOnOpen).toBe(before + 1);
  });

  it("★ on a touch screen a question from Home or an Ask Mink button does not raise the keyboard", async () => {
    stub();
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    try {
      render(
        <ChatProvider minkEnabled>
          <Probe />
        </ChatProvider>,
      );
      await waitFor(() => expect(chat.current?.conversations).toHaveLength(1));
      const before = chat.current?.focusComposerOnOpen ?? 0;
      act(() => chat.current?.startExpandedChat("Stock?"));
      expect(chat.current?.isChatOpen).toBe(true);
      expect(chat.current?.focusComposerOnOpen).toBe(before);
    } finally {
      window.matchMedia = original;
    }
  });

  it("★ every close forgets the control that opened the chat", async () => {
    stub();
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(chat.current?.conversations).toHaveLength(1));
    const button = document.createElement("button");
    document.body.append(button);
    try {
      button.focus();
      act(() => chat.current?.startChat(""));
      // Closed by the face (toggle), not the chat's own Close button.
      act(() => chat.current?.toggleChat());
      expect(chat.current?.isChatOpen).toBe(false);
      expect(takeMinkOpener()).toBeNull();
    } finally {
      button.remove();
    }
  });

  it("★ the pop-out bar's context keeps its identity while a reply streams", async () => {
    const requests = stub({ holdAnswer: true });
    const dock: Array<ReturnType<typeof useMinkDock>> = [];
    function DockProbe() {
      dock.push(useMinkDock());
      return null;
    }
    render(
      <ChatProvider minkEnabled>
        <Probe />
        <DockProbe />
      </ChatProvider>,
    );
    await waitFor(() => expect(chat.current?.conversations).toHaveLength(1));
    const settled = dock[dock.length - 1];
    act(() => chat.current?.send("Stock?"));
    await waitFor(() => expect(chat.current?.isReplying).toBe(true));
    expect(requests).toHaveLength(1);
    expect(dock[dock.length - 1]).toBe(settled);
  });

  it("openChat opens without toggling or expanding", async () => {
    rememberChat(5);
    stub();
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() =>
      expect(chat.current?.activeConversationId).toBe(CHAT_ID),
    );

    act(() => chat.current?.openChat());
    act(() => chat.current?.openChat());

    expect(chat.current?.isChatOpen).toBe(true);
    expect(chat.current?.isExpanded).toBe(false);
    expect(chat.current?.activeConversationId).toBe(CHAT_ID);
  });

  it("keeps a page's suggestion until it is cleared", async () => {
    stub();
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(chat.current).not.toBeNull());
    expect(chat.current?.pageSuggestion).toBeNull();

    act(() =>
      chat.current?.setPageSuggestion({
        label: "How do I add my first product?",
        prompt: "How do I add my first product?",
      }),
    );
    await waitFor(() =>
      expect(chat.current?.pageSuggestion?.label).toBe(
        "How do I add my first product?",
      ),
    );

    act(() => chat.current?.setPageSuggestion(null));
    await waitFor(() => expect(chat.current?.pageSuggestion).toBeNull());
  });

  it("a page's MinkPageSuggestion sets the suggestion, follows it, and clears it on unmount", async () => {
    stub();
    const page = (label: string | null) => (
      <ChatProvider minkEnabled>
        <Probe />
        {label ? (
          <MinkPageSuggestion label={label} prompt={`${label}?`} />
        ) : null}
      </ChatProvider>
    );
    const { rerender } = render(page("Add your first product"));
    await waitFor(() =>
      expect(chat.current?.pageSuggestion).toEqual({
        label: "Add your first product",
        prompt: "Add your first product?",
      }),
    );

    rerender(page("Publish your store policies"));
    await waitFor(() =>
      expect(chat.current?.pageSuggestion?.label).toBe(
        "Publish your store policies",
      ),
    );

    // Leaving the page (the provider stays, it lives in the layout).
    rerender(page(null));
    await waitFor(() => expect(chat.current?.pageSuggestion).toBeNull());
  });
});

describe("★★ a dashboard address that names a chat opens it (B20)", () => {
  const MINE = "11111111-1111-4111-8111-111111111111";
  const THEIRS = "22222222-2222-4222-8222-222222222222";
  const chat = { current: null as ReturnType<typeof useChat> | null };
  function Probe() {
    const value = useChat();
    useEffect(() => {
      chat.current = value;
    });
    return null;
  }

  /** The viewer has one chat; any other id is not found for them. */
  function stub() {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/mink/conversations")
        return Response.json({
          conversations: [
            {
              id: MINE,
              title: "Storefront redesign",
              lastMessageAt: "2026-10-21T10:00:00.000Z",
              createdAt: "2026-10-21T09:59:00.000Z",
            },
          ],
        });
      if (url === `/api/mink/conversations/${MINE}`)
        return Response.json({
          conversation: {
            id: MINE,
            title: "Storefront redesign",
            messages: [
              { id: "m-1", role: "user", text: "Redesign my store" },
              { id: "m-2", role: "assistant", text: "Your redesign is ready." },
            ],
          },
        });
      if (url.startsWith("/api/mink/conversations/"))
        return Response.json(
          {
            error: "That conversation was not found.",
            code: "conversation_not_found",
          },
          { status: 404 },
        );
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  const detailCalls = (fetch: ReturnType<typeof stub>, id: string) =>
    fetch.mock.calls.filter(
      ([input]) => String(input) === `/api/mink/conversations/${id}`,
    ).length;

  function visit(search: string) {
    address.search = search;
    window.history.replaceState(null, "", `/dashboard${search}`);
  }

  afterEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    chat.current = null;
  });

  it("★★ opens the viewer's chat in the full view, once, and takes the address back", async () => {
    const fetch = stub();
    visit(`?chat=${MINE}&from=bell`);
    const view = render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(chat.current?.activeConversationId).toBe(MINE));
    expect(chat.current?.isChatOpen).toBe(true);
    expect(chat.current?.isExpanded).toBe(true);
    expect(chat.current?.messages.map((message) => message.text)).toEqual([
      "Redesign my store",
      "Your redesign is ready.",
    ]);
    // ★ The parameter is read once and removed; the rest of the address stays.
    expect(window.location.pathname).toBe("/dashboard");
    expect(window.location.search).toBe("?from=bell");
    view.rerender(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(chat.current?.isReplying).toBe(false));
    expect(detailCalls(fetch, MINE)).toBe(1);
  });

  it("★ reads the address once, even when React runs its effects twice", async () => {
    const fetch = stub();
    visit(`?chat=${MINE}`);
    render(
      <StrictMode>
        <ChatProvider minkEnabled>
          <Probe />
        </ChatProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(chat.current?.activeConversationId).toBe(MINE));
    expect(detailCalls(fetch, MINE)).toBe(1);
  });

  it("★★ an id that is not the viewer's opens a new chat, never someone else's", async () => {
    // This tab's own recent chat would otherwise be restored.
    window.sessionStorage.setItem(
      "storemink:mink-active-chat",
      JSON.stringify({ id: MINE, lastActivityAt: Date.now() - 60_000 }),
    );
    const fetch = stub();
    visit(`?chat=${THEIRS}`);
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(detailCalls(fetch, THEIRS)).toBe(1));
    await waitFor(() => expect(chat.current?.isHistoryLoading).toBe(false));
    await waitFor(() => expect(chat.current?.conversations).toHaveLength(1));
    expect(chat.current?.isChatOpen).toBe(true);
    expect(chat.current?.isExpanded).toBe(true);
    expect(chat.current?.activeConversationId).toBeNull();
    expect(chat.current?.messages).toEqual([]);
    // Not an error: the merchant simply gets a new chat.
    expect(chat.current?.error).toBeNull();
    // ★ The address won: the tab's own chat was not reopened behind it.
    expect(detailCalls(fetch, MINE)).toBe(0);
    expect(window.location.search).toBe("");
  });

  it("an address that names no chat opens a new one without asking the server", async () => {
    const fetch = stub();
    visit("?chat=not-a-chat");
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(chat.current?.isChatOpen).toBe(true));
    await waitFor(() => expect(chat.current?.conversations).toHaveLength(1));
    expect(chat.current?.isExpanded).toBe(true);
    expect(chat.current?.activeConversationId).toBeNull();
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).startsWith("/api/mink/conversations/"),
      ),
    ).toBe(false);
    expect(window.location.search).toBe("");
  });

  it("with Mink AI off, the address is taken back and nothing opens", async () => {
    const fetch = stub();
    visit(`?chat=${MINE}`);
    render(
      <ChatProvider minkEnabled={false}>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(chat.current?.isChatOpen).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(chat.current?.addressOpens).toBe(0);
  });

  it("★★ counts the open for the chat view, which meets the chat at its newest message", async () => {
    stub();
    visit(`?chat=${MINE}`);
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(chat.current?.activeConversationId).toBe(MINE));
    expect(chat.current?.addressOpens).toBe(1);
  });
});

describe("★★ Stop asks the server, through the provider (25 Oct 2026)", () => {
  const RUN_ID = "33333333-3333-4333-8333-333333333333";
  const STOP_URL = `/api/mink/runs/${RUN_ID}/stop`;
  const chat = { current: null as ReturnType<typeof useChat> | null };
  function Probe() {
    const value = useChat();
    useEffect(() => {
      chat.current = value;
    });
    return null;
  }

  /**
   * The reply names its run and keeps writing; the stop route answers that
   * the run already started something.
   */
  function stub() {
    const encoder = new TextEncoder();
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/mink/conversations")
          return Response.json({ conversations: [] });
        if (url === STOP_URL) return Response.json({ outcome: "acted" });
        if (url === "/api/mink/stream")
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `event: status\ndata: ${JSON.stringify({ runId: RUN_ID })}\n\n`,
                  ),
                );
                init?.signal?.addEventListener("abort", () =>
                  controller.error(new DOMException("Aborted", "AbortError")),
                );
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        return new Response(null, { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  afterEach(() => {
    window.sessionStorage.clear();
    chat.current = null;
  });

  it("outside a provider History is empty and every history action is safe to call", async () => {
    render(<Probe />);
    const value = chat.current!;
    expect(value.enabled).toBe(false);
    expect(value.conversations).toEqual([]);
    expect(value.hasMoreConversations).toBe(false);
    expect(value.historyStatus).toEqual({
      loadingMore: false,
      error: null,
      failed: null,
    });
    expect(value.historySearchText).toBe("");
    expect(value.historySearch).toBeNull();
    expect(value.hasEarlierMessages).toBe(false);
    expect(value.earlierStatus).toEqual({ loading: false, error: null });
    expect(value.revealTarget).toBeNull();
    value.setHistorySearchText("coupon");
    value.clearRevealTarget();
    await expect(value.refreshConversations()).resolves.toBeUndefined();
    await expect(value.loadMoreConversations()).resolves.toBeUndefined();
    await expect(value.searchConversations()).resolves.toBeUndefined();
    await expect(value.loadMoreSearchResults()).resolves.toBeUndefined();
    await expect(value.loadEarlierMessages()).resolves.toBeUndefined();
    await expect(
      value.loadConversation("chat", { revealMessageId: "message" }),
    ).resolves.toBeUndefined();
  });

  it("outside a provider there is nothing to stop: Stop answers finished and is never refused", async () => {
    render(<Probe />);
    expect(chat.current?.stopRefused).toBe(false);
    await expect(chat.current?.cancel()).resolves.toEqual({
      outcome: "finished",
    });
  });

  it("★★ the voice loop and the Stop button share one stop, and a refusal reaches the chat", async () => {
    const fetch = stub();
    render(
      <ChatProvider minkEnabled>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(loop.input).not.toBeNull());
    expect(loop.input?.cancel).toBe(chat.current?.cancel);
    expect(chat.current?.stopRefused).toBe(false);
    act(() => chat.current?.send("Redesign my store"));
    await waitFor(() => expect(chat.current?.isReplying).toBe(true));
    let answer: unknown;
    await act(async () => {
      answer = await loop.input?.cancel();
    });
    expect(answer).toEqual({ outcome: "acted" });
    // Refused: the reply finishes, Stop is not offered, the status says why.
    await waitFor(() => expect(chat.current?.stopRefused).toBe(true));
    expect(chat.current?.isReplying).toBe(true);
    expect(chat.current?.statusText).toBe(
      "Mink has already started this, so it will finish.",
    );
    // Pressed again (the button after the voice loop): asked once.
    await act(async () => {
      await chat.current?.cancel();
    });
    expect(
      fetch.mock.calls.filter(([input]) => String(input) === STOP_URL),
    ).toHaveLength(1);
  });
});
