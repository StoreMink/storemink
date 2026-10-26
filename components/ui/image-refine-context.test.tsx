// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const nav = vi.hoisted(() => ({ pathname: "/dashboard/products/1" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));
vi.mock("@/lib/http/page-exit-request", () => ({
  sendPageExitRequest: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));

import { sendPageExitRequest } from "@/lib/http/page-exit-request";
import { ImageRefineProvider, ImageRefineScope } from "./image-refine-context";
import {
  getImageRefineView,
  refineMatchKey,
  resetImageRefinesForTests,
  startImageRefine,
} from "./image-refine-registry";

// ---------------------------------------------------------------------------
// ★★ The provider and the scopes send the stops a merchant leaving needs
// (image-refine-context.tsx): a dashboard route change stops the refines
// started on another path, the dashboard going away stops them all, and a
// scope whose unmount means its slots are gone (a dialog closing) stops its
// own. Without them a refine the merchant left is charged.
// ---------------------------------------------------------------------------

const SOURCE = "https://storage.googleapis.com/b/stores/s/uploads/a.jpg";
const STOP_URL = "/api/mink/image-refine/stop";

let refines: { stopToken: string; signal?: AbortSignal }[];
let stops: { url: string; init: RequestInit }[];

beforeEach(() => {
  nav.pathname = "/dashboard/products/1";
  refines = [];
  stops = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input) === "/api/mink/image-refine") {
        refines.push({
          stopToken: (JSON.parse(String(init.body)) as { stopToken: string })
            .stopToken,
          signal: init.signal ?? undefined,
        });
        // A refine still running: it never answers here.
        return new Promise<Response>(() => {});
      }
      stops.push({ url: String(input), init });
      return Promise.resolve(
        new Response(JSON.stringify({ outcome: "stopped" })),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  resetImageRefinesForTests();
  vi.unstubAllGlobals();
});

const start = (scope: string) =>
  startImageRefine({
    scope,
    pathname: nav.pathname,
    spec: "product",
    sourceUrl: SOURCE,
  });
const stopBeacon = (index: number) =>
  [STOP_URL, JSON.stringify({ stopToken: refines[index].stopToken })] as const;

describe("★★ ImageRefineProvider: the page's exits", () => {
  it("★★ a route change stops a refine started on another path: its token, its fetch aborted", () => {
    const { rerender } = render(
      <ImageRefineProvider available>
        <div />
      </ImageRefineProvider>,
    );
    start("product:1");
    // The same path again sends nothing.
    rerender(
      <ImageRefineProvider available>
        <div />
      </ImageRefineProvider>,
    );
    expect(sendPageExitRequest).not.toHaveBeenCalled();

    nav.pathname = "/dashboard/orders";
    rerender(
      <ImageRefineProvider available>
        <div />
      </ImageRefineProvider>,
    );
    expect(sendPageExitRequest).toHaveBeenCalledOnce();
    expect(sendPageExitRequest).toHaveBeenCalledWith(...stopBeacon(0));
    expect(refines[0].signal?.aborted).toBe(true);
    expect(
      getImageRefineView(refineMatchKey("product:1", "product", SOURCE)),
    ).toBeNull();
  });

  it("★★ the dashboard going away stops every running refine with a keepalive POST", () => {
    const { unmount } = render(
      <ImageRefineProvider available>
        <div />
      </ImageRefineProvider>,
    );
    start("product:1");
    unmount();
    expect(stops).toHaveLength(1);
    expect(stops[0].url).toBe(STOP_URL);
    expect(stops[0].init).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
    });
    expect(JSON.parse(String(stops[0].init.body))).toEqual({
      stopToken: refines[0].stopToken,
    });
    expect(refines[0].signal?.aborted).toBe(true);
  });
});

describe("★★ ImageRefineScope", () => {
  it("★★ with releaseOnUnmount, closing it stops its own refines and only those", () => {
    const { rerender } = render(
      <ImageRefineProvider available>
        <ImageRefineScope key="dialog" id="category:new" releaseOnUnmount>
          <div />
        </ImageRefineScope>
        <ImageRefineScope key="section" id="builder:chrome">
          <div />
        </ImageRefineScope>
      </ImageRefineProvider>,
    );
    start("category:new");
    start("builder:chrome");

    // The dialog closes: its refine is stopped.
    rerender(
      <ImageRefineProvider available>
        <ImageRefineScope key="section" id="builder:chrome">
          <div />
        </ImageRefineScope>
      </ImageRefineProvider>,
    );
    expect(sendPageExitRequest).toHaveBeenCalledOnce();
    expect(sendPageExitRequest).toHaveBeenCalledWith(...stopBeacon(0));
    expect(refines[0].signal?.aborted).toBe(true);
    expect(refines[1].signal?.aborted).toBe(false);

    // ★ A scope without the flag (a builder form) unmounts on ordinary
    //   editing: that stops nothing.
    rerender(
      <ImageRefineProvider available>
        <div />
      </ImageRefineProvider>,
    );
    expect(sendPageExitRequest).toHaveBeenCalledOnce();
    expect(refines[1].signal?.aborted).toBe(false);
    expect(
      getImageRefineView(refineMatchKey("builder:chrome", "product", SOURCE)),
    ).toEqual({ status: "running" });
  });
});
