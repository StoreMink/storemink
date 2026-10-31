import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComplaintRow } from "@/lib/moderation/complaints";
import type { StoreHoldRow } from "@/lib/moderation/holds";
import type { ResolvedTarget } from "@/lib/moderation/console-read";

/**
 * The operator console's takedown actions (stage T15; design 3.10, 5.5, 6,
 * 8.1, 10). Every lib/moderation function is a spy that passes through to
 * the real one, so a refusal the lib makes before any read comes back in the
 * design's own words; a test that needs a success replaces the answer. The
 * database throws, so nothing here reaches one.
 */

const h = vi.hoisted(() => ({
  viewer: null as null | { email: string; role: "superadmin" | "member" },
  production: false,
}));

vi.mock("@/app/actions/platform", () => ({
  getPlatformViewer: vi.fn(async () => h.viewer),
}));
vi.mock("@/lib/db/client", () => {
  const refuse = async () => {
    throw new Error("no database in this test");
  };
  return {
    withService: vi.fn(refuse),
    withUser: vi.fn(refuse),
    withAnon: vi.fn(refuse),
  };
});
vi.mock("@/lib/store/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store/host")>();
  return {
    ...actual,
    get IS_PRODUCTION_PLATFORM() {
      return h.production;
    },
  };
});
vi.mock("next/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/cache")>();
  return { ...actual, refresh: vi.fn() };
});
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/moderation/follow-ups", () => ({
  runModerationFollowUps: vi.fn(async () => ({})),
}));
vi.mock("@/lib/moderation/notify", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/notify")>();
  return {
    ...actual,
    notifyComplaintUrgent: vi.fn(async () => "event-id"),
    acknowledgeComplainant: vi.fn(async () => ({ sent: true })),
    tellComplainantOutcome: vi.fn(async () => ({ sent: true })),
  };
});
vi.mock("@/lib/moderation/complaints", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/complaints")>();
  return {
    ...actual,
    logComplaint: vi.fn(actual.logComplaint),
    updateComplaint: vi.fn(actual.updateComplaint),
    acknowledgeComplaint: vi.fn(actual.acknowledgeComplaint),
    markActioned: vi.fn(actual.markActioned),
    resolveComplaint: vi.fn(actual.resolveComplaint),
    reopenComplaint: vi.fn(actual.reopenComplaint),
  };
});
vi.mock("@/lib/moderation/block", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/block")>();
  return {
    ...actual,
    blockItem: vi.fn(actual.blockItem),
    liftBlock: vi.fn(actual.liftBlock),
    tellStoreNow: vi.fn(actual.tellStoreNow),
    replyToStore: vi.fn(actual.replyToStore),
    addStoreEmailedReply: vi.fn(actual.addStoreEmailedReply),
    markRemovedByHand: vi.fn(actual.markRemovedByHand),
    retryStorage: vi.fn(actual.retryStorage),
  };
});
vi.mock("@/lib/moderation/archive", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/archive")>();
  return {
    ...actual,
    recordArchiveView: vi.fn(actual.recordArchiveView),
    extendArchive: vi.fn(actual.extendArchive),
    releaseArchiveHold: vi.fn(actual.releaseArchiveHold),
  };
});
vi.mock("@/lib/moderation/console-read", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/console-read")>();
  return {
    ...actual,
    resolveTarget: vi.fn(actual.resolveTarget),
    getArchiveForViewing: vi.fn(actual.getArchiveForViewing),
  };
});
vi.mock("@/lib/moderation/holds", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/holds")>();
  return {
    ...actual,
    setStoreHold: vi.fn(actual.setStoreHold),
    releaseStoreHold: vi.fn(actual.releaseStoreHold),
  };
});

import * as actions from "./takedown-actions";
import { refresh } from "next/cache";
import { logError, logWarn } from "@/lib/observability/logger";
import { runModerationFollowUps } from "@/lib/moderation/follow-ups";
import {
  acknowledgeComplainant,
  notifyComplaintUrgent,
  tellComplainantOutcome,
} from "@/lib/moderation/notify";
import {
  acknowledgeComplaint,
  logComplaint,
  markActioned,
  reopenComplaint,
  resolveComplaint,
  updateComplaint,
} from "@/lib/moderation/complaints";
import {
  addStoreEmailedReply,
  blockItem,
  liftBlock,
  markRemovedByHand,
  replyToStore,
  retryStorage,
  tellStoreNow,
} from "@/lib/moderation/block";
import {
  extendArchive,
  recordArchiveView,
  releaseArchiveHold,
} from "@/lib/moderation/archive";
import {
  getArchiveForViewing,
  resolveTarget,
} from "@/lib/moderation/console-read";
import { releaseStoreHold, setStoreHold } from "@/lib/moderation/holds";

const BLOCK = "11111111-1111-4111-8111-111111111111";
const COMPLAINT = "22222222-2222-4222-8222-222222222222";
const STORE = "33333333-3333-4333-8333-333333333333";
const HOLD = "44444444-4444-4444-8444-444444444444";
const EVENT = "55555555-5555-4555-8555-555555555555";

