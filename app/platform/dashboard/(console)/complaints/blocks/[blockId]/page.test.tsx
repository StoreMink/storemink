// @vitest-environment jsdom
// A block's page (takedown design 6.6, stage T16b).
//
// ★★ getBlock reads under withService, so the operator gate is the access
// control: it runs first, and a refusal stops the read. A member is never
// handed a superadmin's controls, and every date is India time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type {
  ArchiveSummary,
  BlockDetail,
  BlockListRow,
  BlockMessage,
  BlockPage,
  ModerationEventRow,
} from "@/lib/moderation/console-read";

const H = vi.hoisted(() => ({
  calls: [] as string[],
  operator: true,
  role: "superadmin" as "superadmin" | "member",
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("../../../require-operator", () => ({
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
  getBlock: vi.fn(async (id: string) => {
    H.calls.push(`read:${id}`);
    return null;
  }),
}));

vi.mock("./block-detail", () => ({
  BlockActions: vi.fn(
    (props: {
      superadmin: boolean;
      storeName: string;
      liveImageBlocks: number;
      replacingNow: boolean;
      told: boolean;
      archive: { keepUntil: string } | null;
    }) => (
      <p data-testid="actions">
        superadmin={String(props.superadmin)} store={props.storeName} images=
        {props.liveImageBlocks} replacing={String(props.replacingNow)} told=
        {String(props.told)} archive={props.archive ? "yes" : "no"}
      </p>
    ),
  ),
  ArchiveCopy: vi.fn((props: { superadmin: boolean }) => (
    <p data-testid="archive">archive superadmin={String(props.superadmin)}</p>
  )),
  RetryNowButton: vi.fn(() => <button type="button">Retry now</button>),
  MarkRemovedButton: vi.fn(() => (
    <button type="button">Mark as removed</button>
  )),
  StoreReplyForms: vi.fn(() => <p data-testid="reply">reply forms</p>),
}));

import BlockDetailPage from "./page";
import { getBlock } from "@/lib/moderation/console-read";
import { logError } from "@/lib/observability/logger";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const BLOCK_ID = "22222222-2222-4222-8222-222222222222";

function block(over: Partial<BlockDetail> = {}): BlockDetail {
  return {
    id: BLOCK_ID,
    kind: "product",
    label: "Blue mug",
    url: "https://crumb.storemink.com/shop/blue-mug",
    storeId: STORE_ID,
    storeLabel: "Crumb & Co (crumb.storemink.com)",
    complaintId: "c-1",
    complaintRef: "SM-000123",
    reasonKind: "court_order",
    tellStore: true,
    blockedAt: "2026-10-29T08:30:00.000Z",
    blockedBy: "ops@storemink.com",
    liftedAt: null,
    liftedBy: null,
    status: "blocked",
    fileSource: null,
    objectPath: null,
    storageState: "none",
    storageError: "",
    fileStage: null,
    archive: null,
    parentBlockId: null,
    merchantNotifiedAt: "2026-10-29T08:31:00.000Z",
    merchantSeenAt: null,
    lastMessage: null,
    erased: false,
    itemId: "p-1",
    objectMd5: null,
    authorUserId: null,
    parentItemId: null,
    storeStatusBefore: null,
    legalBasis: "Order 12/2026 of 20 Oct 2026, section 79",
    storeMessage: "We blocked this product because a court ordered us to.",
    liftNote: "",
    storageAttempts: 0,
    replacingNow: false,
    noticeEmailFailed: false,
    store: {
      id: STORE_ID,
      name: "Crumb & Co",
      slug: "crumb",
      status: "active",
    },
    ...over,
  };
}

function row(over: Partial<BlockListRow> = {}): BlockListRow {
  const b = block();
  return {
    id: b.id,
    kind: b.kind,
    label: b.label,
    url: b.url,
    storeId: b.storeId,
    storeLabel: b.storeLabel,
    complaintId: b.complaintId,
    complaintRef: b.complaintRef,
    reasonKind: b.reasonKind,
    tellStore: b.tellStore,
    blockedAt: b.blockedAt,
    blockedBy: b.blockedBy,
    liftedAt: null,
    liftedBy: null,
    status: "blocked",
    fileSource: null,
    objectPath: null,
    storageState: "none",
    storageError: "",
    fileStage: null,
    archive: null,
    parentBlockId: null,
    merchantNotifiedAt: null,
    merchantSeenAt: null,
    lastMessage: null,
    erased: false,
    ...over,
  };
}

function archive(over: Partial<ArchiveSummary> = {}): ArchiveSummary {
  return {
    id: "a-1",
    createdAt: "2026-10-29T08:30:00.000Z",
    keepUntil: "2027-04-27T08:30:00.000Z",
    legalHold: false,
    legalHoldNote: "",
    legalHoldSetAt: null,
    legalHoldSetBy: null,
    purgedAt: null,
    sha256: "ab".repeat(32),
    snapshotBytes: 2048,
    filesState: "copied",
    filesError: "",
    files: {
      filesState: "copied",
      total: 3,
      copied: 3,
      missing: 0,
      changed: 0,
    },
    ...over,
  };
}

function message(over: Partial<BlockMessage> = {}): BlockMessage {
  return {
    id: "m-1",
    fromSide: "store",
    author: "Asha (Crumb & Co)",
    body: "We have changed the listing. Please look again.",
    asksReview: true,
    at: "2026-10-29T09:00:00.000Z",
    seenAt: null,
    ...over,
  };
}

function event(over: Partial<ModerationEventRow> = {}): ModerationEventRow {
  return {
    id: "e-1",
    at: "2026-10-29T08:30:00.000Z",
    actor: "ops@storemink.com",
    action: "merchant_notified",
    complaintId: null,
    blockId: BLOCK_ID,
    holdId: null,
    storeId: STORE_ID,
    detail: {},
    block: { kind: "product", label: "Blue mug" },
    ...over,
  };
}

function pageOf(over: Partial<BlockPage> = {}): BlockPage {
  return {
    block: block(),
    parent: null,
    children: [],
    messages: [],
    events: [],
    archive: null,
    ...over,
  };
}

async function renderPage(id = BLOCK_ID) {
  render(await BlockDetailPage({ params: Promise.resolve({ blockId: id }) }));
}

function fact(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: "dt" });
  return term.nextElementSibling as HTMLElement;
}

beforeEach(() => {
  H.calls = [];
  H.operator = true;
  H.role = "superadmin";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T06:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BlockDetailPage gate", () => {
  it("★★ checks the operator BEFORE reading the block", async () => {
    vi.mocked(getBlock).mockImplementationOnce(async (id: string) => {
      H.calls.push(`read:${id}`);
      return pageOf();
    });
    await renderPage();
    expect(H.calls).toEqual(["requireOperator", `read:${BLOCK_ID}`]);
  });

  it("★★ reads nothing for someone who is not an operator", async () => {
    H.operator = false;
    await expect(renderPage()).rejects.toThrow("redirect:/dashboard");
    expect(getBlock).not.toHaveBeenCalled();
  });

  it("404s a block that is not there", async () => {
    await expect(renderPage()).rejects.toThrow("notFound");
  });

  it("★ says so when the block cannot be read", async () => {
    vi.mocked(getBlock).mockRejectedValueOnce(new Error("db down"));
    await renderPage();
    expect(screen.getByRole("alert").textContent).toBe(
      "This block could not be read just now. Refresh the page to try again.",
    );
    expect(logError).toHaveBeenCalled();
  });

  it("has the page title", async () => {
    const mod = await import("./page");
    expect(mod.metadata.title).toBe("Block · StoreMink Admin");
  });
});

describe("BlockDetailPage heading", () => {
  it("names an item block with its chip and links back to the blocks", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(pageOf());
    await renderPage();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Product blocked: Blue mug",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Blocked", { selector: "span" })).toBeTruthy();
    const back = screen.getByRole("link", { name: "Complaints" });
    expect(back.getAttribute("href")).toContain("/dashboard/complaints");
    expect(back.getAttribute("href")).toContain("blocks");
  });

  it("names a whole store as suspended", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({
          kind: "store",
          label: "Crumb & Co",
          status: "store_suspended",
        }),
      }),
    );
    await renderPage();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Store suspended: Crumb & Co",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Suspended", { selector: "span" })).toBeTruthy();
  });

  it("shows Lifted for a lifted block", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({
          status: "lifted",
          liftedAt: "2026-10-29T10:00:00.000Z",
          liftedBy: "ops@storemink.com",
          liftNote: "The court order was set aside.",
        }),
      }),
    );
    await renderPage();
    expect(screen.getByText("Lifted", { selector: "span" })).toBeTruthy();
    expect(fact("Lifted").textContent).toBe(
      "29 Oct, 15:30 by ops@storemink.com: The court order was set aside.",
    );
  });
});

