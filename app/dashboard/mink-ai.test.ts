// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeMinkSse,
  MINK_STOP_ACTED_STATUS,
  MINK_STOP_FINISHING_STATUS,
  MINK_STOP_REQUEST_TIMEOUT_MS,
  MINK_STOP_RUN_ID_WAIT_MS,
  MINK_STOPPING_STATUS,
  minkReadingStatus,
  useMinkAi,
} from "./mink-ai";
import type { MinkStopResult } from "@/lib/mink/run-stop-types";

afterEach(() => {
  vi.unstubAllGlobals();
  // ★ A chat a test opened is remembered for the tab, and the restore now
  //   reopens it whether or not History lists it: no test inherits another's.
  window.sessionStorage.clear();
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

/**
 * History lists two chats; opening one returns its two messages. A chat it
 * does not have (or one deleted meanwhile) answers 404, as the server does.
 */
function historyFetch() {
  const deleted = new Set<string>();
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/mink/conversations") {
      return Response.json({
        conversations: [
          summary(CHAT_ID, "Published products"),
          summary(OTHER_ID, "Older chat"),
        ].filter((row) => !deleted.has(row.id)),
      });
    }
    const id = url.endsWith(OTHER_ID)
      ? OTHER_ID
      : url.endsWith(CHAT_ID)
        ? CHAT_ID
        : null;
    if (init?.method === "DELETE") {
      if (id) deleted.add(id);
      // The previous bundle's list: the current client never reads it.
      return Response.json({ conversations: [], nextCursor: null });
    }
    if (!id || deleted.has(id))
      return Response.json(
        {
          error: "That Mink AI conversation is no longer available.",
          code: "conversation_not_found",
        },
        { status: 404 },
      );
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
    // Asked for by itself (it need not be on History's first page), then
    // forgotten without a word when the server no longer has it.
    await waitFor(() =>
      expect(window.sessionStorage.getItem(ACTIVE_KEY)).toBeNull(),
    );
    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.error).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("★ a reload continues this tab's chat even when it is not on History's first page, or History failed", async () => {
    rememberChat(OTHER_ID, 5);
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/mink/conversations")
        return Response.json({ error: "Down" }, { status: 503 });
      return Response.json({
        conversation: {
          id: OTHER_ID,
          title: "Older chat",
          messages: [{ id: "m-1", role: "user", text: "How many?" }],
        },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));

    await waitFor(() =>
      expect(result.current.activeConversationId).toBe(OTHER_ID),
    );
    expect(fetch).toHaveBeenCalledWith(`/api/mink/conversations/${OTHER_ID}`, {
      signal: expect.any(AbortSignal),
    });
    // ★ R18: History's failure is the sidebar's, never the chat's.
    expect(result.current.error).toBeNull();
    expect(result.current.historyStatus).toEqual({
      loadingMore: false,
      error: { code: "http_503", message: "Down" },
      failed: "list",
    });
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
    // Removed at once, and still gone after page 1 is merged in again.
    expect(result.current.conversations.map((row) => row.id)).toEqual([
      OTHER_ID,
    ]);
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(
          ([url]) => String(url) === "/api/mink/conversations",
        ),
      ).toHaveLength(2),
    );
    expect(result.current.conversations.map((row) => row.id)).toEqual([
      OTHER_ID,
    ]);
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
        // The server confirms the stop: the run had done nothing yet.
        if (String(input).endsWith("/stop")) {
          return Response.json({ outcome: "stopped" });
        }
        streams += 1;
        const first = streams === 1;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (first) {
              // Mink is still thinking when the merchant carries on talking.
              controller.enqueue(
                encoder.encode(
                  'event: status\ndata: {"runId":"33333333-3333-4333-8333-333333333333"}\n\n',
                ),
              );
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
    await act(async () => {
      await expect(result.current.cancel()).resolves.toEqual({
        outcome: "stopped",
      });
    });
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

  it("★★ sends the page's path and screen with their contact details hidden", async () => {
    // The Customers search writes what was typed into the address bar.
    window.history.replaceState(
      null,
      "",
      "/dashboard/users?q=priya%40example.com",
    );
    document.body.innerHTML = "<main><h1>Customers</h1></main>";
    try {
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/mink/conversations") {
          return Response.json({ conversations: [] });
        }
        return new Response(
          sse([
            'event: message\ndata: {"role":"assistant","text":"Done.","artifacts":[]}\n\n',
            "event: done\ndata: {}\n\n",
          ]),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      });
      vi.stubGlobal("fetch", fetch);
      const { result } = renderHook(() => useMinkAi({ enabled: true }));
      await waitFor(() => expect(result.current.isHistoryLoading).toBe(false));

      act(() => result.current.send("Who is this?"));
      await waitFor(() => expect(result.current.isReplying).toBe(false));

      const streamCall = (
        fetch.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>
      ).find(([input]) => String(input) === "/api/mink/stream");
      const context = JSON.parse(String(streamCall?.[1]?.body)).context;
      expect(context.currentPath).toBe("/dashboard/users?q=%5Bemail+hidden%5D");
      expect(context.screen.query).toEqual({ q: "[email hidden]" });
      expect(JSON.stringify(context)).not.toContain("priya");
    } finally {
      window.history.replaceState(null, "", "/");
      document.body.innerHTML = "";
    }
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
    const fetch = streamFetch();
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    const send = prepared(({ signal }) => untilAborted(signal));

    act(() => {
      result.current.sendPrepared(send);
    });
    expect(result.current.isReplying).toBe(true);
    // ★ Nothing has reached the server yet, so the stop is this tab's alone.
    await act(async () => {
      await expect(result.current.cancel()).resolves.toEqual({
        outcome: "stopped",
      });
    });

    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(send.restore).toHaveBeenCalledWith(null);
    expect(send.discard).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
    expect(
      fetch.mock.calls.some(
        ([input]) =>
          String(input) === "/api/mink/stream" ||
          String(input).endsWith("/stop"),
      ),
    ).toBe(false);
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

  it("★ keeps every loaded chat when a new one starts: there is no cap", async () => {
    const full = Array.from({ length: 45 }, (_, index) =>
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
    await waitFor(() => expect(result.current.conversations).toHaveLength(45));

    act(() => {
      result.current.send("Hi");
    });
    await waitFor(() =>
      expect(result.current.conversations[0]?.id).toBe(CHAT_ID),
    );
    expect(result.current.conversations).toHaveLength(46);
    expect(result.current.conversations.at(-1)?.title).toBe("Chat 44");
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
   * The first reply calls `tool` and then waits; `cut()` drops its stream the
   * way a lost connection does, with no answer. Any later reply answers at
   * once. A stop request answers `stop` (default: the run had acted). The
   * chat, as the server has it, holds the kept card once `saved()` says so.
   * ★ Only the network leaves a reply like this now: a Stop the server
   * confirmed means the run did nothing, and one it refused is read on.
   */
  function cutOffReplyFetch(options: {
    tool?: string;
    saved: () => boolean;
    stop?: MinkStopResult["outcome"];
  }) {
    let streams = 0;
    let cut: (() => void) | null = null;
    const tool = options.tool ?? "start_storefront_revamp";
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/mink/conversations") {
          return Response.json({
            conversations: [summary(CHAT_ID, "Redesign")],
          });
        }
        if (url === `/api/mink/runs/${RUN_ID}/stop`) {
          return Response.json({ outcome: options.stop ?? "acted" });
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
              cut = () => controller.error(new TypeError("Failed to fetch"));
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
      },
    );
    return Object.assign(fetch, { cut: () => cut?.() });
  }
  /** The chat's reads (a delete names the same address). */
  const detailCalls = (fetch: ReturnType<typeof cutOffReplyFetch>) =>
    fetch.mock.calls.filter(
      ([input, init]) =>
        String(input) === `/api/mink/conversations/${CHAT_ID}` &&
        init?.method !== "DELETE",
    ).length;
  const stopCalls = (fetch: ReturnType<typeof cutOffReplyFetch>) =>
    fetch.mock.calls.filter(([input]) => String(input).endsWith("/stop"))
      .length;

  async function replyAfterTool(fetch: ReturnType<typeof cutOffReplyFetch>) {
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
    return hook;
  }

  async function cutOffAfterTool(fetch: ReturnType<typeof cutOffReplyFetch>) {
    const hook = await replyAfterTool(fetch);
    act(() => fetch.cut());
    await waitFor(() => expect(hook.result.current.isReplying).toBe(false));
    return hook;
  }

  it("★★ asks for the chat again until the card is saved, and shows it after the question", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let saved = false;
    const fetch = cutOffReplyFetch({ saved: () => saved });
    const { result } = await cutOffAfterTool(fetch);
    // The connection dropped with no answer: no card yet, and the failure is
    // said (Retry is offered) while the card is asked for.
    expect(result.current.messages.map((m) => m.text)).toEqual([
      "Redesign my store",
    ]);
    expect(result.current.error?.code).toBe("mink_failed");
    expect(stopCalls(fetch)).toBe(0);

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
    const fetch = cutOffReplyFetch({ saved: () => saved });
    const { result } = await cutOffAfterTool(fetch);
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
    const fetch = cutOffReplyFetch({ saved: () => true });
    const { result } = await cutOffAfterTool(fetch);
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

  it("asks nothing after a reply that started no redesign, or once the chat is left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Reading the store's context starts nothing.
    const read = cutOffReplyFetch({
      tool: "get_storefront_revamp_context",
      saved: () => true,
    });
    const first = await cutOffAfterTool(read);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(detailCalls(read)).toBe(0);
    expect(first.result.current.messages).toHaveLength(1);
    first.unmount();
    // A new tab: it restores no chat of its own.
    window.sessionStorage.clear();

    const left = cutOffReplyFetch({ saved: () => true });
    const second = await cutOffAfterTool(left);
    act(() => second.result.current.startNewChat());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(detailCalls(left)).toBe(0);
    expect(second.result.current.messages).toEqual([]);
    second.unmount();
    window.sessionStorage.clear();

    // Deleting the chat leaves it too.
    const deleted = cutOffReplyFetch({ saved: () => true });
    const third = await cutOffAfterTool(deleted);
    await act(async () => {
      await third.result.current.deleteConversation(CHAT_ID);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(detailCalls(deleted)).toBe(0);
  });

  it("★★ never asks for a card after a stop the server confirmed: that run started nothing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // A confirmed stop won before the run's first side effect, so whatever
    // redesign tool it had called, no redesign exists to keep.
    const fetch = cutOffReplyFetch({ saved: () => true, stop: "stopped" });
    const { result } = await replyAfterTool(fetch);
    await act(async () => {
      await expect(result.current.cancel()).resolves.toEqual({
        outcome: "stopped",
      });
    });
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.error).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(stopCalls(fetch)).toBe(1);
    expect(detailCalls(fetch)).toBe(0);
    expect(result.current.messages.map((m) => m.text)).toEqual([
      "Redesign my store",
    ]);
  });

  it("★ a reply whose Stop was refused, and which then broke, still brings its card in", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = cutOffReplyFetch({ saved: () => true, stop: "acted" });
    const { result } = await replyAfterTool(fetch);
    await act(async () => {
      await expect(result.current.cancel()).resolves.toEqual({
        outcome: "acted",
      });
    });
    // Refused: the reply is read on.
    expect(result.current.isReplying).toBe(true);
    expect(result.current.stopRefused).toBe(true);
    act(() => fetch.cut());
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.stopRefused).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages[1]).toMatchObject({
      runId: RUN_ID,
      artifacts: [REVAMP_CARD],
    });
  });
});

