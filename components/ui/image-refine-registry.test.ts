// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/http/page-exit-request", () => ({
  sendPageExitRequest: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));

import { toast } from "sonner";
import { sendPageExitRequest } from "@/lib/http/page-exit-request";
import {
  REFINE_CLIENT_WAIT_MS,
  REFINE_READY_TOAST,
  addImageRefineViewer,
  getImageRefineView,
  handlePageHide,
  handlePageShow,
  refineMatchKey,
  releaseImageRefines,
  releaseImageRefinesOffPath,
  resetImageRefinesForTests,
  settleImageRefine,
  startImageRefine,
  stopAllImageRefines,
  subscribeImageRefines,
} from "./image-refine-registry";

// ---------------------------------------------------------------------------
// ★★ The page owns each refine (image-refine-registry.ts): a stop token per
// refine, a stop on every exit, and a lost answer is asked about, never
// shown as a failure the server may not agree with.
// ---------------------------------------------------------------------------

const SOURCE = "https://storage.googleapis.com/b/stores/s/uploads/a.jpg";
const RESULT = "https://storage.googleapis.com/b/stores/s/refined/r.webp";
const SCOPE = "builder:page-1:section-1";
const PATH = "/dashboard/builder";
const KEY = refineMatchKey(SCOPE, "product", SOURCE);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STOP_URL = "/api/mink/image-refine/stop";

type Held = {
  init: RequestInit;
  answer: (response: Response) => void;
  fail: (error: unknown) => void;
};

let refines: Held[];
let stopCalls: RequestInit[];
let stopAnswers: Array<() => Response | Promise<Response>>;

const json = (body: unknown, status = 200, contentType?: string) =>
  new Response(JSON.stringify(body), {
    status,
    ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
  });

beforeEach(() => {
  refines = [];
  stopCalls = [];
  stopAnswers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input) === "/api/mink/image-refine") {
        return new Promise<Response>((resolve, reject) => {
          refines.push({ init, answer: resolve, fail: reject });
          init.signal?.addEventListener("abort", () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            ),
          );
        });
      }
      stopCalls.push(init);
      const next = stopAnswers.shift();
      return Promise.resolve(
        next ? next() : json({ error: "down", outcome: "unknown" }, 503),
      );
    }),
  );
});

