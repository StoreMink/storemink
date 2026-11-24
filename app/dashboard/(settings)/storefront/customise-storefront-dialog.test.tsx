// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const startExpandedChat = vi.fn();
const chat = { enabled: true };
vi.mock("@/app/dashboard/chat-context", () => ({
  useChat: () => ({ startExpandedChat, enabled: chat.enabled }),
}));

import { customiseStorefrontMessage } from "@/lib/mink/revamp/customise-form";
import { CustomiseStorefrontButton } from "./customise-storefront-dialog";

function renderButton() {
  return render(<CustomiseStorefrontButton className="btn" />);
}

describe("CustomiseStorefrontButton", () => {
  it("renders nothing while Mink AI is off for the store", () => {
    chat.enabled = false;
    try {
      const { container } = renderButton();
      expect(container).toBeEmptyDOMElement();
    } finally {
      chat.enabled = true;
    }
  });

  it("opens a box asking about the business", async () => {
    renderButton();
    fireEvent.click(
      screen.getByRole("button", { name: "Customise storefront" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Customise your storefront" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("What do you sell, and who buys it?"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/The look and feel you want/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Facts about your business/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Anything to avoid/)).toBeInTheDocument();
  });

  it("★ asks what the store sells before anything goes to Mink AI", async () => {
    renderButton();
    fireEvent.click(
      screen.getByRole("button", { name: "Customise storefront" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Customise" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Tell Mink AI what you sell and who buys it.",
    );
    expect(startExpandedChat).not.toHaveBeenCalled();
    // The box stays open with the answers so far.
    expect(
      screen.getByRole("heading", { name: "Customise your storefront" }),
    ).toBeInTheDocument();
  });

  it("★★ Customise sends every answer to Mink AI in a new chat, and the redesign starts there", async () => {
    renderButton();
    fireEvent.click(
      screen.getByRole("button", { name: "Customise storefront" }),
    );
    fireEvent.change(
      await screen.findByLabelText("What do you sell, and who buys it?"),
      { target: { value: "Cold-pressed oils for home cooks" } },
    );
    fireEvent.change(screen.getByLabelText(/The look and feel you want/), {
      target: { value: "Warm and earthy" },
    });
    fireEvent.change(screen.getByLabelText(/Facts about your business/), {
      target: { value: "Pressed in our own mill since 1998" },
    });
    fireEvent.change(screen.getByLabelText(/Anything to avoid/), {
      target: { value: "Bright pink" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Customise" }));

    expect(startExpandedChat).toHaveBeenCalledTimes(1);
    expect(startExpandedChat).toHaveBeenCalledWith(
      customiseStorefrontMessage({
        business: "Cold-pressed oils for home cooks",
        look: "Warm and earthy",
        facts: "Pressed in our own mill since 1998",
        avoid: "Bright pink",
      }),
    );
    // The box closes once the chat has the answers.
    expect(
      screen.queryByRole("heading", { name: "Customise your storefront" }),
    ).not.toBeInTheDocument();
  });

  it("Cancel closes the box without sending anything", async () => {
    renderButton();
    fireEvent.click(
      screen.getByRole("button", { name: "Customise storefront" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(startExpandedChat).not.toHaveBeenCalled();
  });
});