describe("BlockDetailPage details", () => {
  it("shows every fact in India time with its links", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(pageOf());
    await renderPage();
    const store = within(fact("Store")).getByRole("link");
    expect(store.getAttribute("href")).toBe(`/dashboard/stores/${STORE_ID}`);
    const address = within(fact("Address")).getByRole("link");
    expect(address.getAttribute("href")).toBe(
      "https://crumb.storemink.com/shop/blue-mug",
    );
    expect(address.getAttribute("target")).toBe("_blank");
    expect(address.getAttribute("rel")).toBe("noopener noreferrer");
    expect(fact("Blocked").textContent).toBe(
      "29 Oct, 14:00 by ops@storemink.com",
    );
    expect(fact("Reason").textContent).not.toBe("court_order");
    expect(fact("Legal basis").textContent).toBe(
      "Order 12/2026 of 20 Oct 2026, section 79",
    );
    const complaint = within(fact("Complaint")).getByRole("link");
    expect(complaint.textContent).toBe("SM-000123");
    expect(complaint.getAttribute("href")).toContain("SM-000123");
    expect(fact("Store told").textContent).toBe("29 Oct, 14:01 by email");
    expect(fact("Store opened the notice").textContent).toBe("Not yet");
  });

  it("says when the store opened the notice", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({ block: block({ merchantSeenAt: "2026-10-29T12:00:00.000Z" }) }),
    );
    await renderPage();
    expect(fact("Store opened the notice").textContent).toBe("29 Oct, 17:30");
  });

  it("★ an untold block says it was kept from the store", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({
          tellStore: false,
          status: "blocked_untold",
          merchantNotifiedAt: null,
        }),
      }),
    );
    await renderPage();
    expect(fact("Store told").textContent).toBe(
      "Not told: kept from the store under an order",
    );
    expect(fact("Store opened the notice").textContent).toBe("-");
    expect(
      screen.getByText(
        "The store has not been told about this block, so there is no one to reply to yet.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("reply")).toBeNull();
  });

  it("says a failed notice email is being retried", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({ merchantNotifiedAt: null, noticeEmailFailed: true }),
      }),
    );
    await renderPage();
    expect(fact("Store told").textContent).toBe("Email failed, retrying");
  });

  it("says Not yet before the notice email has gone", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({ block: block({ merchantNotifiedAt: null }) }),
    );
    await renderPage();
    expect(fact("Store told").textContent).toBe("Not yet");
  });

  it("explains a block with no complaint", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({
          complaintId: null,
          complaintRef: null,
          reasonKind: "store_request",
          legalBasis: "",
        }),
      }),
    );
    await renderPage();
    expect(fact("Complaint").textContent).toBe(
      "No complaint: the store asked us",
    );
    expect(fact("Legal basis").textContent).toBe("-");
  });

  it("says StoreMink found it when no one complained", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({
          complaintId: null,
          complaintRef: null,
          reasonKind: "terms_breach",
        }),
      }),
    );
    await renderPage();
    expect(fact("Complaint").textContent).toBe(
      "No complaint: StoreMink found it",
    );
  });

  it("does not link an address that is not a web address", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({ block: block({ url: "stores/x/hero.webp" }) }),
    );
    await renderPage();
    expect(within(fact("Address")).queryByRole("link")).toBeNull();
    expect(fact("Address").textContent).toBe("stores/x/hero.webp");
  });

  it("links the block this one is part of", async () => {
    const parentId = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({
          kind: "file",
          label: "hero.webp",
          parentBlockId: parentId,
        }),
        parent: row({ id: parentId, kind: "product", label: "Blue mug" }),
      }),
    );
    await renderPage();
    const link = within(fact("Part of")).getByRole("link");
    expect(link.textContent).toBe("Product blocked: Blue mug");
    expect(link.getAttribute("href")).toContain(parentId);
  });
});

