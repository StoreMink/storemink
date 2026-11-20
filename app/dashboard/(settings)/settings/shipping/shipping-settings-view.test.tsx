// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeMinkPrefill, takeMinkPrefill } from "@/lib/mink/form-prefill";
import { DEFAULT_SHIPPING_SETTINGS } from "@/lib/shipping/types";
import { ShippingSettingsView } from "./shipping-settings-view";
import type { ShippingSettingsState } from "@/app/actions/shipping-actions";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/shipping-actions", () => ({
  saveShippingSettings: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...p }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...p}>
      {children}
    </a>
  ),
}));

const NOTICE = "Filled in by Mink AI. Review every field before saving.";

function state(
  over: Partial<ShippingSettingsState> = {},
): ShippingSettingsState {
  return {
    settings: {
      ...DEFAULT_SHIPPING_SETTINGS,
      mode: "flat",
      flatRate: 49,
      freeAbove: 999,
      manualMinDays: 3,
      manualMaxDays: 7,
      handlingDays: 1,
    },
    shiprocketConnected: false,
    shiprocketEnabled: false,
    ...over,
  };
}

describe("ShippingSettingsView with a Mink prefill", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/dashboard/settings/shipping");
  });

  it("merges the fields over the loaded settings and says so", () => {
    storeMinkPrefill({
      kind: "shipping",
      fields: {
        mode: "flat",
        flatRate: 79,
        freeAbove: 1500,
        manualMinDays: 2,
        manualMaxDays: 5,
      },
    });
    window.history.replaceState(null, "", "?prefill=mink");
    render(<ShippingSettingsView initial={state()} canManage />);

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByLabelText("Charge per order (₹)")).toHaveValue(79);
    expect(screen.getByLabelText("Minimum days")).toHaveValue(2);
    expect(screen.getByLabelText("Maximum days")).toHaveValue(5);
    expect(
      screen.getByLabelText("Free shipping when the basket reaches"),
    ).toBeChecked();
    expect(screen.getByLabelText("Basket subtotal (₹)")).toHaveValue(1500);
    // The merchant still presses Save.
    expect(
      screen.getByRole("button", { name: "Save shipping settings" }),
    ).toBeEnabled();
    expect(takeMinkPrefill("shipping")).toBeNull();
    expect(window.location.search).not.toContain("prefill");
  });

  it("keeps the current mode when live rates are asked for without Shiprocket", () => {
    storeMinkPrefill({
      kind: "shipping",
      fields: { mode: "shiprocket", handlingDays: 3 },
    });
    window.history.replaceState(null, "", "?prefill=mink");
    render(<ShippingSettingsView initial={state()} canManage />);
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    // Still the fixed rate: the handling field belongs to live rates and is
    // not shown, and the flat charge is the saved one.
    expect(screen.getByLabelText("Charge per order (₹)")).toHaveValue(49);
    expect(screen.queryByLabelText("Handling time (days)")).toBeNull();
  });

  it("renders the saved settings untouched without the flag", () => {
    storeMinkPrefill({ kind: "shipping", fields: { flatRate: 79 } });
    render(<ShippingSettingsView initial={state()} canManage />);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Charge per order (₹)")).toHaveValue(49);
    expect(screen.getByLabelText("Basket subtotal (₹)")).toHaveValue(999);
    expect(takeMinkPrefill("shipping")).toEqual({ flatRate: 79 });
  });
});