const MEMBER = { email: "member@storemink.com", role: "member" as const };
const SUPER = { email: "owner@storemink.com", role: "superadmin" as const };

const NOT_OPERATOR = "Only a StoreMink operator can block content.";

const LIB = {
  logComplaint,
  updateComplaint,
  acknowledgeComplaint,
  markActioned,
  resolveComplaint,
  reopenComplaint,
  resolveTarget,
  blockItem,
  liftBlock,
  tellStoreNow,
  replyToStore,
  addStoreEmailedReply,
  markRemovedByHand,
  retryStorage,
  recordArchiveView,
  getArchiveForViewing,
  extendArchive,
  releaseArchiveHold,
  setStoreHold,
  releaseStoreHold,
};

function row(over: Partial<ComplaintRow> = {}): ComplaintRow {
  return {
    id: COMPLAINT,
    refNo: 123,
    receivedAt: "2026-10-29T09:00:00.000Z",
    channel: "email",
    kind: "grievance",
    complainantName: "Asha Rao",
    complainantContact: "asha@example.com",
    storeId: STORE,
    storeLabel: "Crumb & Co (crumb.storemink.com)",
    urls: ["https://crumb.storemink.com/shop/blue-mug"],
    summary: "Remove the blue mug photo.",
    actionDueAt: "2026-11-05T09:00:00.000Z",
    ...over,
  } as unknown as ComplaintRow;
}

const ARCHIVE = {
  blockId: BLOCK,
  storeId: STORE,
  createdAt: "2026-10-26T07:01:00.000Z",
  keepUntil: "2027-04-24T18:29:59.000Z",
  legalHold: false,
  snapshot: { item: { name: "Blue mug" } },
  sha256: "a".repeat(64),
  hashMatches: true,
  filesState: "complete",
  files: [],
};

/** The toast an answer carries, or its error when it is a refusal. */
function messageOf(result: { ok: boolean }): string | undefined {
  const r = result as { message?: string; error?: string };
  return r.message ?? r.error;
}

/** Every lib call answers a success (a test then reads what was asked). */
function succeed() {
  vi.mocked(logComplaint).mockResolvedValue({
    ok: true,
    complaint: row(),
    urgent: false,
  });
  vi.mocked(updateComplaint).mockResolvedValue({
    ok: true,
    complaint: row({ kind: "court_order" }),
    changed: ["kind"],
    passed: [],
  });
  vi.mocked(acknowledgeComplaint).mockResolvedValue({
    ok: true,
    complaint: row(),
    emailed: false,
  });
  vi.mocked(markActioned).mockResolvedValue({ ok: true, complaint: row() });
  vi.mocked(resolveComplaint).mockResolvedValue({
    ok: true,
    complaint: row(),
    emailed: null,
  });
  vi.mocked(reopenComplaint).mockResolvedValue({ ok: true, complaint: row() });
  vi.mocked(resolveTarget).mockResolvedValue({
    ok: true,
    found: "target",
    target: { kind: "product" } as unknown as ResolvedTarget,
  });
  vi.mocked(blockItem).mockResolvedValue({
    ok: true,
    blockId: BLOCK,
    childBlockIds: [],
    warnings: [],
  });
  vi.mocked(liftBlock).mockResolvedValue({
    ok: true,
    liftedIds: [BLOCK],
    warnings: [],
  });
  vi.mocked(tellStoreNow).mockResolvedValue({ ok: true, notified: true });
  vi.mocked(replyToStore).mockResolvedValue({
    ok: true,
    messageId: "m1",
    notified: true,
  });
  vi.mocked(addStoreEmailedReply).mockResolvedValue({
    ok: true,
    messageId: "m2",
  });
  vi.mocked(markRemovedByHand).mockResolvedValue({ ok: true });
  vi.mocked(retryStorage).mockResolvedValue({
    ok: true,
    storage: true,
    files: false,
  });
  vi.mocked(recordArchiveView).mockResolvedValue({
    ok: true,
    eventId: EVENT,
    file: null,
    thisDatabase: true,
  });
  vi.mocked(getArchiveForViewing).mockResolvedValue({
    ok: true,
    archive: ARCHIVE,
  });
  vi.mocked(extendArchive).mockResolvedValue({
    ok: true,
    keepUntil: "2027-10-24T18:29:59.000Z",
    legalHold: false,
  });
  vi.mocked(releaseArchiveHold).mockResolvedValue({
    ok: true,
    keepUntil: "2027-04-24T18:29:59.000Z",
  });
  vi.mocked(setStoreHold).mockResolvedValue({
    ok: true,
    hold: { id: HOLD } as unknown as StoreHoldRow,
  });
  vi.mocked(releaseStoreHold).mockResolvedValue({
    ok: true,
    hold: { id: HOLD } as unknown as StoreHoldRow,
  });
}

function complaintForm() {
  return {
    receivedAt: "2026-10-29T14:30",
    channel: "email",
    kind: "grievance",
    complainantName: "Asha Rao",
    complainantContact: "asha@example.com",
    storeId: STORE,
    urls: "https://crumb.storemink.com/shop/blue-mug",
    summary: "Remove the blue mug photo.",
  };
}