describe("BlockDetailPage file", () => {
  const cases: [string, Partial<BlockDetail>, string, boolean, boolean][] = [
    [
      "archived",
      { fileStage: "archived" },
      "Archived. It is replaced with the placeholder about a minute after the block.",
      false,
      false,
    ],
    [
      "replaced",
      { fileStage: "replaced" },
      "Replaced with the placeholder",
      false,
      false,
    ],
    [
      "copying",
      { fileStage: "copying" },
      "Not archived yet, still at its storage address",
      true,
      false,
    ],
    [
      "copy failed",
      { fileStage: "copy_failed" },
      "The copy failed after 24 hours. Retry it.",
      true,
      false,
    ],
    [
      "built into a theme",
      { fileStage: "remove_by_hand" },
      "Built into a theme: remove it in the code",
      false,
      true,
    ],
    [
      "removed by hand",
      { fileStage: "removed_by_hand" },
      "Removed by hand",
      false,
      false,
    ],
    [
      "not ours",
      { fileStage: "not_ours" },
      "Not StoreMink's file",
      false,
      false,
    ],
    [
      "restoring",
      { fileStage: "restoring" },
      "Restoring the original",
      false,
      false,
    ],
    ["restored", { fileStage: "restored" }, "Restored", false, false],
    [
      "not restored",
      { fileStage: "not_restored" },
      "Not restored: the file was changed or removed",
      false,
      false,
    ],
    [
      "cancelled",
      { fileStage: "cancelled" },
      "Replacement cancelled when the block was lifted",
      false,
      false,
    ],
    [
      "a replacement that can be retried",
      { fileStage: "replace_failed", storageError: "Storage did not answer." },
      "Storage did not answer.",
      true,
      false,
    ],
    [
      "a file that changed after it was copied",
      {
        fileStage: "replace_failed",
        storageError:
          "The file changed after StoreMink copied it, so it was not replaced.",
      },
      "The file changed after StoreMink copied it, so it was not replaced.",
      false,
      false,
    ],
    [
      "a failed replacement with no sentence",
      { fileStage: "replace_failed", storageError: "" },
      "The file changed after StoreMink copied it, so it was not replaced. Block it again to keep a copy of the new version.",
      false,
      false,
    ],
  ];

  it.each(cases)("%s", async (_name, over, text, retry, markRemoved) => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({ block: block({ kind: "file", label: "hero.webp", ...over }) }),
    );
    await renderPage();
    const cell = fact("File");
    expect(within(cell).getByText(text)).toBeTruthy();
    expect(
      within(cell).queryByRole("button", { name: "Retry now" }) !== null,
    ).toBe(retry);
    expect(
      within(cell).queryByRole("button", { name: "Mark as removed" }) !== null,
    ).toBe(markRemoved);
  });

  it("shows no File line for an item block", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(pageOf());
    await renderPage();
    expect(screen.queryByText("File", { selector: "dt" })).toBeNull();
  });
});

