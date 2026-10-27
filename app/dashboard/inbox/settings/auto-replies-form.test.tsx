// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/app/actions/whatsapp-auto-reply-actions", () => ({
  saveWhatsAppAutoReplies: h.save,
}));

import { toast } from "sonner";
import { AutoRepliesForm } from "./auto-replies-form";
import { defaultAutoReplySettings } from "@/lib/whatsapp/auto-reply-settings";
import type { AutoRepliesView } from "@/app/actions/whatsapp-auto-reply-actions";

function view(over: Partial<AutoRepliesView> = {}): AutoRepliesView {
  return {
    settings: defaultAutoReplySettings("Echoss"),
    saved: false,
    canManage: true,
    timeZoneLabel: "India - Kolkata",
    canChangeTimeZone: true,
    ...over,
  };
}

beforeEach(() => {
  h.save.mockResolvedValue({ ok: true });
});

describe("AutoRepliesForm", () => {
  it("starts with every reply off and nothing to save", () => {
    render(<AutoRepliesForm view={view()} />);
    for (const name of ["Welcome message", "Away message", "Order status"]) {
      expect(screen.getByRole("switch", { name })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    }
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(
      screen.getByText(/Times are in India - Kolkata/),
    ).toBeInTheDocument();
  });

  it("★ saves what the merchant set, hours included", async () => {
    render(<AutoRepliesForm view={view()} />);
    fireEvent.click(screen.getByRole("switch", { name: "Away message" }));
    fireEvent.change(screen.getByLabelText("Sunday hours"), {
      target: { value: "open" },
    });
    fireEvent.change(screen.getByLabelText("Sunday closes at"), {
      target: { value: "14:00" },
    });
    fireEvent.change(screen.getByLabelText("Saturday hours"), {
      target: { value: "all_day" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(h.save).toHaveBeenCalled());
    const sent = h.save.mock.calls[0][0];
    expect(sent.awayEnabled).toBe(true);
    expect(sent.hours.sun).toEqual({ open: "10:00", close: "14:00" });
    expect(sent.hours.sat).toEqual({ open: "00:00", close: "24:00" });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Automatic replies saved."),
    );
  });

  it("a closing time before the opening time says it runs into the next day", () => {
    render(<AutoRepliesForm view={view()} />);
    fireEvent.change(screen.getByLabelText("Friday closes at"), {
      target: { value: "02:00" },
    });
    expect(screen.getByText("next day")).toBeInTheDocument();
  });

  it("★ checks before sending: a reply that is on needs words", async () => {
    render(<AutoRepliesForm view={view()} />);
    fireEvent.click(screen.getByRole("switch", { name: "Welcome message" }));
    fireEvent.change(screen.getByLabelText("Welcome message text"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(toast.error).toHaveBeenCalledWith(
      "Write a welcome message, or turn the welcome message off.",
    );
    expect(h.save).not.toHaveBeenCalled();
  });

  it("a viewer without Inbox: manage can read but not change anything", () => {
    render(<AutoRepliesForm view={view({ canManage: false })} />);
    expect(
      screen.getByRole("switch", { name: "Welcome message" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Away message text")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
  });
});

describe("AutoRepliesForm: menu buttons", () => {
  it("starts off with no buttons and lets the merchant add up to three", () => {
    render(<AutoRepliesForm view={view()} />);
    expect(
      screen.getByRole("switch", { name: "Menu buttons" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByLabelText("Menu button 1 label")).toBeNull();
    const add = () =>
      fireEvent.click(screen.getByRole("button", { name: "Add a button" }));
    add();
    add();
    add();
    expect(screen.getByLabelText("Menu button 3 label")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a button" })).toBeNull();
    expect(screen.getByText(/WhatsApp allows 3 buttons/)).toBeInTheDocument();
  });

  it("★ saves the buttons with what each does, and keeps their generated ids", async () => {
    render(<AutoRepliesForm view={view()} />);
    fireEvent.click(screen.getByRole("switch", { name: "Menu buttons" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a button" }));
    fireEvent.change(screen.getByLabelText("Menu button 1 label"), {
      target: { value: "Check my order" },
    });
    fireEvent.change(screen.getByLabelText("Menu button 1 action"), {
      target: { value: "order_status" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add a button" }));
    fireEvent.change(screen.getByLabelText("Menu button 2 label"), {
      target: { value: "Talk to a person" },
    });
    fireEvent.change(screen.getByLabelText("Menu button 2 action"), {
      target: { value: "person" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(h.save).toHaveBeenCalled());
    const saved = h.save.mock.calls[0][0];
    expect(saved.menuEnabled).toBe(true);
    expect(saved.menuButtons).toEqual([
      {
        id: expect.stringMatching(/^b[a-z0-9]+$/),
        title: "Check my order",
        action: "order_status",
        text: "",
      },
      {
        id: expect.stringMatching(/^b[a-z0-9]+$/),
        title: "Talk to a person",
        action: "person",
        text: "",
      },
    ]);
    expect(saved.menuButtons[0].id).not.toBe(saved.menuButtons[1].id);
  });

  it("★ checks before sending: a menu that is on needs a button, and a message button needs words", async () => {
    render(<AutoRepliesForm view={view()} />);
    fireEvent.click(screen.getByRole("switch", { name: "Menu buttons" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(toast.error).toHaveBeenCalledWith(
      "Add at least one menu button, or turn the menu off.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add a button" }));
    fireEvent.change(screen.getByLabelText("Menu button 1 label"), {
      target: { value: "Hours" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(toast.error).toHaveBeenCalledWith(
      'Write the message "Hours" sends, or change what it does.',
    );
    expect(h.save).not.toHaveBeenCalled();
  });

  it("removing a button drops it; a label is capped at 20 characters", () => {
    render(<AutoRepliesForm view={view()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a button" }));
    expect(screen.getByLabelText("Menu button 1 label")).toHaveAttribute(
      "maxlength",
      "20",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove menu button 1" }),
    );
    expect(screen.queryByLabelText("Menu button 1 label")).toBeNull();
  });
});

describe("AutoRepliesForm: Mink AI answers", () => {
  it("starts off, and switching it on offers the two ways with helps first", () => {
    render(<AutoRepliesForm view={view()} />);
    const toggle = screen.getByRole("switch", { name: "Mink AI answers" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("radio", { name: /Answers customers/ }),
    ).toBeDisabled();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("radio", { name: /Answers customers/ }),
    ).toBeChecked();
    expect(
      screen.getByText(/Replies that are sent use Mink credits/),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d+\s*Mink credits?/);
  });

  it("★ saves the chosen mode, and off again as off", async () => {
    render(<AutoRepliesForm view={view()} />);
    fireEvent.click(screen.getByRole("switch", { name: "Mink AI answers" }));
    fireEvent.click(
      screen.getByRole("radio", { name: /Drafts replies for you/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(h.save).toHaveBeenCalled());
    expect(h.save.mock.calls[0][0]).toMatchObject({ minkMode: "drafts" });
    await screen.findByRole("button", { name: "Save changes" });

    fireEvent.click(screen.getByRole("switch", { name: "Mink AI answers" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(2));
    expect(h.save.mock.calls[1][0]).toMatchObject({ minkMode: "off" });
  });
});
