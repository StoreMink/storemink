// @vitest-environment jsdom
// Log a complaint (takedown design 6.3): the labels and help word for word,
// the live deadline line in India time, what is sent to the T15 action, and
// where each answer is shown.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformStoreRow } from "@/app/actions/platform";

const state = vi.hoisted(() => ({
  push: vi.fn(),
  toastSuccess: vi.fn(),
  log: vi.fn(),
  listAllStores: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push, refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: state.toastSuccess, error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/takedown-actions", () => ({
  logComplaintAction: state.log,
}));
vi.mock("@/app/actions/platform", () => ({
  listAllStores: state.listAllStores,
}));

import { ComplaintForm, deadlineLine, findStores } from "./complaint-form";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function store(over: Partial<PlatformStoreRow> = {}): PlatformStoreRow {
  return {
    id: "store-1",
    slug: "crumb",
    name: "Crumb & Co",
    custom_domain: null,
    ...over,
  } as PlatformStoreRow;
}

const MAX = "2026-10-30T18:00";

describe("the form's words (design 6.3)", () => {
  it("labels every field and shows its help", () => {
    render(<ComplaintForm maxReceivedAt={MAX} />);
    const when = screen.getByLabelText("When did it reach us?");
    expect(when).toHaveValue("");
    expect(when).toHaveAttribute("max", MAX);
    expect(when).toHaveAccessibleDescription(
      "The time on the email, letter or order, in India time. Every deadline counts from this time, not from when you log it.",
    );
    expect(
      screen.getByRole("group", { name: "How did it reach us?" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "How did it reach us?" }))
        .getAllByRole("radio")
        .map((r) => (r as HTMLInputElement).value),
    ).toEqual(["email", "post", "gac", "court", "government", "other"]);
    expect(screen.getByRole("radio", { name: "Letter" })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", {
        name: "Court order: remove or block within 3 hours.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Their name")).toBeInTheDocument();
    expect(
      screen.getByLabelText("How to reach them"),
    ).toHaveAccessibleDescription("An email address or a phone number.");
    expect(
      screen.getByLabelText("Acting for someone else?"),
    ).toHaveAccessibleDescription(
      "Who, and how they are related. Leave empty if they complain for themselves.",
    );
    expect(
      screen.getByLabelText("Order or reference number"),
    ).toHaveAccessibleDescription(
      "For an order: who issued it, its number and date, and the law it names.",
    );
    expect(screen.getByLabelText("Store")).toHaveAccessibleDescription(
      "Search by name or address. Leave empty if it is about StoreMink itself.",
    );
    expect(screen.getByLabelText("Web addresses")).toHaveAccessibleDescription(
      "One per line.",
    );
    expect(
      screen.getByLabelText("What do they ask for?"),
    ).toHaveAccessibleDescription(
      "In your own words. Never paste an intimate image, a password or a card number.",
    );
    expect(
      screen.getByRole("button", { name: "Log complaint" }),
    ).toBeInTheDocument();
  });
});

describe("the live deadline line", () => {
  it("names each deadline of the kind in India time", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T09:00:00.000Z"));
    expect(deadlineLine("court_order", "2026-10-26T14:05")).toBe(
      "Acknowledge by 27 Oct, 14:05. Remove or block by 26 Oct, 17:05. Resolve by 26 Oct, 17:05.",
    );
    expect(deadlineLine("information_order", "2026-10-26T14:05")).toBe(
      "Acknowledge by 27 Oct, 14:05. Provide by 29 Oct, 14:05.",
    );
    expect(deadlineLine("grievance", "2026-10-26T14:05")).toBe(
      "Acknowledge by 27 Oct, 14:05. Resolve by 2 Nov, 14:05.",
    );
    expect(deadlineLine("grievance", "")).toBe("");
    expect(deadlineLine("grievance", "not a time")).toBe("");
  });

  it("appears under the form once the time and kind are chosen", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T09:00:00.000Z"));
    render(<ComplaintForm maxReceivedAt={MAX} />);
    expect(screen.queryByText(/^Acknowledge by/)).toBeNull();
    fireEvent.change(screen.getByLabelText("When did it reach us?"), {
      target: { value: "2026-10-26T14:05" },
    });
    fireEvent.click(
      screen.getByRole("radio", { name: /^Intimate image or impersonation:/ }),
    );
    expect(
      screen.getByText(
        "Acknowledge by 27 Oct, 14:05. Remove or block by 26 Oct, 16:05. Resolve by 28 Oct, 02:05.",
      ),
    ).toBeInTheDocument();
  });
});

