// @vitest-environment jsdom
// The "Block an item" page (takedown design 6.5, stage T16b).
//
// ★★ The reads behind it run under withService, so the operator gate is the
// access control: it must run first, and a refusal must stop every read.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  ComplaintPage,
  ResolvedTarget,
} from "@/lib/moderation/console-read";

const H = vi.hoisted(() => ({
  calls: [] as string[],
  operator: true,
  role: "superadmin" as "superadmin" | "member",
}));

vi.mock("../../require-operator", () => ({
  requireOperator: vi.fn(async () => {
    H.calls.push("requireOperator");
    if (!H.operator) throw new Error("redirect:/dashboard");
    return { email: "ops@storemink.com", role: H.role };
  }),
  canManage: vi.fn((viewer: { role: string }) => viewer.role === "superadmin"),
}));

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@/lib/moderation/console-read", () => ({
  TARGET_ERRORS: { readFailed: "Could not look it up. Please try again." },
  getComplaint: vi.fn(async (ref: string) => {
    H.calls.push(`complaint:${ref}`);
    return null;
  }),
  resolveTarget: vi.fn(async (input: { storeId: string }) => {
    H.calls.push(`target:${input.storeId}`);
    return { ok: false, error: "We could not find that store." };
  }),
}));

vi.mock("./block-form", () => ({
  BlockForm: vi.fn(
    (props: {
      superadmin: boolean;
      complaint: {
        ref: string;
        storeId: string | null;
        firstUrl: string | null;
      } | null;
      initialTarget?: { label: string } | null;
      initialError?: string | null;
      storeRefused?: boolean;
    }) => (
      <p data-testid="form">
        superadmin={String(props.superadmin)} complaint=
        {props.complaint ? props.complaint.ref : "none"} store=
        {String(props.complaint?.storeId ?? null)} url=
        {String(props.complaint?.firstUrl ?? null)} target=
        {props.initialTarget ? props.initialTarget.label : "none"} error=
        {String(props.initialError ?? null)} refused=
        {String(props.storeRefused ?? false)}
      </p>
    ),
  ),
}));

import BlockItemPage from "./page";
import { getComplaint, resolveTarget } from "@/lib/moderation/console-read";
import { logError } from "@/lib/observability/logger";

const STORE_ID = "11111111-1111-4111-8111-111111111111";

function complaintPage(urls: string[]): ComplaintPage {
  return {
    complaint: {
      id: "c-1",
      ref: "SM-000123",
      kind: "court_order",
      storeId: STORE_ID,
      storeLabel: "Crumb & Co (crumb.storemink.com)",
      urls,
    },
    blocks: [],
    events: [],
  } as unknown as ComplaintPage;
}

function storeTarget(): ResolvedTarget {
  return {
    kind: "store",
    itemId: null,
    label: "Crumb & Co",
    url: "https://crumb.storemink.com",
  } as unknown as ResolvedTarget;
}

async function renderPage(params: Record<string, string>) {
  render(await BlockItemPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  H.calls = [];
  H.operator = true;
  H.role = "superadmin";
});

