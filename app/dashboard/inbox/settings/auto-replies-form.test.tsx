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
