// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MinkFeedbackControls } from "./mink-feedback";
afterEach(cleanup);
it("explains clipboard failure and announces a successful retry", async () => {
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(new Error("blocked"))
    .mockResolvedValueOnce(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(
    <MinkFeedbackControls
      message={{
        id: "answer",
        role: "assistant",
        text: "Your orders",
        runId: "run",
      }}
      submitting={false}
      submit={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Could not copy"),
  );
  expect(screen.getByRole("status").closest(".mink-feedback")).toHaveClass(
    "mink-feedback-visible",
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Answer copied."),
  );
  expect(writeText).toHaveBeenLastCalledWith("Your orders");
});
