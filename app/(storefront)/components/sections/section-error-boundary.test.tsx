// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SectionErrorBoundary } from "./section-error-boundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Broken(): never {
  throw new Error("old config shape");
}

it("renders its children when nothing throws", () => {
  render(
    <SectionErrorBoundary sectionId="s1" sectionType="hero">
      <p>hero copy</p>
    </SectionErrorBoundary>,
  );
  expect(screen.getByText("hero copy")).toBeTruthy();
});

it("drops only the failing section and names it in the log", () => {
  // React logs the throw itself as well; silence both for the assertion.
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(
    <>
      <SectionErrorBoundary sectionId="s1" sectionType="usp_bar">
        <Broken />
      </SectionErrorBoundary>
      <SectionErrorBoundary sectionId="s2" sectionType="newsletter">
        <p>still here</p>
      </SectionErrorBoundary>
    </>,
  );
  expect(screen.getByText("still here")).toBeTruthy();
  expect(screen.queryByText("old config shape")).toBeNull();
  expect(
    log.mock.calls.some(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("section usp_bar (s1) failed to render"),
    ),
  ).toBe(true);
});
