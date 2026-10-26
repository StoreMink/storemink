// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendPageExitRequest } from "./page-exit-request";

afterEach(() => {
  vi.unstubAllGlobals();
});

const URL_PATH = "/api/mink/image-refine/stop";
const BODY = JSON.stringify({
  stopToken: "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b",
});

describe("★★ sendPageExitRequest: the beacon first, a keepalive fetch otherwise, never a throw", () => {
  it("a queued beacon sends no fetch", () => {
    const beacon = vi.fn(() => true);
    const fetcher = vi.fn(async () => new Response(null));
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    vi.stubGlobal("fetch", fetcher);
    sendPageExitRequest(URL_PATH, BODY);
    expect(beacon).toHaveBeenCalledWith(URL_PATH, BODY);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["refused", () => false],
    [
      "throwing",
      () => {
        throw new DOMException("not allowed", "SecurityError");
      },
    ],
  ])(
    "★ a %s beacon falls back to one same-origin keepalive fetch with the same body",
    (_label, impl) => {
      const beacon = vi.fn(impl);
      const fetcher = vi.fn(async () => new Response(null));
      vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
      vi.stubGlobal("fetch", fetcher);
      expect(() => sendPageExitRequest(URL_PATH, BODY)).not.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledWith(URL_PATH, {
        method: "POST",
        body: BODY,
        keepalive: true,
        credentials: "same-origin",
      });
    },
  );

  it("no beacon at all (jsdom has none) sends the keepalive fetch", () => {
    const fetcher = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", fetcher);
    expect(typeof navigator.sendBeacon).not.toBe("function");
    sendPageExitRequest(URL_PATH, BODY);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("★ a fetch that throws synchronously, or rejects, does not throw", async () => {
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: () => false });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new TypeError("keepalive quota exceeded");
      }),
    );
    expect(() => sendPageExitRequest(URL_PATH, BODY)).not.toThrow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(() => sendPageExitRequest(URL_PATH, BODY)).not.toThrow();
    // An unhandled rejection would fail the run after this tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