describe("logging", () => {
  function fill() {
    fireEvent.change(screen.getByLabelText("When did it reach us?"), {
      target: { value: "2026-10-26T14:05" },
    });
    fireEvent.click(
      screen.getByRole("radio", { name: "Email to support@storemink.com" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /^Court order:/ }));
    fireEvent.change(screen.getByLabelText("Their name"), {
      target: { value: "Asha Rao" },
    });
    fireEvent.change(screen.getByLabelText("How to reach them"), {
      target: { value: "asha@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Order or reference number"), {
      target: { value: "Delhi HC, CS 12/2026" },
    });
    fireEvent.change(screen.getByLabelText("Web addresses"), {
      target: { value: "https://crumb.storemink.com/shop/mug" },
    });
    fireEvent.change(screen.getByLabelText("What do they ask for?"), {
      target: { value: "Remove the mug listing." },
    });
  }

  it("sends what was typed and opens the new complaint", async () => {
    state.log.mockResolvedValue({
      ok: true,
      complaintId: "c-1",
      ref: "SM-000123",
      urgent: true,
      message: "Complaint SM-000123 logged.",
    });
    render(<ComplaintForm maxReceivedAt={MAX} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Log complaint" }));
    await waitFor(() =>
      expect(state.push).toHaveBeenCalledWith(
        "/dashboard/complaints/SM-000123",
      ),
    );
    expect(state.log).toHaveBeenCalledWith({
      receivedAt: "2026-10-26T14:05",
      channel: "email",
      kind: "court_order",
      complainantName: "Asha Rao",
      complainantContact: "asha@example.com",
      actingFor: "",
      authorityRef: "Delhi HC, CS 12/2026",
      storeId: null,
      urls: "https://crumb.storemink.com/shop/mug",
      summary: "Remove the mug listing.",
    });
    expect(state.toastSuccess).toHaveBeenCalledWith(
      "Complaint SM-000123 logged.",
    );
  });

  it("shows a refusal under the field it names", async () => {
    state.log.mockResolvedValue({
      ok: false,
      error: "That time is in the future.",
      field: "receivedAt",
    });
    render(<ComplaintForm maxReceivedAt={MAX} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Log complaint" }));
    expect(
      await screen.findByText("That time is in the future."),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("When did it reach us?"),
    ).toHaveAccessibleDescription(
      "The time on the email, letter or order, in India time. Every deadline counts from this time, not from when you log it. That time is in the future.",
    );
    expect(state.push).not.toHaveBeenCalled();
  });

  it("shows a refusal with no field above the button", async () => {
    state.log.mockResolvedValue({
      ok: false,
      error: "Too many complaints logged just now. Try again in a minute.",
    });
    render(<ComplaintForm maxReceivedAt={MAX} />);
    fireEvent.click(screen.getByRole("button", { name: "Log complaint" }));
    expect(
      await screen.findByText(
        "Too many complaints logged just now. Try again in a minute.",
      ),
    ).toBeInTheDocument();
  });

  it("says so when the request never got an answer", async () => {
    state.log.mockRejectedValue(new Error("network"));
    render(<ComplaintForm maxReceivedAt={MAX} />);
    fireEvent.click(screen.getByRole("button", { name: "Log complaint" }));
    expect(
      await screen.findByText("Could not log the complaint. Please try again."),
    ).toBeInTheDocument();
  });
});

describe("choosing the store", () => {
  it("searches as the operator types and sends the store chosen", async () => {
    state.listAllStores.mockResolvedValue([
      store(),
      store({ id: "store-2", slug: "crumble", name: "Crumble" }),
    ]);
    state.log.mockResolvedValue({ ok: false, error: "Choose a kind." });
    render(<ComplaintForm maxReceivedAt={MAX} />);
    fireEvent.change(screen.getByLabelText("Store"), {
      target: { value: "crumb" },
    });
    expect(screen.getByText("Searching")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /^Crumb & Co/ }));
    expect(state.listAllStores).toHaveBeenCalledWith("crumb");
    expect(
      screen.getByText("Crumb & Co (crumb.storemink.com)"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Log complaint" }));
    expect(await screen.findByText("Choose a kind.")).toBeInTheDocument();
    expect(state.log).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1" }),
    );
    // The refusal is drawn while the log is still finishing, and Clear waits
    // on it, so a click before then is lost: wait until it can be pressed.
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByLabelText("Store")).toHaveValue("");
  });

  it("says when no store matches", async () => {
    state.listAllStores.mockResolvedValue([]);
    render(<ComplaintForm maxReceivedAt={MAX} />);
    fireEvent.change(screen.getByLabelText("Store"), {
      target: { value: "nobody" },
    });
    expect(await screen.findByText("No store matches.")).toBeInTheDocument();
  });
});

describe("findStores", () => {
  it("does not search fewer than two letters", async () => {
    expect(await findStores(" a ")).toEqual([]);
    expect(state.listAllStores).not.toHaveBeenCalled();
  });

  it("searches a name as typed", async () => {
    state.listAllStores.mockResolvedValue([store()]);
    expect(await findStores("Crumb")).toEqual([store()]);
    expect(state.listAllStores).toHaveBeenCalledWith("Crumb");
  });

  it("reads a store address down to its slug", async () => {
    state.listAllStores.mockResolvedValue([
      store({ id: "store-2", slug: "crumble" }),
      store(),
    ]);
    expect(
      await findStores("https://crumb.storemink.com/shop/blue-mug"),
    ).toEqual([store()]);
    expect(state.listAllStores).toHaveBeenCalledWith("crumb");
  });

  it("matches a custom domain against the stores' connected domains", async () => {
    state.listAllStores.mockResolvedValue([
      store({ custom_domain: "acme.in" }),
      store({ id: "store-2", slug: "other", custom_domain: "other.in" }),
    ]);
    expect(await findStores("www.acme.in/products/1")).toEqual([
      store({ custom_domain: "acme.in" }),
    ]);
    expect(state.listAllStores).toHaveBeenCalledWith("");
  });
});