describe("★★ useMinkAi: Stop asks the server before it lets go (25 Oct 2026)", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const STOP_RUN_ID = "88888888-8888-4888-8888-888888888888";
  const STOP_URL = `/api/mink/runs/${STOP_RUN_ID}/stop`;
  const encoder = new TextEncoder();

  type Feed = { emit: (event: string, data: object) => void; close(): void };

  /**
   * Each reply's stream is fed by the test, and errors when its request is
   * aborted, as a browser's does. A stop request answers `stop`. With
   * `holdStream`, the first stream request gets no answer until
   * `releaseStream()`.
   */
  function stopHarness(
    stop: (attempt: number, init?: RequestInit) => Promise<Response> | Response,
    options: { holdStream?: boolean } = {},
  ) {
    const feeds: Feed[] = [];
    let attempts = 0;
    let releaseStream: () => void = () => {};
    const held = options.holdStream
      ? new Promise<void>((resolve) => {
          releaseStream = resolve;
        })
      : null;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/mink/conversations")
          return Response.json({ conversations: [] });
        if (url === STOP_URL) {
          attempts += 1;
          return stop(attempts, init);
        }
        if (url === "/api/mink/stream") {
          if (held && feeds.length === 0) await held;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              feeds.push({
                emit: (event, data) =>
                  controller.enqueue(
                    encoder.encode(
                      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                    ),
                  ),
                close: () => controller.close(),
              });
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
        return new Response(null, { status: 404 });
      },
    );
    const stopRequests = () =>
      fetch.mock.calls.filter(([input]) => String(input) === STOP_URL);
    const streamRequest = () =>
      fetch.mock.calls.find(([input]) => String(input) === "/api/mink/stream");
    return {
      fetch,
      feeds,
      stopRequests,
      streamRequest,
      releaseStream: () => releaseStream(),
    };
  }

  /** A reply in progress; its run named unless `runId: false`. */
  async function replying(
    harness: ReturnType<typeof stopHarness>,
    options: { runId?: boolean } = {},
  ) {
    vi.stubGlobal("fetch", harness.fetch);
    const hook = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() =>
      expect(hook.result.current.isHistoryLoading).toBe(false),
    );
    act(() => {
      hook.result.current.send("Redesign my store");
    });
    await waitFor(() => expect(harness.feeds).toHaveLength(1));
    if (options.runId !== false)
      act(() =>
        harness.feeds[0]?.emit("status", {
          conversationId: CHAT_ID,
          runId: STOP_RUN_ID,
        }),
      );
    return hook;
  }

  function answer(harness: ReturnType<typeof stopHarness>) {
    act(() => {
      harness.feeds[0]?.emit("message", {
        role: "assistant",
        text: "Your storefront redesign has started.",
        runId: STOP_RUN_ID,
        artifacts: [REVAMP_CARD],
      });
      harness.feeds[0]?.emit("done", {});
      harness.feeds[0]?.close();
    });
  }

  it("★★ lets go only when the server says stopped: no error, no Retry, the question stays", async () => {
    const h = stopHarness(() => Response.json({ outcome: "stopped" }));
    const { result } = await replying(h);
    let stop!: Promise<MinkStopResult>;
    act(() => {
      stop = result.current.cancel();
    });
    expect(result.current.statusText).toBe(MINK_STOPPING_STATUS);
    await act(async () => {
      await expect(stop).resolves.toEqual({ outcome: "stopped" });
    });
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.stopRefused).toBe(false);
    expect(result.current.statusText).toBeNull();
    expect(result.current.messages.map((m) => m.text)).toEqual([
      "Redesign my store",
    ]);
    expect(h.stopRequests()).toHaveLength(1);
    expect(h.stopRequests()[0]?.[1]).toMatchObject({
      method: "POST",
      body: "{}",
      cache: "no-store",
    });
  });

  it("★ a stop asked before the run has an id waits for it, reading the stream meanwhile", async () => {
    const h = stopHarness(() => Response.json({ outcome: "stopped" }));
    const { result } = await replying(h, { runId: false });
    let stop!: Promise<MinkStopResult>;
    act(() => {
      stop = result.current.cancel();
    });
    // Nothing to ask about yet, and nothing let go: the stream is read on,
    // under the stop's own status line.
    act(() => h.feeds[0]?.emit("delta", { text: "Let me look" }));
    await waitFor(() =>
      expect(result.current.streamingText).toBe("Let me look"),
    );
    expect(result.current.statusText).toBe(MINK_STOPPING_STATUS);
    expect(result.current.isReplying).toBe(true);
    expect(h.stopRequests()).toHaveLength(0);
    // The server sends the run's id first; the stop is asked the moment it lands.
    act(() =>
      h.feeds[0]?.emit("status", {
        conversationId: CHAT_ID,
        runId: STOP_RUN_ID,
      }),
    );
    await act(async () => {
      await expect(stop).resolves.toEqual({ outcome: "stopped" });
    });
    expect(h.stopRequests()).toHaveLength(1);
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it("★★ acted: the reply is read to its end, its answer and card land, and the status line says why", async () => {
    const h = stopHarness(() => Response.json({ outcome: "acted" }));
    const { result } = await replying(h);
    act(() =>
      h.feeds[0]?.emit("tool", {
        state: "running",
        name: "start_storefront_revamp",
        sequence: 1,
      }),
    );
    await act(async () => {
      await expect(result.current.cancel()).resolves.toEqual({
        outcome: "acted",
      });
    });
    expect(result.current.isReplying).toBe(true);
    expect(result.current.stopRefused).toBe(true);
    // The owner's words (25 Oct 2026).
    expect(MINK_STOP_ACTED_STATUS).toBe(
      "Mink has already started this, so it will finish.",
    );
    expect(result.current.statusText).toBe(MINK_STOP_ACTED_STATUS);
    // ★ The stream's own status ("Writing…") does not overwrite the reason.
    act(() => h.feeds[0]?.emit("delta", { text: "Your redesign" }));
    await waitFor(() =>
      expect(result.current.streamingText).toBe("Your redesign"),
    );
    expect(result.current.statusText).toBe(MINK_STOP_ACTED_STATUS);
    answer(h);
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.stopRefused).toBe(false);
    expect(result.current.statusText).toBeNull();
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      runId: STOP_RUN_ID,
      artifacts: [REVAMP_CARD],
    });
    expect(h.stopRequests()).toHaveLength(1);
  });

  it.each([
    [
      "the run is over (404)",
      () => new Response(null, { status: 404 }),
      "finished",
    ],
    [
      "the run had finished",
      () => Response.json({ outcome: "finished", status: "succeeded" }),
      "finished",
    ],
    ["a server error", () => new Response(null, { status: 500 }), "unknown"],
    [
      "an answer it cannot read",
      () => Response.json({ outcome: "STOPPED" }),
      "unknown",
    ],
  ] as const)(
    "%s: the reply is read to its end under Finishing…",
    async (_case, stop, answered) => {
      const h = stopHarness(stop);
      const { result } = await replying(h);
      let got: MinkStopResult | null = null;
      act(() => {
        void result.current.cancel().then((value) => {
          got = value;
        });
      });
      await waitFor(() => expect(result.current.stopRefused).toBe(true));
      expect(result.current.isReplying).toBe(true);
      expect(result.current.statusText).toBe(MINK_STOP_FINISHING_STATUS);
      expect(MINK_STOP_FINISHING_STATUS).toBe("Finishing…");
      // ★ `finished` is the server's last word. `unknown` is not: the caller
      //   hears how the reply ended instead.
      if (answered === "finished")
        await waitFor(() => expect(got).toMatchObject({ outcome: "finished" }));
      else expect(got).toBeNull();
      answer(h);
      await waitFor(() => expect(result.current.isReplying).toBe(false));
      expect(result.current.messages.at(-1)?.artifacts).toEqual([REVAMP_CARD]);
      await waitFor(() => expect(got).toMatchObject({ outcome: "finished" }));
    },
  );

  it("★ a network failure is asked once more; two leave the reply running", async () => {
    const h = stopHarness(() => {
      throw new TypeError("Failed to fetch");
    });
    const { result } = await replying(h);
    let got: MinkStopResult | null = null;
    act(() => {
      void result.current.cancel().then((value) => {
        got = value;
      });
    });
    await waitFor(() => expect(result.current.stopRefused).toBe(true));
    expect(h.stopRequests()).toHaveLength(2);
    expect(result.current.isReplying).toBe(true);
    expect(result.current.statusText).toBe(MINK_STOP_FINISHING_STATUS);
    // Not known yet: the reply's end decides.
    expect(got).toBeNull();
    answer(h);
    await waitFor(() => expect(got).toEqual({ outcome: "finished" }));
    expect(h.stopRequests()).toHaveLength(2);
  });

  it("a network failure and then an answer: the answer counts", async () => {
    const h = stopHarness((attempt) => {
      if (attempt === 1) throw new TypeError("Failed to fetch");
      return Response.json({ outcome: "stopped" });
    });
    const { result } = await replying(h);
    await act(async () => {
      await expect(result.current.cancel()).resolves.toEqual({
        outcome: "stopped",
      });
    });
    expect(h.stopRequests()).toHaveLength(2);
    await waitFor(() => expect(result.current.isReplying).toBe(false));
  });

  it("★ a stop that gets no answer in time counts as unknown, and is not asked again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = stopHarness(
      (_attempt, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const { result } = await replying(h);
    let got: MinkStopResult | null = null;
    act(() => {
      void result.current.cancel().then((value) => {
        got = value;
      });
    });
    await waitFor(() => expect(h.stopRequests()).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINK_STOP_REQUEST_TIMEOUT_MS);
    });
    await waitFor(() =>
      expect(result.current.statusText).toBe(MINK_STOP_FINISHING_STATUS),
    );
    expect(result.current.isReplying).toBe(true);
    expect(result.current.stopRefused).toBe(true);
    expect(got).toBeNull();
    answer(h);
    await waitFor(() => expect(got).toEqual({ outcome: "finished" }));
    expect(h.stopRequests()).toHaveLength(1);
  });

  it("no run id within the wait: nothing is asked, and the reply is read on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = stopHarness(() => Response.json({ outcome: "stopped" }));
    const { result } = await replying(h, { runId: false });
    let got: MinkStopResult | null = null;
    act(() => {
      void result.current.cancel().then((value) => {
        got = value;
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINK_STOP_RUN_ID_WAIT_MS);
    });
    await waitFor(() => expect(result.current.stopRefused).toBe(true));
    expect(h.stopRequests()).toHaveLength(0);
    expect(result.current.isReplying).toBe(true);
    expect(got).toBeNull();
    answer(h);
    await waitFor(() => expect(got).toEqual({ outcome: "finished" }));
    expect(h.stopRequests()).toHaveLength(0);
  });

  it("★ Stop twice (the voice loop and the button together) asks once", async () => {
    let respond: ((response: Response) => void) | null = null;
    const h = stopHarness(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    const { result } = await replying(h);
    let first!: Promise<MinkStopResult>;
    let second!: Promise<MinkStopResult>;
    act(() => {
      first = result.current.cancel();
      second = result.current.cancel();
    });
    expect(second).toBe(first);
    await waitFor(() => expect(h.stopRequests()).toHaveLength(1));
    await act(async () => {
      respond?.(Response.json({ outcome: "stopped" }));
      await expect(first).resolves.toEqual({ outcome: "stopped" });
    });
    // Pressed again after it was answered: the same answer, not a new ask.
    await act(async () => {
      await expect(result.current.cancel()).resolves.toMatchObject({
        outcome: expect.any(String),
      });
    });
    expect(h.stopRequests()).toHaveLength(1);
  });

  it("★ the stream's own `stopped` reads like an abort: no error, no answer, no Retry", async () => {
    const h = stopHarness(() => Response.json({ outcome: "stopped" }));
    const { result } = await replying(h);
    act(() => {
      h.feeds[0]?.emit("stopped", { runId: STOP_RUN_ID });
      h.feeds[0]?.emit("done", {});
      h.feeds[0]?.close();
    });
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.messages.map((m) => m.text)).toEqual([
      "Redesign my store",
    ]);
  });

  it("★ a stop whose answer was lost still counts when the run said it stopped", async () => {
    let respond: ((response: Response) => void) | null = null;
    const h = stopHarness(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    const { result } = await replying(h);
    let stop!: Promise<MinkStopResult>;
    act(() => {
      stop = result.current.cancel();
    });
    await waitFor(() => expect(h.stopRequests()).toHaveLength(1));
    act(() => {
      h.feeds[0]?.emit("stopped", { runId: STOP_RUN_ID });
      h.feeds[0]?.close();
    });
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    await act(async () => {
      respond?.(new Response(null, { status: 502 }));
      await expect(stop).resolves.toEqual({ outcome: "stopped" });
    });
    expect(result.current.error).toBeNull();
    expect(result.current.stopRefused).toBe(false);
  });

  it.each([
    ["no answer in time", "the browser gives up first"],
    ["no answer in time", "the run stops first"],
    ["a 503", "the browser gives up first"],
    ["a 503", "the run stops first"],
  ] as const)(
    "★★ %s, and the server stopped the run all the same (%s): the stop is `stopped`, never left at unknown",
    async (failure, order) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let fail: () => Promise<void> = async () => {};
      const h = stopHarness(
        (_attempt, init) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
            fail =
              failure === "a 503"
                ? async () => resolve(new Response(null, { status: 503 }))
                : async () => {
                    await vi.advanceTimersByTimeAsync(
                      MINK_STOP_REQUEST_TIMEOUT_MS,
                    );
                  };
          }),
      );
      const { result } = await replying(h);
      let got: MinkStopResult | null = null;
      act(() => {
        void result.current.cancel().then((value) => {
          got = value;
        });
      });
      await waitFor(() => expect(h.stopRequests()).toHaveLength(1));
      // The run's own word, late: it stopped, with no answer.
      const runStops = () =>
        act(() => {
          h.feeds[0]?.emit("stopped", { runId: STOP_RUN_ID });
          h.feeds[0]?.emit("done", {});
          h.feeds[0]?.close();
        });
      if (order === "the browser gives up first") {
        await act(async () => {
          await fail();
        });
        await waitFor(() => expect(result.current.stopRefused).toBe(true));
        expect(result.current.statusText).toBe(MINK_STOP_FINISHING_STATUS);
        expect(got).toBeNull();
        runStops();
      } else {
        runStops();
        await waitFor(() => expect(result.current.isReplying).toBe(false));
        await act(async () => {
          await fail();
        });
      }
      // ★ The voice loop reads this to ask the stopped question again.
      await waitFor(() => expect(got).toEqual({ outcome: "stopped" }));
      expect(result.current.isReplying).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.stopRefused).toBe(false);
      expect(result.current.messages.map((m) => m.text)).toEqual([
        "Redesign my store",
      ]);
      expect(h.stopRequests()).toHaveLength(1);
    },
  );

  it("★★ Stop while the request is still on its way never lets go: it asks once the run is named", async () => {
    // From the moment POST /api/mink/stream leaves, the run may exist on the
    // server before any answer reaches the browser: letting go here and
    // calling it stopped is the 25 Oct incident again.
    const h = stopHarness(() => Response.json({ outcome: "acted" }), {
      holdStream: true,
    });
    vi.stubGlobal("fetch", h.fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.isHistoryLoading).toBe(false));
    act(() => {
      result.current.send("Redesign my store");
    });
    await waitFor(() => expect(h.streamRequest()).toBeDefined());
    let stop!: Promise<MinkStopResult>;
    act(() => {
      stop = result.current.cancel();
    });
    expect(h.streamRequest()?.[1]?.signal?.aborted).toBe(false);
    expect(result.current.statusText).toBe(MINK_STOPPING_STATUS);
    act(() => h.releaseStream());
    await waitFor(() => expect(h.feeds).toHaveLength(1));
    act(() =>
      h.feeds[0]?.emit("status", {
        conversationId: CHAT_ID,
        runId: STOP_RUN_ID,
      }),
    );
    await act(async () => {
      await expect(stop).resolves.toEqual({ outcome: "acted" });
    });
    expect(h.stopRequests()).toHaveLength(1);
    expect(h.streamRequest()?.[1]?.signal?.aborted).toBe(false);
    expect(result.current.isReplying).toBe(true);
    expect(result.current.statusText).toBe(MINK_STOP_ACTED_STATUS);
  });

  it("★ an answer to the stop of a reply that has ended never marks the next reply refused", async () => {
    let respond: ((response: Response) => void) | null = null;
    const h = stopHarness(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    const { result } = await replying(h);
    let stop!: Promise<MinkStopResult>;
    act(() => {
      stop = result.current.cancel();
    });
    await waitFor(() => expect(h.stopRequests()).toHaveLength(1));
    // The reply finishes before the stop is answered, and the merchant asks
    // the next question at once.
    answer(h);
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    act(() => {
      result.current.send("How many orders today?");
    });
    await waitFor(() => expect(h.feeds).toHaveLength(2));
    act(() =>
      h.feeds[1]?.emit("status", {
        conversationId: CHAT_ID,
        runId: "99999999-9999-4999-8999-999999999999",
      }),
    );
    await act(async () => {
      respond?.(Response.json({ outcome: "finished", status: "succeeded" }));
      await expect(stop).resolves.toMatchObject({ outcome: "finished" });
    });
    expect(result.current.isReplying).toBe(true);
    expect(result.current.stopRefused).toBe(false);
    expect(result.current.statusText).toBe("Thinking…");
  });

  it("★★ New chat only stops reading: it never asks the server to stop the run (owner's decision)", async () => {
    const h = stopHarness(() => Response.json({ outcome: "stopped" }));
    const { result } = await replying(h);
    act(() => result.current.startNewChat());
    expect(result.current.isReplying).toBe(false);
    expect(result.current.messages).toEqual([]);
    expect(h.streamRequest()?.[1]?.signal?.aborted).toBe(true);
    // Nothing of this tab's is running now, so there is nothing to stop.
    await act(async () => {
      await expect(result.current.cancel()).resolves.toEqual({
        outcome: "finished",
      });
    });
    expect(h.stopRequests()).toHaveLength(0);
  });

  it("leaving the dashboard only stops reading too", async () => {
    const h = stopHarness(() => Response.json({ outcome: "stopped" }));
    const hook = await replying(h);
    hook.unmount();
    expect(h.streamRequest()?.[1]?.signal?.aborted).toBe(true);
    expect(h.stopRequests()).toHaveLength(0);
  });
});

