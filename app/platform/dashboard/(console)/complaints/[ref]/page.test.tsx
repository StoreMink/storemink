// @vitest-environment jsdom
// One complaint (takedown design 6.4): gated on its own, its deadlines in
// India time, its details (or the erasure sentence), addresses that open only
// as web addresses, its blocks and its history.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ComplaintDetail,
  ComplaintPage,
} from "@/lib/moderation/console-read";

const H = vi.hoisted(() => ({
  calls: [] as string[],
  operator: true,
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("../../require-operator", () => ({
  requireOperator: vi.fn(async () => {
    H.calls.push("requireOperator");
    if (!H.operator) throw new Error("redirect:/dashboard");
    return { email: "ops@storemink.com", role: "member" };
  }),
}));

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@/lib/moderation/complaints", () => ({
  isEmailContact: vi.fn((value: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()),
  ),
}));

vi.mock("@/lib/moderation/console-read", () => ({
  getComplaint: vi.fn(async (ref: string) => {
    H.calls.push(`read:${ref}`);
    return null;
  }),
}));

vi.mock("./complaint-actions", () => ({
  ComplaintActions: vi.fn(
    (props: { email: string | null; resolved: boolean; erased: boolean }) => (
      <p>
        actions email={String(props.email)} resolved={String(props.resolved)}{" "}
        erased={String(props.erased)}
      </p>
    ),
  ),
}));

import ComplaintPageRoute, { generateMetadata } from "./page";
import { getComplaint } from "@/lib/moderation/console-read";

// 26 Oct 2026, 14:05 in India.
const NOW = new Date("2026-10-26T08:35:00.000Z");

function detail(over: Partial<ComplaintDetail> = {}): ComplaintDetail {
  return {
    id: "c-1",
    ref: "SM-000123",
    receivedAt: "2026-10-26T06:44:00.000Z",
    channel: "email",
    kind: "court_order",
    storeId: "store-1",
    storeLabel: "Crumb & Co (crumb.storemink.com)",
    status: "acknowledged",
    outcome: null,
    acknowledgedAt: "2026-10-26T06:50:00.000Z",
    actionedAt: null,
    resolvedAt: null,
    nextDue: {
      stage: "act",
      dueAt: "2026-10-26T08:10:00.000Z",
      overdue: true,
    },
    blockCount: 0,
    erased: false,
    complainantName: "Asha Rao",
    complainantContact: "asha@example.com",
    actingFor: "",
    authorityRef: "Delhi HC, CS 12/2026",
    urls: ["https://crumb.storemink.com/shop/blue-mug", "javascript:alert(1)"],
    summary: "Remove the mug listing.",
    acknowledgeDueAt: "2026-10-27T06:44:00.000Z",
    actionDueAt: "2026-10-26T08:10:00.000Z",
    resolveDueAt: "2026-10-26T10:27:00.000Z",
    acknowledgedBy: "a@storemink.com",
    acknowledgementEmailed: true,
    actionedBy: null,
    resolvedBy: null,
    outcomeNote: "",
    erasedAt: null,
    createdBy: "a@storemink.com",
    createdAt: "2026-10-26T06:44:00.000Z",
    store: {
      id: "store-1",
      name: "Crumb & Co",
      slug: "crumb",
      status: "active",
    },
    ...over,
  };
}

function page(over: Partial<ComplaintPage> = {}): ComplaintPage {
  return {
    complaint: detail(),
    blocks: [],
    events: [
      {
        id: "e-1",
        at: "2026-10-26T06:44:00.000Z",
        actor: "a@storemink.com",
        action: "complaint_logged",
        complaintId: "c-1",
        blockId: null,
        holdId: null,
        storeId: null,
        detail: {},
        block: null,
      },
    ],
    ...over,
  };
}

async function renderPage(ref = "SM-000123") {
  render(await ComplaintPageRoute({ params: Promise.resolve({ ref }) }));
}

beforeEach(() => {
  H.calls = [];
  H.operator = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the gate", () => {
  it("checks the operator before reading the complaint", async () => {
    H.operator = false;
    await expect(renderPage()).rejects.toThrow("redirect:/dashboard");
    expect(H.calls).toEqual(["requireOperator"]);
  });

  it("answers not found for a reference with no complaint", async () => {
    await expect(renderPage("SM-999999")).rejects.toThrow("notFound");
    expect(H.calls).toEqual(["requireOperator", "read:SM-999999"]);
  });

  it("says when the complaint could not be read", async () => {
    vi.mocked(getComplaint).mockRejectedValueOnce(new Error("db down"));
    await renderPage();
    expect(
      screen.getByText(
        "This complaint could not be read just now. Refresh the page to try again.",
      ),
    ).toBeInTheDocument();
  });
});

