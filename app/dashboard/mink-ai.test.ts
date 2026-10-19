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
