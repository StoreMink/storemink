// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WhatsAppTemplatePanel } from "./whatsapp-template-panel";
import type { WhatsAppEventTemplate } from "@/app/actions/whatsapp-provider-actions";

const base: WhatsAppEventTemplate = {
  audience: "customer",
  name: "sm_order_placed_customer_v1",
  status: "APPROVED",
  rejectionReason: null,
  syncError: null,
  lastSyncedAt: null,
  body: "Order {{1}} received.",
  variables: ["subject_label"],
  variant: null,
  buttons: [],
};
const cod: WhatsAppEventTemplate = {
  ...base,
  name: "sm_order_placed_customer_cod_confirm_v1",
  status: "PENDING",
  body: "Please confirm order {{1}}.",
  variant: "cod_confirm",
  buttons: ["Confirm order", "Cancel order"],
};

describe("WhatsAppTemplatePanel", () => {
  it("★ shows the plain message first and the COD one after it, with its buttons", () => {
    render(
      <WhatsAppTemplatePanel
        audience="customer"
        templates={[cod, base]}
        connected
        variables={[{ name: "subject_label", sample: "ORD1" }]}
      />,
    );
    const names = screen
      .getAllByText(/^sm_order_placed_customer/)
      .map((n) => n.textContent);
    expect(names).toEqual([base.name, cod.name]);
    expect(screen.getByText("Cash-on-delivery orders")).toBeTruthy();
    expect(screen.getByText("Please confirm order ORD1.")).toBeTruthy();
    expect(screen.getByText("Confirm order")).toBeTruthy();
    expect(screen.getByText("Cancel order")).toBeTruthy();
  });

  it("an ordinary notification shows one card and no COD heading", () => {
    render(
      <WhatsAppTemplatePanel
        audience="customer"
        templates={[base]}
        connected
        variables={[]}
      />,
    );
    expect(screen.queryByText("Cash-on-delivery orders")).toBeNull();
    expect(screen.queryByLabelText("Buttons")).toBeNull();
  });
});
