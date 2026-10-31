// @vitest-environment jsdom
// Billing & tax: the way into the refunds queue, the switch that decides
// whether owed refunds leave without a person (renewal-cancel, design 7.1),
// and the GST cards (GST design 6): status, StoreMink's tax identity,
// Charging GST and the monthly invoice list.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GstImpactResult } from "@/lib/billing/gst-impact";
import type { PlatformTaxSettings } from "@/lib/billing/invoice-types";
import type { RefundsNeedingAction } from "@/lib/billing/refunds";

/** 29 October 2026, 12:00 IST. */
const NOW = "2026-10-29T06:30:00.000Z";
/** 1 December 2026, 00:00 IST. */
const START = "2026-11-30T18:30:00.000Z";

const H = vi.hoisted(() => ({
  viewer: { email: "ops@storemink.com", role: "superadmin" } as {
    email: string;
    role: "superadmin" | "member";
  } | null,
  openItems: 0,
  refunds: null as RefundsNeedingAction | null,
  settings: null as unknown as PlatformTaxSettings,
  /** False: the settings row could not be read (review R3-05). */
  readOk: true,
  notices: [] as unknown,
  refresh: vi.fn(),
  setAutoRefunds: vi.fn(),
  saveTaxIdentitySettings: vi.fn(),
  scheduleGstChange: vi.fn(),
  cancelGstChange: vi.fn(),
  getGstChangePreview: vi.fn(),
  exportInvoiceList: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
  useRouter: () => ({ refresh: H.refresh }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function settings(
  over: Partial<PlatformTaxSettings> = {},
): PlatformTaxSettings {
  return {
    legalName: "STOREMINK LLP",
    gstin: "03ABCDE1234F1Z5",
    address: {
      line1: "Bala ji Colony",
      city: "Faridkot",
      postalCode: "151203",
    },
    stateCode: "03",
    taxEnabled: false,
    taxRateBps: 1800,
    taxInclusive: false,
    invoicePrefix: "SM",
    updatedAt: null,
    updatedBy: null,
    autoRefunds: false,
    nextTax: null,
    sacCode: "998314",
    llpin: "ADC-5432",
    registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
    ...over,
  };
}

vi.mock("@/app/actions/platform", () => ({
  getPlatformViewer: vi.fn(async () => H.viewer),
  getOpenReconciliationCount: vi.fn(async () => H.openItems),
  getTaxSettings: vi.fn(async () =>
    H.readOk
      ? { ok: true, settings: H.settings }
      : { ok: false, reason: "read_failed" },
  ),
  getPlanPricingForConsole: vi.fn(async () => ({
    pricing: {
      free: { monthlyInr: 0, yearlyInr: 0 },
      basic: { monthlyInr: 1500, yearlyInr: 15000 },
      pro: { monthlyInr: 2400, yearlyInr: 24000 },
    },
    extraLocation: { monthlyInr: 1000, yearlyInr: 10000 },
  })),
  getGstChangeNotices: vi.fn(async () => H.notices),
  saveTaxIdentitySettings: H.saveTaxIdentitySettings,
  scheduleGstChange: H.scheduleGstChange,
  cancelGstChange: H.cancelGstChange,
  getGstChangePreview: H.getGstChangePreview,
  exportInvoiceList: H.exportInvoiceList,
}));
vi.mock("@/app/actions/platform-billing", () => ({
  countRefundsNeedingAction: vi.fn(async () => H.refunds),
  setAutoRefunds: H.setAutoRefunds,
}));
// What the page falls back to when the row cannot be read: the module's own
// defaults, written out (the module itself is server-only).
vi.mock("@/lib/billing/platform-settings", () => ({
  DEFAULT_TAX_SETTINGS: {
    legalName: null,
    gstin: null,
    address: {},
    stateCode: null,
    taxEnabled: false,
    taxRateBps: 1800,
    taxInclusive: false,
    invoicePrefix: "SM",
    updatedAt: null,
    updatedBy: null,
    autoRefunds: false,
    nextTax: null,
    sacCode: null,
    llpin: null,
    registeredOffice: null,
  },
}));

import { toast } from "sonner";
import PlatformBillingPage from "./page";
import { TaxStatus } from "./tax-status";

function counts(total: number): RefundsNeedingAction {
  return { failed: total, owed: 0, pending: 0, held: 0, total, oldestAt: null };
}

/** A preview with one store and more renewals than the table keeps. */
function impact(): GstImpactResult {
  return {
    ok: true,
    impact: {
      before: { enabled: false, inclusive: false, rateBps: 0 },
      after: { enabled: true, inclusive: true, rateBps: 1800 },
      renewals: 250,
      counts: {
        rise: 2,
        byHand: 0,
        aboveMandate: 0,
        aboveAfaLimit: 0,
        noState: 1,
        fromAddress: 0,
        outsideIndia: 0,
        supplierStateCode: "03",
      },
      rows: [
        {
          storeId: "store-1",
          storeName: "Acme Retail",
          storeSlug: "acme",
          plan: "pro",
          period: "monthly",
          billedLocations: 0,
          renewsOn: START,
          todayPaise: 240_000,
          afterPaise: 283_200,
          routeToday: { auto: true },
          routeAfter: { auto: false, reason: "no_mandate" },
          placeOfSupply: { code: "03", basis: "supplier_state" },
          countryName: null,
        } as never,
      ],
      truncated: true,
    },
  };
}

async function renderPage() {
  render(await PlatformBillingPage());
}

function card(title: string): HTMLElement {
  return screen.getByRole("heading", { name: title }).closest("section")!;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  H.viewer = { email: "ops@storemink.com", role: "superadmin" };
  H.openItems = 0;
  H.refunds = counts(0);
  H.settings = settings();
  H.readOk = true;
  H.notices = [];
  H.getGstChangePreview.mockResolvedValue(impact());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("the page", () => {
  it("opens with design 6.1's intro", async () => {
    await renderPage();
    expect(
      screen.getByText(
        "What StoreMink's own invoices say (plans, extra locations and Mink credit packs) and whether they charge GST. This is StoreMink's tax identity, not a merchant's. A merchant's own tax settings live in their dashboard.",
      ),
    ).toBeTruthy();
  });

  it("★ shows the cards in order, with the refunds card last", async () => {
    await renderPage();
    const titles = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(titles).toEqual([
      "GST status",
      "StoreMink's tax identity",
      "Charging GST",
      "Monthly invoice list",
      "Refunds",
    ]);
  });
});

describe("the refunds banner", () => {
  it("says how many refunds need a look and links to the queue", async () => {
    H.refunds = counts(3);
    await renderPage();
    const banner = screen.getByText(/need a look/).closest("a");
    expect(banner?.textContent).toContain("3 refunds");
    expect(banner?.getAttribute("href")).toBe("/dashboard/billing/refunds");
    expect(screen.queryByText("Refunds and credit notes →")).toBeNull();
  });

  it("reads in the singular for one", async () => {
    H.refunds = counts(1);
    await renderPage();
    expect(
      screen.getByText(/needs a look/).closest("a")?.textContent,
    ).toContain("1 refund");
  });

  it("★★ at zero the way in stays, quietly", async () => {
    await renderPage();
    expect(screen.queryByText(/refunds? needs? a look/)).toBeNull();
    const quiet = screen.getByRole("link", {
      name: "Refunds and credit notes →",
    });
    expect(quiet.getAttribute("href")).toBe("/dashboard/billing/refunds");
  });

  it("★ says so when the count could not be read, rather than showing zero as an answer", async () => {
    H.refunds = null;
    await renderPage();
    expect(
      screen.getByText(
        "The refunds that need a look couldn't be counted just now.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Refunds and credit notes →" }),
    ).toBeTruthy();
  });

  it("keeps the reconciliation banner beside it", async () => {
    H.openItems = 2;
    H.refunds = counts(1);
    await renderPage();
    expect(
      screen
        .getByText(/payment discrepancies/)
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("/dashboard/billing/reconciliation");
  });

  it("★ the banners stay above the cards", async () => {
    H.refunds = counts(2);
    await renderPage();
    const banner = screen.getByText(/need a look/).closest("a")!;
    const status = card("GST status");
    expect(
      banner.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("★★ settings that could not be read (review R3-05)", () => {
  beforeEach(() => {
    H.readOk = false;
  });

  it("★★ the status card says so, and never says no GST is charged", async () => {
    await renderPage();
    const status = card("GST status");
    expect(
      within(status).getByTestId("tax-status-unreadable").textContent,
    ).toBe(
      "Couldn't read the billing and tax settings, so nothing on this page can be saved. Refresh the page to try again.",
    );
    expect(within(status).queryByTestId("tax-status-sentence")).toBeNull();
    expect(screen.queryByText(/No GST is being charged/)).toBeNull();
    // The defaults have no LLPIN; that is not news about the stored row.
    expect(screen.queryByText(/LLP's particulars yet/)).toBeNull();
  });

  it("★★ every save on the page is disabled, for a superadmin too", async () => {
    await renderPage();
    const id = card("StoreMink's tax identity");
    expect(
      (
        within(id).getByRole("button", {
          name: "Save tax identity",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (within(id).getByLabelText("GSTIN") as HTMLInputElement).disabled,
    ).toBe(true);
    const c = card("Charging GST");
    expect(
      (within(c).getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (within(c).getByLabelText("Charge GST") as HTMLInputElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(
      true,
    );
    // The superadmin is not told they lack the role: they don't.
    expect(
      screen.queryByText("Only a platform superadmin can change these."),
    ).toBeNull();
  });

  it("★ the status card offers no cancel while unreadable, whatever it holds", () => {
    // The page passes the defaults (no change), so this renders the card
    // itself with a change, to pin its own gate.
    render(
      <TaxStatus
        settings={settings({
          nextTax: {
            enabled: true,
            inclusive: true,
            rateBps: 1800,
            startsAt: START,
            noticeId: null,
          },
        })}
        canEdit
        now={NOW}
        unreadable
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Cancel this change" }),
    ).toBeNull();
    expect(screen.getByTestId("tax-status-unreadable")).toBeTruthy();
  });

  it("the monthly invoice list stays: it reads nothing from the settings", async () => {
    await renderPage();
    expect(card("Monthly invoice list")).toBeTruthy();
  });
});

describe("Card 1, GST status (design 6.2)", () => {
  it("says no GST is charged while it is off", async () => {
    await renderPage();
    expect(
      within(card("GST status")).getByTestId("tax-status-sentence").textContent,
    ).toBe("No GST is being charged. Invoices show no GST.");
  });

  it("names a scheduled switch-on, in IST", async () => {
    H.settings = settings({
      nextTax: {
        enabled: true,
        inclusive: false,
        rateBps: 1800,
        startsAt: START,
        noticeId: null,
      },
    });
    await renderPage();
    expect(
      within(card("GST status")).getByTestId("tax-status-sentence").textContent,
    ).toBe(
      "No GST is being charged yet. From 1 December 2026, 00:00 IST, GST at 18% is added to every price.",
    );
  });

  it("says what is charged while it is on", async () => {
    H.settings = settings({ taxEnabled: true, taxInclusive: true });
    await renderPage();
    expect(
      within(card("GST status")).getByTestId("tax-status-sentence").textContent,
    ).toBe(
      "GST is being charged at 18%, included in every price: plans, extra locations and Mink credit packs.",
    );
    expect(
      within(card("GST status")).queryByRole("button", {
        name: "Cancel this change",
      }),
    ).toBeNull();
  });

  it("★ reads a change whose start has passed as started", async () => {
    H.settings = settings({
      nextTax: {
        enabled: true,
        inclusive: true,
        rateBps: 1800,
        startsAt: "2026-10-01T00:00:00.000Z",
        noticeId: null,
      },
    });
    await renderPage();
    expect(
      within(card("GST status")).getByTestId("tax-status-sentence").textContent,
    ).toMatch(/^GST is being charged at 18%, included in every price/);
  });

  it("★★ cancels a scheduled change after a confirmation, then reloads", async () => {
    H.cancelGstChange.mockResolvedValue({ success: true });
    H.settings = settings({
      taxEnabled: true,
      taxInclusive: true,
      nextTax: {
        enabled: true,
        inclusive: false,
        rateBps: 1800,
        startsAt: START,
        noticeId: "n-1",
      },
    });
    await renderPage();
    const status = card("GST status");
    expect(within(status).getByTestId("tax-status-sentence").textContent).toBe(
      "GST is being charged at 18%, included in every price: plans, extra locations and Mink credit packs. From 1 December 2026, 00:00 IST: GST at 18% is added to every price.",
    );
    fireEvent.click(
      within(status).getByRole("button", { name: "Cancel this change" }),
    );
    expect(
      within(status).getByText(
        "Cancel the change scheduled for 1 December 2026, 00:00 IST? If you sent merchants a notice, tell them it won't happen.",
      ),
    ).toBeTruthy();
    expect(H.cancelGstChange).not.toHaveBeenCalled();
    fireEvent.click(
      within(status).getByRole("button", { name: "Cancel the change" }),
    );
    await waitFor(() => expect(H.cancelGstChange).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Scheduled change cancelled."),
    );
    expect(H.refresh).toHaveBeenCalled();
  });

  it("★ a refusal (the change started) is shown and the card reloads", async () => {
    H.cancelGstChange.mockResolvedValue({
      error:
        "This change has already started. To stop charging GST, choose Don't charge GST under Charging GST.",
    });
    H.settings = settings({
      nextTax: {
        enabled: true,
        inclusive: true,
        rateBps: 1800,
        startsAt: START,
        noticeId: null,
      },
    });
    await renderPage();
    const status = card("GST status");
    fireEvent.click(
      within(status).getByRole("button", { name: "Cancel this change" }),
    );
    fireEvent.click(
      within(status).getByRole("button", { name: "Cancel the change" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "This change has already started. To stop charging GST, choose Don't charge GST under Charging GST.",
      ),
    );
    expect(H.refresh).toHaveBeenCalled();
  });

  it("Keep it closes the confirmation without cancelling", async () => {
    H.settings = settings({
      nextTax: {
        enabled: true,
        inclusive: true,
        rateBps: 1800,
        startsAt: START,
        noticeId: null,
      },
    });
    await renderPage();
    const status = card("GST status");
    fireEvent.click(
      within(status).getByRole("button", { name: "Cancel this change" }),
    );
    fireEvent.click(within(status).getByRole("button", { name: "Keep it" }));
    expect(H.cancelGstChange).not.toHaveBeenCalled();
    expect(
      within(status).getByRole("button", { name: "Cancel this change" }),
    ).toBeTruthy();
  });

  it("★ a member sees the scheduled change but cannot cancel it", async () => {
    H.viewer = { email: "member@storemink.com", role: "member" };
    H.settings = settings({
      nextTax: {
        enabled: true,
        inclusive: true,
        rateBps: 1800,
        startsAt: START,
        noticeId: null,
      },
    });
    await renderPage();
    expect(
      within(card("GST status")).queryByRole("button", {
        name: "Cancel this change",
      }),
    ).toBeNull();
  });

  it("★ warns, whatever the GST state, while the LLP's particulars are missing", async () => {
    H.settings = settings({ llpin: null });
    await renderPage();
    expect(
      within(card("GST status")).getByText(
        "Invoices don't show the LLP's particulars yet. The LLP Act asks for the LLPIN and the registered office on every invoice. Add them under StoreMink's tax identity.",
      ),
    ).toBeTruthy();
    cleanup();
    H.settings = settings({ taxEnabled: true, registeredOffice: "  " });
    await renderPage();
    expect(
      within(card("GST status")).getByText(/LLP's particulars yet/),
    ).toBeTruthy();
  });

  it("says nothing about the LLP once both are filled in", async () => {
    await renderPage();
    expect(screen.queryByText(/LLP's particulars yet/)).toBeNull();
  });
});

describe("Card 2, StoreMink's tax identity (design 6.3)", () => {
  it("shows every field with its label, hint and placeholder", async () => {
    await renderPage();
    const id = card("StoreMink's tax identity");
    expect(
      (within(id).getByLabelText("Registered legal name") as HTMLInputElement)
        .placeholder,
    ).toBe("STOREMINK LLP");
    expect(
      within(id).getByText(
        "The entity issuing the invoice, exactly as on the GST registration.",
      ),
    ).toBeTruthy();
    expect(
      (within(id).getByLabelText("GSTIN") as HTMLInputElement).placeholder,
    ).toBe("03ABCDE1234F1Z5");
    expect(within(id).getByLabelText("State")).toBeTruthy();
    expect(
      within(id).getByLabelText("Address printed on invoices"),
    ).toBeTruthy();
    expect(
      (within(id).getByLabelText("SAC code") as HTMLInputElement).value,
    ).toBe("998314");
    expect((within(id).getByLabelText("LLPIN") as HTMLInputElement).value).toBe(
      "ADC-5432",
    );
    expect(
      (within(id).getByLabelText("Invoice number prefix") as HTMLInputElement)
        .maxLength,
    ).toBe(2);
  });

  it("★ Use the address above copies the address into the registered office", async () => {
    H.settings = settings({ registeredOffice: null });
    await renderPage();
    const id = card("StoreMink's tax identity");
    fireEvent.click(
      within(id).getByRole("button", { name: "Use the address above" }),
    );
    expect(
      (within(id).getByLabelText("Registered office") as HTMLInputElement)
        .value,
    ).toBe("Bala ji Colony, Faridkot, 151203");
  });

  it("★★ saves through saveTaxIdentitySettings, with every field", async () => {
    H.saveTaxIdentitySettings.mockResolvedValue({ success: true });
    await renderPage();
    const id = card("StoreMink's tax identity");
    fireEvent.change(within(id).getByLabelText("LLPIN"), {
      target: { value: "abc-1234" },
    });
    fireEvent.click(
      within(id).getByRole("button", { name: "Save tax identity" }),
    );
    await waitFor(() =>
      expect(H.saveTaxIdentitySettings).toHaveBeenCalledWith({
        legalName: "STOREMINK LLP",
        gstin: "03ABCDE1234F1Z5",
        stateCode: "03",
        addressLine1: "Bala ji Colony",
        addressLine2: "",
        city: "Faridkot",
        postalCode: "151203",
        sacCode: "998314",
        llpin: "ABC-1234",
        registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
        invoicePrefix: "SM",
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Tax identity saved."),
    );
  });

  it("a refusal is shown under the button", async () => {
    H.saveTaxIdentitySettings.mockResolvedValue({
      error: "The SAC code is 6 digits starting with 99, for example 998314.",
    });
    await renderPage();
    const id = card("StoreMink's tax identity");
    fireEvent.click(
      within(id).getByRole("button", { name: "Save tax identity" }),
    );
    expect((await within(id).findByRole("alert")).textContent).toBe(
      "The SAC code is 6 digits starting with 99, for example 998314.",
    );
  });

  it("★★ a member sees the identity, cannot change it, and is told why", async () => {
    H.viewer = { email: "member@storemink.com", role: "member" };
    await renderPage();
    const id = card("StoreMink's tax identity");
    expect(
      (within(id).getByLabelText("GSTIN") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (
        within(id).getByRole("button", {
          name: "Save tax identity",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      within(id).getByText("Only a platform superadmin can change these."),
    ).toBeTruthy();
  });
});

describe("Card 3, Charging GST (design 6.4)", () => {
  it("shows the choice and the amber note; nothing to preview while nothing changes", async () => {
    await renderPage();
    const c = card("Charging GST");
    expect(
      (within(c).getByLabelText("Don't charge GST") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      within(c).getByText(
        "The pricing page, signup and every price in merchants' dashboards read this setting, so they change with it. Prices that exclude GST raise every bill: send the notice first.",
      ),
    ).toBeTruthy();
    expect(within(c).getByRole("button", { name: "Save" })).toBeTruthy();
    expect(H.getGstChangePreview).not.toHaveBeenCalled();
  });

  it("★ the price-mode examples use the live Basic monthly price", async () => {
    await renderPage();
    const c = card("Charging GST");
    fireEvent.click(within(c).getByLabelText("Charge GST"));
    expect(
      within(c).getByText(
        "A ₹1,500 plan is still billed ₹1,500, of which ₹228.81 is GST. Nobody's bill changes; StoreMink keeps less of each payment.",
      ),
    ).toBeTruthy();
    expect(
      within(c).getByText(
        "A ₹1,500 plan is billed ₹1,770. Every merchant's bill goes up, so this needs 1 month's notice.",
      ),
    ).toBeTruthy();
  });

  it("★★ switching GST on now: the impact, its warning, the confirmation, then the save", async () => {
    H.scheduleGstChange.mockResolvedValue({
      ok: true,
      applied: "now",
      startsAt: null,
    });
    await renderPage();
    const c = card("Charging GST");
    fireEvent.click(within(c).getByLabelText("Charge GST"));
    fireEvent.click(within(c).getByLabelText(/^Prices include GST/));

    // The impact panel, from the preview action.
    expect(
      await within(c).findByText("2 renewals will cost more."),
    ).toBeTruthy();
    expect(H.getGstChangePreview).toHaveBeenLastCalledWith({
      enabled: true,
      inclusive: true,
      ratePercent: 18,
    });
    expect(
      within(c).getByText("What this changes for merchants with a plan"),
    ).toBeTruthy();
    const table = within(c).getByRole("table");
    expect(within(table).getByText("Acme Retail")).toBeTruthy();
    expect(within(table).getByText("Pro, monthly")).toBeTruthy();
    expect(within(table).getByText("₹2,832")).toBeTruthy();
    expect(within(table).getByText("By hand: no autopay")).toBeTruthy();
    expect(within(table).getByText("None: Punjab used")).toBeTruthy();
    expect(
      within(c).getByText("Showing the 1 renewal that needs a look first."),
    ).toBeTruthy();

    // The warning first, because a store has no state.
    fireEvent.click(
      within(c).getByRole("button", { name: "Switch GST on now" }),
    );
    expect(
      within(c).getByText(
        "1 store has no state on record. You can still schedule this; consider waiting until more of them have added a state.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(c).getByRole("button", { name: "Schedule anyway" }));

    // Then the confirmation for "now".
    expect(
      within(c).getByText(
        "Switch GST on now? Invoices built from now charge GST at 18%, included in every price.",
      ),
    ).toBeTruthy();
    expect(H.scheduleGstChange).not.toHaveBeenCalled();
    fireEvent.click(within(c).getByRole("button", { name: "Switch GST on" }));
    await waitFor(() =>
      expect(H.scheduleGstChange).toHaveBeenCalledWith({
        enabled: true,
        inclusive: true,
        ratePercent: "18",
        when: "now",
        startsAt: undefined,
        noticeId: null,
        rateSetByLaw: false,
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("GST settings saved."),
    );
    expect(H.refresh).toHaveBeenCalled();
  });

  it("Not yet and Go back leave the change unsaved", async () => {
    await renderPage();
    const c = card("Charging GST");
    fireEvent.click(within(c).getByLabelText("Charge GST"));
    fireEvent.click(within(c).getByLabelText(/^Prices include GST/));
    await within(c).findByText("2 renewals will cost more.");
    fireEvent.click(
      within(c).getByRole("button", { name: "Switch GST on now" }),
    );
    fireEvent.click(within(c).getByRole("button", { name: "Go back" }));
    fireEvent.click(
      within(c).getByRole("button", { name: "Switch GST on now" }),
    );
    fireEvent.click(within(c).getByRole("button", { name: "Schedule anyway" }));
    fireEvent.click(within(c).getByRole("button", { name: "Not yet" }));
    expect(H.scheduleGstChange).not.toHaveBeenCalled();
  });

  it("★ a preview that could not be read says so", async () => {
    H.getGstChangePreview.mockResolvedValue({
      ok: false,
      reason: "read_failed",
    });
    await renderPage();
    const c = card("Charging GST");
    fireEvent.click(within(c).getByLabelText("Charge GST"));
    expect(
      await within(c).findByText(
        "Couldn't work out what this changes. Please try again.",
      ),
    ).toBeTruthy();
  });

  it("★★ a rise asks for the notice, lists every Operational notice and schedules with it", async () => {
    H.notices = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "GST from December",
        sentAt: "2026-10-20T09:30:00.000Z",
        sent: 12,
        failed: 1,
        check: { ok: true },
        earliestStart: "2026-11-20T09:30:00.000Z",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        title: "SMS only",
        sentAt: "2026-10-21T09:30:00.000Z",
        sent: 4,
        failed: 0,
        check: { ok: false, reason: "not_email" },
        earliestStart: null,
      },
    ];
    H.scheduleGstChange.mockResolvedValue({
      ok: true,
      applied: "scheduled",
      startsAt: START,
    });
    await renderPage();
    const c = card("Charging GST");
    fireEvent.click(within(c).getByLabelText("Charge GST"));
    // Prices exclude GST (the saved mode): every bill rises.
    const select = within(c).getByLabelText(
      "Notice email",
    ) as HTMLSelectElement;
    const options = Array.from(select.options);
    expect(options.map((o) => o.textContent)).toEqual([
      "Choose the notice",
      "GST from December, sent 20 Oct 2026: 12 delivered, 1 failed",
      "SMS only, sent 21 Oct 2026: 4 delivered, 0 failed (not by email)",
    ]);
    expect(options[2].disabled).toBe(true);
    expect(
      within(c)
        .getByRole("link", { name: "Write the notice in Announcements" })
        .getAttribute("href"),
    ).toBe("/dashboard/announcements");

    fireEvent.click(within(c).getByLabelText("From a date and time"));
    fireEvent.change(
      within(c).getByLabelText("From a date and time", {
        selector: "input[type=datetime-local]",
      }),
      { target: { value: "2026-12-01T00:00" } },
    );
    fireEvent.change(select, {
      target: { value: "11111111-1111-4111-8111-111111111111" },
    });
    await within(c).findByText("2 renewals will cost more.");
    fireEvent.click(
      within(c).getByRole("button", { name: "Schedule this change" }),
    );
    fireEvent.click(within(c).getByRole("button", { name: "Schedule anyway" }));
    await waitFor(() =>
      expect(H.scheduleGstChange).toHaveBeenCalledWith({
        enabled: true,
        inclusive: false,
        ratePercent: "18",
        when: "scheduled",
        startsAt: START,
        noticeId: "11111111-1111-4111-8111-111111111111",
        rateSetByLaw: false,
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "GST change scheduled for 1 December 2026, 00:00 IST.",
      ),
    );
  });

  it("★ a start before the notice allows one says the earliest start", async () => {
    H.notices = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        title: "Late notice",
        sentAt: "2026-11-10T09:30:00.000Z",
        sent: 3,
        failed: 0,
        check: { ok: true },
        earliestStart: "2026-12-10T09:30:00.000Z",
      },
    ];
    await renderPage();
    const c = card("Charging GST");
    fireEvent.click(within(c).getByLabelText("Charge GST"));
    fireEvent.click(within(c).getByLabelText("From a date and time"));
    fireEvent.change(within(c).getByLabelText("Notice email"), {
      target: { value: "33333333-3333-4333-8333-333333333333" },
    });
    fireEvent.change(
      within(c).getByLabelText("From a date and time", {
        selector: "input[type=datetime-local]",
      }),
      { target: { value: "2026-12-01T00:00" } },
    );
    expect(
      within(c).getByText(
        "This can start on 10 December 2026, 15:00 IST at the earliest: 1 month after the notice went out on 10 November 2026, 15:00 IST.",
      ),
    ).toBeTruthy();
  });

  it("★ says so when the announcements could not be read", async () => {
    H.notices = null;
    await renderPage();
    const c = card("Charging GST");
    fireEvent.click(within(c).getByLabelText("Charge GST"));
    expect(
      within(c).getByText(/The announcements couldn't be read just now/),
    ).toBeTruthy();
  });

  it("a refusal is shown under the button", async () => {
    H.scheduleGstChange.mockResolvedValue({
      ok: false,
      error:
        "This raises what merchants pay, so it can't start now. Schedule it at least 1 month after you email them.",
    });
    const base = impact();
    if (!base.ok) throw new Error("the fixture is a successful preview");
    H.getGstChangePreview.mockResolvedValue({
      ok: true,
      impact: { ...base.impact, rows: [] },
    });
    H.settings = settings({ taxEnabled: true, taxInclusive: true });
    await renderPage();
    const c = card("Charging GST");
    fireEvent.click(within(c).getByLabelText(/^Prices exclude GST/));
    await within(c).findByText("No merchant has a plan that renews.");
    fireEvent.click(within(c).getByRole("button", { name: "Save" }));
    // A store has no state on record, so the warning comes first.
    fireEvent.click(within(c).getByRole("button", { name: "Schedule anyway" }));
    expect((await within(c).findByRole("alert")).textContent).toBe(
      "This raises what merchants pay, so it can't start now. Schedule it at least 1 month after you email them.",
    );
  });

  it("★★ a member sees the setting and cannot change it", async () => {
    H.viewer = { email: "member@storemink.com", role: "member" };
    await renderPage();
    const c = card("Charging GST");
    expect(
      (within(c).getByLabelText("Charge GST") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (within(c).getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      within(c).getByText("Only a platform superadmin can change these."),
    ).toBeTruthy();
  });
});

describe("Card 4, the monthly invoice list (design 6.6)", () => {
  it("★★ a superadmin downloads one month's CSV as a file", async () => {
    H.exportInvoiceList.mockResolvedValue({
      fileName: "storemink-invoices-2026-10.csv",
      csv: "﻿Invoice number\r\n",
    });
    const createObjectURL = vi.fn(() => "blob:invoice-list");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await renderPage();
    const c = card("Monthly invoice list");
    expect(
      within(c).getByText(
        "Every invoice StoreMink issued in a month, with GSTINs, place of supply, SAC and the GST split, for your accountant's GST returns.",
      ),
    ).toBeTruthy();
    const month = within(c).getByLabelText("Month") as HTMLSelectElement;
    expect(month.options).toHaveLength(25);
    expect(month.value).toBe("2026-10");
    expect(month.options[0].textContent).toBe("October 2026");
    fireEvent.click(within(c).getByRole("button", { name: "Download CSV" }));
    await waitFor(() =>
      expect(H.exportInvoiceList).toHaveBeenCalledWith("2026-10"),
    );
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (createObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    expect(blob.type).toBe("text/csv;charset=utf-8");
    click.mockRestore();
  });

  it("a failure is said in the card's own words", async () => {
    H.exportInvoiceList.mockResolvedValue({
      error: "Couldn't prepare the invoice list. Please try again.",
    });
    await renderPage();
    const c = card("Monthly invoice list");
    fireEvent.click(within(c).getByRole("button", { name: "Download CSV" }));
    expect((await within(c).findByRole("alert")).textContent).toBe(
      "Couldn't prepare the invoice list. Please try again.",
    );
  });

  it("★★ a member sees no invoice list card at all", async () => {
    H.viewer = { email: "member@storemink.com", role: "member" };
    await renderPage();
    expect(
      screen.queryByRole("heading", { name: "Monthly invoice list" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
  });
});

describe("Send refunds automatically", () => {
  it("★★ renders in its own card and saves at once through setAutoRefunds", async () => {
    H.setAutoRefunds.mockResolvedValue({ success: true });
    await renderPage();
    const refunds = card("Refunds");
    const toggle = within(refunds).getByRole("switch", {
      name: "Send refunds automatically",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(H.setAutoRefunds).toHaveBeenCalledWith(true));
    expect(toggle.checked).toBe(true);
    expect(H.saveTaxIdentitySettings).not.toHaveBeenCalled();
    expect(H.scheduleGstChange).not.toHaveBeenCalled();
  });

  it("★ a refusal switches it back and shows the action's sentence", async () => {
    H.setAutoRefunds.mockResolvedValue({
      error: "Only a platform superadmin can change billing settings.",
    });
    H.settings = settings({ autoRefunds: true });
    await renderPage();
    const toggle = screen.getByRole("switch") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(
      (await within(card("Refunds")).findByRole("alert")).textContent,
    ).toBe("Only a platform superadmin can change billing settings.");
    expect(toggle.checked).toBe(true);
  });

  it("★ shows A2's sentence when the tax identity blocks the write", async () => {
    H.setAutoRefunds.mockResolvedValue({
      error:
        "Couldn't save this switch: StoreMink's tax identity is incomplete. Save StoreMink's tax identity first, then try again.",
    });
    await renderPage();
    fireEvent.click(screen.getByRole("switch"));
    expect(
      (await within(card("Refunds")).findByRole("alert")).textContent,
    ).toBe(
      "Couldn't save this switch: StoreMink's tax identity is incomplete. Save StoreMink's tax identity first, then try again.",
    );
  });

  it("★★ a member sees the state, cannot change it, and is told why", async () => {
    H.viewer = { email: "member@storemink.com", role: "member" };
    H.settings = settings({ autoRefunds: true });
    await renderPage();
    const toggle = screen.getByRole("switch") as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(
      within(card("Refunds")).getByText(
        "Only a platform superadmin can change this.",
      ),
    ).toBeTruthy();
  });

  it("explains what the switch does", async () => {
    await renderPage();
    expect(
      screen.getByText(/Refunds an operator issues are always sent at once\./),
    ).toBeTruthy();
  });
});
