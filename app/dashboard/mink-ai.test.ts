// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeMinkSse, minkReadingStatus, useMinkAi } from "./mink-ai";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("consumeMinkSse", () => {
  it("parses events split across network chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: sta"));
        controller.enqueue(
          encoder.encode(
            'tus\ndata: {"conversationId":"conversation-1"}\n\nevent: message\n',
          ),
        );
        controller.enqueue(encoder.encode('data: {"text":"Ready"}\n\n'));
        controller.close();
      },
    });
    const onEvent = vi.fn();

    await consumeMinkSse(stream, onEvent);

    expect(onEvent).toHaveBeenNthCalledWith(1, "status", {
      conversationId: "conversation-1",
    });
    expect(onEvent).toHaveBeenNthCalledWith(2, "message", { text: "Ready" });
  });

  it("rejects malformed JSON instead of displaying untrusted stream text", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode("event: message\ndata: not-json\n\n"),
        );
        controller.close();
      },
    });

    await expect(consumeMinkSse(stream, vi.fn())).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });
});

const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_KEY = "storemink:mink-active-chat";
/** A storefront redesign's card, as an answer carries it. */
const REVAMP_CARD = {
  type: "storefront_revamp",
  revampId: "44444444-4444-4444-8444-444444444444",
  kind: "full",
  status: "running",
};

function summary(id: string, title: string) {
  return {
    id,
    title,
    lastMessageAt: "2026-08-29T10:00:00.000Z",
    createdAt: "2026-08-29T09:59:00.000Z",
  };
}

function rememberChat(id: string, minutesAgo: number) {
  window.sessionStorage.setItem(
    ACTIVE_KEY,
    JSON.stringify({ id, lastActivityAt: Date.now() - minutesAgo * 60_000 }),
  );
}

/** History lists two chats; opening one returns its two messages. */
function historyFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/mink/conversations") {
      return Response.json({
        conversations: [
          summary(CHAT_ID, "Published products"),
          summary(OTHER_ID, "Older chat"),
        ],
      });
    }
    if (init?.method === "DELETE") {
      return Response.json({
        conversations: [summary(OTHER_ID, "Older chat")],
      });
    }
    const id = url.endsWith(OTHER_ID) ? OTHER_ID : CHAT_ID;
    return Response.json({
      conversation: {
        id,
        title: id === CHAT_ID ? "Published products" : "Older chat",
        messages: [
          { id: `${id}-1`, role: "user", text: "How many?" },
          { id: `${id}-2`, role: "assistant", text: "**14** products." },
        ],
      },
    });
  });
}

