// @vitest-environment jsdom
// Log a complaint's page (takedown design 6.3): gated on its own, and the
// form's latest allowed time is now in India time.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  calls: [] as string[],
  operator: true,
}));

vi.mock("../../require-operator", () => ({
  requireOperator: vi.fn(async () => {
    H.calls.push("requireOperator");
    if (!H.operator) throw new Error("redirect:/dashboard");
    return { email: "ops@storemink.com", role: "member" };
  }),
}));

vi.mock("./complaint-form", () => ({
  ComplaintForm: vi.fn(({ maxReceivedAt }: { maxReceivedAt: string }) => (
    <p>form until {maxReceivedAt}</p>
  )),
}));

import NewComplaintPage, { metadata } from "./page";

beforeEach(() => {
  H.calls = [];
  H.operator = true;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the Log a complaint page", () => {
  it("is refused to someone who is not an operator", async () => {
    H.operator = false;
    await expect(NewComplaintPage()).rejects.toThrow("redirect:/dashboard");
    expect(H.calls).toEqual(["requireOperator"]);
  });

  it("shows the heading, the way back and the form", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T08:35:00.000Z"));
    render(await NewComplaintPage());
    expect(
      screen.getByRole("heading", { level: 1, name: "Log a complaint" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Complaints" })).toHaveAttribute(
      "href",
      "/dashboard/complaints",
    );
    expect(screen.getByText("form until 2026-10-26T14:05")).toBeInTheDocument();
    expect(metadata.title).toBe("Log a complaint · StoreMink Admin");
  });
});
