// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { InfoTip } from "./info-tip";

describe("InfoTip", () => {
  it("is a named button, so a screen reader can find it", () => {
    render(<InfoTip label="About facts">Only what you write here.</InfoTip>);
    expect(
      screen.getByRole("button", { name: "About facts" }),
    ).toBeInTheDocument();
  });

  it("shows its text on a click or tap, where a tooltip would not open", async () => {
    render(<InfoTip>Only what you write here.</InfoTip>);
    expect(
      screen.queryByText("Only what you write here."),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More information" }));
    expect(
      await screen.findByText("Only what you write here."),
    ).toBeInTheDocument();
  });

  it("never submits the form it sits in", () => {
    render(
      <form>
        <InfoTip>Help</InfoTip>
      </form>,
    );
    expect(
      screen.getByRole("button", { name: "More information" }),
    ).toHaveAttribute("type", "button");
  });
});