function blockForm(over: Record<string, unknown> = {}) {
  return {
    kind: "product" as const,
    storeId: STORE,
    itemId: "66666666-6666-4666-8666-666666666666",
    reason: "terms_breach" as const,
    storeMessage: "We blocked your product because it breaks our policy.",
    ...over,
  };
}

/** One call per export, as the console would make it. */
const CALLS: Record<
  string,
  () => Promise<{ ok: boolean; error?: string; message?: string }>
> = {
  logComplaintAction: () => actions.logComplaintAction(complaintForm()),
  updateComplaintAction: () =>
    actions.updateComplaintAction(COMPLAINT, { kind: "court_order" }),
  acknowledgeComplaintAction: () =>
    actions.acknowledgeComplaintAction(COMPLAINT, { sendEmail: false }),
  markComplaintActionedAction: () =>
    actions.markComplaintActionedAction(COMPLAINT, "Not on StoreMink."),
  resolveComplaintAction: () =>
    actions.resolveComplaintAction(COMPLAINT, { outcome: "removed" }),
  reopenComplaintAction: () =>
    actions.reopenComplaintAction(COMPLAINT, "They wrote again."),
  resolveTargetAction: () =>
    actions.resolveTargetAction({
      address: "https://crumb.storemink.com/shop/blue-mug",
    }),
  blockItemAction: () => actions.blockItemAction(blockForm()),
  liftBlockAction: () =>
    actions.liftBlockAction(BLOCK, { note: "The order was withdrawn." }),
  tellStoreNowAction: () => actions.tellStoreNowAction(BLOCK),
  replyToStoreAction: () =>
    actions.replyToStoreAction(BLOCK, "We looked at it again."),
  addStoreEmailedReplyAction: () =>
    actions.addStoreEmailedReplyAction(
      BLOCK,
      "owner@crumb.test",
      "Please look again.",
    ),
  markRemovedByHandAction: () =>
    actions.markRemovedByHandAction(BLOCK, "Deleted from the theme folder."),
  retryStorageAction: () => actions.retryStorageAction(BLOCK),
  openArchiveAction: () => actions.openArchiveAction(BLOCK, "SM-000123"),
  extendArchiveAction: () =>
    actions.extendArchiveAction(BLOCK, { hold: true }, "Police letter 42"),
  releaseArchiveHoldAction: () =>
    actions.releaseArchiveHoldAction(BLOCK, "The case is closed."),
  setStoreHoldAction: () =>
    actions.setStoreHoldAction({
      storeId: STORE,
      reason: "Police investigation",
    }),
  releaseStoreHoldAction: () =>
    actions.releaseStoreHoldAction(HOLD, "The case is closed."),
};

beforeEach(() => {
  h.viewer = null;
  h.production = false;
});

