// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import {
  ChatProvider,
  useMinkVoice,
  type MinkVoiceComposer,
} from "./chat-context";
import type { MinkVoiceModeInput } from "./mink-voice-mode";

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
