// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeMinkSse, useMinkAi } from "./mink-ai";

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

describe("useMinkAi history", () => {
  it("restores the newest retained conversation after refresh", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/mink/conversations") {
        return Response.json({
          conversations: [
            {
              id,
              title: "Published products",
              lastMessageAt: "2026-08-29T10:00:00.000Z",
              createdAt: "2026-08-29T09:59:00.000Z",
            },
          ],
        });
      }
      return Response.json({
        conversation: {
          id,
          title: "Published products",
          messages: [
            { id: "message-1", role: "user", text: "How many?" },
            { id: "message-2", role: "assistant", text: "**14** products." },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));

    await waitFor(() => {
      expect(result.current.activeConversationId).toBe(id);
    });
    expect(result.current.activeConversationTitle).toBe("Published products");
    expect(result.current.conversations).toHaveLength(1);
    expect(result.current.messages).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith("/api/mink/conversations", {
      cache: "no-store",
    });
  });

  it("starts a blank thread without deleting the visible history sidebar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ conversations: [] })),
    );
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.isHistoryLoading).toBe(false));

    act(() => result.current.reset());

    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.conversations).toEqual([]);
  });

  it("does not reopen history when New conversation wins an initial-load race", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    let resolveHistory!: (response: Response) => void;
    const history = new Promise<Response>((resolve) => {
      resolveHistory = resolve;
    });
    const fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/mink/conversations") return history;
      return Promise.resolve(
        Response.json({
          conversation: {
            id,
            title: "Old conversation",
            messages: [],
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    act(() => result.current.reset());
    resolveHistory(
      Response.json({
        conversations: [
          {
            id,
            title: "Old conversation",
            lastMessageAt: "2026-08-29T10:00:00.000Z",
            createdAt: "2026-08-29T09:59:00.000Z",
          },
        ],
      }),
    );

    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("deletes the active conversation and leaves a blank thread when none remain", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/mink/conversations") {
          return Response.json({
            conversations: [
              {
                id,
                title: "Delete me",
                lastMessageAt: "2026-08-29T10:00:00.000Z",
                createdAt: "2026-08-29T09:59:00.000Z",
              },
            ],
          });
        }
        if (init?.method === "DELETE") {
          return Response.json({ conversations: [] });
        }
        return Response.json({
          conversation: {
            id,
            title: "Delete me",
            messages: [{ id: "message-1", role: "user", text: "Delete this" }],
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useMinkAi({ enabled: true }));
    await waitFor(() => expect(result.current.activeConversationId).toBe(id));

    let deleteError: { code: string; message: string } | null = null;
    await act(async () => {
      deleteError = await result.current.deleteConversation(id);
    });

    expect(deleteError).toBeNull();
    expect(result.current.activeConversationId).toBeNull();
    expect(result.current.conversations).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(fetch).toHaveBeenCalledWith(`/api/mink/conversations/${id}`, {
      method: "DELETE",
    });
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