describe("BlockDetailPage store copy", () => {
  it("counts files while a whole store's copy runs", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({
          kind: "store",
          label: "Crumb & Co",
          status: "store_suspended",
          archive: {
            filesState: "pending",
            total: 1200,
            copied: 340,
            missing: 0,
            changed: 0,
          },
        }),
      }),
    );
    await renderPage();
    expect(fact("Store copy").textContent).toBe("Copying files: 340 of 1,200");
  });

  it("offers a retry when the store copy failed", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({
          kind: "store",
          label: "Crumb & Co",
          status: "store_suspended",
          archive: {
            filesState: "failed",
            total: 5,
            copied: 2,
            missing: 0,
            changed: 0,
          },
        }),
      }),
    );
    await renderPage();
    const cell = fact("Store copy");
    expect(
      within(cell).getByText("The copy failed after 24 hours. Retry it."),
    ).toBeTruthy();
    expect(
      within(cell).getByRole("button", { name: "Retry now" }),
    ).toBeTruthy();
  });

  it("says the copy is complete with its missing files", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({
          kind: "store",
          label: "Crumb & Co",
          status: "store_suspended",
          archive: {
            filesState: "copied",
            total: 1200,
            copied: 1198,
            missing: 2,
            changed: 0,
          },
        }),
      }),
    );
    await renderPage();
    expect(fact("Store copy").textContent).toBe(
      "Complete: 1,200 files, 2 missing",
    );
  });

  it("puts an item's running copy in the archived copy card", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({
          archive: {
            filesState: "pending",
            total: 4,
            copied: 1,
            missing: 0,
            changed: 0,
          },
        }),
        archive: archive(),
      }),
    );
    await renderPage();
    const card = screen
      .getByRole("heading", { name: "Archived copy" })
      .closest("section") as HTMLElement;
    expect(within(card).getByText("Copying files: 1 of 4")).toBeTruthy();
    expect(screen.queryByText("Store copy", { selector: "dt" })).toBeNull();
  });
});