afterEach(() => {
  resetImageRefinesForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const start = (overrides: { pathname?: string; scope?: string } = {}) =>
  startImageRefine({
    scope: overrides.scope ?? SCOPE,
    pathname: overrides.pathname ?? PATH,
    spec: "product",
    sourceUrl: SOURCE,
  });
const token = (index = 0) =>
  (JSON.parse(String(refines[index].init.body)) as { stopToken: string })
    .stopToken;
const settleTurns = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const stopBodies = () =>
  stopCalls.map((init) => JSON.parse(String(init.body)) as unknown);

describe("★★ a refine carries its own stop token", () => {
  it("★★ posts exactly { url, spec, stopToken } with a fresh UUID", () => {
    start();
    expect(refines).toHaveLength(1);
    const body = JSON.parse(String(refines[0].init.body));
    expect(Object.keys(body).sort()).toEqual(["spec", "stopToken", "url"]);
    expect(body).toMatchObject({ url: SOURCE, spec: "product" });
    expect(body.stopToken).toMatch(UUID_RE);
    expect(getImageRefineView(KEY)).toEqual({ status: "running" });
  });

  it("★ a second start for a running key is left alone; a finished one is replaced", async () => {
    start();
    start();
    expect(refines).toHaveLength(1);
    refines[0].answer(json({ url: RESULT }));
    await settleTurns();
    start();
    expect(refines).toHaveLength(2);
    expect(token(1)).not.toBe(token(0));
  });

  it("★★ release sends the stop with that token and aborts the fetch", () => {
    start();
    releaseImageRefines((refine) => refine.scope === SCOPE);
    expect(sendPageExitRequest).toHaveBeenCalledWith(
      STOP_URL,
      JSON.stringify({ stopToken: token() }),
    );
    expect(refines[0].init.signal?.aborted).toBe(true);
    expect(getImageRefineView(KEY)).toBeNull();
  });

  it("★ a late answer for a released refine is ignored", async () => {
    start();
    const first = refines[0];
    releaseImageRefines(() => true);
    first.answer(json({ url: RESULT }));
    await settleTurns();
    expect(getImageRefineView(KEY)).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it("★ an answer whose body is still being read when the refine is released is ignored (no view, no toast)", async () => {
    start();
    let finishBody: (text: string) => void = () => {};
    const body = new Promise<string>((resolve) => {
      finishBody = resolve;
    });
    // The response has arrived; its body has not been read yet.
    refines[0].answer({
      ok: true,
      status: 200,
      text: () => body,
    } as unknown as Response);
    await settleTurns();
    releaseImageRefines(() => true);
    finishBody(JSON.stringify({ url: RESULT }));
    await settleTurns();
    expect(getImageRefineView(KEY)).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it("releasing a finished refine sends nothing (there is nothing to stop)", async () => {
    start();
    refines[0].answer(json({ url: RESULT }));
    await settleTurns();
    releaseImageRefines(() => true);
    expect(sendPageExitRequest).not.toHaveBeenCalled();
    expect(getImageRefineView(KEY)).toBeNull();
  });
});

describe("★★ the page's exits", () => {
  it("★★ pagehide (persisted false) stops, aborts and forgets the refine", () => {
    start();
    handlePageHide(
      Object.assign(new Event("pagehide"), {
        persisted: false,
      }) as PageTransitionEvent,
    );
    expect(sendPageExitRequest).toHaveBeenCalledWith(
      STOP_URL,
      JSON.stringify({ stopToken: token() }),
    );
    expect(refines[0].init.signal?.aborted).toBe(true);
    expect(getImageRefineView(KEY)).toBeNull();
  });

  it("★★ pagehide (persisted true) stops but keeps the fetch; pageshow asks: too_late shows the photo", async () => {
    start();
    handlePageHide(
      Object.assign(new Event("pagehide"), {
        persisted: true,
      }) as PageTransitionEvent,
    );
    expect(sendPageExitRequest).toHaveBeenCalledOnce();
    expect(refines[0].init.signal?.aborted).toBe(false);
    stopAnswers.push(() => json({ outcome: "too_late", url: RESULT }));
    handlePageShow(
      Object.assign(new Event("pageshow"), {
        persisted: true,
      }) as PageTransitionEvent,
    );
    await settleTurns();
    expect(stopBodies()).toEqual([{ stopToken: token() }]);
    expect(getImageRefineView(KEY)).toEqual({
      status: "done",
      resultUrl: RESULT,
    });
    expect(refines[0].init.signal?.aborted).toBe(true);
  });

  it("★★ pageshow after a stop that won says so, and aborts the fetch", async () => {
    start();
    handlePageHide(
      Object.assign(new Event("pagehide"), {
        persisted: true,
      }) as PageTransitionEvent,
    );
    stopAnswers.push(() => json({ outcome: "stopped" }));
    handlePageShow(
      Object.assign(new Event("pageshow"), {
        persisted: true,
      }) as PageTransitionEvent,
    );
    await settleTurns();
    expect(getImageRefineView(KEY)).toEqual({
      status: "failed",
      message:
        "Refining was stopped because you left the page. Nothing was charged.",
    });
    expect(refines[0].init.signal?.aborted).toBe(true);
  });

  it("★ pageshow with recorded leaves the fetch to finish: only the server's answer is true", async () => {
    start();
    handlePageHide(
      Object.assign(new Event("pagehide"), {
        persisted: true,
      }) as PageTransitionEvent,
    );
    stopAnswers.push(() => json({ outcome: "recorded" }));
    handlePageShow(
      Object.assign(new Event("pageshow"), {
        persisted: true,
      }) as PageTransitionEvent,
    );
    await settleTurns();
    expect(getImageRefineView(KEY)).toEqual({ status: "running" });
    expect(refines[0].init.signal?.aborted).toBe(false);
    refines[0].answer(
      json({ error: "Refining was stopped. Nothing was charged." }, 409),
    );
    await settleTurns();
    expect(getImageRefineView(KEY)).toEqual({
      status: "failed",
      message: "Refining was stopped. Nothing was charged.",
    });
  });

  it("★★ a route change releases only the refines started on another path", () => {
    start({
      scope: "route:/dashboard/products/1",
      pathname: "/dashboard/products/1",
    });
    start({ scope: SCOPE, pathname: PATH });
    releaseImageRefinesOffPath(PATH);
    expect(refines[0].init.signal?.aborted).toBe(true);
    expect(refines[1].init.signal?.aborted).toBe(false);
    expect(sendPageExitRequest).toHaveBeenCalledOnce();
    expect(getImageRefineView(KEY)).toEqual({ status: "running" });
  });

  it("★ stopAllImageRefines stops every running refine with a keepalive fetch, and resolves within its wait", async () => {
    vi.useFakeTimers();
    start();
    // A stop that never answers: the wait bounds it.
    stopAnswers.push(() => new Promise<Response>(() => {}));
    let resolved = false;
    void stopAllImageRefines({ waitMs: 1_500 }).then(() => {
      resolved = true;
    });
    expect(refines[0].init.signal?.aborted).toBe(true);
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
    });
    expect(stopBodies()).toEqual([{ stopToken: token() }]);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    expect(getImageRefineView(KEY)).toBeNull();
    // Nothing running: nothing to wait for.
    await expect(
      stopAllImageRefines({ waitMs: 1_500 }),
    ).resolves.toBeUndefined();
  });
});

describe("★★ a lost answer is asked about, not shown as a failure", () => {
  it("★★ a rejected fetch asks the outcome: stopped says the connection dropped", async () => {
    start();
    stopAnswers.push(() => json({ outcome: "stopped" }));
    refines[0].fail(new TypeError("Failed to fetch"));
    await settleTurns();
    expect(stopBodies()).toEqual([{ stopToken: token() }]);
    expect(stopCalls[0]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
    });
    expect(getImageRefineView(KEY)).toEqual({
      status: "failed",
      message:
        "The connection dropped, so refining was stopped. Nothing was charged; try again.",
    });
  });

  it("★★ an HTML 502 from the edge asks: too_late with the photo shows it (charged once, not twice)", async () => {
    start();
    stopAnswers.push(() => json({ outcome: "too_late", url: RESULT }));
    refines[0].answer(
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
    );
    await settleTurns();
    expect(getImageRefineView(KEY)).toEqual({
      status: "done",
      resultUrl: RESULT,
    });
  });

  it("★★ a JSON refine_duplicate is a lost answer: recorded promises nothing", async () => {
    start();
    stopAnswers.push(() => json({ outcome: "recorded" }));
    refines[0].answer(
      json(
        {
          error: "This photo is already being refined.",
          code: "refine_duplicate",
        },
        409,
        "application/json",
      ),
    );
    await settleTurns();
    expect(getImageRefineView(KEY)).toEqual({
      status: "failed",
      message: "Refining failed. Check your connection and try again.",
    });
  });

  it("★ a JSON 502 without error, and a 200 without url, ask; unknown twice says to check the Media Library", async () => {
    vi.useFakeTimers();
    start();
    refines[0].answer(json({ message: "upstream" }, 502, "application/json"));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopCalls).toHaveLength(1);
    // Unknown is asked once more, two seconds later.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stopCalls).toHaveLength(2);
    expect(getImageRefineView(KEY)).toEqual({
      status: "failed",
      message:
        "We couldn't confirm whether your refined photo was saved. Check your Media Library before you try again.",
    });

    settleImageRefine(KEY);
    start();
    stopAnswers.push(() => json({ outcome: "too_late", url: null }));
    refines[1].answer(json({ ok: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(getImageRefineView(KEY)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("Check your Media Library"),
    });
  });

  it("★★ the watchdog aborts a request that never answers, asks, and says it took too long", async () => {
    vi.useFakeTimers();
    start();
    stopAnswers.push(() => json({ outcome: "stopped" }));
    await vi.advanceTimersByTimeAsync(REFINE_CLIENT_WAIT_MS - 1);
    expect(stopCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(refines[0].init.signal?.aborted).toBe(true);
    expect(getImageRefineView(KEY)).toEqual({
      status: "failed",
      message:
        "Refining took too long, so it was stopped. Nothing was charged; try again.",
    });
  });

  it.each([
    ["labelled application/json", "application/json"],
    ["built from a plain string (text/plain)", undefined],
  ])(
    "★★ a refusal %s shows its text and sends no stop",
    async (_label, contentType) => {
      start();
      refines[0].answer(
        json({ error: "Not enough Mink credits." }, 402, contentType),
      );
      await settleTurns();
      expect(getImageRefineView(KEY)).toEqual({
        status: "failed",
        message: "Not enough Mink credits.",
      });
      expect(stopCalls).toHaveLength(0);
      expect(sendPageExitRequest).not.toHaveBeenCalled();
    },
  );

  it("★ a success built from a plain string is done", async () => {
    start();
    refines[0].answer(new Response(JSON.stringify({ url: RESULT })));
    await settleTurns();
    expect(getImageRefineView(KEY)).toEqual({
      status: "done",
      resultUrl: RESULT,
    });
    expect(stopCalls).toHaveLength(0);
  });
});

describe("★ boxes watching a refine", () => {
  it("★ the ready toast appears only when no box watches the key", async () => {
    start();
    const detach = addImageRefineViewer(KEY);
    refines[0].answer(json({ url: RESULT }));
    await settleTurns();
    expect(toast).not.toHaveBeenCalled();
    detach();
    settleImageRefine(KEY);

    start();
    refines[1].answer(json({ url: RESULT }));
    await settleTurns();
    expect(toast).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith(REFINE_READY_TOAST);
    expect(REFINE_READY_TOAST).not.toMatch(/credit/i);
  });

  it("★ a failure waits for a box to show it, and is forgotten when that box goes", async () => {
    start();
    refines[0].answer(json({ error: "Not enough Mink credits." }, 402));
    await settleTurns();
    // Nobody has seen it yet: it waits.
    expect(getImageRefineView(KEY)).toMatchObject({ status: "failed" });
    const detach = addImageRefineViewer(KEY);
    expect(getImageRefineView(KEY)).toMatchObject({ status: "failed" });
    detach();
    await settleTurns();
    expect(getImageRefineView(KEY)).toBeNull();
  });

  it("★ a box that detaches and attaches again in one commit keeps the failure it shows (Strict Mode, two boxes swapping)", async () => {
    start();
    refines[0].answer(json({ error: "Not enough Mink credits." }, 402));
    await settleTurns();
    const first = addImageRefineViewer(KEY);
    // React runs every effect cleanup of a commit before any setup.
    first();
    const second = addImageRefineViewer(KEY);
    await settleTurns();
    expect(getImageRefineView(KEY)).toEqual({
      status: "failed",
      message: "Not enough Mink credits.",
    });
    second();
    await settleTurns();
    expect(getImageRefineView(KEY)).toBeNull();
  });

  it("★ getImageRefineView returns the same object until the refine changes, and notifies on change", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeImageRefines(listener);
    start();
    const first = getImageRefineView(KEY);
    expect(getImageRefineView(KEY)).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
    refines[0].answer(json({ url: RESULT }));
    await settleTurns();
    const second = getImageRefineView(KEY);
    expect(second).not.toBe(first);
    expect(getImageRefineView(KEY)).toBe(second);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(getImageRefineView(null)).toBeNull();
  });
});