describe("BlockItemPage gate", () => {
  it("★★ checks the operator BEFORE reading anything", async () => {
    vi.mocked(getComplaint).mockImplementationOnce(async (ref: string) => {
      H.calls.push(`complaint:${ref}`);
      return complaintPage([]);
    });
    await renderPage({ complaint: "SM-000123" });
    expect(H.calls[0]).toBe("requireOperator");
    expect(H.calls).toContain("complaint:SM-000123");
  });

  it("★★ reads nothing for someone who is not an operator", async () => {
    H.operator = false;
    await expect(
      BlockItemPage({
        searchParams: Promise.resolve({
          complaint: "SM-000123",
          store: STORE_ID,
          kind: "store",
        }),
      }),
    ).rejects.toThrow("redirect:/dashboard");
    expect(H.calls).toEqual(["requireOperator"]);
    expect(getComplaint).not.toHaveBeenCalled();
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it("has the page title", async () => {
    const mod = await import("./page");
    expect(mod.metadata.title).toBe("Block an item · StoreMink Admin");
  });
});

describe("BlockItemPage with no parameters", () => {
  it("renders the form with nothing chosen and a link back to the complaints", async () => {
    await renderPage({});
    expect(
      screen.getByRole("heading", { level: 1, name: "Block an item" }),
    ).toBeTruthy();
    const back = screen.getByRole("link", { name: "Complaints" });
    expect(back.getAttribute("href")).toBe("/dashboard/complaints");
    expect(screen.getByTestId("form").textContent).toContain("complaint=none");
    expect(screen.getByTestId("form").textContent).toContain("superadmin=true");
    expect(getComplaint).not.toHaveBeenCalled();
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it("tells the form a member is not a superadmin", async () => {
    H.role = "member";
    await renderPage({});
    expect(screen.getByTestId("form").textContent).toContain(
      "superadmin=false",
    );
  });
});

describe("BlockItemPage with a complaint", () => {
  it("hands the form the complaint, its store and its first web address", async () => {
    vi.mocked(getComplaint).mockResolvedValueOnce(
      complaintPage([
        "not an address",
        "https://crumb.storemink.com/shop/blue-mug",
        "https://crumb.storemink.com/shop/red-mug",
      ]),
    );
    await renderPage({ complaint: " SM-000123 " });
    expect(getComplaint).toHaveBeenCalledWith("SM-000123");
    const text = screen.getByTestId("form").textContent ?? "";
    expect(text).toContain("complaint=SM-000123");
    expect(text).toContain(`store=${STORE_ID}`);
    expect(text).toContain("url=https://crumb.storemink.com/shop/blue-mug");
    const back = screen.getByRole("link", { name: "Complaint SM-000123" });
    expect(back.getAttribute("href")).toContain("SM-000123");
  });

  it("gives no address when the complaint names none", async () => {
    vi.mocked(getComplaint).mockResolvedValueOnce(
      complaintPage(["ftp://example.com/file", "words"]),
    );
    await renderPage({ complaint: "SM-000123" });
    expect(screen.getByTestId("form").textContent).toContain("url=null");
  });

  it("★ says so, and renders no form, when the complaint is not found", async () => {
    await renderPage({ complaint: "SM-999999" });
    expect(screen.getByRole("alert").textContent).toBe(
      "That complaint was not found.",
    );
    expect(screen.queryByTestId("form")).toBeNull();
  });

  it("★ says so, and renders no form, when the complaint cannot be read", async () => {
    vi.mocked(getComplaint).mockRejectedValueOnce(new Error("db down"));
    await renderPage({ complaint: "SM-000123" });
    expect(screen.getByRole("alert").textContent).toBe(
      "This complaint could not be read just now. Refresh the page to try again.",
    );
    expect(screen.queryByTestId("form")).toBeNull();
    expect(logError).toHaveBeenCalled();
  });

  it("does not read the store when the complaint itself failed", async () => {
    await renderPage({
      complaint: "SM-999999",
      store: STORE_ID,
      kind: "store",
    });
    expect(resolveTarget).not.toHaveBeenCalled();
  });
});

describe("BlockItemPage suspending a whole store", () => {
  it("★ reads the store for a superadmin, behind the gate", async () => {
    vi.mocked(resolveTarget).mockImplementationOnce(async (input) => {
      H.calls.push(`target:${input.storeId}`);
      return { ok: true, found: "target", target: storeTarget() };
    });
    await renderPage({ store: STORE_ID, kind: "store" });
    expect(H.calls).toEqual(["requireOperator", `target:${STORE_ID}`]);
    expect(resolveTarget).toHaveBeenCalledWith({
      storeId: STORE_ID,
      kind: "store",
    });
    const text = screen.getByTestId("form").textContent ?? "";
    expect(text).toContain("target=Crumb & Co");
    expect(text).toContain("refused=false");
  });

  it("passes on the read's own refusal", async () => {
    await renderPage({ store: STORE_ID, kind: "store" });
    expect(screen.getByTestId("form").textContent).toContain(
      "error=We could not find that store.",
    );
  });

  it("★ says the read failed when it throws", async () => {
    vi.mocked(resolveTarget).mockRejectedValueOnce(new Error("db down"));
    await renderPage({ store: STORE_ID, kind: "store" });
    expect(screen.getByTestId("form").textContent).toContain(
      "error=Could not look it up. Please try again.",
    );
    expect(logError).toHaveBeenCalled();
  });

  it("★★ reads nothing for a member, and the form refuses them", async () => {
    H.role = "member";
    await renderPage({ store: STORE_ID, kind: "store" });
    expect(resolveTarget).not.toHaveBeenCalled();
    const text = screen.getByTestId("form").textContent ?? "";
    expect(text).toContain("refused=true");
    expect(text).toContain("target=none");
  });

  it("ignores a store without kind=store", async () => {
    await renderPage({ store: STORE_ID });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(screen.getByTestId("form").textContent).toContain("refused=false");
  });
});