describe("the complaint", () => {
  it("heads the page with the reference, the kind and the status", async () => {
    vi.mocked(getComplaint).mockResolvedValueOnce(page());
    await renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "Complaint SM-000123" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Court order")).toBeInTheDocument();
    expect(screen.getByText("Acknowledged")).toBeInTheDocument();
    expect(
      screen.getByText(
        "actions email=asha@example.com resolved=false erased=false",
      ),
    ).toBeInTheDocument();
    expect(getComplaint).toHaveBeenCalledWith("SM-000123", { now: NOW });
  });

  it("shows each deadline in India time with where it stands", async () => {
    vi.mocked(getComplaint).mockResolvedValueOnce(page());
    await renderPage();
    const card = within(
      screen.getByRole("heading", { name: "Deadlines" }).closest("section")!,
    );
    expect(card.getByText("Acknowledge by 27 Oct, 12:14")).toBeInTheDocument();
    expect(
      card.getByText("Done 26 Oct, 12:20 by a@storemink.com"),
    ).toBeInTheDocument();
    expect(
      card.getByText("Remove or block by 26 Oct, 13:40"),
    ).toBeInTheDocument();
    expect(card.getByText("Overdue by 25 min").className).toContain(
      "--dash-red",
    );
    expect(card.getByText("Resolve by 26 Oct, 15:57")).toBeInTheDocument();
    expect(card.getByText("In 1 h 52 min")).toBeInTheDocument();
  });

  it("shows the details, and opens only a web address as a link", async () => {
    vi.mocked(getComplaint).mockResolvedValueOnce(page());
    await renderPage();
    expect(screen.getByText("Asha Rao")).toBeInTheDocument();
    expect(screen.getByText("Delhi HC, CS 12/2026")).toBeInTheDocument();
    expect(
      screen.getByText("Email to support@storemink.com"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Crumb & Co (crumb.storemink.com)" }),
    ).toHaveAttribute("href", "/dashboard/stores/store-1");
    const link = screen.getByRole("link", {
      name: "https://crumb.storemink.com/shop/blue-mug",
    });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("javascript:alert(1)").tagName).toBe("LI");
    expect(
      screen.queryByRole("link", { name: "javascript:alert(1)" }),
    ).toBeNull();
    expect(screen.getByText("Remove the mug listing.")).toBeInTheDocument();
    expect(screen.getByText("No blocks yet.")).toBeInTheDocument();
  });

  it("writes the history in India time", async () => {
    vi.mocked(getComplaint).mockResolvedValueOnce(page());
    await renderPage();
    const history = within(
      screen.getByRole("heading", { name: "History" }).closest("section")!,
    );
    expect(history.getByRole("listitem").textContent).toBe(
      "26 Oct, 12:14 · Logged by a@storemink.com",
    );
  });

  it("passes no email when the contact is a phone number", async () => {
    vi.mocked(getComplaint).mockResolvedValueOnce(
      page({ complaint: detail({ complainantContact: "+91 98765 43210" }) }),
    );
    await renderPage();
    expect(
      screen.getByText("actions email=null resolved=false erased=false"),
    ).toBeInTheDocument();
  });

  it("says when the complainant's details were erased, and hides them", async () => {
    vi.mocked(getComplaint).mockResolvedValueOnce(
      page({
        complaint: detail({
          complainantName: "",
          complainantContact: "",
          urls: [],
          summary: "",
          resolvedAt: "2023-10-26T08:00:00.000Z",
          erasedAt: "2026-10-26T08:00:00.000Z",
        }),
      }),
    );
    await renderPage();
    expect(
      screen.getByText(
        "The complainant's details were erased on 26 Oct 2026, 3 years after it was resolved.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("What they ask for")).toBeNull();
    expect(screen.queryByText("Addresses")).toBeNull();
  });
});

describe("the page title", () => {
  it("names a valid reference and nothing else", async () => {
    expect(
      await generateMetadata({ params: Promise.resolve({ ref: "sm-000123" }) }),
    ).toEqual({ title: "Complaint SM-000123 · StoreMink Admin" });
    expect(
      await generateMetadata({ params: Promise.resolve({ ref: "<script>" }) }),
    ).toEqual({ title: "Complaint · StoreMink Admin" });
  });
});
