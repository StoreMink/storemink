import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlParamValues, sqlText } from "@/app/actions/_test-helpers";

// ★ No network and no real bucket: gcs.ts is replaced, every network call
//   in it throws.
vi.mock("@/lib/storage/gcs", () => {
  const offline = () => {
    throw new Error("No storage in this test.");
  };
  return {
    GCS_BUCKET_NAME: "sm-media",
    GCS_PRIVATE_BUCKET_NAME: "sm-private",
    gcsPublicUrl: (path: string) =>
      `https://storage.googleapis.com/sm-media/${path}`,
    gcsObjectMetadata: vi.fn(offline),
    gcsCopyObject: vi.fn(offline),
    gcsUploadObject: vi.fn(offline),
    gcsPrivateUploadObject: vi.fn(offline),
    gcsDownloadObject: vi.fn(offline),
    gcsDeleteGeneration: vi.fn(offline),
    gcsDeletePaths: vi.fn(offline),
  };
});
vi.mock("@/lib/db/client", () => ({ withService: vi.fn(), withAnon: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { withAnon, withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { ROOT_DOMAIN, subdomainOrigin } from "@/lib/store/host";
import { canonicalJson } from "@/lib/themes/canonical-json";
import { ARCHIVE_ERRORS } from "./archive";
import { STORE_DELETE_REFUSALS } from "./holds";
import {
  APPEARS_ON,
  TARGET_ERRORS,
  blockStatusOf,
  complaintNextDueSql,
  consoleCounts,
  fileStageOf,
  getArchiveForViewing,
  getBlock,
  getComplaint,
  listBlocks,
  listComplaints,
  listHolds,
  moderationQueueSql,
  resolveTarget,
  storeModerationSummary,
} from "./console-read";

type Row = Record<string, unknown>;
type Seen = { text: string; params: unknown[] };
type Handler = (text: string, params: unknown[]) => Row[] | undefined;

const STORE = "2cda365a-2723-4efa-82e2-be1619b16def";
const PREVIEW = "d7676f61-efc6-4f2a-b0af-7f75b876f3e4";
const PRODUCT = "11111111-2222-4333-8444-555555555555";
const REVIEW = "22222222-3333-4444-8555-666666666666";
const BLOCK = "0f8e6a1c-2b3d-4e5f-8a9b-1c2d3e4f5a6b";
const COMPLAINT = "33333333-4444-4555-8666-777777777777";
const EVENT = "44444444-5555-4666-8777-888888888888";
const SUPER = { email: "ops@storemink.com", role: "superadmin" as const };
const MEMBER = { email: "member@storemink.com", role: "member" as const };
const NOW = new Date("2026-10-30T06:00:00.000Z");
const ECHO = subdomainOrigin("echo");

let handlers: Handler[] = [];
let seen: Seen[] = [];

function on(
  match: string | RegExp,
  rows: Row[] | ((params: unknown[]) => Row[]),
) {
  handlers.push((text, params) => {
    const hit =
      typeof match === "string" ? text.includes(match) : match.test(text);
    if (!hit) return undefined;
    return typeof rows === "function" ? rows(params) : rows;
  });
}

function ran(match: string): Seen[] {
  return seen.filter((query) => query.text.includes(match));
}

beforeEach(() => {
  handlers = [];
  seen = [];
  const db = {
    execute: vi.fn(async (query: unknown) => {
      const text = sqlText(query).replace(/\s+/g, " ");
      const params = sqlParamValues(query);
      seen.push({ text, params });
      for (const handler of handlers) {
        const rows = handler(text, params);
        if (rows) return { rows };
      }
      return { rows: [] };
    }),
  };
  vi.mocked(withService).mockImplementation(async (fn) => fn(db as never));
  // The storefront's own read sees no suspended or pending store at all.
  vi.mocked(withAnon).mockImplementation(async (fn) =>
    fn({ execute: vi.fn(async () => ({ rows: [] })) } as never),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function storeRow(overrides: Row = {}): Row {
  return {
    id: STORE,
    name: "Echo",
    slug: "echo",
    status: "active",
    custom_domain: null,
    domain_verified: false,
    preview: false,
    demo: false,
    ...overrides,
  };
}

// ── The Overview's SQL ──────────────────────────────────────────────────────

describe("complaintNextDueSql and moderationQueueSql", () => {
  it("leaves out the stages a kind does not have, and every stage once resolved", () => {
    const text = sqlText(complaintNextDueSql()).replace(/\s+/g, " ");
    expect(text).toContain("case when c.resolved_at is null then least(");
    expect(text).toContain(
      "c.acknowledged_at is null then c.acknowledge_due_at",
    );
    expect(text).toContain("c.kind <> 'grievance'");
    expect(text).toContain(
      "c.kind not in ('information_order', 'data_request')",
    );
  });

  it("answers the four Overview queues as scalar counts", () => {
    const queues = moderationQueueSql(NOW);
    expect(Object.keys(queues).sort()).toEqual([
      "complaintsDue",
      "filesToFinish",
      "holdsToReview",
      "storeReplies",
    ]);
    expect(sqlText(queues.complaintsDue)).toContain("grievance_complaints");
    expect(sqlText(queues.storeReplies)).toContain("= 'store'");
    expect(sqlText(queues.filesToFinish)).toContain(
      "a.files_state in ('pending', 'failed')",
    );
    expect(sqlText(queues.holdsToReview)).toContain("Asia/Kolkata");
    expect(sqlParamValues(queues.holdsToReview)).toContain(NOW.toISOString());
  });
});

// ── Complaints ──────────────────────────────────────────────────────────────

function complaintRow(overrides: Row = {}): Row {
  return {
    id: COMPLAINT,
    ref_no: 123,
    received_at: "2026-10-30 04:00:00+00",
    channel: "email",
    kind: "intimate_or_impersonation",
    store_id: STORE,
    store_label: "Echo (echo.storemink.com)",
    outcome: null,
    acknowledged_at: null,
    actioned_at: null,
    resolved_at: null,
    acknowledge_due_at: "2026-10-31 04:00:00+00",
    action_due_at: "2026-10-30 06:00:00+00",
    resolve_due_at: "2026-10-31 16:00:00+00",
    erased_at: null,
    block_count: 1,
    total: 7,
    ...overrides,
  };
}

describe("listComplaints", () => {
  it("lists the open complaints soonest due first, with no complainant's details", async () => {
    on("from public.grievance_complaints c", [complaintRow()]);
    const result = await listComplaints({ now: NOW });
    expect(result.total).toBe(7);
    expect(result.rows).toEqual([
      expect.objectContaining({
        id: COMPLAINT,
        ref: "SM-000123",
        status: "not_acknowledged",
        blockCount: 1,
        nextDue: {
          stage: "act",
          dueAt: "2026-10-30T06:00:00.000Z",
          overdue: true,
        },
      }),
    ]);
    expect(Object.keys(result.rows[0])).not.toContain("complainantName");
    const query = ran("from public.grievance_complaints c")[0];
    expect(query.text).toContain("where c.resolved_at is null");
    expect(query.text).toContain("asc nulls last");
    expect(query.text).not.toContain("complainant_name");
  });

  it("narrows to one store, refuses a store that is not an id, and caps the page", async () => {
    await listComplaints({ storeId: STORE, limit: 5000, view: "resolved" });
    const narrowed = ran("from public.grievance_complaints c")[0];
    expect(narrowed.text).toContain("and c.store_id = ");
    expect(narrowed.text).toContain("c.resolved_at is not null");
    expect(narrowed.params).toContain(200);
    await listComplaints({ storeId: "echo" });
    expect(ran("from public.grievance_complaints c")[1].text).toContain(
      "and false",
    );
  });

  it("reads a resolved complaint as having no deadline", async () => {
    on("from public.grievance_complaints c", [
      complaintRow({
        resolved_at: "2026-10-30 05:00:00+00",
        outcome: "removed",
      }),
    ]);
    const { rows } = await listComplaints({ view: "all", now: NOW });
    expect(rows[0]).toMatchObject({
      status: "resolved",
      outcome: "removed",
      nextDue: null,
    });
  });
});

describe("getComplaint", () => {
  it("answers null for anything that is not a reference or an id, without a read", async () => {
    expect(await getComplaint("not-a-ref")).toBeNull();
    expect(seen).toEqual([]);
  });

  it("reads one complaint by its reference with its blocks and the record", async () => {
    on("from public.grievance_complaints c left join public.stores s", [
      complaintRow({
        complainant_name: "Asha Rao",
        complainant_contact: "asha@example.com",
        acting_for: "",
        authority_ref: "",
        urls: ["https://echo.storemink.com/shop/x"],
        summary: "Remove the photo of me.",
        acknowledged_by: null,
        acknowledgement_emailed: false,
        actioned_by: null,
        resolved_by: null,
        outcome_note: "",
        created_by: "ops@storemink.com",
        created_at: "2026-10-30 04:01:00+00",
        s_name: "Echo",
        s_slug: "echo",
        s_status: "active",
      }),
    ]);
    on("where b.complaint_id = ", [
      {
        id: BLOCK,
        item_kind: "product",
        item_label: "Oat milk",
        item_url: `${ECHO}/shop/oat-milk`,
        store_id: STORE,
        store_label: "Echo",
        complaint_id: COMPLAINT,
        complaint_ref_no: 123,
        reason_kind: "intimate_or_impersonation",
        tell_store: true,
        blocked_at: "2026-10-30 05:00:00+00",
        blocked_by: "ops@storemink.com",
        lifted_at: null,
        storage_state: "none",
        archive_id: null,
      },
    ]);
    on("from public.moderation_events e", [
      {
        id: EVENT,
        at: "2026-10-30 04:01:00+00",
        actor: "ops@storemink.com",
        action: "complaint_logged",
        complaint_id: COMPLAINT,
        block_id: null,
        hold_id: null,
        store_id: STORE,
        detail: { kind: "intimate_or_impersonation" },
        block_kind: null,
        block_label: null,
      },
    ]);
    const page = await getComplaint("sm-000123", { now: NOW });
    expect(page?.complaint).toMatchObject({
      ref: "SM-000123",
      complainantName: "Asha Rao",
      urls: ["https://echo.storemink.com/shop/x"],
      store: { id: STORE, slug: "echo", status: "active" },
    });
    expect(page?.blocks).toEqual([
      expect.objectContaining({
        id: BLOCK,
        kind: "product",
        status: "blocked",
        complaintRef: "SM-000123",
        fileStage: null,
        archive: null,
      }),
    ]);
    expect(page?.events).toEqual([
      expect.objectContaining({ action: "complaint_logged", block: null }),
    ]);
    expect(ran("where c.ref_no = ")[0].params).toContain(123);
  });

  it("answers null when there is no such complaint", async () => {
    expect(await getComplaint(COMPLAINT)).toBeNull();
    expect(ran("where c.id = ")).toHaveLength(1);
  });
});

// ── Blocks ──────────────────────────────────────────────────────────────────

describe("a block's state and file stage", () => {
  it("names the state from the row", () => {
    expect(
      blockStatusOf({ itemKind: "product", tellStore: true, liftedAt: null }),
    ).toBe("blocked");
    expect(
      blockStatusOf({ itemKind: "product", tellStore: false, liftedAt: null }),
    ).toBe("blocked_untold");
    expect(
      blockStatusOf({ itemKind: "store", tellStore: true, liftedAt: null }),
    ).toBe("store_suspended");
    expect(
      blockStatusOf({
        itemKind: "store",
        tellStore: true,
        liftedAt: "2026-10-30",
      }),
    ).toBe("lifted");
  });

  it("names where a file stands, and only for a file or a store's copy", () => {
    const file = (storageState: string, filesState: string | null) =>
      fileStageOf({ itemKind: "file", storageState, filesState });
    expect(file("pending", "pending")).toBe("copying");
    expect(file("pending", "failed")).toBe("copy_failed");
    expect(file("pending", "copied")).toBe("archived");
    expect(file("failed", "copied")).toBe("replace_failed");
    expect(file("manual", "none")).toBe("remove_by_hand");
    expect(file("not_ours", "none")).toBe("not_ours");
    expect(file("cancelled", "copied")).toBe("cancelled");
    expect(
      fileStageOf({
        itemKind: "store",
        storageState: "none",
        filesState: "pending",
      }),
    ).toBe("store_copy");
    expect(
      fileStageOf({
        itemKind: "product",
        storageState: "none",
        filesState: "copied",
      }),
    ).toBeNull();
  });
});

describe("listBlocks", () => {
  it("lists the stores waiting for an answer, longest waiting first", async () => {
    on("from public.content_blocks b left join public.grievance_complaints c", [
      {
        id: BLOCK,
        item_kind: "file",
        item_label: "photo.webp",
        item_url: "https://storage.googleapis.com/sm-media/stores/x/a.webp",
        store_id: STORE,
        store_label: "Echo",
        reason_kind: "terms_breach",
        tell_store: true,
        blocked_at: "2026-10-29 05:00:00+00",
        blocked_by: "ops@storemink.com",
        lifted_at: null,
        file_source: "bucket",
        object_path: "stores/x/a.webp",
        storage_state: "replaced",
        storage_error: "",
        archive_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        files_state: "copied",
        files_total: 2,
        files_copied: 1,
        files_missing: 0,
        files_changed: 1,
        last_from_side: "store",
        last_author: "owner@echo.test",
        last_at: "2026-10-30 05:00:00+00",
        last_asks_review: true,
        total: 3,
      },
    ]);
    const result = await listBlocks({ view: "replies", storeId: STORE });
    expect(result.total).toBe(3);
    expect(result.rows[0]).toMatchObject({
      kind: "file",
      status: "blocked",
      fileStage: "replaced",
      archive: { filesState: "copied", total: 2, copied: 1, changed: 1 },
      lastMessage: {
        fromSide: "store",
        author: "owner@echo.test",
        asksReview: true,
      },
    });
    const query = seen[0];
    expect(query.text).toContain("= 'store'");
    expect(query.text).toContain("order by x.last_at asc nulls last");
    expect(query.text).toContain("count(*) over ()");
    expect(query.text).toContain("and b.store_id = ");
  });

  it("lists the files to finish and refuses filters that are not ids or kinds", async () => {
    await listBlocks({
      view: "files",
      complaintId: "x",
      kind: "nope" as never,
    });
    const query = seen[0];
    expect(query.text).toContain(
      "b.storage_state in ('pending', 'failed', 'manual')",
    );
    expect(query.text.match(/and false/g)).toHaveLength(2);
    expect(query.text).toContain("order by x.blocked_at desc");
  });
});

describe("getBlock", () => {
  it("answers null for an id that is not one", async () => {
    expect(await getBlock("nope")).toBeNull();
    expect(seen).toEqual([]);
  });

  it("reads a block with its conversation and the archive's summary, never the snapshot", async () => {
    on("join public.content_blocks b2", [
      {
        id: BLOCK,
        item_kind: "product",
        item_label: "Oat milk",
        item_url: `${ECHO}/shop/oat-milk`,
        store_id: STORE,
        store_label: "Echo",
        reason_kind: "terms_breach",
        tell_store: true,
        blocked_at: "2026-10-30 05:00:00+00",
        blocked_by: "ops@storemink.com",
        lifted_at: null,
        storage_state: "none",
        parent_block_id: null,
        merchant_notified_at: null,
        archive_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        files_state: "copied",
        files_total: 0,
        item_id: PRODUCT,
        legal_basis: "",
        store_message: "We blocked this.",
        lift_note: "",
        storage_attempts: 0,
        replacing_now: false,
        s_name: "Echo",
        s_slug: "echo",
        s_status: "active",
        last_notice_event: "merchant_notify_failed",
      },
    ]);
    on("from public.content_block_messages m where m.block_id", [
      {
        id: "m1",
        from_side: "store",
        author: "owner@echo.test",
        body: "Please look again.",
        asks_review: true,
        created_at: "2026-10-30 05:30:00+00",
        seen_at: null,
      },
    ]);
    on("from public.content_block_archives a left join lateral", [
      {
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        created_at: "2026-10-30 05:00:00+00",
        keep_until: "2027-04-28 05:00:00+00",
        legal_hold: false,
        legal_hold_note: "",
        legal_hold_set_at: null,
        legal_hold_set_by: null,
        purged_at: null,
        snapshot_sha256: "a".repeat(64),
        files_state: "copied",
        files_error: "",
        snapshot_bytes: 512,
        total: 0,
        copied: 0,
        missing: 0,
        changed: 0,
      },
    ]);
    const page = await getBlock(BLOCK);
    expect(page?.block).toMatchObject({
      itemId: PRODUCT,
      storeMessage: "We blocked this.",
      noticeEmailFailed: true,
      replacingNow: false,
      store: { slug: "echo" },
    });
    expect(page?.messages).toEqual([
      expect.objectContaining({ fromSide: "store", asksReview: true }),
    ]);
    expect(page?.archive).toMatchObject({
      snapshotBytes: 512,
      sha256: "a".repeat(64),
      keepUntil: "2027-04-28 05:00:00+00",
    });
    expect(page?.archive).not.toHaveProperty("snapshot");
    const archiveRead = ran(
      "from public.content_block_archives a left join lateral",
    )[0];
    expect(archiveRead.text).toContain("octet_length(a.snapshot::text)");
    expect(archiveRead.text).not.toMatch(/a\.snapshot,/);
  });
});

// ── Holds, counts and the store card ────────────────────────────────────────

describe("listHolds and consoleCounts", () => {
  it("lists holds whose review date has come, in India time", async () => {
    on("from public.store_legal_holds h", [
      {
        id: "h1",
        store_id: STORE,
        store_label: "Echo",
        reason: "Police notice",
        authority_ref: "Ref 9",
        complaint_id: COMPLAINT,
        complaint_ref_no: 12,
        set_at: "2026-10-01 05:00:00+00",
        set_by: "ops@storemink.com",
        review_on: "2026-10-30",
        released_at: null,
        released_by: null,
        release_note: "",
      },
    ]);
    const holds = await listHolds({ view: "review", now: NOW });
    expect(holds).toEqual([
      expect.objectContaining({
        reason: "Police notice",
        complaintRef: "SM-000012",
        reviewOn: "2026-10-30",
      }),
    ]);
    expect(seen[0].text).toContain("Asia/Kolkata");
    expect(seen[0].text).toContain("h.review_on::text as review_on");
  });

  it("counts every tab in one statement", async () => {
    on("as open", [
      {
        open: 4,
        due: 2,
        overdue: 1,
        replies: 3,
        blocks: 5,
        files: 1,
        holds: 1,
        resolved: 9,
      },
    ]);
    expect(await consoleCounts(NOW)).toEqual({
      open: 4,
      due: 2,
      overdue: 1,
      replies: 3,
      blocks: 5,
      files: 1,
      holds: 1,
      resolved: 9,
    });
    expect(seen).toHaveLength(1);
  });
});

describe("storeModerationSummary", () => {
  it("answers an empty card for an id that is not one", async () => {
    expect(await storeModerationSummary("echo")).toMatchObject({
      activeBlocks: 0,
      hold: null,
      deleteRefusal: null,
    });
    expect(seen).toEqual([]);
  });

  it("says why Delete is unavailable: a hold first, then a copy still running", async () => {
    on("as active_blocks", [
      {
        active_blocks: 2,
        open_complaints: 1,
        unfinished_archives: 1,
        store_block: null,
        hold: {
          id: "h1",
          reason: "Police notice",
          authorityRef: "",
          setAt: "2026-10-01T05:00:00+00:00",
          setBy: "ops@storemink.com",
          reviewOn: null,
          complaintId: null,
        },
      },
    ]);
    expect(await storeModerationSummary(STORE)).toMatchObject({
      activeBlocks: 2,
      openComplaints: 1,
      hold: { reason: "Police notice" },
      deleteRefusal: { reason: "hold", message: STORE_DELETE_REFUSALS.hold },
    });
    handlers = [];
    on("as active_blocks", [
      {
        active_blocks: 0,
        open_complaints: 0,
        unfinished_archives: 1,
        store_block: { id: BLOCK, blockedAt: "2026-10-30T05:00:00+00:00" },
        hold: null,
      },
    ]);
    expect(await storeModerationSummary(STORE)).toMatchObject({
      storeBlock: { id: BLOCK },
      deleteRefusal: {
        reason: "archive",
        message: STORE_DELETE_REFUSALS.archive,
      },
    });
  });

  it("answers an empty card before the migration, and throws on any other failure", async () => {
    vi.mocked(withService).mockRejectedValueOnce(
      Object.assign(new Error('relation "content_blocks" does not exist'), {
        code: "42P01",
      }),
    );
    expect(await storeModerationSummary(STORE)).toMatchObject({
      deleteRefusal: null,
    });
    vi.mocked(withService).mockRejectedValueOnce(new Error("db down"));
    await expect(storeModerationSummary(STORE)).rejects.toThrow("db down");
    expect(logError).toHaveBeenCalledWith(
      "moderation.console: store summary failed",
      expect.anything(),
      { storeId: STORE },
    );
  });
});

// ── Reading an archived copy ────────────────────────────────────────────────

describe("getArchiveForViewing", () => {
  const snapshot = { kind: "product", row: { name: "Oat milk" } };
  const sha = createHash("sha256")
    .update(canonicalJson(snapshot))
    .digest("hex");

  function archiveRow(overrides: Row = {}): Row {
    return {
      block_id: BLOCK,
      store_id: STORE,
      created_at: "2026-10-30 05:00:00+00",
      keep_until: "2027-04-28 05:00:00+00",
      legal_hold: false,
      purged_at: null,
      snapshot,
      snapshot_sha256: sha,
      files: [{ n: 0, garbage: true }],
      files_state: "copied",
      has_receipt: true,
      ...overrides,
    };
  }

  it("is a superadmin's", async () => {
    expect(
      await getArchiveForViewing(BLOCK, { eventId: EVENT }, MEMBER),
    ).toEqual({ ok: false, error: ARCHIVE_ERRORS.viewSuperadminOnly });
    expect(seen).toEqual([]);
  });

  it("asks for the reason first: without a fresh receipt of this operator it reads nothing", async () => {
    expect(
      await getArchiveForViewing(BLOCK, { eventId: "nope" }, SUPER),
    ).toEqual({ ok: false, error: ARCHIVE_ERRORS.reasonMissing });
    on("from public.content_block_archives a join public.content_blocks b", [
      archiveRow({ has_receipt: false }),
    ]);
    expect(
      await getArchiveForViewing(BLOCK, { eventId: EVENT }, SUPER),
    ).toEqual({ ok: false, error: ARCHIVE_ERRORS.reasonMissing });
    const query = seen[0];
    expect(query.text).toContain("e.actor = ");
    expect(query.text).toContain(
      "e.action in ('archive_viewed', 'archive_downloaded')",
    );
    expect(query.params).toEqual(
      expect.arrayContaining([EVENT, SUPER.email, 10, BLOCK]),
    );
  });

  it("answers the snapshot, whether it still hashes to its record, and the file list", async () => {
    on("from public.content_block_archives a join public.content_blocks b", [
      archiveRow(),
    ]);
    const result = await getArchiveForViewing(BLOCK, { eventId: EVENT }, SUPER);
    expect(result).toMatchObject({
      ok: true,
      archive: {
        snapshot,
        sha256: sha,
        hashMatches: true,
        files: [{ entry: null, raw: { n: 0, garbage: true } }],
      },
    });
    handlers = [];
    on("from public.content_block_archives a join public.content_blocks b", [
      archiveRow({ snapshot_sha256: "b".repeat(64) }),
    ]);
    expect(
      await getArchiveForViewing(BLOCK, { eventId: EVENT }, SUPER),
    ).toMatchObject({ ok: true, archive: { hashMatches: false } });
  });

  it("says when the copy was already deleted", async () => {
    on("from public.content_block_archives a join public.content_blocks b", [
      archiveRow({ purged_at: "2027-05-01", snapshot: null }),
    ]);
    expect(
      await getArchiveForViewing(BLOCK, { eventId: EVENT }, SUPER),
    ).toEqual({ ok: false, error: ARCHIVE_ERRORS.purged });
  });
});

// ── Finding what to block ───────────────────────────────────────────────────

describe("resolveTarget", () => {
  const storeHost = `echo.${ROOT_DOMAIN}`;

  function withEcho(store: Row = {}) {
    on(
      /from public\.stores s where (s\.slug|lower\(s\.custom_domain\)|s\.id)/,
      [storeRow(store)],
    );
  }

  it("asks for a full address", async () => {
    for (const address of ["", "echo.storemink.com/shop/x", "ftp://x.test/a"]) {
      expect(await resolveTarget({ address })).toEqual({
        ok: false,
        error: TARGET_ERRORS.fullAddress,
      });
    }
    expect(withService).not.toHaveBeenCalled();
  });

  it("says when an address is StoreMink's own site, not a store", async () => {
    expect(
      await resolveTarget({ address: `https://${ROOT_DOMAIN}/pricing` }),
    ).toEqual({ ok: false, error: TARGET_ERRORS.notStore });
  });

  it("resolves a suspended store's address (the storefront's own read would not find it)", async () => {
    withEcho({ status: "suspended" });
    on("from public.products p where p.store_id", [
      {
        id: PRODUCT,
        label: "Oat milk",
        slug: "oat-milk",
        status: "published",
        moderation_blocked_at: null,
        row: { name: "Oat milk", image_url: null },
        related: [],
      },
    ]);
    const result = await resolveTarget({
      address: `https://${storeHost}/shop/Oat-Milk/`,
    });
    expect(result).toMatchObject({
      ok: true,
      found: "target",
      target: {
        kind: "product",
        itemId: PRODUCT,
        label: "Oat milk",
        url: `${ECHO}/shop/oat-milk`,
        state: "published",
        store: { id: STORE, status: "suspended", slug: "echo" },
        appearsOn: APPEARS_ON.product,
        warnings: [],
      },
    });
    expect(withAnon).not.toHaveBeenCalled();
    const storeRead = ran("from public.stores s where s.slug = ")[0];
    expect(storeRead.params).toContain("echo");
    // ★ No status in the WHERE: a suspended or pending store resolves too.
    expect(storeRead.text.split(" where ")[1]).not.toContain("status");
    expect(ran("lower(p.slug) = lower(")[0].params).toContain("Oat-Milk");
  });

  it("refuses a Theme Studio preview store", async () => {
    withEcho({
      id: PREVIEW,
      slug: "studio-preview-67bd33696c6b",
      preview: true,
    });
    expect(
      await resolveTarget({
        address: `https://studio-preview-67bd33696c6b.${ROOT_DOMAIN}/`,
      }),
    ).toEqual({ ok: false, error: TARGET_ERRORS.preview });
    handlers = [];
    withEcho({ id: PREVIEW, preview: true });
    expect(await resolveTarget({ storeId: PREVIEW, kind: "store" })).toEqual({
      ok: false,
      error: TARGET_ERRORS.preview,
    });
  });

  it("finds the homepage and warns that it is the homepage", async () => {
    withEcho();
    on("from public.store_pages g where g.store_id", [
      {
        id: "page-1",
        label: "Home",
        slug: "",
        status: "published",
        moderation_blocked_at: null,
        row: { sections: [] },
        related: null,
      },
    ]);
    const result = await resolveTarget({ address: `https://${storeHost}` });
    expect(result).toMatchObject({
      ok: true,
      target: {
        kind: "page",
        homepage: true,
        url: `${ECHO}/`,
        warnings: ["homepage"],
      },
    });
  });

  it("answers not found for a route that is not an item", async () => {
    withEcho();
    for (const path of ["/cart", "/blogs/write", "/shop", "/a/b/c"]) {
      expect(
        await resolveTarget({ address: `https://${storeHost}${path}` }),
      ).toEqual({ ok: false, error: TARGET_ERRORS.notFound });
    }
  });

  it("reads a verified custom domain, never an unverified one", async () => {
    withEcho({ custom_domain: "echo.shop", domain_verified: true });
    on("from public.blogs g where g.store_id", [
      {
        id: "blog-1",
        label: "Our story",
        slug: "our-story",
        status: "published",
        moderation_blocked_at: "2026-10-30 05:00:00+00",
        row: { title: "Our story" },
        related: null,
      },
    ]);
    on(/b\.item_kind = and b\.item_id = /, [
      { id: BLOCK, blocked_at: "2026-10-30 05:00:00+00" },
    ]);
    const result = await resolveTarget({
      address: "https://Echo.Shop/blogs/our-story",
    });
    expect(result).toMatchObject({
      ok: true,
      target: {
        kind: "blog_post",
        blocked: true,
        alreadyBlocked: { blockId: BLOCK },
        warnings: ["already_blocked"],
        store: { customDomain: "echo.shop" },
      },
    });
    const storeRead = ran("lower(s.custom_domain) = ")[0];
    expect(storeRead.text).toContain("custom_domain_verified");
    expect(storeRead.params).toContain("echo.shop");
  });

  it("finds an image in the bucket and its store from the path", async () => {
    withEcho();
    on("from public.media_assets m where m.store_id", [
      {
        id: "asset-1",
        filename: "logo.webp",
        content_type: "image/webp",
        size_bytes: 2048,
      },
    ]);
    const key = `stores/${STORE}/media/logo.webp`;
    const result = await resolveTarget({
      address: `https://storage.googleapis.com/sm-media/${key}`,
    });
    expect(result).toMatchObject({
      ok: true,
      target: {
        kind: "file",
        label: "logo.webp",
        store: { id: STORE },
        file: {
          source: "bucket",
          key,
          url: `https://storage.googleapis.com/sm-media/${key}`,
          themeRelease: false,
          mediaAsset: { id: "asset-1", sizeBytes: 2048 },
        },
        warnings: [],
      },
    });
    expect(ran("s.id = ")[0].params).toContain(STORE);
  });

  it("warns about a theme's image and a file built into the app", async () => {
    const release = "theme-releases/vitrine/1.0.0/hero-abc.webp";
    expect(
      await resolveTarget({
        address: `https://storage.googleapis.com/sm-media/${release}`,
      }),
    ).toMatchObject({
      ok: true,
      target: {
        store: null,
        file: { themeRelease: true },
        warnings: ["theme_release"],
      },
    });
    withEcho();
    expect(
      await resolveTarget({
        address: `https://${storeHost}/_next/image?url=%2Fthemes%2Fbasket%2Fhero.webp&w=640`,
      }),
    ).toMatchObject({
      ok: true,
      target: {
        file: { source: "bundled", key: "/themes/basket/hero.webp" },
        warnings: ["bundled"],
      },
    });
  });

  it("refuses the archive's own folder and an address that cannot be read safely", async () => {
    for (const address of [
      "https://storage.googleapis.com/sm-media/takedown-archive/storemink/x/0-a.webp",
      "https://storage.googleapis.com/sm-media/stores/a/%2E%2E/b.webp",
    ]) {
      expect(await resolveTarget({ address })).toEqual({
        ok: false,
        error: TARGET_ERRORS.fileNotServed,
      });
    }
  });

  it("takes an outside picture as an outside file, and an outside page as not a store", async () => {
    expect(
      await resolveTarget({ address: "https://cdn.example.com/a/photo.JPG" }),
    ).toMatchObject({
      ok: true,
      target: {
        kind: "file",
        file: {
          source: "external",
          key: "https://cdn.example.com/a/photo.JPG",
        },
        warnings: ["external"],
      },
    });
    expect(
      await resolveTarget({ address: "https://shop.example.com/products/x" }),
    ).toEqual({ ok: false, error: TARGET_ERRORS.notStore });
  });

  it("names a whole store and its live block", async () => {
    withEcho({ status: "suspended" });
    on("b.item_kind = 'store'", [{ id: BLOCK, blocked_at: "2026-10-30" }]);
    expect(
      await resolveTarget({ storeId: STORE, kind: "store" }),
    ).toMatchObject({
      ok: true,
      target: {
        kind: "store",
        label: "Echo",
        url: ECHO,
        state: "suspended",
        alreadyBlocked: { blockId: BLOCK },
        appearsOn: APPEARS_ON.store,
      },
    });
  });

  it("searches a store with the search words taken literally", async () => {
    withEcho();
    on("from public.products p where p.store_id", [
      {
        id: PRODUCT,
        label: "50% off oat milk",
        slug: "oat-milk",
        status: "draft",
        blocked: false,
      },
    ]);
    const result = await resolveTarget({
      storeId: STORE,
      kind: "product",
      search: " 50%_off ",
    });
    expect(result).toEqual({
      ok: true,
      found: "matches",
      kind: "product",
      store: expect.objectContaining({ id: STORE }),
      matches: [
        {
          itemId: PRODUCT,
          label: "50% off oat milk",
          url: `${ECHO}/shop/oat-milk`,
          state: "draft",
          blocked: false,
        },
      ],
    });
    expect(ran("p.name ilike")[0].params).toContain("%50\\%\\_off%");
    expect(
      await resolveTarget({
        storeId: STORE,
        kind: "review" as never,
        search: "x",
      }),
    ).toEqual({ ok: false, error: TARGET_ERRORS.searchKind });
  });

  it("reads a picked review with the product it is on", async () => {
    withEcho();
    on("from public.product_reviews r join public.products p", [
      {
        id: REVIEW,
        label: "Terrible, and the seller is a fraud. ".repeat(4),
        slug: null,
        status: null,
        moderation_blocked_at: null,
        row: null,
        related: null,
        author_user_id: "user-1",
        author_name: "Asha Kumar",
        parent_id: PRODUCT,
        parent_label: "Oat milk",
        parent_slug: "oat-milk",
      },
    ]);
    const result = await resolveTarget({
      storeId: STORE,
      kind: "review",
      itemId: REVIEW,
    });
    expect(result).toMatchObject({
      ok: true,
      target: {
        kind: "review",
        itemId: REVIEW,
        authorUserId: "user-1",
        url: `${ECHO}/shop/oat-milk`,
        parent: { kind: "product", id: PRODUCT, label: "Oat milk" },
        appearsOn: APPEARS_ON.review,
      },
    });
    if (!result.ok || result.found !== "target")
      throw new Error("expected a target");
    expect(result.target.label.length).toBeLessThanOrEqual(80);
    expect(result.target.label.endsWith("…")).toBe(true);
  });

  it("lists a product's reviews to pick from and the images it shows", async () => {
    withEcho();
    const image = `https://storage.googleapis.com/sm-media/stores/${STORE}/media/oat.webp`;
    on("from public.products p where p.store_id", [
      {
        id: PRODUCT,
        label: "Oat milk",
        slug: "oat-milk",
        status: "published",
        moderation_blocked_at: null,
        row: { name: "Oat milk", image_url: image },
        related: [{ image_url: "/themes/basket/oat.webp" }],
      },
    ]);
    on("from public.product_reviews r where r.store_id", [
      {
        id: REVIEW,
        author_name: "Asha Kumar",
        created_at: "2026-10-29 05:00:00+00",
        body: "<p>Lovely</p>",
        user_id: "user-1",
        parent_id: PRODUCT,
        blocked: false,
      },
    ]);
    on("select distinct b.object_path", [
      { object_path: `stores/${STORE}/media/oat.webp` },
    ]);
    const result = await resolveTarget({
      storeId: STORE,
      kind: "product",
      itemId: PRODUCT,
    });
    expect(result).toMatchObject({
      ok: true,
      target: {
        picks: [
          {
            kind: "review",
            id: REVIEW,
            author: "Asha K.",
            excerpt: "Lovely",
            parentId: PRODUCT,
          },
        ],
      },
    });
    if (!result.ok || result.found !== "target")
      throw new Error("expected a target");
    expect(result.target.images).toEqual(
      expect.arrayContaining([
        {
          source: "bucket",
          key: `stores/${STORE}/media/oat.webp`,
          url: image,
          blocked: true,
        },
        {
          source: "bundled",
          key: "/themes/basket/oat.webp",
          url: "/themes/basket/oat.webp",
          blocked: false,
        },
      ]),
    );
    const blockedRead = ran("select distinct b.object_path")[0];
    expect(blockedRead.text).toContain("= any(");
    expect(blockedRead.text).toContain("::text[]");
  });

  it("answers plain sentences for a store or item that is not there, or a failed read", async () => {
    expect(await resolveTarget({ storeId: "echo", kind: "store" })).toEqual({
      ok: false,
      error: TARGET_ERRORS.storeNotFound,
    });
    expect(await resolveTarget({ storeId: STORE, kind: "store" })).toEqual({
      ok: false,
      error: TARGET_ERRORS.storeNotFound,
    });
    withEcho();
    expect(
      await resolveTarget({ storeId: STORE, kind: "page", itemId: "x" }),
    ).toEqual({ ok: false, error: TARGET_ERRORS.itemNotFound });
    expect(
      await resolveTarget({ storeId: STORE, kind: "page", itemId: PRODUCT }),
    ).toEqual({ ok: false, error: TARGET_ERRORS.itemNotFound });
    vi.mocked(withService).mockRejectedValueOnce(new Error("db down"));
    expect(await resolveTarget({ storeId: STORE, kind: "store" })).toEqual({
      ok: false,
      error: TARGET_ERRORS.readFailed,
    });
    expect(logError).toHaveBeenCalledWith(
      "moderation.console: target lookup failed",
      expect.anything(),
    );
  });
});