describe("★★ useMinkAi: History pages, search and earlier messages (chat history, 26 Oct 2026)", () => {
  const LIST = "/api/mink/conversations";
  const SEARCH = "/api/mink/conversations/search";

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Chats n.. newest first, a minute apart. */
  function rows(from: number, count: number) {
    return Array.from({ length: count }, (_, index) => {
      const n = from + index;
      return {
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`,
        title: `Chat ${n}`,
        lastMessageAt: new Date(
          Date.UTC(2026, 9, 26, 12) - n * 60_000,
        ).toISOString(),
        createdAt: "2026-10-01T00:00:00.000Z",
      };
    });
  }
  const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);
  const eventStream = (text: string) => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const urls = (fetch: ReturnType<typeof vi.fn>) =>
    fetch.mock.calls.map(([input]) => String(input));

  it("★ loads the next page on request, each chat once, and stops at the last page", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LIST)
        return Response.json({
          conversations: rows(0, 30),
          nextCursor: "c-30",
        });
      if (url === `${LIST}?cursor=c-30`)
        return Response.json({
          // Row 29 again (a tie the server resolved since): shown once.
          conversations: [...rows(29, 1), ...rows(30, 15)],
          nextCursor: null,
        });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(30));
    expect(result.current.hasMoreConversations).toBe(true);

    await act(async () => {
      await result.current.loadMoreConversations();
    });
    expect(ids(result.current.conversations)).toEqual(ids(rows(0, 45)));
    expect(result.current.hasMoreConversations).toBe(false);
    await act(async () => {
      await result.current.loadMoreConversations();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("★ R18: a next page that fails stays in the sidebar, keeps its cursor, and Try again asks for the same page", async () => {
    let failNext = true;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LIST)
        return Response.json({
          conversations: rows(0, 30),
          nextCursor: "c-30",
        });
      if (failNext) {
        failNext = false;
        return Response.json({ error: "Busy" }, { status: 503 });
      }
      return Response.json({ conversations: rows(30, 5), nextCursor: null });
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(30));

    await act(async () => {
      await result.current.loadMoreConversations();
    });
    expect(result.current.historyStatus).toEqual({
      loadingMore: false,
      error: { code: "http_503", message: "Busy" },
      failed: "more",
    });
    // The welcome screen stays: no chat error, no dead Retry.
    expect(result.current.error).toBeNull();
    expect(result.current.hasMoreConversations).toBe(true);

    await act(async () => {
      await result.current.loadMoreConversations();
    });
    expect(urls(fetch).slice(1)).toEqual([
      `${LIST}?cursor=c-30`,
      `${LIST}?cursor=c-30`,
    ]);
    expect(result.current.conversations).toHaveLength(35);
    expect(result.current.historyStatus.failed).toBeNull();
  });

  it("★ a next page that lands after a refresh is dropped", async () => {
    let releasePage!: () => void;
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LIST)
        return Response.json({
          conversations: rows(0, 30),
          nextCursor: "c-30",
        });
      await pageGate;
      return Response.json({ conversations: rows(30, 5), nextCursor: null });
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(30));

    let page!: Promise<void>;
    act(() => {
      page = result.current.loadMoreConversations();
    });
    await act(async () => {
      await result.current.refreshConversations();
    });
    await act(async () => {
      releasePage();
      await page;
    });
    expect(result.current.conversations).toHaveLength(30);
    expect(result.current.hasMoreConversations).toBe(true);
  });

  it("★ R13: the refresh after an answer keeps every chat scrolled in, and continues below them", async () => {
    let listed = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LIST) {
        listed += 1;
        return Response.json(
          listed === 1
            ? { conversations: rows(0, 30), nextCursor: "c-30" }
            : {
                conversations: [
                  summary(CHAT_ID, "Today's orders"),
                  ...rows(0, 29),
                ],
                nextCursor: "c-29",
              },
        );
      }
      if (url === `${LIST}?cursor=c-30`)
        return Response.json({
          conversations: rows(30, 15),
          nextCursor: "c-45",
        });
      if (url === `${LIST}?cursor=c-45`)
        return Response.json({ conversations: rows(45, 3), nextCursor: null });
      return eventStream(
        `event: status\ndata: {"conversationId":"${CHAT_ID}"}\n\n` +
          'event: title\ndata: {"conversationId":"' +
          CHAT_ID +
          '","title":"Today\'s orders"}\n\n' +
          'event: message\ndata: {"role":"assistant","text":"Twelve.","artifacts":[]}\n\n',
      );
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(30));
    await act(async () => {
      await result.current.loadMoreConversations();
    });
    expect(result.current.conversations).toHaveLength(45);

    act(() => {
      result.current.send("How many orders today?");
    });
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    await waitFor(() => expect(listed).toBe(2));
    // The new chat on top and all 45 loaded before it: nothing dropped.
    expect(ids(result.current.conversations)).toEqual([
      CHAT_ID,
      ...ids(rows(0, 45)),
    ]);
    await act(async () => {
      await result.current.loadMoreConversations();
    });
    expect(urls(fetch).at(-1)).toBe(`${LIST}?cursor=c-45`);
    expect(result.current.conversations).toHaveLength(49);
  });

  it("★ R12: the history actions keep their identities through a refresh, a page, a search and a new chat", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LIST)
        return Response.json({
          conversations: rows(0, 30),
          nextCursor: "c-30",
        });
      if (url.startsWith(`${LIST}?cursor=`))
        return Response.json({ conversations: rows(30, 2), nextCursor: null });
      if (url === SEARCH)
        return Response.json({ conversations: rows(3, 1), nextCursor: null });
      return eventStream(
        `event: status\ndata: {"conversationId":"${CHAT_ID}"}\n\n` +
          'event: message\ndata: {"role":"assistant","text":"Hi.","artifacts":[]}\n\n',
      );
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(30));
    const pick = () => ({
      refreshConversations: result.current.refreshConversations,
      loadMoreConversations: result.current.loadMoreConversations,
      searchConversations: result.current.searchConversations,
      loadMoreSearchResults: result.current.loadMoreSearchResults,
      loadEarlierMessages: result.current.loadEarlierMessages,
      setHistorySearchText: result.current.setHistorySearchText,
      clearRevealTarget: result.current.clearRevealTarget,
      loadConversation: result.current.loadConversation,
      deleteConversation: result.current.deleteConversation,
    });
    const before = pick();

    await act(async () => {
      await result.current.refreshConversations();
      await result.current.loadMoreConversations();
    });
    act(() => result.current.setHistorySearchText("chat"));
    await act(async () => {
      await result.current.searchConversations();
    });
    act(() => {
      result.current.send("Hello");
    });
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.conversations.length).toBeGreaterThan(30);

    const after = pick();
    for (const [name, fn] of Object.entries(before)) {
      expect(after[name as keyof typeof after], name).toBe(fn);
    }
  });

  it("★ R12: a reply streaming while History changes length under it still finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LIST)
        return Response.json({
          conversations: rows(0, 30),
          nextCursor: "c-30",
        });
      if (url.startsWith(`${LIST}?cursor=`))
        return Response.json({ conversations: rows(30, 15), nextCursor: null });
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode(
                `event: status\ndata: {"conversationId":"${CHAT_ID}"}\n\n`,
              ),
            );
            await gate;
            controller.enqueue(
              encoder.encode(
                'event: message\ndata: {"role":"assistant","text":"Twelve orders.","artifacts":[]}\n\n',
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(30));

    act(() => {
      result.current.send("How many orders?");
    });
    await waitFor(() =>
      expect(result.current.activeConversationId).toBe(CHAT_ID),
    );
    await act(async () => {
      await result.current.loadMoreConversations();
    });
    expect(result.current.conversations).toHaveLength(46);

    act(() => release());
    await waitFor(() => expect(result.current.isReplying).toBe(false));
    expect(result.current.messages.at(-1)?.text).toBe("Twelve orders.");
  });

  it("★ R10: searches with a POST whose body carries the words, never the URL, and reads snippets", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LIST) return Response.json({ conversations: rows(0, 2) });
      if (url === SEARCH)
        return Response.json({
          conversations: [
            {
              ...summary(OTHER_ID, "Priya's order"),
              hasRedesignCard: false,
              snippet: "Call «Priya» on «9876543210»",
              matchMessageId: "message-7",
            },
          ],
          nextCursor: null,
        });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(2));

    act(() => result.current.setHistorySearchText("  Priya   9876543210 "));
    await act(async () => {
      await result.current.searchConversations();
    });

    const [, init] = fetch.mock.calls.at(-1) as unknown as [
      string,
      RequestInit,
    ];
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(SEARCH);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ q: "Priya 9876543210" });
    for (const url of urls(fetch)) {
      expect(url).not.toMatch(/priya|9876543210/i);
    }
    expect(result.current.historySearch).toMatchObject({
      query: "Priya 9876543210",
      words: ["priya", "9876543210"],
      loading: false,
      results: [
        {
          id: OTHER_ID,
          snippet: "Call «Priya» on «9876543210»",
          matchMessageId: "message-7",
        },
      ],
    });
    // The plain list is untouched by a search.
    expect(result.current.conversations).toHaveLength(2);
  });

  it("★ R15: text with no searchable word asks nothing and leaves the hint's state", async () => {
    const fetch = vi.fn(async () => Response.json({ conversations: [] }));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    for (const text of ["a b", "??", "🙂"]) {
      act(() => result.current.setHistorySearchText(text));
      await act(async () => {
        await result.current.searchConversations();
      });
      expect(result.current.historySearch).toMatchObject({
        words: [],
        results: [],
        loading: false,
      });
    }
    expect(urls(fetch)).not.toContain(SEARCH);
  });

  it("★ the same words again ask nothing; clearing them is back to the list at once", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === SEARCH
        ? Response.json({ conversations: rows(1, 1), nextCursor: null })
        : Response.json({ conversations: rows(0, 3) }),
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(3));

    act(() => result.current.setHistorySearchText("coupon"));
    await act(async () => {
      await result.current.searchConversations();
    });
    // A remounted sidebar runs its debounce again with the same words.
    await act(async () => {
      await result.current.searchConversations();
    });
    expect(urls(fetch).filter((url) => url === SEARCH)).toHaveLength(1);

    act(() => result.current.setHistorySearchText(""));
    expect(result.current.historySearch).toBeNull();
    expect(result.current.historySearchText).toBe("");
  });

  it("★ an answer for words no longer searched is ignored", async () => {
    let releaseFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== SEARCH)
          return Response.json({ conversations: [] });
        const { q } = JSON.parse(String(init?.body)) as { q: string };
        if (q === "old words") return first;
        return Response.json({ conversations: rows(7, 1), nextCursor: null });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    act(() => result.current.setHistorySearchText("old words"));
    let older!: Promise<void>;
    act(() => {
      older = result.current.searchConversations();
    });
    act(() => result.current.setHistorySearchText("new words"));
    await act(async () => {
      await result.current.searchConversations();
    });
    await act(async () => {
      releaseFirst(
        Response.json({ conversations: rows(1, 1), nextCursor: null }),
      );
      await older;
    });
    expect(result.current.historySearch?.query).toBe("new words");
    expect(ids(result.current.historySearch?.results ?? [])).toEqual(
      ids(rows(7, 1)),
    );
  });

  it("★ R20: asks again while the server is still busy with the last search, three times at most", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === SEARCH
        ? Response.json(
            {
              error: "Still searching your chats. Try again in a moment.",
              code: "history_search_busy",
            },
            { status: 409 },
          )
        : Response.json({ conversations: [] }),
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    act(() => result.current.setHistorySearchText("coupon"));
    let search!: Promise<void>;
    act(() => {
      search = result.current.searchConversations();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await search;
    });
    expect(urls(fetch).filter((url) => url === SEARCH)).toHaveLength(4);
    expect(result.current.historySearch?.error).toEqual({
      code: "history_search_busy",
      message: "Still searching your chats. Try again in a moment.",
    });
    expect(result.current.error).toBeNull();
  });

  it("★ a delete removes the chat from the list and the results without replacing either; a failure goes to the dialog only", async () => {
    let failDelete = false;
    const deleted = new Set<string>();
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "DELETE") {
          if (!failDelete) deleted.add(url.split("/").at(-1) ?? "");
          if (failDelete)
            return Response.json(
              {
                error:
                  "A storefront redesign from this chat is still being made.",
                code: "conversation_has_redesign",
              },
              { status: 409 },
            );
          // The previous bundle's list, which must not replace this one.
          return Response.json({
            conversations: rows(90, 1),
            nextCursor: null,
          });
        }
        if (url === SEARCH)
          return Response.json({ conversations: rows(1, 2), nextCursor: null });
        if (url === LIST)
          return Response.json({
            conversations: rows(0, 30).filter((row) => !deleted.has(row.id)),
            nextCursor: "c-30",
          });
        return Response.json({
          conversations: rows(30, 10),
          nextCursor: "c-40",
        });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(30));
    await act(async () => {
      await result.current.loadMoreConversations();
    });
    act(() => result.current.setHistorySearchText("chat"));
    await act(async () => {
      await result.current.searchConversations();
    });

    const doomed = rows(1, 1)[0].id;
    await act(async () => {
      await expect(result.current.deleteConversation(doomed)).resolves.toBe(
        null,
      );
    });
    expect(ids(result.current.conversations)).not.toContain(doomed);
    // Page 1 merged in again afterwards: everything scrolled in stays.
    await waitFor(() =>
      expect(urls(fetch).filter((url) => url === LIST)).toHaveLength(2),
    );
    expect(ids(result.current.conversations)).not.toContain(doomed);
    expect(result.current.conversations).toHaveLength(39);
    expect(ids(result.current.historySearch?.results ?? [])).toEqual(
      ids(rows(2, 1)),
    );
    expect(ids(result.current.conversations)).not.toContain(rows(90, 1)[0].id);
    expect(result.current.hasMoreConversations).toBe(true);

    failDelete = true;
    let failure: unknown;
    await act(async () => {
      failure = await result.current.deleteConversation(rows(5, 1)[0].id);
    });
    expect(failure).toMatchObject({ code: "conversation_has_redesign" });
    expect(result.current.error).toBeNull();
  });

  it("★ a chat that is gone when chosen leaves both lists, and says so", async () => {
    const gone = rows(1, 1)[0].id;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LIST) return Response.json({ conversations: rows(0, 3) });
      if (url === SEARCH)
        return Response.json({ conversations: rows(1, 1), nextCursor: null });
      return Response.json(
        {
          error: "That Mink AI conversation is no longer available.",
          code: "conversation_not_found",
        },
        { status: 404 },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(3));
    act(() => result.current.setHistorySearchText("chat"));
    await act(async () => {
      await result.current.searchConversations();
    });

    await act(async () => {
      await result.current.loadConversation(gone);
    });
    expect(ids(result.current.conversations)).not.toContain(gone);
    expect(result.current.historySearch?.results).toEqual([]);
    expect(result.current.error).toMatchObject({
      code: "conversation_not_found",
    });
  });

  it("★ R6: opening a result 120 messages back reads two earlier pages first, renders once, and marks the match", async () => {
    // Messages m-000 (oldest) to m-119; the match is m-010, an answer.
    const message = (n: number) => ({
      id: `m-${String(n).padStart(3, "0")}`,
      role: n % 2 ? "assistant" : "user",
      text: `Message ${n}`,
      runId: `run-${Math.floor(n / 2)}`,
    });
    const range = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, index) => message(from + index));
    const detail = (messages: unknown[], earlierCursor: string | null) =>
      Response.json({
        conversation: { id: CHAT_ID, title: "Long", messages, earlierCursor },
      });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LIST) return Response.json({ conversations: [] });
      if (url.endsWith("?before=e-70")) return detail(range(20, 70), "e-20");
      if (url.endsWith("?before=e-20")) return detail(range(0, 20), null);
      return detail(range(70, 120), "e-70");
    });
    vi.stubGlobal("fetch", fetch);
    const lengths: number[] = [];
    const { result } = renderHook(() => {
      const value = useMinkAi({ enabled: true });
      lengths.push(value.messages.length);
      return value;
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.loadConversation(CHAT_ID, {
        revealMessageId: "m-011",
      });
    });

    expect(urls(fetch).slice(1)).toEqual([
      `${LIST}/${CHAT_ID}`,
      `${LIST}/${CHAT_ID}?before=e-70`,
      `${LIST}/${CHAT_ID}?before=e-20`,
    ]);
    expect(result.current.messages).toHaveLength(120);
    expect(result.current.messages[0]?.id).toBe("m-000");
    // The thread went from empty to whole, never through a partial page.
    expect(new Set(lengths)).toEqual(new Set([0, 120]));
    expect(result.current.revealTarget).toEqual({
      messageId: "m-011",
      runId: "run-5",
      role: "assistant",
    });
    expect(result.current.hasEarlierMessages).toBe(false);
    act(() => result.current.clearRevealTarget());
    expect(result.current.revealTarget).toBeNull();
  });

  describe("★ opening a search result whose match is hard to reach", () => {
    // Messages m-000 (oldest) up; even ones are questions, each answer is in
    // its question's run.
    const message = (n: number) => ({
      id: `m-${String(n).padStart(3, "0")}`,
      role: n % 2 ? "assistant" : "user",
      text: `Message ${n}`,
      runId: `run-${Math.floor(n / 2)}`,
    });
    const range = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, index) => message(from + index));
    const detail = (messages: unknown[], earlierCursor: string | null) =>
      Response.json({
        conversation: { id: CHAT_ID, title: "Long", messages, earlierCursor },
      });

    it("★ F11: a matched answer whose question is on the page before reads that page too, so the thread can scroll to it", async () => {
      // The newest page begins with m-071, an answer; its question m-070 is
      // on the page before.
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === LIST) return Response.json({ conversations: [] });
        if (url.endsWith("?before=e-71")) return detail(range(21, 71), "e-21");
        return detail(range(71, 121), "e-71");
      });
      vi.stubGlobal("fetch", fetch);
      const { result } = renderHook(() => useMinkAi({ enabled: true }));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

      await act(async () => {
        await result.current.loadConversation(CHAT_ID, {
          revealMessageId: "m-071",
        });
      });

      expect(urls(fetch).slice(1)).toEqual([
        `${LIST}/${CHAT_ID}`,
        `${LIST}/${CHAT_ID}?before=e-71`,
      ]);
      expect(result.current.messages[0]?.id).toBe("m-021");
      expect(result.current.revealTarget).toEqual({
        messageId: "m-071",
        runId: "run-35",
        role: "assistant",
      });
      expect(result.current.hasEarlierMessages).toBe(true);
    });

    it("★ F15: an earlier page that fails ends the reading: the chat opens with what loaded, and Show earlier asks for that page again", async () => {
      let earlierAsked = 0;
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === LIST) return Response.json({ conversations: [] });
        if (url.endsWith("?before=e-70")) {
          earlierAsked += 1;
          if (earlierAsked === 1)
            return Response.json(
              { error: "Too many requests.", code: "rate_limited" },
              { status: 429 },
            );
          return detail(range(20, 70), "e-20");
        }
        return detail(range(70, 120), "e-70");
      });
      vi.stubGlobal("fetch", fetch);
      const { result } = renderHook(() => useMinkAi({ enabled: true }));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

      await act(async () => {
        await result.current.loadConversation(CHAT_ID, {
          revealMessageId: "m-011",
        });
      });

      expect(result.current.activeConversationId).toBe(CHAT_ID);
      expect(result.current.messages).toHaveLength(50);
      expect(result.current.messages[0]?.id).toBe("m-070");
      // No error in the chat, and nothing to scroll to: it opens at its
      // newest message (dashboard-chat.tsx).
      expect(result.current.error).toBeNull();
      expect(result.current.revealTarget).toBeNull();
      expect(result.current.hasEarlierMessages).toBe(true);

      await act(async () => {
        await result.current.loadEarlierMessages();
      });
      expect(urls(fetch).at(-1)).toBe(`${LIST}/${CHAT_ID}?before=e-70`);
      expect(result.current.messages).toHaveLength(100);
    });
  });

  it("★ F12: an earlier page dropped because another chat was chosen leaves no spinner when that chat fails to open", async () => {
    let releaseEarlier!: () => void;
    const earlierGate = new Promise<void>((resolve) => {
      releaseEarlier = resolve;
    });
    let earlierAsked = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LIST) return Response.json({ conversations: [] });
      if (url.endsWith("?before=e-1")) {
        earlierAsked += 1;
        if (earlierAsked === 1) await earlierGate;
        return Response.json({
          conversation: {
            id: CHAT_ID,
            title: "Long",
            messages: [{ id: "old-1", role: "user", text: "Older" }],
            earlierCursor: null,
          },
        });
      }
      if (url.endsWith(OTHER_ID))
        return Response.json({ error: "Busy" }, { status: 503 });
      return Response.json({
        conversation: {
          id: CHAT_ID,
          title: "Long",
          messages: [{ id: "new-1", role: "user", text: "Newer" }],
          earlierCursor: "e-1",
        },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.loadConversation(CHAT_ID);
    });

    let earlier!: Promise<void>;
    act(() => {
      earlier = result.current.loadEarlierMessages();
    });
    expect(result.current.earlierStatus.loading).toBe(true);
    await act(async () => {
      await result.current.loadConversation(OTHER_ID);
    });
    await act(async () => {
      releaseEarlier();
      await earlier;
    });

    // The long chat is still open, and its button works again.
    expect(result.current.activeConversationId).toBe(CHAT_ID);
    expect(result.current.earlierStatus).toEqual({
      loading: false,
      error: null,
    });
    expect(result.current.hasEarlierMessages).toBe(true);
    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(result.current.messages.map((row) => row.id)).toEqual([
      "old-1",
      "new-1",
    ]);
  });

  it("★ F13: reads which chats hold a redesign card, in the list and in search results alike", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LIST)
        return Response.json({
          conversations: [
            {
              ...summary(CHAT_ID, "Storefront redesign"),
              hasRedesignCard: true,
            },
            // A server that does not say: no card.
            summary(OTHER_ID, "Redesign ideas"),
          ],
          nextCursor: null,
        });
      if (url === SEARCH)
        return Response.json({
          conversations: [
            {
              ...summary(OTHER_ID, "Redesign ideas"),
              snippet: "«Redesign» ideas",
              matchMessageId: "message-2",
            },
            {
              ...summary(CHAT_ID, "Storefront redesign"),
              hasRedesignCard: true,
              snippet: "Your storefront «redesign» is ready",
              matchMessageId: "message-9",
            },
          ],
          nextCursor: null,
        });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.conversations).toHaveLength(2));
    expect(
      result.current.conversations.map((row) => [row.id, row.hasRedesignCard]),
    ).toEqual([
      [CHAT_ID, true],
      [OTHER_ID, false],
    ]);

    act(() => result.current.setHistorySearchText("redesign"));
    await act(async () => {
      await result.current.searchConversations();
    });
    expect(
      result.current.historySearch?.results.map((row) => [
        row.id,
        row.hasRedesignCard,
      ]),
    ).toEqual([
      [OTHER_ID, false],
      [CHAT_ID, true],
    ]);
  });

  it("★ R6: shows earlier messages above, each once, and drops a page that lands after another chat opened", async () => {
    let releaseEarlier!: () => void;
    const earlierGate = new Promise<void>((resolve) => {
      releaseEarlier = resolve;
    });
    let gateEarlier = false;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === LIST) return Response.json({ conversations: [] });
      if (url.endsWith("?before=e-1")) {
        if (gateEarlier) await earlierGate;
        return Response.json({
          conversation: {
            id: CHAT_ID,
            title: "Long",
            messages: [
              { id: "old-1", role: "user", text: "Older" },
              // Already shown: once only.
              { id: "new-1", role: "user", text: "Newer" },
            ],
            earlierCursor: null,
          },
        });
      }
      const id = url.endsWith(OTHER_ID) ? OTHER_ID : CHAT_ID;
      return Response.json({
        conversation: {
          id,
          title: id,
          messages: [{ id: `${id}-new`, role: "user", text: "Newer" }].map(
            (row) => (id === CHAT_ID ? { ...row, id: "new-1" } : row),
          ),
          earlierCursor: id === CHAT_ID ? "e-1" : null,
        },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.loadConversation(CHAT_ID);
    });
    expect(result.current.hasEarlierMessages).toBe(true);

    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(result.current.messages.map((row) => row.id)).toEqual([
      "old-1",
      "new-1",
    ]);
    expect(result.current.hasEarlierMessages).toBe(false);

    // Again, but another chat opens while the page is on its way.
    await act(async () => {
      await result.current.loadConversation(CHAT_ID);
    });
    gateEarlier = true;
    let earlier!: Promise<void>;
    act(() => {
      earlier = result.current.loadEarlierMessages();
    });
    await act(async () => {
      await result.current.loadConversation(OTHER_ID);
    });
    await act(async () => {
      releaseEarlier();
      await earlier;
    });
    expect(result.current.activeConversationId).toBe(OTHER_ID);
    expect(result.current.messages.map((row) => row.id)).toEqual([
      `${OTHER_ID}-new`,
    ]);
    expect(result.current.earlierStatus).toEqual({
      loading: false,
      error: null,
    });
  });
});