describe('the "use server" export rule', () => {
  const source = readFileSync(
    path.join(process.cwd(), "app/actions/takedown-actions.ts"),
    "utf8",
  );

  it('starts with "use server" and exports only async functions', () => {
    expect(source.split("\n")[0]).toBe('"use server";');
    const exports = source.split("\n").filter((line) => /^export\b/.test(line));
    expect(exports.length).toBeGreaterThan(0);
    for (const line of exports) {
      expect(line).toMatch(/^export async function \w+\(/);
    }
    for (const [name, value] of Object.entries(actions)) {
      expect(typeof value, name).toBe("function");
      expect((value as () => unknown).constructor.name, name).toBe(
        "AsyncFunction",
      );
    }
  });

  it("has a call in this file for every export", () => {
    expect(Object.keys(actions).sort()).toEqual(Object.keys(CALLS).sort());
  });
});

describe("a caller who is not a StoreMink operator", () => {
  it.each(Object.keys(CALLS))(
    "%s answers the operator sentence and calls nothing",
    async (name) => {
      succeed();
      const result = await CALLS[name]();
      expect(result).toEqual({ ok: false, error: NOT_OPERATOR });
      for (const fn of Object.values(LIB)) expect(fn).not.toHaveBeenCalled();
      expect(runModerationFollowUps).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    },
  );

  it("treats a viewer with no email as nobody", async () => {
    succeed();
    h.viewer = { email: "  ", role: "superadmin" };
    expect(await CALLS.liftBlockAction()).toEqual({
      ok: false,
      error: NOT_OPERATOR,
    });
    expect(liftBlock).not.toHaveBeenCalled();
  });
});

describe("what a member may do (design 3.10, D1)", () => {
  beforeEach(() => {
    h.viewer = MEMBER;
    succeed();
  });

  const MEMBER_CAN: [string, keyof typeof LIB, string][] = [
    ["logComplaintAction", "logComplaint", "Complaint SM-000123 logged."],
    [
      "updateComplaintAction",
      "updateComplaint",
      "Kind changed. Deadlines updated.",
    ],
    [
      "acknowledgeComplaintAction",
      "acknowledgeComplaint",
      "Marked as acknowledged.",
    ],
    ["markComplaintActionedAction", "markActioned", "Recorded."],
    ["resolveComplaintAction", "resolveComplaint", "Complaint resolved."],
    ["reopenComplaintAction", "reopenComplaint", "Complaint reopened."],
    [
      "blockItemAction",
      "blockItem",
      "Blocked. It is hidden from the store now.",
    ],
    ["replyToStoreAction", "replyToStore", "Reply sent."],
    ["addStoreEmailedReplyAction", "addStoreEmailedReply", "Reply added."],
    ["markRemovedByHandAction", "markRemovedByHand", "Marked as removed."],
    ["retryStorageAction", "retryStorage", "StoreMink is trying again now."],
  ];

  it.each(MEMBER_CAN)("%s", async (name, lib, message) => {
    const result = await CALLS[name]();
    expect(result.ok).toBe(true);
    expect(messageOf(result)).toBe(message);
    const call = vi.mocked(LIB[lib]).mock.calls[0] as unknown[];
    expect(call).toContainEqual({ email: MEMBER.email, role: "member" });
  });

  it("finds a target", async () => {
    const result = await CALLS.resolveTargetAction();
    expect(result).toMatchObject({ ok: true, found: "target" });
    expect(resolveTarget).toHaveBeenCalledWith({
      address: "https://crumb.storemink.com/shop/blue-mug",
      storeId: null,
    });
  });

  it("blocks a review at the store's own request", async () => {
    const result = await actions.blockItemAction(
      blockForm({ kind: "review", reason: "store_request" }),
    );
    expect(result).toMatchObject({ ok: true, blockId: BLOCK });
    expect(blockItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "review", reason: "store_request" }),
      { email: MEMBER.email, role: "member" },
    );
  });

  const MEMBER_CANNOT: [string, () => Promise<unknown>, string, unknown][] = [
    [
      "lift a block",
      () => CALLS.liftBlockAction(),
      "Only a superadmin can lift a block.",
      liftBlock,
    ],
    [
      "tell the store later",
      () => CALLS.tellStoreNowAction(),
      "Only a superadmin can tell the store later.",
      tellStoreNow,
    ],
    [
      "open an archived copy",
      () => CALLS.openArchiveAction(),
      "Only a superadmin can open an archived copy.",
      recordArchiveView,
    ],
    [
      "keep a copy longer",
      () => CALLS.extendArchiveAction(),
      "Only a superadmin can keep a copy longer.",
      extendArchive,
    ],
    [
      "release a copy's hold",
      () => CALLS.releaseArchiveHoldAction(),
      "Only a superadmin can release the hold on a copy.",
      releaseArchiveHold,
    ],
    [
      "put a store on hold",
      () => CALLS.setStoreHoldAction(),
      "Only a superadmin can put a store on hold.",
      setStoreHold,
    ],
    [
      "release a store's hold",
      () => CALLS.releaseStoreHoldAction(),
      "Only a superadmin can release a hold.",
      releaseStoreHold,
    ],
    [
      "suspend a whole store",
      () => actions.blockItemAction(blockForm({ kind: "store", itemId: null })),
      "Only a superadmin can suspend a whole store.",
      blockItem,
    ],
    [
      "keep a block from the store",
      () =>
        actions.blockItemAction(
          blockForm({
            reason: "court_order",
            legalBasis: "Order 12 of 2026",
            tellStore: false,
          }),
        ),
      "Only a superadmin can keep a block from the store.",
      blockItem,
    ],
  ];

  it.each(MEMBER_CANNOT)(
    "is refused: %s, before the lib is asked",
    async (_what, call, sentence, lib) => {
      expect(await call()).toEqual({ ok: false, error: sentence });
      expect(lib).not.toHaveBeenCalled();
      expect(runModerationFollowUps).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    },
  );
});

