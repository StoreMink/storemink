// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({
  submit: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  routerRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.routerRefresh }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/app/actions/whatsapp-provider-actions", () => ({
  submitWhatsAppTemplate: h.submit,
  deleteWhatsAppTemplate: h.remove,
  refreshWhatsAppTemplates: h.refresh,
}));

import { toast } from "sonner";
import { TemplatesClient } from "./templates-client";
import type { ManagedTemplate } from "@/lib/whatsapp/templates";

const row = (over: Partial<ManagedTemplate> = {}): ManagedTemplate => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "delivery_delay",
  language: "en",
  category: "UTILITY",
  status: "APPROVED",
  rejectionReason: null,
  syncError: null,
  quality: null,
  lastSyncedAt: null,
  createdAt: "2026-10-14T00:00:00Z",
  catalogue: false,
  eventKey: null,
  audience: "customer",
  headerText: "",
  body: "Hi {{1}}, your order is late.",
  footerText: "",
  variables: ["customer_name"],
  buttons: [],
  sendableFromInbox: true,
  ...over,
});

function view(
  over: Partial<Parameters<typeof TemplatesClient>[0]["view"]> = {},
) {
  return {
    connected: true,
    status: "connected",
    canManage: true,
    templates: [
      row(),
      row({
        id: "22222222-2222-4222-8222-222222222222",
        name: "sm_order_placed_customer_v1",
        catalogue: true,
        eventKey: "order.placed",
        status: "REJECTED",
        rejectionReason: "INVALID_FORMAT",
        sendableFromInbox: false,
      }),
    ],
    ...over,
  };
}

beforeEach(() => {
  h.submit.mockResolvedValue({ success: true, id: "x", status: "PENDING" });
  h.remove.mockResolvedValue({ success: true });
  window.confirm = vi.fn(() => true);
});

describe("TemplatesClient", () => {
  it("lists every template with Meta's status and reason; only the merchant's own can be deleted", () => {
    render(<TemplatesClient view={view()} />);
    expect(screen.getByText("delivery_delay")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(
      screen.getByText(/Meta's reason: INVALID_FORMAT/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete delivery_delay" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Delete sm_order_placed_customer_v1",
      }),
    ).toBeNull();
  });

  it("★ the editor refuses before sending, and sends the checked template", async () => {
    render(<TemplatesClient view={view()} />);
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    fireEvent.change(screen.getByLabelText("Template title"), {
      target: { value: "Back in stock" },
    });
    expect(screen.getByLabelText("Template name")).toHaveValue("back_in_stock");
    fireEvent.change(screen.getByLabelText("Template message"), {
      target: { value: "{{1}} is back in stock" },
    });
    fireEvent.change(screen.getByLabelText("Placeholder 1 label"), {
      target: { value: "product" },
    });
    fireEvent.change(screen.getByLabelText("Placeholder 1 sample"), {
      target: { value: "Almond shake" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send to Meta for review" }),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "The message cannot start with a placeholder; add a word before it.",
    );
    expect(h.submit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Template message"), {
      target: { value: "Good news: {{1}} is back in stock." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send to Meta for review" }),
    );
    await waitFor(() => expect(h.submit).toHaveBeenCalled());
    expect(h.submit.mock.calls[0][0]).toEqual({
      name: "back_in_stock",
      language: "en",
      category: "UTILITY",
      headerText: "",
      body: "Good news: {{1}} is back in stock.",
      variables: [{ name: "product", sample: "Almond shake" }],
      footerText: "",
      buttons: [],
    });
  });

  it("a viewer sees the list and no way to add or delete; a reconnect-needed number cannot submit", () => {
    render(<TemplatesClient view={view({ canManage: false })} />);
    expect(screen.queryByRole("button", { name: "New template" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
    render(<TemplatesClient view={view({ status: "needs_reauth" })} />);
    expect(screen.queryByRole("button", { name: "New template" })).toBeNull();
    expect(screen.getByText(/Reconnect WhatsApp/)).toBeInTheDocument();
  });

  it("delete asks first, then calls the action with the id", async () => {
    render(<TemplatesClient view={view()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete delivery_delay" }),
    );
    await waitFor(() =>
      expect(h.remove).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
      ),
    );
    expect(window.confirm).toHaveBeenCalled();
  });
});
