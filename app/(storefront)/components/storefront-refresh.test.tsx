// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StorefrontRefresh } from "./storefront-refresh";
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});
afterEach(cleanup);
it("refreshes saved storefront data on return and removes listeners on unmount", () => {
  const view = render(<StorefrontRefresh />);
  fireEvent.focus(window);
  expect(router.refresh).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  fireEvent(document, new Event("visibilitychange"));
  expect(router.refresh).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  fireEvent(document, new Event("visibilitychange"));
  expect(router.refresh).toHaveBeenCalledTimes(2);
  view.unmount();
  fireEvent.focus(window);
  expect(router.refresh).toHaveBeenCalledTimes(2);
});
