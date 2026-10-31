// @vitest-environment jsdom
// The controls of a block's page (takedown design 6.6, stage T16b): the lift
// dialog's lines by where the file stands, a superadmin's buttons only for a
// superadmin, the archived copy opened only after a reason, and the action's
// own sentence shown on a refusal.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ArchiveForViewing,
  ArchiveSummary,
} from "@/lib/moderation/console-read";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  tell: vi.fn(),
  lift: vi.fn(),
  retry: vi.fn(),
  markRemoved: vi.fn(),
  open: vi.fn(),
  extend: vi.fn(),
  release: vi.fn(),
  reply: vi.fn(),
  emailed: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: state.refresh }),
}));
vi.mock("sonner", () => ({
  toast: {
    success: state.toastSuccess,
    warning: state.toastWarning,
    error: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock("@/app/actions/takedown-actions", () => ({
  tellStoreNowAction: state.tell,
  liftBlockAction: state.lift,
  retryStorageAction: state.retry,
  markRemovedByHandAction: state.markRemoved,
  openArchiveAction: state.open,
  extendArchiveAction: state.extend,
  releaseArchiveHoldAction: state.release,
  replyToStoreAction: state.reply,
  addStoreEmailedReplyAction: state.emailed,
}));

import {
  ArchiveCopy,
  BlockActions,
  LIFT_REPLACING,
  MarkRemovedButton,
  REQUEST_FAILED,
  RetryNowButton,
  StoreReplyForms,
  archiveFileHref,
  archiveRecordHref,
  archiveSummaryLine,
  liftDialogLines,
  type BlockActionsProps,
} from "./block-detail";

const BLOCK_ID = "22222222-2222-4222-8222-222222222222";
const OK = { ok: true as const, message: "Done." };

function props(over: Partial<BlockActionsProps> = {}): BlockActionsProps {
  return {
    blockId: BLOCK_ID,
    kind: "product",
    label: "Blue mug",
    storeName: "Crumb & Co",
    storeStatusBefore: null,
    status: "blocked",
    told: true,
    fileStage: null,
    replacingNow: false,
    archive: {
      keepUntil: "2027-04-27T08:30:00.000Z",
      legalHold: false,
      purgedAt: null,
    },
    liveImageBlocks: 0,
    superadmin: true,
    ...over,
  };
}

function summary(over: Partial<ArchiveSummary> = {}): ArchiveSummary {
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
      total: 2,
      copied: 2,
      missing: 0,
      changed: 0,
    },
    ...over,
  };
}

function viewing(over: Partial<ArchiveForViewing> = {}): ArchiveForViewing {
  return {
    blockId: BLOCK_ID,
    storeId: "s-1",
    createdAt: "2026-10-29T08:30:00.000Z",
    keepUntil: "2027-04-27T08:30:00.000Z",
    legalHold: false,
    snapshot: {
      store: { row: { name: "Crumb & Co" } },
      item: { kind: "product", row: { name: "Blue mug" } },
      related: { reviews: [] },
      history: [],
    },
    sha256: "cd".repeat(32),
    hashMatches: true,
    filesState: "copied",
    files: [
      {
        entry: {
          n: 1,
          source: "bucket",
          path: "stores/s-1/products/blue-mug.webp",
          state: "copied",
          size: 12345,
          contentType: "image/webp",
          sha256: "ef".repeat(32),
        },
        raw: {},
      },
      {
        entry: {
          n: 2,
          source: "bucket",
          path: "stores/s-1/products/gone.webp",
          state: "missing",
          size: null,
          contentType: null,
          sha256: null,
        },
        raw: {},
      },
      { entry: null, raw: { strange: true } },
    ],
    ...over,
  } as unknown as ArchiveForViewing;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in tests");
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("liftDialogLines", () => {
  const archive = {
    keepUntil: "2027-04-27T08:30:00.000Z",
    legalHold: false,
    purgedAt: null,
  };

  it("opens a store again with the status it had", () => {
    expect(
      liftDialogLines({
        kind: "store",
        storeName: "Crumb & Co",
        storeStatusBefore: "active",
        fileStage: null,
        archive: null,
      }),
    ).toEqual(["The store opens again with the status it had before (Open)."]);
    expect(
      liftDialogLines({
        kind: "store",
        storeName: "Crumb & Co",
        storeStatusBefore: "suspended",
        fileStage: null,
        archive: null,
      })[0],
    ).toBe("The store opens again with the status it had before (Suspended).");
    expect(
      liftDialogLines({
        kind: "store",
        storeName: "Crumb & Co",
        storeStatusBefore: null,
        fileStage: null,
        archive: null,
      })[0],
    ).toBe("The store opens again with the status it had before.");
  });

  it("puts a replaced file back, and warns about image sizes", () => {
    expect(
      liftDialogLines({
        kind: "file",
        storeName: "Crumb & Co",
        storeStatusBefore: null,
        fileStage: "replaced",
        archive,
      }),
    ).toEqual([
      "The original file goes back to its address. Some image sizes may show the placeholder for up to 4 hours.",
      "The archived copy is kept until 27 Apr 2027.",
    ]);
  });

  it("asks for a file removed by hand to go back by hand", () => {
    expect(
      liftDialogLines({
        kind: "file",
        storeName: "Crumb & Co",
        storeStatusBefore: null,
        fileStage: "removed_by_hand",
        archive: null,
      }),
    ).toEqual([
      "Pages show it again. Put the file back by hand from the archived copy if needed (see the runbook).",
    ]);
  });

  it("says pages show any other file again", () => {
    for (const stage of ["archived", "not_ours", null] as const) {
      expect(
        liftDialogLines({
          kind: "file",
          storeName: "Crumb & Co",
          storeStatusBefore: null,
          fileStage: stage,
          archive: null,
        }),
      ).toEqual(["Pages show it again."]);
    }
  });

  it("names the store for an item", () => {
    expect(
      liftDialogLines({
        kind: "product",
        storeName: "Crumb & Co",
        storeStatusBefore: null,
        fileStage: null,
        archive: null,
      }),
    ).toEqual([
      "It shows on Crumb & Co again as the store last saved it, if the store has it published.",
    ]);
  });

  it("says a held copy is kept until released, and nothing once purged", () => {
    expect(
      liftDialogLines({
        kind: "product",
        storeName: "Crumb & Co",
        storeStatusBefore: null,
        fileStage: null,
        archive: { ...archive, legalHold: true },
      })[1],
    ).toBe("The archived copy is kept until it is released.");
    expect(
      liftDialogLines({
        kind: "product",
        storeName: "Crumb & Co",
        storeStatusBefore: null,
        fileStage: null,
        archive: { ...archive, purgedAt: "2027-04-28T00:00:00.000Z" },
      }),
    ).toHaveLength(1);
  });
});

describe("archive links and summary", () => {
  it("builds the file and record links with the receipt", () => {
    expect(archiveFileHref("b 1", 3, "r/1")).toBe(
      "/api/platform/takedowns/b%201/files/3?receipt=r%2F1",
    );
    expect(archiveFileHref("b1", 3, "r1", true)).toBe(
      "/api/platform/takedowns/b1/files/3?receipt=r1&download=1",
    );
    expect(archiveRecordHref("b1", "r1")).toBe(
      "/api/platform/takedowns/b1/record?receipt=r1",
    );
  });

  it("says when the copy will be deleted", () => {
    expect(archiveSummaryLine(summary(), true)).toBe(
      "A copy was kept on 29 Oct 2026 and will be deleted after 27 Apr 2027.",
    );
  });

  it("★ tells a member only a superadmin can open it", () => {
    expect(archiveSummaryLine(summary(), false)).toBe(
      "A copy was kept on 29 Oct 2026 and will be deleted after 27 Apr 2027. Only a superadmin can open it.",
    );
  });

  it("says a held copy is kept until released", () => {
    expect(archiveSummaryLine(summary({ legalHold: true }), true)).toBe(
      "A copy was kept on 29 Oct 2026 and will be kept until it is released.",
    );
  });

  it("names the fingerprint of a purged copy", () => {
    expect(
      archiveSummaryLine(
        summary({ purgedAt: "2027-04-28T00:00:00.000Z" }),
        false,
      ),
    ).toBe(
      `The copy was deleted on 28 Apr 2027, as the law allows after 180 days. Its fingerprint was SHA-256 ${"ab".repeat(32)}.`,
    );
  });
});

describe("BlockActions", () => {
  it("★★ renders nothing for a member", () => {
    const { container } = render(
      <BlockActions
        {...props({ superadmin: false, status: "blocked_untold" })}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders nothing for a lifted block", () => {
    const { container } = render(
      <BlockActions {...props({ status: "lifted" })} />,
    );
    expect(container.textContent).toBe("");
  });

  it("offers Tell the store now only while the store is untold", () => {
    render(<BlockActions {...props()} />);
    expect(
      screen.queryByRole("button", { name: "Tell the store now" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Lift block" })).toBeTruthy();
    cleanup();
    render(
      <BlockActions {...props({ status: "blocked_untold", told: false })} />,
    );
    expect(
      screen.getByRole("button", { name: "Tell the store now" }),
    ).toBeTruthy();
  });

  it("tells the store after the dialog, and refreshes", async () => {
    state.tell.mockResolvedValue({
      ok: true,
      message: "The store has been told.",
      warnings: ["The email could not be sent."],
    });
    render(
      <BlockActions {...props({ status: "blocked_untold", told: false })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tell the store now" }));
    const box = dialog();
    expect(
      within(box).getByRole("heading", {
        name: "Tell Crumb & Co about this block now?",
      }),
    ).toBeTruthy();
    expect(
      within(box).getByText(
        "They get the email, the notice and the label on the item. This can't be undone.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(box).getByRole("button", { name: "Tell the store now" }),
    );
    await waitFor(() => expect(state.tell).toHaveBeenCalledWith(BLOCK_ID));
    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        "The store has been told.",
      ),
    );
    expect(state.toastWarning).toHaveBeenCalledWith(
      "The email could not be sent.",
    );
    expect(state.refresh).toHaveBeenCalled();
  });

  it("shows the action's own refusal", async () => {
    state.tell.mockResolvedValue({
      ok: false,
      error: "Only a superadmin can tell the store.",
    });
    render(
      <BlockActions {...props({ status: "blocked_untold", told: false })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tell the store now" }));
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "Tell the store now" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Only a superadmin can tell the store.",
    );
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("says the request did not reach StoreMink when it throws", async () => {
    state.tell.mockRejectedValue(new Error("offline"));
    render(
      <BlockActions {...props({ status: "blocked_untold", told: false })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tell the store now" }));
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "Tell the store now" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(REQUEST_FAILED);
  });

  it("lifts an item with its note, the email and its images", async () => {
    state.lift.mockResolvedValue(OK);
    render(<BlockActions {...props({ liveImageBlocks: 2 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Lift block" }));
    const box = dialog();
    expect(
      within(box).getByRole("heading", { name: "Lift the block on Blue mug?" }),
    ).toBeTruthy();
    expect(
      within(box).getByText(
        "It shows on Crumb & Co again as the store last saved it, if the store has it published.",
      ),
    ).toBeTruthy();
    expect(
      within(box).getByText("The archived copy is kept until 27 Apr 2027."),
    ).toBeTruthy();
    fireEvent.change(
      within(box).getByLabelText(
        "Why are you lifting it? The store sees this.",
      ),
      { target: { value: "The order was set aside." } },
    );
    const email = within(box).getByLabelText(
      "Tell the store by email",
    ) as HTMLInputElement;
    const images = within(box).getByLabelText(
      "Also lift the blocks on its 2 images",
    ) as HTMLInputElement;
    expect(email.checked).toBe(true);
    expect(images.checked).toBe(true);
    fireEvent.click(within(box).getByRole("button", { name: "Lift block" }));
    await waitFor(() =>
      expect(state.lift).toHaveBeenCalledWith(BLOCK_ID, {
        note: "The order was set aside.",
        notifyStore: true,
        alsoChildren: true,
      }),
    );
  });

  it("sends the ticks as the operator left them", async () => {
    state.lift.mockResolvedValue(OK);
    render(<BlockActions {...props({ liveImageBlocks: 1 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Lift block" }));
    const box = dialog();
    fireEvent.click(within(box).getByLabelText("Tell the store by email"));
    fireEvent.click(
      within(box).getByLabelText("Also lift the block on its image"),
    );
    fireEvent.click(within(box).getByRole("button", { name: "Lift block" }));
    await waitFor(() =>
      expect(state.lift).toHaveBeenCalledWith(BLOCK_ID, {
        note: "",
        notifyStore: false,
        alsoChildren: false,
      }),
    );
  });

  it("★ never emails a store it never told, and has no image tick without images", async () => {
    state.lift.mockResolvedValue(OK);
    render(
      <BlockActions {...props({ status: "blocked_untold", told: false })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Lift block" }));
    const box = dialog();
    expect(within(box).queryByLabelText("Tell the store by email")).toBeNull();
    expect(within(box).queryByLabelText(/Also lift/)).toBeNull();
    fireEvent.click(within(box).getByRole("button", { name: "Lift block" }));
    await waitFor(() =>
      expect(state.lift).toHaveBeenCalledWith(BLOCK_ID, {
        note: "",
        notifyStore: false,
        alsoChildren: false,
      }),
    );
  });

  it("names the store when lifting a suspension", () => {
    render(
      <BlockActions
        {...props({
          kind: "store",
          label: "Crumb & Co",
          status: "store_suspended",
          storeStatusBefore: "active",
          archive: null,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Lift block" }));
    const box = dialog();
    expect(
      within(box).getByRole("heading", {
        name: "Lift the suspension of Crumb & Co?",
      }),
    ).toBeTruthy();
    expect(
      within(box).getByText(
        "The store opens again with the status it had before (Open).",
      ),
    ).toBeTruthy();
  });

  it("★ waits while a replacement holds the file, with the reason under the button", () => {
    render(
      <BlockActions
        {...props({ kind: "file", label: "hero.webp", replacingNow: true })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Lift block" }));
    const box = dialog();
    const button = within(box).getByRole("button", {
      name: "Lift block",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const reason = within(box).getByText(LIFT_REPLACING);
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);
    expect(button.getAttribute("title")).toBeNull();
  });

  it("closes on Cancel without lifting", () => {
    render(<BlockActions {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Lift block" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.lift).not.toHaveBeenCalled();
  });
});

describe("RetryNowButton", () => {
  it("retries and refreshes", async () => {
    state.retry.mockResolvedValue({ ok: true, message: "Retrying now." });
    render(<RetryNowButton blockId={BLOCK_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(state.retry).toHaveBeenCalledWith(BLOCK_ID));
    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith("Retrying now."),
    );
    expect(state.refresh).toHaveBeenCalled();
  });

  it("shows the action's refusal beside the button", async () => {
    state.retry.mockResolvedValue({
      ok: false,
      error: "Nothing is waiting to be retried.",
    });
    render(<RetryNowButton blockId={BLOCK_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Nothing is waiting to be retried.",
    );
  });

  it("says the request failed when it throws", async () => {
    state.retry.mockRejectedValue(new Error("offline"));
    render(<RetryNowButton blockId={BLOCK_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect((await screen.findByRole("alert")).textContent).toBe(REQUEST_FAILED);
  });
});

describe("MarkRemovedButton", () => {
  it("asks how it was removed, then marks it", async () => {
    state.markRemoved.mockResolvedValue(OK);
    render(<MarkRemovedButton blockId={BLOCK_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark as removed" }));
    const box = dialog();
    expect(
      within(box).getByRole("heading", { name: "Mark it as removed?" }),
    ).toBeTruthy();
    expect(
      within(box).getByText("Do this only after the file is deleted."),
    ).toBeTruthy();
    fireEvent.change(within(box).getByLabelText("How it was removed"), {
      target: { value: "Deleted from the theme code." },
    });
    fireEvent.click(
      within(box).getByRole("button", { name: "Mark as removed" }),
    );
    await waitFor(() =>
      expect(state.markRemoved).toHaveBeenCalledWith(
        BLOCK_ID,
        "Deleted from the theme code.",
      ),
    );
  });
});

describe("ArchiveCopy", () => {
  it("★★ offers a member no buttons, only why", () => {
    render(
      <ArchiveCopy blockId={BLOCK_ID} archive={summary()} superadmin={false} />,
    );
    expect(screen.getByText(/Only a superadmin can open it\./)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers no buttons once the copy is purged", () => {
    render(
      <ArchiveCopy
        blockId={BLOCK_ID}
        archive={summary({ purgedAt: "2027-04-28T00:00:00.000Z" })}
        superadmin
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers a superadmin Open the copy and Keep longer", () => {
    render(<ArchiveCopy blockId={BLOCK_ID} archive={summary()} superadmin />);
    expect(screen.getByRole("button", { name: "Open the copy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep longer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Release hold" })).toBeNull();
  });

  it("shows who asked for a hold, and offers Release hold", () => {
    render(
      <ArchiveCopy
        blockId={BLOCK_ID}
        archive={summary({
          legalHold: true,
          legalHoldNote: "Faridkot police, letter 41/2026",
        })}
        superadmin
      />,
    );
    expect(
      screen.getByText("Who asked: Faridkot police, letter 41/2026"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Release hold" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Keep longer" })).toBeNull();
  });

  it("★★ asks why before opening, and shows the action's refusal", async () => {
    state.open.mockResolvedValue({
      ok: false,
      error: "Write why you are opening it.",
    });
    render(<ArchiveCopy blockId={BLOCK_ID} archive={summary()} superadmin />);
    fireEvent.click(screen.getByRole("button", { name: "Open the copy" }));
    const box = dialog();
    expect(
      within(box).getByRole("heading", { name: "Open the copy" }),
    ).toBeTruthy();
    expect(
      within(box).getByText(
        "The complaint reference or the authority that asked.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(box).getByRole("button", { name: "Open the copy" }));
    expect((await within(box).findByRole("alert")).textContent).toBe(
      "Write why you are opening it.",
    );
    expect(state.open).toHaveBeenCalledWith(BLOCK_ID, "");
    expect(screen.queryByText("Download record")).toBeNull();
  });

  it("opens the copy with the reason and links to it with the receipt", async () => {
    state.open.mockResolvedValue({
      ok: true,
      receipt: "rcpt-1",
      archive: viewing(),
    });
    render(<ArchiveCopy blockId={BLOCK_ID} archive={summary()} superadmin />);
    fireEvent.click(screen.getByRole("button", { name: "Open the copy" }));
    const box = dialog();
    fireEvent.change(within(box).getByLabelText("Why are you opening it?"), {
      target: { value: "SM-000123" },
    });
    fireEvent.click(within(box).getByRole("button", { name: "Open the copy" }));
    await waitFor(() =>
      expect(state.open).toHaveBeenCalledWith(BLOCK_ID, "SM-000123"),
    );
    const record = await screen.findByRole("link", { name: "Download record" });
    expect(record.getAttribute("href")).toBe(
      `/api/platform/takedowns/${BLOCK_ID}/record?receipt=rcpt-1`,
    );
    expect(screen.getByText(`SHA-256: ${"cd".repeat(32)}`)).toBeTruthy();
    for (const title of ["Store", "Item", "Related", "History", "Files"]) {
      expect(screen.getByText(title, { selector: "summary" })).toBeTruthy();
    }
    expect(screen.getByText("stores/s-1/products/blue-mug.webp")).toBeTruthy();
    expect(screen.getByText("Copied · image/webp · 12,345 bytes")).toBeTruthy();
    expect(screen.getByText("Missing")).toBeTruthy();
    const downloads = screen.getAllByRole("link", { name: "Download" });
    expect(downloads).toHaveLength(1);
    expect(downloads[0].getAttribute("href")).toBe(
      `/api/platform/takedowns/${BLOCK_ID}/files/1?receipt=rcpt-1&download=1`,
    );
    expect(screen.getAllByRole("button", { name: "Show" })).toHaveLength(1);
    expect(
      screen.queryByText("The copy no longer matches its fingerprint."),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("★ warns when the copy no longer matches its fingerprint", async () => {
    state.open.mockResolvedValue({
      ok: true,
      receipt: "rcpt-1",
      archive: viewing({ hashMatches: false }),
    });
    render(<ArchiveCopy blockId={BLOCK_ID} archive={summary()} superadmin />);
    fireEvent.click(screen.getByRole("button", { name: "Open the copy" }));
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "Open the copy" }),
    );
    expect(
      await screen.findByText("The copy no longer matches its fingerprint."),
    ).toBeTruthy();
  });

  async function openViewer() {
    state.open.mockResolvedValue({
      ok: true,
      receipt: "rcpt-1",
      archive: viewing(),
    });
    render(<ArchiveCopy blockId={BLOCK_ID} archive={summary()} superadmin />);
    fireEvent.click(screen.getByRole("button", { name: "Open the copy" }));
    fireEvent.change(
      within(dialog()).getByLabelText("Why are you opening it?"),
      {
        target: { value: "SM-000123" },
      },
    );
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "Open the copy" }),
    );
    await screen.findByRole("link", { name: "Download record" });
  }

  it("★ fetches a picture's bytes only when Show is pressed", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["x"], { type: "image/webp" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    // jsdom has no object URLs; add them for this test only.
    const urlApi = URL as unknown as {
      createObjectURL?: unknown;
      revokeObjectURL?: unknown;
    };
    const before = {
      create: urlApi.createObjectURL,
      revoke: urlApi.revokeObjectURL,
    };
    const create = vi.fn(() => "blob:shown");
    const revoke = vi.fn();
    urlApi.createObjectURL = create;
    urlApi.revokeObjectURL = revoke;
    try {
      await openViewer();
      expect(fetchMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Show" }));
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/platform/takedowns/${BLOCK_ID}/files/1?receipt=rcpt-1`,
          { cache: "no-store", credentials: "same-origin" },
        ),
      );
      await waitFor(() =>
        expect(document.querySelector('img[src="blob:shown"]')).not.toBeNull(),
      );
      expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
      cleanup();
      expect(revoke).toHaveBeenCalledWith("blob:shown");
    } finally {
      urlApi.createObjectURL = before.create;
      urlApi.revokeObjectURL = before.revoke;
    }
  });

  it("shows the route's own sentence when a file cannot be shown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () => "Write why you are opening it.",
      })),
    );
    await openViewer();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Write why you are opening it.",
    );
  });

  it("says the file could not be read for a 404 or a failed request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        text: async () => "Not found",
      })),
    );
    await openViewer();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not read the file. Please try again.",
    );
  });

  it("keeps the copy until a date, with who asked", async () => {
    state.extend.mockResolvedValue(OK);
    render(<ArchiveCopy blockId={BLOCK_ID} archive={summary()} superadmin />);
    fireEvent.click(screen.getByRole("button", { name: "Keep longer" }));
    const box = dialog();
    expect(
      within(box).getByRole("heading", { name: "Keep this copy longer" }),
    ).toBeTruthy();
    fireEvent.change(
      within(box).getByLabelText("Until a date", {
        selector: "input[type=date]",
      }),
      {
        target: { value: "2027-12-31" },
      },
    );
    fireEvent.change(within(box).getByLabelText("Who asked"), {
      target: { value: "Faridkot police, letter 41/2026" },
    });
    fireEvent.click(within(box).getByRole("button", { name: "Keep longer" }));
    await waitFor(() =>
      expect(state.extend).toHaveBeenCalledWith(
        BLOCK_ID,
        { until: "2027-12-31" },
        "Faridkot police, letter 41/2026",
      ),
    );
  });

  it("holds the copy until released", async () => {
    state.extend.mockResolvedValue(OK);
    render(<ArchiveCopy blockId={BLOCK_ID} archive={summary()} superadmin />);
    fireEvent.click(screen.getByRole("button", { name: "Keep longer" }));
    const box = dialog();
    fireEvent.click(within(box).getByLabelText("Until we release it"));
    expect(
      within(box).queryByLabelText("Until a date", {
        selector: "input[type=date]",
      }),
    ).toBeNull();
    fireEvent.click(within(box).getByRole("button", { name: "Keep longer" }));
    await waitFor(() =>
      expect(state.extend).toHaveBeenCalledWith(BLOCK_ID, { hold: true }, ""),
    );
  });

  it("releases a hold with a note", async () => {
    state.release.mockResolvedValue(OK);
    render(
      <ArchiveCopy
        blockId={BLOCK_ID}
        archive={summary({ legalHold: true })}
        superadmin
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Release hold" }));
    const box = dialog();
    expect(
      within(box).getByRole("heading", { name: "Release hold" }),
    ).toBeTruthy();
    fireEvent.change(within(box).getByLabelText("Note"), {
      target: { value: "The case is closed." },
    });
    fireEvent.click(within(box).getByRole("button", { name: "Release hold" }));
    await waitFor(() =>
      expect(state.release).toHaveBeenCalledWith(
        BLOCK_ID,
        "The case is closed.",
      ),
    );
  });
});

describe("StoreReplyForms", () => {
  it("sends a reply, clears the box and refreshes", async () => {
    state.reply.mockResolvedValue({ ok: true, message: "Reply sent." });
    render(<StoreReplyForms blockId={BLOCK_ID} />);
    const box = screen.getByLabelText(
      "Reply to the store",
    ) as HTMLTextAreaElement;
    // No instruction in the box: who sees a reply sits behind the "i".
    expect(box.getAttribute("placeholder")).toBeNull();
    expect(screen.getByRole("button", { name: "About replies" })).toBeTruthy();
    fireEvent.change(box, { target: { value: "We are looking at it." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(state.reply).toHaveBeenCalledWith(
        BLOCK_ID,
        "We are looking at it.",
      ),
    );
    await waitFor(() => expect(box.value).toBe(""));
    expect(state.toastSuccess).toHaveBeenCalledWith("Reply sent.");
    expect(state.refresh).toHaveBeenCalled();
  });

  it("shows the action's refusal and keeps the words", async () => {
    state.reply.mockResolvedValue({
      ok: false,
      error: "The store has not been told about this block.",
    });
    render(<StoreReplyForms blockId={BLOCK_ID} />);
    const box = screen.getByLabelText(
      "Reply to the store",
    ) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The store has not been told about this block.",
    );
    expect(box.value).toBe("Hello");
  });

  it("adds the store's emailed reply", async () => {
    state.emailed.mockResolvedValue(OK);
    render(<StoreReplyForms blockId={BLOCK_ID} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Add the store's emailed reply" }),
    );
    const box = dialog();
    expect(
      within(box).getByRole("heading", {
        name: "Add the store's emailed reply",
      }),
    ).toBeTruthy();
    fireEvent.change(within(box).getByLabelText("From"), {
      target: { value: "owner@crumb.example" },
    });
    fireEvent.change(within(box).getByLabelText("Their reply"), {
      target: { value: "We removed it." },
    });
    fireEvent.click(within(box).getByRole("button", { name: "Add reply" }));
    await waitFor(() =>
      expect(state.emailed).toHaveBeenCalledWith(
        BLOCK_ID,
        "owner@crumb.example",
        "We removed it.",
      ),
    );
  });
});