describe("what only a superadmin does", () => {
  beforeEach(() => {
    h.viewer = SUPER;
    succeed();
  });

  it("lifts a block, with both ticks on unless unticked", async () => {
    const result = await CALLS.liftBlockAction();
    expect(result).toMatchObject({
      ok: true,
      liftedIds: [BLOCK],
      message: "Block lifted.",
    });
    expect(liftBlock).toHaveBeenCalledWith(
      {
        blockId: BLOCK,
        note: "The order was withdrawn.",
        notifyStore: true,
        alsoChildren: true,
      },
      { email: SUPER.email, role: "superadmin" },
    );
    await actions.liftBlockAction(BLOCK, {
      note: "x",
      notifyStore: false,
      alsoChildren: false,
    });
    expect(vi.mocked(liftBlock).mock.calls[1][0]).toMatchObject({
      notifyStore: false,
      alsoChildren: false,
    });
  });

  it("tells the store later", async () => {
    expect(await CALLS.tellStoreNowAction()).toEqual({
      ok: true,
      notified: true,
      message: "The store has been told.",
    });
  });

  it("suspends a whole store", async () => {
    const result = await actions.blockItemAction(
      blockForm({ kind: "store", itemId: null }),
    );
    expect(result).toMatchObject({
      ok: true,
      message: "Store suspended. StoreMink is copying its files.",
    });
  });

  it("keeps a block from the store on an order", async () => {
    await actions.blockItemAction(
      blockForm({
        reason: "court_order",
        legalBasis: "Order 12 of 2026",
        tellStore: false,
        alsoBlockImages: ["https://x/a.webp", 7],
      }),
    );
    expect(blockItem).toHaveBeenCalledWith(
      expect.objectContaining({
        tellStore: false,
        legalBasis: "Order 12 of 2026",
        alsoBlockImages: ["https://x/a.webp"],
      }),
      { email: SUPER.email, role: "superadmin" },
    );
  });

  it("opens the copy: records why first, then reads it on that receipt", async () => {
    const result = await CALLS.openArchiveAction();
    expect(result).toEqual({ ok: true, receipt: EVENT, archive: ARCHIVE });
    const op = { email: SUPER.email, role: "superadmin" };
    expect(recordArchiveView).toHaveBeenCalledWith(BLOCK, "SM-000123", op, {
      what: "copy",
    });
    expect(getArchiveForViewing).toHaveBeenCalledWith(
      BLOCK,
      { eventId: EVENT },
      op,
    );
    expect(
      vi.mocked(recordArchiveView).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(getArchiveForViewing).mock.invocationCallOrder[0]);
    // A read: no follow-up, no re-render.
    expect(runModerationFollowUps).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("never reads the copy when the reason could not be recorded", async () => {
    vi.mocked(recordArchiveView).mockResolvedValue({
      ok: false,
      error: "Could not save it. Please try again.",
    });
    expect(await CALLS.openArchiveAction()).toEqual({
      ok: false,
      error: "Could not save it. Please try again.",
    });
    expect(getArchiveForViewing).not.toHaveBeenCalled();
  });

  it("keeps a copy until a date, or until released", async () => {
    expect(
      await actions.extendArchiveAction(
        BLOCK,
        { until: "2027-10-24" },
        "Police letter 42",
      ),
    ).toMatchObject({ ok: true, message: "Kept until 24 Oct 2027." });
    expect(extendArchive).toHaveBeenCalledWith(
      BLOCK,
      { until: "2027-10-24" },
      "Police letter 42",
      { email: SUPER.email, role: "superadmin" },
    );
    vi.mocked(extendArchive).mockResolvedValue({
      ok: true,
      keepUntil: "2027-04-24T18:29:59.000Z",
      legalHold: true,
    });
    expect(await CALLS.extendArchiveAction()).toMatchObject({
      ok: true,
      legalHold: true,
      message: "Kept until released.",
    });
    expect(vi.mocked(extendArchive).mock.calls[1][1]).toEqual({ hold: true });
  });

  it("releases a copy's hold", async () => {
    expect(await CALLS.releaseArchiveHoldAction()).toEqual({
      ok: true,
      keepUntil: "2027-04-24T18:29:59.000Z",
      message: "Hold released. The copy will be deleted after 24 Apr 2027.",
    });
  });

  it("puts a store on hold and releases it", async () => {
    expect(await CALLS.setStoreHoldAction()).toEqual({
      ok: true,
      holdId: HOLD,
      message: "Store on hold.",
    });
    expect(setStoreHold).toHaveBeenCalledWith(
      {
        storeId: STORE,
        reason: "Police investigation",
        authorityRef: null,
        complaint: null,
        reviewOn: null,
      },
      { email: SUPER.email, role: "superadmin" },
    );
    expect(await CALLS.releaseStoreHoldAction()).toEqual({
      ok: true,
      message: "Hold released.",
    });
  });
});

describe("validation, in the design's words (section 6)", () => {
  it("a complaint received in the future", async () => {
    h.viewer = MEMBER;
    expect(
      await actions.logComplaintAction({
        ...complaintForm(),
        receivedAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).toEqual({
      ok: false,
      error: "That time is in the future.",
      field: "receivedAt",
    });
  });

  it("a complaint with no channel, then with no summary", async () => {
    h.viewer = MEMBER;
    const now = new Date(Date.now() - 60_000).toISOString();
    expect(
      await actions.logComplaintAction({
        ...complaintForm(),
        receivedAt: now,
        channel: "",
      }),
    ).toEqual({
      ok: false,
      error: "Choose how it reached us.",
      field: "channel",
    });
    expect(
      await actions.logComplaintAction({
        ...complaintForm(),
        receivedAt: now,
        summary: "  ",
      }),
    ).toEqual({
      ok: false,
      error: "Write what they ask for.",
      field: "summary",
    });
  });

  it("an outcome that needs a note", async () => {
    h.viewer = MEMBER;
    expect(
      await actions.resolveComplaintAction(COMPLAINT, {
        outcome: "not_removed",
      }),
    ).toEqual({
      ok: false,
      error: "Write a note for this outcome.",
      field: "note",
    });
  });

  it("a lift with no reason", async () => {
    h.viewer = SUPER;
    expect(await actions.liftBlockAction(BLOCK, { note: "  " })).toEqual({
      ok: false,
      error: "Write why you are lifting it.",
    });
  });

  it("an empty reply and one too long", async () => {
    h.viewer = MEMBER;
    expect(await actions.replyToStoreAction(BLOCK, "")).toEqual({
      ok: false,
      error: "Write a reply first.",
    });
    expect(await actions.replyToStoreAction(BLOCK, "x".repeat(4001))).toEqual({
      ok: false,
      error: "Keep it under 4,000 characters.",
    });
  });

  it("keeping a copy longer without saying who asked", async () => {
    h.viewer = SUPER;
    expect(
      await actions.extendArchiveAction(BLOCK, { hold: true }, ""),
    ).toEqual({ ok: false, error: "Write who asked." });
  });

  it("opening a copy without a reason", async () => {
    h.viewer = SUPER;
    expect(await actions.openArchiveAction(BLOCK, " ")).toEqual({
      ok: false,
      error: "Write why you are opening it.",
    });
    expect(getArchiveForViewing).not.toHaveBeenCalled();
  });

  it("keeping a block from the store without an order", async () => {
    h.viewer = SUPER;
    expect(
      await actions.blockItemAction(blockForm({ tellStore: false })),
    ).toEqual({
      ok: false,
      error:
        "To keep a block from the store, choose the court or government order and fill in its legal basis.",
    });
  });

  it("a removed-by-hand note and an emailed reply's address", async () => {
    h.viewer = MEMBER;
    expect(await actions.markRemovedByHandAction(BLOCK, "")).toEqual({
      ok: false,
      error: "Write how it was removed.",
    });
    expect(
      await actions.addStoreEmailedReplyAction(BLOCK, "not-an-email", "Hi"),
    ).toEqual({
      ok: false,
      error: "Enter the email address the reply came from.",
    });
  });

  it("a hold with no reason", async () => {
    h.viewer = SUPER;
    expect(
      await actions.setStoreHoldAction({ storeId: STORE, reason: "" }),
    ).toEqual({ ok: false, error: "Write the reason for the hold." });
  });

  it("a refusal runs no follow-up and re-renders nothing", async () => {
    h.viewer = SUPER;
    await actions.liftBlockAction(BLOCK, { note: "" });
    expect(runModerationFollowUps).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("complaints", () => {
  beforeEach(() => {
    h.viewer = MEMBER;
    succeed();
  });

  it("reads a zoneless form time as India time; a zoned one as it is", async () => {
    await actions.logComplaintAction(complaintForm());
    expect(vi.mocked(logComplaint).mock.calls[0][0]).toMatchObject({
      receivedAt: "2026-10-29T14:30+05:30",
      urls: "https://crumb.storemink.com/shop/blue-mug",
    });
    await actions.logComplaintAction({
      ...complaintForm(),
      receivedAt: "2026-10-29T09:00:00.000Z",
      urls: ["https://a.test/x", 3 as unknown as string],
    });
    expect(vi.mocked(logComplaint).mock.calls[1][0]).toMatchObject({
      receivedAt: "2026-10-29T09:00:00.000Z",
      urls: ["https://a.test/x"],
    });
  });

  it("alerts every operator about an urgent complaint, once it is stored", async () => {
    vi.mocked(logComplaint).mockResolvedValue({
      ok: true,
      complaint: row({ kind: "court_order" }),
      urgent: true,
    });
    const result = await actions.logComplaintAction(complaintForm());
    expect(result).toEqual({
      ok: true,
      complaintId: COMPLAINT,
      ref: "SM-000123",
      urgent: true,
      message: "Complaint SM-000123 logged.",
    });
    expect(notifyComplaintUrgent).toHaveBeenCalledWith(
      {
        id: COMPLAINT,
        refNo: 123,
        kind: "court_order",
        storeId: STORE,
        storeName: "Crumb & Co (crumb.storemink.com)",
      },
      "2026-11-05T09:00:00.000Z",
    );
    expect(vi.mocked(logComplaint).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(notifyComplaintUrgent).mock.invocationCallOrder[0],
    );
  });

  it("does not alert for a complaint that is not urgent, nor fail on a failed alert", async () => {
    await actions.logComplaintAction(complaintForm());
    expect(notifyComplaintUrgent).not.toHaveBeenCalled();
    vi.mocked(logComplaint).mockResolvedValue({
      ok: true,
      complaint: row({ kind: "court_order" }),
      urgent: true,
    });
    vi.mocked(notifyComplaintUrgent).mockRejectedValue(new Error("mail down"));
    expect((await actions.logComplaintAction(complaintForm())).ok).toBe(true);
  });

  // ★ Design 3.9: an urgent complaint is told "plus a structured warning log
  //   line" the moment it is logged, so the alert "Takedown: a complaint needs
  //   action" (any WARNING starting "moderation: complaint ") pages at once
  //   rather than at the "soon" stage.
  it("writes the urgent complaint's warning line after the alert, naming no store", async () => {
    vi.mocked(logComplaint).mockResolvedValue({
      ok: true,
      complaint: row({ kind: "court_order" }),
      urgent: true,
    });
    await actions.logComplaintAction(complaintForm());
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith("moderation: complaint urgent", {
      ref: "SM-000123",
      kind: "court_order",
      stage: "act",
      phase: "logged",
      dueAt: "2026-11-05T09:00:00.000Z",
    });
    const fields = vi.mocked(logWarn).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(Object.keys(fields)).not.toContain("storeId");
    expect(JSON.stringify(fields)).not.toContain(STORE);
    expect(
      vi.mocked(notifyComplaintUrgent).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(logWarn).mock.invocationCallOrder[0]);
  });

  it("writes the urgent line even when the alert fails, and none for a complaint that is not urgent or not stored", async () => {
    await actions.logComplaintAction(complaintForm());
    expect(logWarn).not.toHaveBeenCalled();

    vi.mocked(logComplaint).mockResolvedValue({
      ok: true,
      complaint: row({ kind: "intimate_or_impersonation" }),
      urgent: true,
    });
    vi.mocked(notifyComplaintUrgent).mockRejectedValue(new Error("mail down"));
    await actions.logComplaintAction(complaintForm());
    expect(logWarn).toHaveBeenCalledWith(
      "moderation: complaint urgent",
      expect.objectContaining({
        kind: "intimate_or_impersonation",
        stage: "act",
        phase: "logged",
      }),
    );

    vi.mocked(logWarn).mockClear();
    vi.mocked(logComplaint).mockResolvedValue({
      ok: false,
      error: "Choose what kind of complaint this is.",
      field: "kind",
    });
    await actions.logComplaintAction(complaintForm());
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("names a deadline that has already passed", async () => {
    vi.mocked(updateComplaint).mockResolvedValue({
      ok: true,
      complaint: row({ kind: "intimate_or_impersonation" }),
      changed: ["kind", "actionDueAt"],
      passed: ["resolve", "act"],
    });
    expect(
      messageOf(
        await actions.updateComplaintAction(COMPLAINT, {
          kind: "intimate_or_impersonation",
        }),
      ),
    ).toBe(
      "Kind changed. The deadline to remove or block has already passed: act now.",
    );
    vi.mocked(updateComplaint).mockResolvedValue({
      ok: true,
      complaint: row({ kind: "information_order" }),
      changed: ["kind"],
      passed: ["act"],
    });
    expect(
      messageOf(
        await actions.updateComplaintAction(COMPLAINT, {
          kind: "information_order",
        }),
      ),
    ).toBe(
      "Kind changed. The deadline to provide has already passed: act now.",
    );
  });

  it("sends only the keys present, and says what changed", async () => {
    vi.mocked(updateComplaint).mockResolvedValue({
      ok: true,
      complaint: row(),
      changed: ["summary"],
      passed: [],
    });
    const result = await actions.updateComplaintAction(COMPLAINT, {
      summary: "New words",
      receivedAt: "2026-10-29T10:00",
    });
    expect(messageOf(result)).toBe("Complaint updated.");
    expect(updateComplaint).toHaveBeenCalledWith(
      COMPLAINT,
      { summary: "New words", receivedAt: "2026-10-29T10:00+05:30" },
      { email: MEMBER.email, role: "member" },
    );
  });

  it("a change that changed nothing re-renders nothing and runs no follow-up", async () => {
    vi.mocked(updateComplaint).mockResolvedValue({
      ok: true,
      complaint: row(),
      changed: [],
      passed: [],
    });
    const result = await actions.updateComplaintAction(COMPLAINT, {
      summary: "Remove the blue mug photo.",
    });
    expect(messageOf(result)).toBe("Nothing was changed.");
    expect(runModerationFollowUps).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("sends the acknowledgement through the email when asked", async () => {
    vi.mocked(acknowledgeComplaint).mockImplementation(
      async (_id, _op, options) => {
        const sent = await options!.deliver!({
          complaint: row(),
          to: "asha@example.com",
        });
        return { ok: true, complaint: row(), emailed: sent.sent };
      },
    );
    const result = await actions.acknowledgeComplaintAction(COMPLAINT, {
      sendEmail: true,
    });
    expect(result).toMatchObject({
      ok: true,
      emailed: true,
      message: "Acknowledgement sent.",
    });
    expect(acknowledgeComplainant).toHaveBeenCalledWith({
      to: "asha@example.com",
      name: "Asha Rao",
      complaint: {
        id: COMPLAINT,
        refNo: 123,
        kind: "grievance",
        storeId: STORE,
        storeName: "Crumb & Co (crumb.storemink.com)",
        receivedAt: "2026-10-29T09:00:00.000Z",
      },
      recorded: {
        summary: "Remove the blue mug photo.",
        addresses: ["https://crumb.storemink.com/shop/blue-mug"],
      },
    });
  });

  it("marks as acknowledged with no email when not asked", async () => {
    await actions.acknowledgeComplaintAction(COMPLAINT);
    expect(acknowledgeComplaint).toHaveBeenCalledWith(
      COMPLAINT,
      { email: MEMBER.email, role: "member" },
      {},
    );
    expect(acknowledgeComplainant).not.toHaveBeenCalled();
  });

  it("emails the outcome only when ticked, and warns when it did not go", async () => {
    vi.mocked(tellComplainantOutcome).mockResolvedValue({ sent: false });
    vi.mocked(resolveComplaint).mockImplementation(async (_id, input) => {
      const sent = await input.deliver!({
        complaint: row(),
        to: "asha@example.com",
        outcome: "removed",
        note: "Taken down.",
      });
      return { ok: true, complaint: row(), emailed: sent.sent };
    });
    const result = await actions.resolveComplaintAction(COMPLAINT, {
      outcome: "removed",
      note: "Taken down.",
      emailComplainant: true,
    });
    expect(result).toMatchObject({
      ok: true,
      emailed: false,
      warnings: ["The outcome email could not be sent."],
      message: "Complaint resolved.",
    });
    expect(tellComplainantOutcome).toHaveBeenCalledWith({
      to: "asha@example.com",
      name: "Asha Rao",
      complaint: {
        id: COMPLAINT,
        refNo: 123,
        kind: "grievance",
        storeId: STORE,
        storeName: "Crumb & Co (crumb.storemink.com)",
      },
      outcome: "removed",
      note: "Taken down.",
    });

    vi.mocked(resolveComplaint).mockResolvedValue({
      ok: true,
      complaint: row(),
      emailed: null,
    });
    await actions.resolveComplaintAction(COMPLAINT, { outcome: "removed" });
    const input = vi.mocked(resolveComplaint).mock.calls[1][1];
    expect(input).toEqual({ outcome: "removed", note: null });
  });
});

describe("the follow-up outside production (design 8.1)", () => {
  beforeEach(() => {
    h.viewer = MEMBER;
    succeed();
  });

  it("runs once, after the action's work, then re-renders", async () => {
    expect((await CALLS.blockItemAction()).ok).toBe(true);
    expect(runModerationFollowUps).toHaveBeenCalledTimes(1);
    expect(runModerationFollowUps).toHaveBeenCalledWith();
    const work = vi.mocked(blockItem).mock.invocationCallOrder[0];
    const follow = vi.mocked(runModerationFollowUps).mock
      .invocationCallOrder[0];
    const render = vi.mocked(refresh).mock.invocationCallOrder[0];
    expect(work).toBeLessThan(follow);
    expect(follow).toBeLessThan(render);
  });

  it.each(
    Object.keys(CALLS).filter(
      (name) =>
        ![
          "resolveTargetAction",
          "openArchiveAction",
          "liftBlockAction",
          "tellStoreNowAction",
          "extendArchiveAction",
          "releaseArchiveHoldAction",
          "setStoreHoldAction",
          "releaseStoreHoldAction",
        ].includes(name),
    ),
  )("%s runs it", async (name) => {
    await CALLS[name]();
    expect(runModerationFollowUps).toHaveBeenCalledTimes(1);
  });

  it.each([
    "liftBlockAction",
    "tellStoreNowAction",
    "extendArchiveAction",
    "releaseArchiveHoldAction",
    "setStoreHoldAction",
    "releaseStoreHoldAction",
  ])("%s runs it for a superadmin", async (name) => {
    h.viewer = SUPER;
    await CALLS[name]();
    expect(runModerationFollowUps).toHaveBeenCalledTimes(1);
  });

  it("never in production, where the scheduler runs it", async () => {
    h.production = true;
    expect((await CALLS.blockItemAction()).ok).toBe(true);
    expect(runModerationFollowUps).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a failed follow-up never fails the action", async () => {
    vi.mocked(runModerationFollowUps).mockRejectedValue(new Error("boom"));
    expect(await CALLS.blockItemAction()).toMatchObject({
      ok: true,
      message: "Blocked. It is hidden from the store now.",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a read runs none", async () => {
    await CALLS.resolveTargetAction();
    expect(runModerationFollowUps).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("a lib call that throws", () => {
  beforeEach(() => {
    succeed();
  });

  it.each([
    [
      "blockItemAction",
      MEMBER,
      blockItem,
      "Could not block it. Nothing was changed. Please try again.",
    ],
    [
      "liftBlockAction",
      SUPER,
      liftBlock,
      "Could not lift it. Nothing was changed. Please try again.",
    ],
    [
      "logComplaintAction",
      MEMBER,
      logComplaint,
      "Could not log the complaint. Please try again.",
    ],
    [
      "extendArchiveAction",
      SUPER,
      extendArchive,
      "Could not save it. Please try again.",
    ],
    [
      "setStoreHoldAction",
      SUPER,
      setStoreHold,
      "Could not save it. Please try again.",
    ],
    [
      "resolveTargetAction",
      MEMBER,
      resolveTarget,
      "Could not look it up. Please try again.",
    ],
  ] as const)(
    "%s answers a plain sentence and logs it",
    async (name, viewer, lib, sentence) => {
      h.viewer = viewer;
      vi.mocked(
        lib as (...args: unknown[]) => Promise<unknown>,
      ).mockRejectedValue(new Error("lost connection"));
      expect(await CALLS[name]()).toEqual({ ok: false, error: sentence });
      expect(logError).toHaveBeenCalledTimes(1);
      expect(runModerationFollowUps).not.toHaveBeenCalled();
    },
  );
});
