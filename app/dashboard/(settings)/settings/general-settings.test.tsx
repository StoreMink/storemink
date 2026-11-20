// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupStoreById } from "@/lib/store/resolve";
import { GeneralSettings } from "./general-settings";

const db = vi.hoisted(() => ({
  rows: [] as unknown[],
  fail: false,
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (d: unknown) => unknown) => {
    if (db.fail) throw new Error("db down");
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: async () => db.rows,
    };
    return fn(chain);
  }),
}));
vi.mock("@/lib/store/resolve", () => ({ lookupStoreById: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({ logWarn: vi.fn() }));
vi.mock("./business-time-zone-form", () => ({
  BusinessTimeZoneForm: ({ timeZone }: { timeZone: string }) => (
    <p>Time zone form {timeZone}</p>
  ),
}));

const STORE = {
  id: "store-1",
  name: "Echos",
  slug: "echos",
  custom_domain: null,
  plan: "basic",
  plan_expires_at: null,
  comp_plan: null,
  comp_expires_at: null,
  settings: {
    brand: { email: "hello@echos.test" },
    business: { timeZone: "Asia/Kolkata" },
  },
};

function access(allowed: Record<string, ("view" | "manage")[]>) {
  return {
    can: (section: string, action: "view" | "manage") =>
      allowed[section]?.includes(action) ?? false,
  } as never;
}

async function renderGeneral(a = access({ settings: ["view", "manage"] })) {
  const page = await GeneralSettings({ access: a, storeId: "store-1" });
  return render(page);
}

function card(title: string) {
  return screen.getByRole("heading", { name: title }).closest("section")!;
}

beforeEach(() => {
  db.rows = [];
  db.fail = false;
  vi.mocked(lookupStoreById).mockResolvedValue(STORE as never);
});

describe("Settings, General", () => {
  it("shows the store's details, its address and what is missing", async () => {
    await renderGeneral();
    const details = card("Store details");
    expect(within(details).getByText("Echos")).toBeInTheDocument();
    expect(within(details).getByText("hello@echos.test")).toBeInTheDocument();
    expect(within(details).getByText("Not added")).toBeInTheDocument();
    expect(
      within(details).getByRole("link", { name: /echos\./ }),
    ).toHaveAttribute("target", "_blank");
  });

  it("lets a manager change the time zone here, and shows it to anyone else", async () => {
    await renderGeneral();
    expect(screen.getByText("Time zone form Asia/Kolkata")).toBeInTheDocument();

    await renderGeneral(access({ settings: ["view"] }));
    expect(
      within(card("Business time zone")).getByText(/Kolkata|Asia\/Kolkata/),
    ).toBeInTheDocument();
  });

  it("links each card to where it is changed, only when the viewer can open it", async () => {
    await renderGeneral(
      access({ settings: ["view"], branding: ["view"], ai: ["view"] }),
    );
    expect(
      within(card("Store details")).getByRole("link", { name: "Edit" }),
    ).toHaveAttribute("href", "/dashboard/branding");
    expect(
      within(card("Plan")).getByRole("link", { name: "Plans & Billing" }),
    ).toHaveAttribute("href", "/dashboard/plans");
    expect(within(card("Plan")).getByText("Basic")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Business details" }),
    ).toBeNull();
  });

  it("shows the business details to someone with Taxes & invoices", async () => {
    db.rows = [
      {
        name: "Echos",
        legalName: "Echos LLP",
        address: "1 Mall Road",
        taxId: null,
      },
    ];
    await renderGeneral(access({ settings: ["view"], billing: ["view"] }));
    const business = card("Business details");
    expect(within(business).getByText("Echos LLP")).toBeInTheDocument();
    expect(within(business).getByText("1 Mall Road")).toBeInTheDocument();
    expect(
      within(business).getByRole("link", { name: "Edit" }),
    ).toHaveAttribute("href", "/dashboard/billing");
  });

  it("says a card could not load and still shows the rest", async () => {
    db.fail = true;
    await renderGeneral(access({ settings: ["view"], billing: ["view"] }));
    expect(
      within(card("Business details")).getByText(/couldn.t be loaded/),
    ).toBeInTheDocument();
    expect(
      within(card("Store details")).getByText("Echos"),
    ).toBeInTheDocument();
    expect(within(card("Plan")).getByText("Basic")).toBeInTheDocument();
  });

  it("reads the plan and time zone from the store row, with no other read", async () => {
    vi.mocked(lookupStoreById).mockResolvedValue({
      ...STORE,
      plan: "pro",
      settings: { business: { timeZone: "not a zone" } },
    } as never);
    await renderGeneral(access({ settings: ["view"] }));
    // An expired or missing plan field would read as Free; Pro shows here.
    expect(within(card("Plan")).getByText("Pro")).toBeInTheDocument();
    // An unreadable zone falls back the way the analytics reader does.
    expect(
      within(card("Business time zone")).getByText(/Kolkata/),
    ).toBeInTheDocument();
  });

  it("says the plan and time zone could not load when the store row cannot", async () => {
    vi.mocked(lookupStoreById).mockRejectedValue(new Error("down"));
    await renderGeneral(access({ settings: ["view"] }));
    expect(
      within(card("Plan")).getByText(/couldn.t be loaded/),
    ).toBeInTheDocument();
    expect(
      within(card("Business time zone")).getByText(/couldn.t be loaded/),
    ).toBeInTheDocument();
  });
});