describe("★★ useMinkAi: when a chat continues and when a new one starts", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("a new tab opens a new chat, with the recent chats in History", async () => {
    const fetch = historyFetch();
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));

    await waitFor(() => expect(result.current.conversations).toHaveLength(2));
    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/mink/conversations", {
      cache: "no-store",
    });
  });

  it("a reload continues this tab's chat while it is recent", async () => {
    rememberChat(CHAT_ID, 5);
    vi.stubGlobal("fetch", historyFetch());

    const { result } = renderHook(() => useMinkAi({ enabled: true }));

    await waitFor(() =>
      expect(result.current.activeConversationId).toBe(CHAT_ID),
    );
    expect(result.current.activeConversationTitle).toBe("Published products");
    expect(result.current.messages).toHaveLength(2);
  });

  it("a reload after the chat has been quiet for over two hours starts a new chat", async () => {
    rememberChat(CHAT_ID, 3 * 60);
    const fetch = historyFetch();
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));

    await waitFor(() => expect(result.current.conversations).toHaveLength(2));
    expect(result.current.activeConversationId).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it("a remembered chat that was deleted elsewhere is forgotten, not reopened", async () => {
    rememberChat("33333333-3333-4333-8333-333333333333", 5);
    const fetch = historyFetch();
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));

    await waitFor(() => expect(result.current.conversations).toHaveLength(2));
    expect(result.current.activeConversationId).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it("opening Mink keeps a recent chat and starts a new one once it has gone quiet", async () => {
    rememberChat(CHAT_ID, 5);
    vi.stubGlobal("fetch", historyFetch());
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe(CHAT_ID),
    );

    act(() => result.current.resumeOrStartFresh());
    expect(result.current.activeConversationId).toBe(CHAT_ID);

    const later = Date.now() + 2 * 60 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    act(() => result.current.resumeOrStartFresh());

    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.conversations).toHaveLength(2);
    expect(window.sessionStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it("choosing a chat in History continues it and remembers it for this tab", async () => {
    vi.stubGlobal("fetch", historyFetch());
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(2));

    await act(async () => {
      await result.current.loadConversation(OTHER_ID);
    });

    expect(result.current.activeConversationId).toBe(OTHER_ID);
    expect(
      JSON.parse(window.sessionStorage.getItem(ACTIVE_KEY) ?? "{}").id,
    ).toBe(OTHER_ID);
  });

  it("New chat leaves the open chat for an empty one and keeps History", async () => {
    rememberChat(CHAT_ID, 5);
    vi.stubGlobal("fetch", historyFetch());
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe(CHAT_ID),
    );

    act(() => result.current.startNewChat());

    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.conversations).toHaveLength(2);
    expect(window.sessionStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it("does not reopen this tab's chat when New chat wins an initial-load race", async () => {
    rememberChat(CHAT_ID, 5);
    let resolveHistory!: (response: Response) => void;
    const history = new Promise<Response>((resolve) => {
      resolveHistory = resolve;
    });
    const fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/mink/conversations") return history;
      return Promise.resolve(
        Response.json({
          conversation: {
            id: CHAT_ID,
            title: "Old conversation",
            messages: [],
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    act(() => result.current.startNewChat());
    resolveHistory(
      Response.json({ conversations: [summary(CHAT_ID, "Old conversation")] }),
    );

    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("★★ a message sent while an old chat is still loading is never replaced by it", async () => {
    rememberChat(CHAT_ID, 5);
    let resolveDetail!: (response: Response) => void;
    const detail = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/mink/conversations")
        return Promise.resolve(
          Response.json({
            conversations: [summary(CHAT_ID, "Published products")],
          }),
        );
      if (url === "/api/mink/stream")
        return new Promise<Response>(() => {
          // The answer never needs to arrive for this test.
        });
      return detail;
    });
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.isHistoryLoading).toBe(true));

    act(() => {
      result.current.send("Is my almond shake in stock?");
    });
    // The old chat arrives after the message was sent (the mock ignores the
    // abort, as a response already on its way would).
    await act(async () => {
      resolveDetail(
        Response.json({
          conversation: {
            id: CHAT_ID,
            title: "Published products",
            messages: [{ id: "old-1", role: "user", text: "How many?" }],
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(result.current.isHistoryLoading).toBe(false);
    expect(result.current.messages.map((message) => message.text)).toEqual([
      "Is my almond shake in stock?",
    ]);
    expect(result.current.activeConversationId).toBeNull();
  });

  it("deleting the open chat leaves a new, empty one, even when other chats remain", async () => {
    rememberChat(CHAT_ID, 5);
    const fetch = historyFetch();
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe(CHAT_ID),
    );

    let deleteError: { code: string; message: string } | null = null;
    await act(async () => {
      deleteError = await result.current.deleteConversation(CHAT_ID);
    });

    expect(deleteError).toBeNull();
    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.conversations).toHaveLength(1);
    expect(window.sessionStorage.getItem(ACTIVE_KEY)).toBeNull();
    expect(fetch).toHaveBeenCalledWith(`/api/mink/conversations/${CHAT_ID}`, {
      method: "DELETE",
    });
    // The remaining chat stays in History; nothing opens it on its own.
    expect(
      fetch.mock.calls.filter(([url]) =>
        String(url).endsWith(`/conversations/${OTHER_ID}`),
      ),
    ).toHaveLength(0);
  });
});

describe("★★ useMinkAi streaming", () => {
  function sse(blocks: string[]) {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const block of blocks) controller.enqueue(encoder.encode(block));
        controller.close();
      },
    });
  }

  it("shows the answer as it streams, names each tool step, and keeps the steps on the finished answer", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: status\ndata: {"conversationId":"11111111-1111-4111-8111-111111111111"}\n\n' +
              'event: tool\ndata: {"state":"running","name":"get_sales_summary","sequence":1}\n\n' +
              'event: tool\ndata: {"state":"completed","name":"get_sales_summary","sequence":1}\n\n' +
              'event: delta\ndata: {"text":"Sales are "}\n\n' +
              'event: delta\ndata: {"text":"up 12%."}\n\n',
          ),
        );
        await gate;
        controller.enqueue(
          encoder.encode(
            'event: message\ndata: {"role":"assistant","text":"Sales are up 12%.","runId":"33333333-3333-4333-8333-333333333333","artifacts":[]}\n\n' +
              "event: done\ndata: {}\n\n",
          ),
        );
        controller.close();
      },
    });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/mink/conversations") {
        return Response.json({ conversations: [] });
      }
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.isHistoryLoading).toBe(false));

    act(() => result.current.send("How are sales?"));

    await waitFor(() =>
      expect(result.current.streamingText).toBe("Sales are up 12%."),
    );
    expect(result.current.steps).toEqual([
      {
        sequence: 1,
        name: "get_sales_summary",
        label: "sales",
        status: "Read sales",
        state: "completed",
      },
    ]);
    expect(result.current.statusText).toBe("Writing…");
    expect(result.current.isReplying).toBe(true);

    act(() => release?.());

    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.streamingText).toBe("");
    expect(result.current.steps).toEqual([]);
    const answer = result.current.messages.at(-1);
    expect(answer?.text).toBe("Sales are up 12%.");
    expect(answer?.toolSteps?.map((step) => step.status)).toEqual([
      "Read sales",
    ]);
  });

  it("★ keeps a voice turn's spoken words apart from the written answer", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: status\ndata: {"conversationId":"11111111-1111-4111-8111-111111111111"}\n\n' +
              'event: spoken\ndata: {"text":"You have twelve "}\n\n' +
              'event: spoken\ndata: {"text":"orders today."}\n\n' +
              "event: spoken_end\ndata: {}\n\n" +
              'event: delta\ndata: {"text":"**12 orders** today."}\n\n',
          ),
        );
        await gate;
        controller.enqueue(
          encoder.encode(
            'event: message\ndata: {"role":"assistant","text":"**12 orders** today.","spoken":"You have twelve orders today.","artifacts":[]}\n\n' +
              "event: done\ndata: {}\n\n",
          ),
        );
        controller.close();
      },
    });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/mink/conversations") {
        return Response.json({ conversations: [] });
      }
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.isHistoryLoading).toBe(false));
    act(() => result.current.send("How many orders today?", { voice: true }));

    await waitFor(() =>
      expect(result.current.spokenText).toBe("You have twelve orders today."),
    );
    expect(result.current.spokenEnded).toBe(true);
    expect(result.current.streamingText).toBe("**12 orders** today.");
    // The send carried the voice flag in its context, nothing else changed.
    const streamCall = (
      fetch.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>
    ).find(([input]) => String(input) === "/api/mink/stream");
    expect(JSON.parse(String(streamCall?.[1]?.body)).context.voice).toBe(true);

    act(() => release?.());
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.spokenText).toBe("");
    expect(result.current.spokenEnded).toBe(false);
    const answer = result.current.messages.at(-1);
    expect(answer?.text).toBe("**12 orders** today.");
    expect(answer?.spoken).toBe("You have twelve orders today.");
  });

  it("★★ keeps a voice turn's acknowledgement across a tool call, and clears it with the answer", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: status\ndata: {"conversationId":"11111111-1111-4111-8111-111111111111"}\n\n' +
              'event: spoken\ndata: {"text":"Let me check."}\n\n' +
              "event: spoken_end\ndata: {}\n\n" +
              'event: delta\ndata: {"text":"Checking"}\n\n' +
              'event: delta_reset\ndata: {"keepSpoken":true,"spoken":"Let me check."}\n\n' +
              'event: tool\ndata: {"state":"running","name":"get_orders_today","sequence":1}\n\n' +
              'event: spoken\ndata: {"text":"Twelve "}\n\n',
          ),
        );
        await gate;
        controller.enqueue(
          encoder.encode(
            'event: message\ndata: {"role":"assistant","text":"12.","spoken":"Twelve orders.","artifacts":[]}\n\n' +
              "event: done\ndata: {}\n\n",
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/mink/conversations") {
          return Response.json({ conversations: [] });
        }
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.isHistoryLoading).toBe(false));
    act(() => result.current.send("How many orders today?", { voice: true }));

    // The acknowledgement moved to `spokenKept`; the block now streaming is
    // the answer's, and only the written working-out was withdrawn.
    await waitFor(() => expect(result.current.spokenText).toBe("Twelve "));
    expect(result.current.spokenKept).toBe("Let me check.");
    expect(result.current.spokenEnded).toBe(false);
    expect(result.current.streamingText).toBe("");

    act(() => release?.());
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.spokenKept).toBe("");
    expect(result.current.spokenText).toBe("");
  });

  it("withdraws the whole spoken block on a plain reset, keeping earlier acknowledgements", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: status\ndata: {"conversationId":"11111111-1111-4111-8111-111111111111"}\n\n' +
              'event: delta_reset\ndata: {"keepSpoken":true,"spoken":"Let me check."}\n\n' +
              'event: spoken\ndata: {"text":"Half an"}\n\n' +
              "event: delta_reset\ndata: {}\n\n",
          ),
        );
        await gate;
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/mink/conversations") {
          return Response.json({ conversations: [] });
        }
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.isHistoryLoading).toBe(false));
    act(() => result.current.send("How many orders today?", { voice: true }));
    await waitFor(() =>
      expect(result.current.spokenKept).toBe("Let me check."),
    );
    await waitFor(() => expect(result.current.spokenText).toBe(""));
    act(() => release?.());
    await waitFor(() => expect(result.current.isReplying).toBe(false));
  });

  it("★ a spoken question asked again with more words replaces the unanswered half", async () => {
    const encoder = new TextEncoder();
    let streams = 0;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/mink/conversations") {
          return Response.json({ conversations: [] });
        }
        streams += 1;
        const first = streams === 1;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (first) {
              // Mink is still thinking when the merchant carries on talking.
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("Aborted", "AbortError")),
              );
              return;
            }
            controller.enqueue(
              encoder.encode(
                'event: message\ndata: {"role":"assistant","text":"Sales were up last week.","artifacts":[]}\n\n' +
                  "event: done\ndata: {}\n\n",
              ),
            );
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.isHistoryLoading).toBe(false));
    act(() => {
      result.current.send("Show me sales for", { voice: true });
    });
    await waitFor(() => expect(result.current.isReplying).toBe(true));
    act(() => result.current.cancel());
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.messages.map((message) => message.text)).toEqual([
      "Show me sales for",
    ]);
    act(() => {
      result.current.send("Show me sales for last week", {
        voice: true,
        replaceUnanswered: true,
      });
    });
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.messages.map((message) => message.text)).toEqual([
      "Show me sales for last week",
      "Sales were up last week.",
    ]);
    // An answered question is never replaced.
    act(() => {
      result.current.send("And this week?", {
        voice: true,
        replaceUnanswered: true,
      });
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.messages.map((message) => message.text)).toEqual([
      "Show me sales for last week",
      "Sales were up last week.",
      "And this week?",
      "Sales were up last week.",
    ]);
  });

  it("discards streamed working-out when the server resets it or a tool starts", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/mink/conversations") {
        return Response.json({ conversations: [] });
      }
      return new Response(
        sse([
          'event: status\ndata: {"conversationId":"11111111-1111-4111-8111-111111111111"}\n\n',
          'event: delta\ndata: {"text":"Let me look."}\n\n',
          "event: delta_reset\ndata: {}\n\n",
          'event: tool\ndata: {"state":"running","name":"list_orders","sequence":1}\n\n',
          'event: delta\ndata: {"text":"Three orders."}\n\n',
          'event: message\ndata: {"role":"assistant","text":"Three orders.","artifacts":[]}\n\n',
          "event: done\ndata: {}\n\n",
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.isHistoryLoading).toBe(false));

    act(() => result.current.send("Orders?"));
    await waitFor(() => expect(result.current.isReplying).toBe(false));

    expect(result.current.messages.at(-1)?.text).toBe("Three orders.");
    expect(result.current.messages.at(-1)?.toolSteps).toEqual([
      expect.objectContaining({
        name: "list_orders",
        status: "Reading orders…",
      }),
    ]);
  });
});