describe("BlockDetailPage controls", () => {
  it("★★ hands a superadmin's controls only to a superadmin", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(pageOf({ archive: archive() }));
    await renderPage();
    expect(screen.getByTestId("actions").textContent).toContain(
      "superadmin=true",
    );
    expect(screen.getByTestId("archive").textContent).toContain(
      "superadmin=true",
    );
  });

  it("★★ tells the controls a member is not a superadmin", async () => {
    H.role = "member";
    vi.mocked(getBlock).mockResolvedValueOnce(pageOf({ archive: archive() }));
    await renderPage();
    expect(screen.getByTestId("actions").textContent).toContain(
      "superadmin=false",
    );
    expect(screen.getByTestId("archive").textContent).toContain(
      "superadmin=false",
    );
  });

  it("passes the store, its live image blocks and the replacement state", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({ replacingNow: true }),
        children: [
          row({ id: "c-a", kind: "file", label: "a.webp" }),
          row({ id: "c-b", kind: "file", label: "b.webp", status: "lifted" }),
          row({ id: "c-c", kind: "file", label: "c.webp" }),
        ],
        archive: archive(),
      }),
    );
    await renderPage();
    const text = screen.getByTestId("actions").textContent ?? "";
    expect(text).toContain("store=Crumb & Co");
    expect(text).toContain("images=2");
    expect(text).toContain("replacing=true");
    expect(text).toContain("archive=yes");
  });

  it("lists its own blocks", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        children: [row({ id: "c-a", kind: "file", label: "a.webp" })],
      }),
    );
    await renderPage();
    expect(screen.getByRole("heading", { name: "Blocks" })).toBeTruthy();
    expect(screen.getAllByText("a.webp").length).toBeGreaterThan(0);
  });

  it("has no archived copy card without an archive", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(pageOf());
    await renderPage();
    expect(screen.queryByRole("heading", { name: "Archived copy" })).toBeNull();
  });
});

describe("BlockDetailPage conversation and history", () => {
  it("shows each message with its author, India time and review chip", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        messages: [
          message(),
          message({
            id: "m-2",
            fromSide: "storemink",
            author: "ops@storemink.com",
            body: "Thank you, we are looking.",
            asksReview: false,
            at: "2026-10-29T09:30:00.000Z",
          }),
        ],
      }),
    );
    await renderPage();
    expect(screen.getByText("Asha (Crumb & Co) · 29 Oct, 14:30")).toBeTruthy();
    expect(screen.getByText("Asked us to review it again")).toBeTruthy();
    expect(screen.getByText("ops@storemink.com · 29 Oct, 15:00")).toBeTruthy();
    expect(screen.getAllByText(/Asked us to/).length).toBe(1);
    expect(screen.getByTestId("reply")).toBeTruthy();
  });

  it("says a store's request asks to show it again", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({ reasonKind: "store_request" }),
        messages: [message()],
      }),
    );
    await renderPage();
    expect(screen.getByText("Asked us to show it again")).toBeTruthy();
  });

  it("★ says a suspended store replies by email", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        block: block({
          kind: "store",
          label: "Crumb & Co",
          status: "store_suspended",
        }),
      }),
    );
    await renderPage();
    expect(
      screen.getByText(
        "This store can't open its dashboard while suspended. Its replies arrive by email.",
      ),
    ).toBeTruthy();
  });

  it("does not say so for an item block on an open store", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(pageOf());
    await renderPage();
    expect(
      screen.queryByText(/can't open its dashboard while suspended/),
    ).toBeNull();
  });

  it("lists the record in India time", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(
      pageOf({
        events: [
          event(),
          event({
            id: "e-2",
            at: "2026-10-29T09:00:00.000Z",
            action: "store_replied",
          }),
        ],
      }),
    );
    await renderPage();
    const card = screen
      .getByRole("heading", { name: "History" })
      .closest("section") as HTMLElement;
    const items = within(card).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "29 Oct, 14:00 · Store emailed about the block on Blue mug",
      "29 Oct, 14:30 · The store replied about Blue mug",
    ]);
  });

  it("shows a dash for an empty record", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(pageOf());
    await renderPage();
    const card = screen
      .getByRole("heading", { name: "History" })
      .closest("section") as HTMLElement;
    expect(within(card).getByText("-")).toBeTruthy();
  });
});