describe("★★ useMinkAi: a message with attachments goes into the chat at once", () => {
  const MESSAGE =
    'Is this in stock?\n\n[Saved Media image: {"url":"https://storage.googleapis.com/b/stores/s/media/shoe.webp","filename":"shoe.jpg"}]';

  function streamFetch(options: { fail?: boolean } = {}) {
    const encoder = new TextEncoder();
    // `init` is declared so a test can read back the request body it sent.
    return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      void _init;
      const url = String(input);
      if (url === "/api/mink/conversations")
        return Response.json({ conversations: [] });
      if (options.fail)
        return Response.json(
          { error: "Mink AI is busy. Try again.", code: "busy" },
          { status: 503 },
        );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `event: status\ndata: {"conversationId":"${CHAT_ID}"}\n\n` +
                  'event: message\ndata: {"role":"assistant","text":"Yes, 12 in stock.","artifacts":[]}\n\n' +
                  "event: done\ndata: {}\n\n",
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    });
  }

  function prepared(
    prepare: (input: {
      signal: AbortSignal;
      setStatus: (text: string) => void;
    }) => Promise<{ message: string; previews?: Record<string, string> }>,
    restored = true,
  ) {
    const restore = vi.fn(() => restored);
    const discard = vi.fn();
    const send = {
      draft: "Is this in stock?",
      attachments: [
        { name: "shoe.jpg", kind: "image" as const, previewUrl: "blob:shoe" },
      ],
      prepare: vi.fn(prepare),
      restore,
      discard,
    };
    return send;
  }

  function untilAborted(signal: AbortSignal) {
    return new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      ),
    );
  }

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("shows the message and photo before anything is read, then becomes the finished message", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = streamFetch();
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const send = prepared(async ({ setStatus }) => {
      setStatus("Looking at your photo…");
      await gate;
      return { message: MESSAGE, previews: { "url:https://x": "blob:shoe" } };
    });

    let taken = false;
    act(() => {
      taken = result.current.sendPrepared(send);
    });

    expect(taken).toBe(true);
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      text: "Is this in stock?",
      pendingAttachments: send.attachments,
    });
    expect(result.current.statusText).toBe("Looking at your photo…");
    expect(result.current.isReplying).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => release());

    await waitFor(() => expect(result.current.isReplying).toBe(false));
    const question = result.current.messages[0];
    expect(question?.text).toBe(MESSAGE);
    expect(question?.pendingAttachments).toBeUndefined();
    expect(question?.localPreviews).toEqual({ "url:https://x": "blob:shoe" });
    expect(result.current.messages.at(-1)?.text).toBe("Yes, 12 in stock.");
    const body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(body.message).toBe(MESSAGE);
    expect(send.restore).not.toHaveBeenCalled();
    // The tab now remembers the chat the server named.
    expect(
      JSON.parse(window.sessionStorage.getItem(ACTIVE_KEY) ?? "{}").id,
    ).toBe(CHAT_ID);
  });

  it("gives the message back to the box, with the reason, when a file cannot be read", async () => {
    const fetch = streamFetch();
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const send = prepared(async () => {
      throw new Error("Could not upload this image.");
    });

    await act(async () => {
      result.current.sendPrepared(send);
    });

    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.messages).toEqual([]);
    expect(send.restore).toHaveBeenCalledWith({
      code: "attachment_failed",
      message: "Could not upload this image.",
    });
    expect(result.current.error).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("Stop while Mink is reading gives the message back without an error", async () => {
    vi.stubGlobal("fetch", streamFetch());
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    const send = prepared(({ signal }) => untilAborted(signal));

    act(() => {
      result.current.sendPrepared(send);
    });
    expect(result.current.isReplying).toBe(true);
    act(() => result.current.cancel());

    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(send.restore).toHaveBeenCalledWith(null);
    expect(send.discard).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
  });

  it("New chat while Mink is reading abandons the half-sent message", async () => {
    vi.stubGlobal("fetch", streamFetch());
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    const send = prepared(({ signal }) => untilAborted(signal));

    act(() => {
      result.current.sendPrepared(send);
    });
    act(() => result.current.startNewChat());

    await waitFor(() => expect(send.discard).toHaveBeenCalledTimes(1));
    expect(send.restore).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
    expect(result.current.isReplying).toBe(false);
  });

  it("says why in the chat, with no Retry, when the box that sent it has closed", async () => {
    vi.stubGlobal("fetch", streamFetch());
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    const send = prepared(async () => {
      throw new Error("The attachment returned an invalid result.");
    }, false);

    await act(async () => {
      result.current.sendPrepared(send);
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toEqual({
      code: "attachment_failed",
      message:
        "The attachment returned an invalid result. Attach the file again to send it.",
      retryable: false,
    });
  });

  it("Retry after a failed answer resends the finished message without reading the files again", async () => {
    const fetch = streamFetch({ fail: true });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const send = prepared(async () => ({ message: MESSAGE }));

    await act(async () => {
      result.current.sendPrepared(send);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("busy"));

    await act(async () => {
      result.current.retry();
    });

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const retried = JSON.parse(String(fetch.mock.calls[2]?.[1]?.body));
    expect(retried.message).toBe(MESSAGE);
    expect(send.prepare).toHaveBeenCalledTimes(1);
  });

  it("names what Mink is reading first", () => {
    const image = { name: "a.jpg", kind: "image" as const, previewUrl: null };
    const document = {
      name: "b.pdf",
      kind: "document" as const,
      previewUrl: null,
    };
    expect(minkReadingStatus([image])).toBe("Looking at your photo…");
    expect(minkReadingStatus([image, image])).toBe("Looking at your photos…");
    expect(minkReadingStatus([document])).toBe("Reading your file…");
    expect(minkReadingStatus([document, document])).toBe("Reading your files…");
    expect(minkReadingStatus([image, document])).toBe(
      "Reading your attachments…",
    );
  });
});

describe("★★ useMinkAi: a new chat's title, like ChatGPT's", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const STATUS = `event: status\ndata: {"conversationId":"${CHAT_ID}"}\n\n`;
  const ANSWER =
    'event: message\ndata: {"role":"assistant","text":"Twelve orders.","artifacts":[]}\n\n' +
    "event: done\ndata: {}\n\n";
  const TITLE = `event: title\ndata: {"conversationId":"${CHAT_ID}","title":"Today's order count"}\n\n`;
  const isList = ([input]: [RequestInfo | URL, RequestInit?]) =>
    String(input) === "/api/mink/conversations";
  const eventStream = (body: ReadableStream<Uint8Array>) =>
    new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  function streamOf(text: string) {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  }
  const titles = (items: Array<{ id: string; title: string }>) =>
    items.map((item) => [item.id, item.title]);

  it("lists a new chat at once as New chat, and gives it its title when the title arrives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(STATUS));
        await gate;
        controller.enqueue(encoder.encode(TITLE + ANSWER));
        controller.close();
      },
    });
    let listed = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/mink/conversations") return eventStream(body);
      listed += 1;
      return Response.json({
        conversations:
          listed === 1
            ? [summary(OTHER_ID, "Older chat")]
            : [
                summary(CHAT_ID, "Today's order count"),
                summary(OTHER_ID, "Older chat"),
              ],
      });
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));

    act(() => {
      result.current.send("How many orders did I get today?");
    });
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe(CHAT_ID),
    );
    expect(result.current.activeConversationTitle).toBe("New chat");
    expect(titles(result.current.conversations)).toEqual([
      [CHAT_ID, "New chat"],
      [OTHER_ID, "Older chat"],
    ]);

    act(() => release());
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.activeConversationTitle).toBe("Today's order count");
    expect(titles(result.current.conversations)).toEqual([
      [CHAT_ID, "Today's order count"],
      [OTHER_ID, "Older chat"],
    ]);
  });

  it("★ keeps calling it New chat until its title is saved, then asks History once more", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const lists = [
      [summary(OTHER_ID, "Older chat")],
      // Straight after the answer the title is not saved yet: the stored
      // excerpt must not flash in the sidebar.
      [
        summary(CHAT_ID, "How many orders did I get today?"),
        summary(OTHER_ID, "Older chat"),
      ],
      [
        summary(CHAT_ID, "Today's order count"),
        summary(OTHER_ID, "Older chat"),
      ],
    ];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/mink/conversations")
        return eventStream(streamOf(STATUS + ANSWER));
      return Response.json({
        conversations: lists.length > 1 ? lists.shift() : lists[0],
      });
    });
    vi.stubGlobal("fetch", fetch);
    const calls = fetch.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit?]
    >;
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));

    act(() => {
      result.current.send("How many orders did I get today?");
    });
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    await waitFor(() => expect(calls.filter(isList)).toHaveLength(2));
    expect(titles(result.current.conversations)).toEqual([
      [CHAT_ID, "New chat"],
      [OTHER_ID, "Older chat"],
    ]);
    expect(result.current.activeConversationTitle).toBe("New chat");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await waitFor(() =>
      expect(result.current.activeConversationTitle).toBe(
        "Today's order count",
      ),
    );
    expect(titles(result.current.conversations)).toEqual([
      [CHAT_ID, "Today's order count"],
      [OTHER_ID, "Older chat"],
    ]);
    expect(calls.filter(isList)).toHaveLength(3);
  });

  it("asks History no more once the title came with the answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/mink/conversations")
        return eventStream(streamOf(STATUS + TITLE + ANSWER));
      return Response.json({ conversations: [] });
    });
    vi.stubGlobal("fetch", fetch);
    const calls = fetch.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit?]
    >;
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(calls.filter(isList)).toHaveLength(1));

    act(() => {
      result.current.send("How many orders did I get today?");
    });
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Mount, and the one refresh after the answer: no late retry.
    expect(calls.filter(isList)).toHaveLength(2);
  });

  it("drops the oldest from a full History, as the server did when it created the chat", async () => {
    const full = Array.from({ length: 10 }, (_, index) =>
      summary(
        `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
        `Chat ${index}`,
      ),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(STATUS));
        await gate;
        controller.enqueue(encoder.encode(ANSWER));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === "/api/mink/conversations"
          ? Response.json({ conversations: full })
          : eventStream(body),
      ),
    );
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(10));

    act(() => {
      result.current.send("Hi");
    });
    await waitFor(() =>
      expect(result.current.conversations[0]?.id).toBe(CHAT_ID),
    );
    expect(result.current.conversations).toHaveLength(10);
    expect(result.current.conversations.at(-1)?.title).toBe("Chat 8");
    act(() => release());
    await waitFor(() => expect(result.current.isReplying).toBe(false));
  });

  it("leaves a chat it continued as it was", async () => {
    rememberChat(CHAT_ID, 5);
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/mink/stream")
        return eventStream(streamOf(STATUS + ANSWER));
      if (url === "/api/mink/conversations")
        return Response.json({
          conversations: [summary(CHAT_ID, "Published products")],
        });
      return Response.json({
        conversation: {
          id: CHAT_ID,
          title: "Published products",
          messages: [{ id: "m-1", role: "user", text: "How many?" }],
        },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() =>
      expect(result.current.activeConversationTitle).toBe("Published products"),
    );

    act(() => {
      result.current.send("And yesterday?");
    });
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.activeConversationTitle).toBe("Published products");
    expect(titles(result.current.conversations)).toEqual([
      [CHAT_ID, "Published products"],
    ]);
  });
});

describe("★★ useMinkAi: a dashboard address that names a chat (B20)", () => {
  const THEIRS = "33333333-3333-4333-8333-333333333333";

  /** History as `historyFetch`, but THEIRS is not found for this viewer. */
  function addressFetch(missing: Response = notFound()) {
    const history = historyFetch();
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `/api/mink/conversations/${THEIRS}`)
        return missing.clone();
      return history(input, init);
    });
  }
  function notFound() {
    return Response.json(
      {
        error: "That conversation was not found.",
        code: "conversation_not_found",
      },
      { status: 404 },
    );
  }
  const detailCalls = (fetch: ReturnType<typeof addressFetch>, id: string) =>
    fetch.mock.calls.filter(
      ([input]) => String(input) === `/api/mink/conversations/${id}`,
    ).length;

  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("opens the viewer's own chat as choosing it in History does", async () => {
    const fetch = addressFetch();
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(2));

    await act(async () => {
      await result.current.openConversationFromAddress(OTHER_ID);
    });

    expect(result.current.activeConversationId).toBe(OTHER_ID);
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.error).toBeNull();
    expect(
      JSON.parse(window.sessionStorage.getItem(ACTIVE_KEY) ?? "{}").id,
    ).toBe(OTHER_ID);
  });

  it("★★ a chat the server does not find for this viewer leaves a new chat, with no error", async () => {
    rememberChat(CHAT_ID, 5);
    const fetch = addressFetch();
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe(CHAT_ID),
    );

    await act(async () => {
      await result.current.openConversationFromAddress(THEIRS);
    });

    // ★ Never someone else's, and never the chat it was on before either.
    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.conversations).toHaveLength(2);
    expect(window.sessionStorage.getItem(ACTIVE_KEY)).toBeNull();
    expect(detailCalls(fetch, THEIRS)).toBe(1);
  });

  it("a malformed id is answered by the server as missing too", async () => {
    const fetch = addressFetch(
      Response.json(
        { error: "Invalid Mink AI conversation." },
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(2));
    await act(async () => {
      await result.current.openConversationFromAddress(THEIRS);
    });
    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("an address that names no chat leaves a new chat without asking", async () => {
    rememberChat(CHAT_ID, 5);
    const fetch = addressFetch();
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe(CHAT_ID),
    );
    const calls = fetch.mock.calls.length;

    await act(async () => {
      await result.current.openConversationFromAddress(null);
    });

    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("★★ the chat already open is loaded again, its draft kept, so a card saved since shows (B4)", async () => {
    rememberChat(CHAT_ID, 5);
    const history = addressFetch();
    let saved = false;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (saved && String(input) === `/api/mink/conversations/${CHAT_ID}`) {
          // The card a stopped reply kept, saved after this tab last read it.
          return Response.json({
            conversation: {
              id: CHAT_ID,
              title: "Published products",
              messages: [
                { id: "m-1", role: "user", text: "Redesign my store" },
                {
                  id: "m-2",
                  role: "assistant",
                  text: "Your storefront redesign is ready. You can review it here.",
                  runId: "run-1",
                  artifacts: [REVAMP_CARD],
                },
              ],
            },
          });
        }
        return history(input, init);
      },
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe(CHAT_ID),
    );
    expect(detailCalls(fetch, CHAT_ID)).toBe(1);
    act(() => result.current.setInput("Make the colours warmer"));
    saved = true;

    await act(async () => {
      await result.current.openConversationFromAddress(CHAT_ID);
    });

    expect(detailCalls(fetch, CHAT_ID)).toBe(2);
    expect(result.current.activeConversationId).toBe(CHAT_ID);
    expect(result.current.messages.at(-1)?.artifacts).toEqual([REVAMP_CARD]);
    // ★ What the merchant was typing stays in the box.
    expect(result.current.input).toBe("Make the colours warmer");
    expect(result.current.error).toBeNull();
  });

  it("★ any other failure is shown, and the thread stays where it was", async () => {
    rememberChat(CHAT_ID, 5);
    const fetch = addressFetch(
      Response.json(
        { error: "Mink AI couldn't load that conversation." },
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe(CHAT_ID),
    );

    await act(async () => {
      await result.current.openConversationFromAddress(THEIRS);
    });

    expect(result.current.error?.message).toBe(
      "Mink AI couldn't load that conversation.",
    );
    expect(result.current.activeConversationId).toBe(CHAT_ID);
  });

  it("★ never replaces a reply that is running, and does nothing while Mink is off", async () => {
    let release: (() => void) | undefined;
    const history = addressFetch();
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/mink/stream")
          return new Promise<Response>((resolve) => {
            release = () => resolve(new Response(null, { status: 503 }));
          });
        return history(input, init);
      },
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(2));
    act(() => result.current.send("How are sales?"));
    await waitFor(() => expect(result.current.isReplying).toBe(true));

    await act(async () => {
      await result.current.openConversationFromAddress(OTHER_ID);
    });

    expect(detailCalls(history, OTHER_ID)).toBe(0);
    expect(result.current.messages[0]?.text).toBe("How are sales?");
    // Nor does an address that names no chat start a new one under it.
    await act(async () => {
      await result.current.openConversationFromAddress(null);
    });
    expect(result.current.isReplying).toBe(true);
    expect(result.current.messages[0]?.text).toBe("How are sales?");
    act(() => release?.());
    await waitFor(() => expect(result.current.isReplying).toBe(false));

    const off = addressFetch();
    vi.stubGlobal("fetch", off);
    const disabled = renderHook(() => useMinkAi({ enabled: false }));
    await act(async () => {
      await disabled.result.current.openConversationFromAddress(OTHER_ID);
    });
    expect(off).not.toHaveBeenCalled();
  });

  it("★★ counts every open from the address before its chat loads, so the chat view meets it at its newest message", async () => {
    rememberChat(CHAT_ID, 5);
    const history = addressFetch();
    let hold = true;
    let release: (() => void) | undefined;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (hold && String(input) === `/api/mink/conversations/${OTHER_ID}`) {
          hold = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return history(input, init);
      },
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe(CHAT_ID),
    );
    expect(result.current.addressOpens).toBe(0);

    // ★ Counted before the chat loads, as History's choice resets the view
    // before it loads.
    let opened: Promise<void> | undefined;
    act(() => {
      opened = result.current.openConversationFromAddress(OTHER_ID);
    });
    await waitFor(() => expect(result.current.isHistoryLoading).toBe(true));
    expect(result.current.addressOpens).toBe(1);
    expect(result.current.activeConversationId).toBe(CHAT_ID);
    await act(async () => {
      release?.();
      await opened;
    });
    expect(result.current.activeConversationId).toBe(OTHER_ID);

    // ★★ The chat already open, loaded again: counted, its draft kept.
    act(() => result.current.setInput("Make the colours warmer"));
    await act(async () => {
      await result.current.openConversationFromAddress(OTHER_ID);
    });
    expect(result.current.addressOpens).toBe(2);
    expect(result.current.activeConversationId).toBe(OTHER_ID);
    expect(result.current.input).toBe("Make the colours warmer");

    // A chat that is not the viewer's, and an address naming none, leave a
    // new chat, which the view meets as History's New chat does.
    await act(async () => {
      await result.current.openConversationFromAddress(THEIRS);
    });
    await act(async () => {
      await result.current.openConversationFromAddress(null);
    });
    expect(result.current.addressOpens).toBe(4);
    expect(result.current.activeConversationId).toBeNull();
  });

  it("★ counts nothing while a reply is running or Mink is off, so a running reply keeps its place", async () => {
    let release: (() => void) | undefined;
    const history = addressFetch();
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/mink/stream")
          return new Promise<Response>((resolve) => {
            release = () => resolve(new Response(null, { status: 503 }));
          });
        return history(input, init);
      },
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(2));
    act(() => result.current.send("How are sales?"));
    await waitFor(() => expect(result.current.isReplying).toBe(true));

    await act(async () => {
      await result.current.openConversationFromAddress(OTHER_ID);
    });
    await act(async () => {
      await result.current.openConversationFromAddress(null);
    });
    expect(result.current.addressOpens).toBe(0);
    act(() => release?.());
    await waitFor(() => expect(result.current.isReplying).toBe(false));

    vi.stubGlobal("fetch", addressFetch());
    const disabled = renderHook(() => useMinkAi({ enabled: false }));
    await act(async () => {
      await disabled.result.current.openConversationFromAddress(OTHER_ID);
    });
    expect(disabled.result.current.addressOpens).toBe(0);
  });
});

describe("★★ useMinkAi: a reply stopped after it started a redesign keeps its card in the chat (B4)", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const RUN_ID = "55555555-5555-4555-8555-555555555555";
  const encoder = new TextEncoder();
  const keptMessage = {
    id: "kept-1",
    role: "assistant",
    text: "Your storefront redesign is being made. You can follow it here.",
    runId: RUN_ID,
    artifacts: [REVAMP_CARD],
  };

  /**
   * The first reply calls `tool` and then waits until the merchant stops
   * it; any later reply answers at once. The chat, as the server has it,
   * holds the kept card once `saved()` says so.
   */
  function stoppedReplyFetch(options: { tool?: string; saved: () => boolean }) {
    let streams = 0;
    const tool = options.tool ?? "start_storefront_revamp";
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/mink/conversations") {
        return Response.json({ conversations: [summary(CHAT_ID, "Redesign")] });
      }
      if (url === "/api/mink/stream") {
        streams += 1;
        const first = streams === 1;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (!first) {
              controller.enqueue(
                encoder.encode(
                  'event: message\ndata: {"role":"assistant","text":"Twelve orders.","artifacts":[]}\n\n' +
                    "event: done\ndata: {}\n\n",
                ),
              );
              controller.close();
              return;
            }
            controller.enqueue(
              encoder.encode(
                `event: status\ndata: {"conversationId":"${CHAT_ID}","runId":"${RUN_ID}"}\n\n` +
                  `event: tool\ndata: {"state":"running","name":"${tool}","sequence":1}\n\n` +
                  `event: tool\ndata: {"state":"completed","name":"${tool}","sequence":1}\n\n`,
              ),
            );
            init?.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("Aborted", "AbortError")),
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (init?.method === "DELETE") {
        return Response.json({ conversations: [] });
      }
      return Response.json({
        conversation: {
          id: CHAT_ID,
          title: "Redesign",
          messages: [
            // An earlier run's card this tab never showed: not this stop's.
            {
              id: "old-1",
              role: "assistant",
              text: "Your storefront redesign is ready. You can review it here.",
              runId: "66666666-6666-4666-8666-666666666666",
              artifacts: [
                {
                  ...REVAMP_CARD,
                  revampId: "77777777-7777-4777-8777-777777777777",
                  status: "ready",
                },
              ],
            },
            { id: "m-1", role: "user", text: "Redesign my store" },
            ...(options.saved() ? [keptMessage] : []),
          ],
        },
      });
    });
  }
  /** The chat's reads (a delete names the same address). */
  const detailCalls = (fetch: ReturnType<typeof stoppedReplyFetch>) =>
    fetch.mock.calls.filter(
      ([input, init]) =>
        String(input) === `/api/mink/conversations/${CHAT_ID}` &&
        init?.method !== "DELETE",
    ).length;

  async function stopAfterTool(fetch: ReturnType<typeof stoppedReplyFetch>) {
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() =>
      expect(hook.result.current.conversations).toHaveLength(1),
    );
    act(() => {
      hook.result.current.send("Redesign my store");
    });
    await waitFor(() =>
      expect(
        hook.result.current.steps.some((step) => step.state === "completed"),
      ).toBe(true),
    );
    act(() => hook.result.current.cancel());
    await waitFor(() => expect(hook.result.current.isReplying).toBe(false));
    return hook;
  }

  it("★★ asks for the chat again until the card is saved, and shows it after the question", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let saved = false;
    const fetch = stoppedReplyFetch({ saved: () => saved });
    const { result } = await stopAfterTool(fetch);
    // The stop sent nothing more: no card yet, and no error either.
    expect(result.current.messages.map((m) => m.text)).toEqual([
      "Redesign my store",
    ]);
    expect(result.current.error).toBeNull();

    // Asked once before the server recorded the stop: nothing changes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await waitFor(() => expect(detailCalls(fetch)).toBe(1));
    expect(result.current.messages).toHaveLength(1);

    saved = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages[0]?.text).toBe("Redesign my store");
    expect(result.current.messages[1]).toMatchObject({
      role: "assistant",
      runId: RUN_ID,
      artifacts: [REVAMP_CARD],
    });
    // Found: never asked again, and never shown twice.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(detailCalls(fetch)).toBe(2);
    expect(result.current.messages).toHaveLength(2);
  });

  it("★ puts the card after the question it answers, even when the merchant asked something since", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let saved = false;
    const fetch = stoppedReplyFetch({ saved: () => saved });
    const { result } = await stopAfterTool(fetch);
    act(() => {
      result.current.send("How many orders today?");
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(3));
    saved = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    expect(result.current.messages.map((m) => m.text)).toEqual([
      "Redesign my store",
      keptMessage.text,
      "How many orders today?",
      "Twelve orders.",
    ]);
  });

  it("★ never shows the card twice when the chat was opened again meanwhile", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = stoppedReplyFetch({ saved: () => true });
    const { result } = await stopAfterTool(fetch);
    // Chosen again in History before the first ask: the card comes with it.
    await act(async () => {
      await result.current.loadConversation(CHAT_ID);
    });
    expect(result.current.messages.map((m) => m.id)).toEqual([
      "old-1",
      "m-1",
      "kept-1",
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await waitFor(() => expect(detailCalls(fetch)).toBe(2));
    expect(result.current.messages.map((m) => m.id)).toEqual([
      "old-1",
      "m-1",
      "kept-1",
    ]);
  });

  it("asks nothing after a stop that started no redesign, or once the chat is left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Reading the store's context starts nothing.
    const read = stoppedReplyFetch({
      tool: "get_storefront_revamp_context",
      saved: () => true,
    });
    const first = await stopAfterTool(read);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(detailCalls(read)).toBe(0);
    expect(first.result.current.messages).toHaveLength(1);
    first.unmount();
    // A new tab: it restores no chat of its own.
    window.sessionStorage.clear();

    const left = stoppedReplyFetch({ saved: () => true });
    const second = await stopAfterTool(left);
    act(() => second.result.current.startNewChat());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(detailCalls(left)).toBe(0);
    expect(second.result.current.messages).toEqual([]);
    second.unmount();
    window.sessionStorage.clear();

    // Deleting the chat leaves it too.
    const deleted = stoppedReplyFetch({ saved: () => true });
    const third = await stopAfterTool(deleted);
    await act(async () => {
      await third.result.current.deleteConversation(CHAT_ID);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(detailCalls(deleted)).toBe(0);
  });
});
