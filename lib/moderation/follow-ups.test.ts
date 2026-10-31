import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type {
  GcsBucketKind,
  GcsCopyPreconditions,
  GcsObjectMetadata,
  GcsUploadOptions,
} from "@/lib/storage/gcs";

// ★ A fake database that runs the module's own compiled SQL by its shape, a
//   fake storage whose every call waits a moment (so two runs interleave), and
//   no network: gcs.ts throws if anything reaches it, and the fake's `fetch`
//   refuses.
type EventRow = {
  actor: string;
  action: string;
  blockId?: string | null;
  complaintId?: string | null;
  storeId?: string | null;
  detail?: Record<string, unknown> | null;
  at: number;
};

const h = vi.hoisted(() => ({
  execute: null as null | ((query: unknown) => Promise<{ rows: unknown[] }>),
  deliver: null as
    | null
    | ((
        blockId: string,
        actor: string,
        options: { bell?: boolean },
      ) => Promise<"sent" | "failed" | "skipped">),
  events: [] as EventRow[],
  clock: 0,
  alerts: [] as { id: string; stage: string; phase: string }[],
  notifyWorks: true,
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) =>
    fn({ execute: (query: unknown) => h.execute!(query) }),
  ),
}));
vi.mock("./record", () => ({
  recordModerationEvent: vi.fn(
    async (_db: unknown, input: Omit<EventRow, "at">) => {
      h.events.push({ ...input, at: h.clock });
      return globalThis.crypto.randomUUID();
    },
  ),
}));
vi.mock("./notify", () => ({
  notifyComplaintDue: vi.fn(
    async (
      complaint: { id: string },
      alert: { stage: string; phase: string },
    ) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      h.alerts.push({
        id: complaint.id,
        stage: alert.stage,
        phase: alert.phase,
      });
      return h.notifyWorks ? globalThis.crypto.randomUUID() : null;
    },
  ),
}));
vi.mock("./block", () => ({
  deliverBlockNotice: vi.fn(
    (blockId: string, actor: string, options: { bell?: boolean } = {}) =>
      h.deliver!(blockId, actor, options),
  ),
}));
vi.mock("./blocked-objects", () => ({ forgetBlockedObjects: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/storage/gcs", () => {
  const refuse = vi.fn(async () => {
    throw new Error("No storage in this test.");
  });
  return {
    GCS_BUCKET_NAME: "mock-media",
    GCS_PRIVATE_BUCKET_NAME: "mock-private",
    gcsObjectMetadata: refuse,
    gcsCopyObject: refuse,
    gcsUploadObject: refuse,
    gcsPrivateUploadObject: refuse,
    gcsDownloadObject: refuse,
    gcsDeleteGeneration: refuse,
    gcsDeletePaths: refuse,
  };
});

import {
  FOLLOW_UP_ERRORS,
  FOLLOW_UP_LIMITS,
  backoffMinutes,
  minutesWaited,
  nextTry,
  runModerationFollowUps,
  type FollowUpOptions,
} from "./follow-ups";
import { dueAlert } from "./deadlines";
import { notifyComplaintDue } from "./notify";
import { deliverBlockNotice } from "./block";
import { forgetBlockedObjects } from "./blocked-objects";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { archiveObjectPath } from "./archive-paths";
import {
  TAKEDOWN_METADATA_KEY,
  parseArchivedFile,
  type ArchivedFile,
  type ModerationStorage,
} from "./storage";

const DB_NAME = "storemink_test";
const START = Date.parse("2026-10-30T06:00:00.000Z");
const STORE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const md5 = (bytes: Uint8Array) =>
  createHash("md5").update(bytes).digest("base64");
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text));
const statusError = (code: number) =>
  Object.assign(new Error(`status ${code}`), { code });
const pause = (ms = 2) => new Promise((resolve) => setTimeout(resolve, ms));
const id = () => globalThis.crypto.randomUUID();

// ── The fake storage ────────────────────────────────────────────────────────

type Stored = {
  bytes: Uint8Array;
  generation: string;
  contentType: string | null;
  cacheControl: string | null;
  metadata: Record<string, string>;
};

class FakeStorage implements ModerationStorage {
  objects = new Map<string, Stored>();
  copies: string[] = [];
  publicUploads: string[] = [];
  deletes: string[] = [];
  beforeCopy: ((fromPath: string) => void) | null = null;
  brokenPaths = new Set<string>();
  failUploads = false;
  private nextGeneration = 1830000000000001;

  key(kind: GcsBucketKind, path: string) {
    return `${kind}:${path}`;
  }

  put(
    kind: GcsBucketKind,
    path: string,
    bytes: Uint8Array,
    extra: Partial<Omit<Stored, "bytes" | "generation">> = {},
  ): Stored {
    const stored: Stored = {
      bytes,
      generation: String(this.nextGeneration++),
      contentType: extra.contentType ?? "image/webp",
      cacheControl: extra.cacheControl ?? "public, max-age=3600",
      metadata: extra.metadata ?? {},
    };
    this.objects.set(this.key(kind, path), stored);
    return stored;
  }

  get(kind: GcsBucketKind, path: string) {
    return this.objects.get(this.key(kind, path));
  }

  private precondition(
    existing: Stored | undefined,
    match: string | number | undefined,
  ) {
    if (match === undefined) return;
    if (
      String(match) === "0" ? existing : existing?.generation !== String(match)
    ) {
      throw statusError(412);
    }
  }

  bucketName(kind: GcsBucketKind) {
    return kind === "private" ? "fake-private" : "fake-media";
  }

  async objectMetadata(
    kind: GcsBucketKind,
    path: string,
  ): Promise<GcsObjectMetadata | null> {
    await pause();
    if (this.brokenPaths.has(path)) throw new Error("storage is down");
    const stored = this.get(kind, path);
    if (!stored) return null;
    return {
      size: stored.bytes.length,
      contentType: stored.contentType,
      md5: md5(stored.bytes),
      crc32c: null,
      generation: stored.generation,
      cacheControl: stored.cacheControl,
      metadata: { ...stored.metadata },
    };
  }

  async copyObject(
    fromKind: GcsBucketKind,
    fromPath: string,
    toKind: GcsBucketKind,
    toPath: string,
    preconditions: GcsCopyPreconditions,
  ) {
    await pause();
    this.copies.push(fromPath);
    this.beforeCopy?.(fromPath);
    const source = this.get(fromKind, fromPath);
    if (
      !source ||
      (preconditions.ifSourceGenerationMatch !== undefined &&
        source.generation !== String(preconditions.ifSourceGenerationMatch))
    ) {
      throw statusError(404);
    }
    this.precondition(
      this.get(toKind, toPath),
      preconditions.ifGenerationMatch,
    );
    this.put(toKind, toPath, source.bytes, source);
  }

  async uploadPublic(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    cacheControl: string,
    options: GcsUploadOptions,
  ) {
    await pause();
    if (this.failUploads) throw new Error("storage is down");
    this.publicUploads.push(path);
    this.precondition(this.get("public", path), options.ifGenerationMatch);
    this.put("public", path, bytes, {
      contentType,
      cacheControl,
      metadata: options.metadata ?? {},
    });
  }

  async uploadPrivate(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    options: GcsUploadOptions,
  ) {
    await pause();
    this.precondition(this.get("private", path), options.ifGenerationMatch);
    this.put("private", path, bytes, { contentType });
  }

  async downloadObject(kind: GcsBucketKind, path: string, maxBytes: number) {
    await pause();
    const stored = this.get(kind, path);
    if (!stored) throw statusError(404);
    if (stored.bytes.length > maxBytes) throw new Error("too large");
    return new Uint8Array(stored.bytes);
  }

  async deleteGeneration(
    kind: GcsBucketKind,
    path: string,
    generation: string | number,
  ) {
    await pause();
    this.deletes.push(`${kind}:${path}`);
    const stored = this.get(kind, path);
    if (stored && stored.generation === String(generation)) {
      this.objects.delete(this.key(kind, path));
      return "deleted" as const;
    }
    return "missing" as const;
  }

  async deletePaths(kind: GcsBucketKind, paths: string[]) {
    for (const path of paths) this.deletes.push(`${kind}:${path}`);
    return [];
  }

  fetch(): Promise<Response> {
    return Promise.reject(new Error("No network in this test."));
  }

  async readBundledFile(): Promise<Uint8Array> {
    throw Object.assign(new Error("no such file"), { code: "ENOENT" });
  }

  async placeholder() {
    return bytesOf("PLACEHOLDER");
  }

  now() {
    return new Date(START);
  }
}

// ── The fake database ───────────────────────────────────────────────────────

type Complaint = {
  id: string;
  ref_no: number;
  kind: string;
  store_id: string | null;
  store_label: string;
  received_at: string;
  acknowledge_due_at: string;
  action_due_at: string;
  resolve_due_at: string;
  acknowledged_at: string | null;
  actioned_at: string | null;
  resolved_at: string | null;
  erased_at: string | null;
  alerts: Record<string, unknown>;
  alert_claimed_at: string | null;
};

type Block = {
  id: string;
  store_id: string | null;
  item_kind: string;
  item_id: string | null;
  object_path: string | null;
  object_md5: string | null;
  parent_block_id: string | null;
  tell_store: boolean;
  storage_state: string;
  storage_attempts: number;
  storage_next_attempt_at: number | null;
  storage_claimed_at: string | null;
  storage_error: string;
  blocked_at: number;
  merchant_notified_at: number | null;
  notice_claimed_at: string | null;
  lifted_at: number | null;
};

type Archive = {
  id: string;
  block_id: string;
  files: unknown[];
  files_state: string;
  files_attempts: number;
  files_next_attempt_at: number | null;
  files_claimed_at: string | null;
  files_error: string;
};

const dialect = new PgDialect();
const iso = (ms: number) => new Date(ms).toISOString();

class FakeDb {
  clock = START;
  complaints = new Map<string, Complaint>();
  blocks = new Map<string, Block>();
  archives = new Map<string, Archive>();
  claims: string[] = [];
  statements: string[] = [];
  failOn: string | null = null;
  onStatement: ((text: string) => void) | null = null;

  lapsed(claim: string | null, t: number) {
    return claim === null || Date.parse(claim) < t - 2 * MINUTE;
  }

  archiveOf(blockId: string) {
    return [...this.archives.values()].find((a) => a.block_id === blockId);
  }

  async execute(query: unknown) {
    const compiled = dialect.sqlToQuery(query as SQL);
    const text = compiled.sql.replace(/\s+/g, " ").trim();
    this.statements.push(text);
    if (this.failOn && text.includes(this.failOn)) {
      throw new Error("database refused");
    }
    this.clock += 1;
    h.clock = this.clock;
    const rows = this.route(text, compiled.params, this.clock);
    this.onStatement?.(text);
    return { rows };
  }

  route(text: string, params: unknown[], t: number): Record<string, unknown>[] {
    const has = (clause: string) => text.includes(clause);

    // 1. Complaint alerts.
    if (has("update public.grievance_complaints g")) {
      const now = new Date(String(params[0]));
      const limit = Number(params[params.length - 1]);
      const rows = [...this.complaints.values()]
        .filter(
          (c) =>
            c.resolved_at === null &&
            c.erased_at === null &&
            (!has("c.alert_claimed_at < now() - interval '2 minutes'") ||
              this.lapsed(c.alert_claimed_at, t)) &&
            dueAlert(
              {
                kind: c.kind as never,
                receivedAt: c.received_at,
                acknowledgeDueAt: c.acknowledge_due_at,
                actionDueAt: c.action_due_at,
                resolveDueAt: c.resolve_due_at,
                acknowledgedAt: c.acknowledged_at,
                actionedAt: c.actioned_at,
                resolvedAt: c.resolved_at,
                alerts: c.alerts,
              },
              now,
            ) !== null,
        )
        .sort((a, b) => a.ref_no - b.ref_no)
        .slice(0, limit);
      for (const c of rows) {
        if (has("set alert_claimed_at = now()")) c.alert_claimed_at = iso(t);
        this.claims.push(`alert:${c.id}`);
      }
      return rows.map((c) => ({
        id: c.id,
        ref_no: c.ref_no,
        kind: c.kind,
        store_id: c.store_id,
        store_label: c.store_label,
        received_at: c.received_at,
        acknowledge_due_at: c.acknowledge_due_at,
        action_due_at: c.action_due_at,
        resolve_due_at: c.resolve_due_at,
        acknowledged_at: c.acknowledged_at,
        actioned_at: c.actioned_at,
        resolved_at: c.resolved_at,
        alerts: { ...c.alerts },
        claimed_at: c.alert_claimed_at,
      }));
    }
    if (has("update public.grievance_complaints set alert_claimed_at = null")) {
      const [ids, claim] = params as [string[], string];
      for (const c of this.complaints.values()) {
        if (ids.includes(c.id) && c.alert_claimed_at === claim) {
          c.alert_claimed_at = null;
        }
      }
      return [];
    }
    if (has("update public.grievance_complaints set alerts = alerts ||")) {
      const [key, at, cid, claim] = params as string[];
      const c = this.complaints.get(cid);
      if (!c || c.alert_claimed_at !== claim) return [];
      c.alerts = { ...c.alerts, [key]: at };
      c.alert_claimed_at = null;
      return [{ id: cid }];
    }

    // 2. Archive copies.
    if (has("update public.content_block_archives a")) {
      const limit = Number(params[params.length - 1]);
      const rows = [...this.archives.values()]
        .filter(
          (a) =>
            a.files_state === "pending" &&
            (a.files_next_attempt_at === null ||
              a.files_next_attempt_at <= t) &&
            (!has("x.files_claimed_at < now() - interval '2 minutes'") ||
              this.lapsed(a.files_claimed_at, t)),
        )
        .sort(
          (a, b) =>
            (a.files_next_attempt_at ?? 0) - (b.files_next_attempt_at ?? 0) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, limit);
      for (const a of rows) {
        if (has("set files_claimed_at = now()")) a.files_claimed_at = iso(t);
        a.files_attempts += 1;
        this.claims.push(`archive:${a.block_id}`);
      }
      return rows.map((a) => {
        const b = this.blocks.get(a.block_id)!;
        return {
          id: a.id,
          block_id: a.block_id,
          files: structuredClone(a.files),
          attempts: a.files_attempts,
          claimed_at: a.files_claimed_at,
          item_kind: b.item_kind,
          item_id: b.item_id,
          store_id: b.store_id,
          object_path: b.object_path,
          object_md5: b.object_md5,
        };
      });
    }
    if (
      has("update public.content_block_archives set files_claimed_at = null")
    ) {
      const [ids, claim] = params as [string[], string];
      for (const a of this.archives.values()) {
        if (
          ids.includes(a.id) &&
          a.files_state === "pending" &&
          a.files_claimed_at === claim
        ) {
          a.files_claimed_at = null;
          a.files_attempts = Math.max(a.files_attempts - 1, 0);
        }
      }
      return [];
    }
    if (has("update public.content_block_archives set files =")) {
      const secs = has("make_interval(secs") ? Number(params[4]) : null;
      const [json, state, attempts, error] = params as [
        string,
        string,
        number,
        string,
      ];
      const aid = String(params[params.length - 2]);
      const claim = String(params[params.length - 1]);
      const a = this.archives.get(aid);
      if (!a || a.files_state !== "pending" || a.files_claimed_at !== claim) {
        return [];
      }
      a.files = JSON.parse(json);
      a.files_state = state;
      a.files_attempts = Number(attempts);
      a.files_error = String(error).slice(0, 1000);
      a.files_next_attempt_at = secs === null ? null : t + secs * 1000;
      a.files_claimed_at = null;
      return [{ id: aid }];
    }
    if (has("update public.content_blocks set object_md5")) {
      const [value, bid, path] = params as string[];
      const b = this.blocks.get(bid);
      if (!b || b.object_md5 !== null || b.object_path !== path) return [];
      b.object_md5 = value;
      return [{ id: bid }];
    }

    // 3. Replacements and 4. restores.
    const claimFiles = (state: "pending" | "restoring") => {
      const limit = Number(params[params.length - 1]);
      const rows = [...this.blocks.values()]
        .filter((b) => {
          if (b.storage_state !== state) return false;
          if (state === "pending") {
            if (has("x.lifted_at is null") && b.lifted_at !== null)
              return false;
            if (
              b.storage_next_attempt_at === null ||
              b.storage_next_attempt_at > t
            )
              return false;
            const archive = this.archiveOf(b.id);
            const ready = (archive?.files ?? []).some((entry) => {
              const e = entry as Record<string, unknown>;
              return (
                e.source === "bucket" &&
                e.path === b.object_path &&
                e.state !== "pending"
              );
            });
            if (!ready) return false;
          } else if (
            b.storage_next_attempt_at !== null &&
            b.storage_next_attempt_at > t
          ) {
            return false;
          }
          return (
            !has("x.storage_claimed_at < now() - interval '2 minutes'") ||
            this.lapsed(b.storage_claimed_at, t)
          );
        })
        .sort(
          (a, b) =>
            (a.storage_next_attempt_at ?? 0) -
              (b.storage_next_attempt_at ?? 0) || a.id.localeCompare(b.id),
        )
        .slice(0, limit);
      for (const b of rows) {
        if (has("set storage_claimed_at = now()"))
          b.storage_claimed_at = iso(t);
        b.storage_attempts += 1;
        this.claims.push(
          `${state === "pending" ? "replace" : "restore"}:${b.id}`,
        );
      }
      return rows.map((b) => ({
        id: b.id,
        store_id: b.store_id,
        object_path: b.object_path,
        attempts: b.storage_attempts,
        claimed_at: b.storage_claimed_at,
        files: structuredClone(this.archiveOf(b.id)?.files ?? null),
      }));
    };
    if (
      has("update public.content_blocks b") &&
      has("x.storage_state = 'pending'")
    ) {
      return claimFiles("pending");
    }
    if (
      has("update public.content_blocks b") &&
      has("x.storage_state = 'restoring'")
    ) {
      return claimFiles("restoring");
    }
    if (
      has(
        "update public.content_blocks set storage_claimed_at = null, storage_attempts = greatest",
      )
    ) {
      const [ids, state, claim] = params as [string[], string, string];
      for (const b of this.blocks.values()) {
        if (
          ids.includes(b.id) &&
          b.storage_state === state &&
          b.storage_claimed_at === claim
        ) {
          b.storage_claimed_at = null;
          b.storage_attempts = Math.max(b.storage_attempts - 1, 0);
        }
      }
      return [];
    }
    if (has("update public.content_blocks set storage_state =")) {
      const secs = has("make_interval(secs") ? Number(params[2]) : null;
      const [to, error] = params as [string, string];
      const [bid, from, claim] = params.slice(-3) as string[];
      const b = this.blocks.get(bid);
      if (!b || b.storage_state !== from || b.storage_claimed_at !== claim) {
        return [];
      }
      // content_blocks_storage_lift_check, as the real table enforces it.
      if (
        b.lifted_at !== null &&
        ["pending", "failed", "replaced"].includes(to)
      ) {
        throw new Error("content_blocks_storage_lift_check");
      }
      b.storage_state = to;
      b.storage_claimed_at = null;
      b.storage_error = String(error).slice(0, 1000);
      b.storage_next_attempt_at = secs === null ? null : t + secs * 1000;
      return [{ id: bid }];
    }
    if (has("select 1 from public.content_blocks where id =")) {
      const [bid, claim] = params as string[];
      const b = this.blocks.get(bid);
      return b &&
        b.storage_state === "pending" &&
        (!has("lifted_at is null") || b.lifted_at === null) &&
        b.storage_claimed_at === claim
        ? [{ "?column?": 1 }]
        : [];
    }

    // 5. Notices.
    if (has("bool_or((e.detail ->> 'bell') = 'true')")) {
      const [windowHours, maxBackoff, limit] = params.map(Number);
      return [...this.blocks.values()]
        .filter((b) => {
          if (
            !b.tell_store ||
            b.merchant_notified_at !== null ||
            b.lifted_at !== null ||
            b.store_id === null ||
            b.parent_block_id !== null ||
            b.blocked_at <= t - windowHours * HOUR ||
            !this.lapsed(b.notice_claimed_at, t)
          ) {
            return false;
          }
          const failures = h.events.filter(
            (e) => e.blockId === b.id && e.action === "merchant_notify_failed",
          );
          if (failures.length === 0) return true;
          const last = Math.max(...failures.map((e) => e.at));
          const wait = Math.min(maxBackoff, 2 ** (failures.length - 1));
          return last <= t - wait * MINUTE;
        })
        .sort((a, b) => a.blocked_at - b.blocked_at)
        .slice(0, limit)
        .map((b) => ({
          id: b.id,
          bell_rang: h.events.some(
            (e) =>
              e.blockId === b.id &&
              e.action === "merchant_notify_failed" &&
              e.detail?.bell === true,
          ),
        }));
    }

    throw new Error(`Unexpected SQL: ${text}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

let db: FakeDb;
let storage: FakeStorage;
let sends: { blockId: string; bell: boolean }[];
let noticeWorks: (blockId: string) => boolean;

function pendingEntry(
  n: number,
  path: string,
  extra: { source?: string; expectedMd5?: string | null } = {},
) {
  return {
    n,
    source: extra.source ?? "bucket",
    path,
    state: "pending",
    at: iso(START),
    expectedMd5: extra.expectedMd5 ?? null,
  };
}

/** A live file block on a public object, its archive still to copy. */
function fileBlock(
  options: {
    path?: string;
    bytes?: string;
    nextAt?: number | null;
    attempts?: number;
    archiveAttempts?: number;
    entries?: unknown[];
    objectMd5?: string | null;
    contentType?: string;
    placeholderSource?: boolean;
  } = {},
) {
  const blockId = id();
  const path = options.path ?? `stores/${STORE}/uploads/${blockId}.webp`;
  storage.put("public", path, bytesOf(options.bytes ?? `photo ${blockId}`), {
    contentType: options.contentType ?? "image/webp",
    metadata: options.placeholderSource
      ? { [TAKEDOWN_METADATA_KEY]: id() }
      : {},
  });
  db.blocks.set(blockId, {
    id: blockId,
    store_id: STORE,
    item_kind: "file",
    item_id: null,
    object_path: path,
    object_md5: options.objectMd5 ?? null,
    parent_block_id: id(),
    tell_store: true,
    storage_state: "pending",
    storage_attempts: options.attempts ?? 0,
    storage_next_attempt_at:
      options.nextAt === undefined ? START - 1 : options.nextAt,
    storage_claimed_at: null,
    storage_error: "",
    blocked_at: START - MINUTE,
    merchant_notified_at: null,
    notice_claimed_at: null,
    lifted_at: null,
  });
  const archiveId = id();
  db.archives.set(archiveId, {
    id: archiveId,
    block_id: blockId,
    files: options.entries ?? [pendingEntry(1, path)],
    files_state: "pending",
    files_attempts: options.archiveAttempts ?? 0,
    files_next_attempt_at: START - 1,
    files_claimed_at: null,
    files_error: "",
  });
  return { blockId, archiveId, path };
}

/** A told product block whose notice never went. */
function noticeBlock(blockedAt = START - MINUTE) {
  const blockId = id();
  db.blocks.set(blockId, {
    id: blockId,
    store_id: STORE,
    item_kind: "product",
    item_id: id(),
    object_path: null,
    object_md5: null,
    parent_block_id: null,
    tell_store: true,
    storage_state: "none",
    storage_attempts: 0,
    storage_next_attempt_at: null,
    storage_claimed_at: null,
    storage_error: "",
    blocked_at: blockedAt,
    merchant_notified_at: null,
    notice_claimed_at: null,
    lifted_at: null,
  });
  return blockId;
}

let refNo = 100;
/** An open complaint whose acknowledge deadline passed an hour ago. */
function overdueComplaint() {
  const complaintId = id();
  db.complaints.set(complaintId, {
    id: complaintId,
    ref_no: refNo++,
    kind: "court_order",
    store_id: STORE,
    store_label: "Echo",
    received_at: iso(START - 30 * HOUR),
    acknowledge_due_at: iso(START - HOUR),
    action_due_at: iso(START + 20 * HOUR),
    resolve_due_at: iso(START + 300 * HOUR),
    acknowledged_at: null,
    actioned_at: null,
    resolved_at: null,
    erased_at: null,
    alerts: {},
    alert_claimed_at: null,
  });
  return complaintId;
}

function run(options: FollowUpOptions = {}) {
  return runModerationFollowUps({
    storage,
    now: () => new Date(db.clock),
    ...options,
  });
}

function entryOf(archiveId: string, n = 1): ArchivedFile | null {
  const value = db.archives
    .get(archiveId)!
    .files.find((entry) => (entry as { n: number }).n === n);
  return parseArchivedFile(value);
}

const eventsOf = (action: string, blockId?: string) =>
  h.events.filter(
    (e) => e.action === action && (!blockId || e.blockId === blockId),
  );

beforeEach(() => {
  vi.stubEnv("DB_NAME", DB_NAME);
  db = new FakeDb();
  storage = new FakeStorage();
  sends = [];
  noticeWorks = () => true;
  h.events = [];
  h.alerts = [];
  h.notifyWorks = true;
  h.clock = START;
  h.execute = (query) => db.execute(query);
  // deliverBlockNotice's own claim and settle (block.ts), against the fake.
  h.deliver = async (blockId, actor, options) => {
    const block = db.blocks.get(blockId);
    const t = db.clock;
    if (
      !block ||
      !block.tell_store ||
      block.lifted_at !== null ||
      block.merchant_notified_at !== null ||
      block.store_id === null ||
      block.parent_block_id !== null ||
      !db.lapsed(block.notice_claimed_at, t)
    ) {
      return "skipped";
    }
    block.notice_claimed_at = iso(t);
    await pause(3);
    const bell = options.bell !== false;
    sends.push({ blockId, bell });
    block.notice_claimed_at = null;
    if (noticeWorks(blockId)) {
      block.merchant_notified_at = db.clock;
      h.events.push({
        actor,
        action: "merchant_notified",
        blockId,
        at: db.clock,
      });
      return "sent";
    }
    h.events.push({
      actor,
      action: "merchant_notify_failed",
      blockId,
      detail: { bell },
      at: db.clock,
    });
    return "failed";
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("backoff", () => {
  it("waits 1, 2, 4 ... minutes, at most an hour", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 30].map(backoffMinutes)).toEqual([
      1, 2, 4, 8, 16, 32, 60, 60, 60,
    ]);
    expect(backoffMinutes(0)).toBe(1);
  });

  it("adds the waits up", () => {
    for (let n = 0; n <= 40; n += 1) {
      let sum = 0;
      for (let k = 1; k <= n; k += 1) sum += backoffMinutes(k);
      expect(minutesWaited(n)).toBe(sum);
    }
  });

  it("gives up once the waits reach 24 hours", () => {
    expect(nextTry(28)).toEqual({ giveUp: false, waitSeconds: 3600 });
    expect(nextTry(29)).toEqual({ giveUp: true });
    expect(nextTry(1)).toEqual({ giveUp: false, waitSeconds: 60 });
  });
});

describe("claims", () => {
  it("every claim skips locked rows, stamps its time and honours a live claim", async () => {
    overdueComplaint();
    const { blockId, archiveId } = fileBlock();
    // A restoring block (a lift whose inline restore did not finish).
    const restoring = fileBlock({ nextAt: START - 1 });
    db.blocks.get(restoring.blockId)!.storage_state = "restoring";
    db.blocks.get(restoring.blockId)!.lifted_at = START - 1;
    await run();
    expect(db.archives.get(archiveId)!.files_state).toBe("copied");
    expect(db.blocks.get(blockId)!.storage_state).toBe("replaced");

    const claim = (needle: string) =>
      db.statements.find((s) => s.includes(needle) && s.includes(" where "))!;
    const complaints = claim("update public.grievance_complaints g");
    const archives = claim("update public.content_block_archives a");
    const replacements = db.statements.find(
      (s) =>
        s.includes("update public.content_blocks b") &&
        s.includes("x.storage_state = 'pending'"),
    )!;
    const restores = db.statements.find(
      (s) =>
        s.includes("update public.content_blocks b") &&
        s.includes("x.storage_state = 'restoring'"),
    )!;
    for (const [statement, column] of [
      [complaints, "alert_claimed_at"],
      [archives, "files_claimed_at"],
      [replacements, "storage_claimed_at"],
      [restores, "storage_claimed_at"],
    ] as const) {
      expect(statement).toContain("for update skip locked");
      expect(statement).toContain(`set ${column} = now()`);
      expect(statement).toContain(`${column} < now() - interval '2 minutes'`);
      expect(statement).toContain(`${column}::text as claimed_at`);
    }
    // ★ A lifted block is never claimed for a replacement.
    expect(replacements).toContain("x.lifted_at is null");
  });

  it("settles every claim on its own claim time", async () => {
    overdueComplaint();
    fileBlock();
    await run();
    const settles = db.statements.filter(
      (s) =>
        s.startsWith("update public.content_blocks set storage_state") ||
        s.startsWith("update public.content_block_archives set files =") ||
        s.startsWith("update public.grievance_complaints set alerts"),
    );
    expect(settles.length).toBe(3);
    for (const statement of settles) {
      expect(statement).toMatch(/claimed_at = \$\d+::timestamptz/);
    }
  });
});

describe("two runs started together", () => {
  it("copy, replace, alert and notify once each, and never touch what they did not make", async () => {
    const complaint = overdueComplaint();
    const plain = fileBlock();
    // A source that is already a StoreMink placeholder: never copied.
    const placeholder = fileBlock({ placeholderSource: true });
    // A different file already sits at the archive path: never overwritten.
    const taken = fileBlock();
    const takenPath = archiveObjectPath(taken.blockId, 1, taken.path);
    storage.put("private", takenPath, bytesOf("someone else's bytes"));
    const notice = noticeBlock();

    const [first, second] = await Promise.all([run(), run()]);

    // Every row was claimed by one run only.
    const counts = new Map<string, number>();
    for (const claim of db.claims)
      counts.set(claim, (counts.get(claim) ?? 0) + 1);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);

    // The alert stage once.
    expect(h.alerts.filter((a) => a.id === complaint)).toHaveLength(1);
    expect(db.complaints.get(complaint)!.alerts).toHaveProperty(
      "acknowledge_overdue",
    );
    expect(
      h.events.filter((e) => e.action === "complaint_alerted"),
    ).toHaveLength(1);

    // The plain file copied once and replaced once.
    expect(storage.copies.filter((p) => p === plain.path)).toHaveLength(1);
    expect(storage.publicUploads.filter((p) => p === plain.path)).toHaveLength(
      1,
    );
    expect(eventsOf("storage_replaced", plain.blockId)).toHaveLength(1);
    expect(
      storage.get("public", plain.path)!.metadata[TAKEDOWN_METADATA_KEY],
    ).toBe(plain.blockId);

    // The placeholder source never copied, and its replacement explains why.
    expect(storage.copies).not.toContain(placeholder.path);
    expect(entryOf(placeholder.archiveId)!.state).toBe("placeholder");
    expect(db.blocks.get(placeholder.blockId)!.storage_state).toBe("failed");
    expect(db.blocks.get(placeholder.blockId)!.storage_error).toBe(
      FOLLOW_UP_ERRORS.placeholderBeforeCopy,
    );

    // The archive object that was there already is untouched; the archive
    // waits for a person, and its file is not replaced.
    expect(
      Buffer.from(storage.get("private", takenPath)!.bytes).toString(),
    ).toBe("someone else's bytes");
    expect(db.archives.get(taken.archiveId)!.files_state).toBe("failed");
    expect(db.blocks.get(taken.blockId)!.storage_state).toBe("pending");

    // Nothing in the archive bucket deleted, nothing deleted by path.
    expect(storage.deletes.filter((d) => d.startsWith("private:"))).toEqual([]);

    // The notice once.
    expect(sends.filter((s) => s.blockId === notice)).toHaveLength(1);

    expect(first.replaced + second.replaced).toBe(1);
    expect(first.alertsSent + second.alertsSent).toBe(1);
  });
});

describe("a replacement", () => {
  it("waits until 35 seconds after the block", async () => {
    const block = fileBlock({ nextAt: START + 35_000 });
    const before = storage.get("public", block.path)!;
    await run();
    expect(db.archives.get(block.archiveId)!.files_state).toBe("copied");
    expect(db.blocks.get(block.blockId)!.storage_state).toBe("pending");
    expect(storage.get("public", block.path)).toBe(before);

    db.clock = START + 36_000;
    await run();
    expect(db.blocks.get(block.blockId)!.storage_state).toBe("replaced");
    expect(
      Buffer.from(storage.get("public", block.path)!.bytes).toString(),
    ).toBe("PLACEHOLDER");
  });

  it("waits until the copy is confirmed", async () => {
    const block = fileBlock();
    storage.brokenPaths.add(block.path);
    const result = await run();
    expect(result.filesRetrying).toBe(1);
    const archive = db.archives.get(block.archiveId)!;
    expect(archive.files_state).toBe("pending");
    // A storage outage is asked again a minute later, not at once.
    expect(archive.files_next_attempt_at! - db.clock).toBeGreaterThan(55_000);
    expect(db.blocks.get(block.blockId)!.storage_state).toBe("pending");
    expect(storage.publicUploads).toEqual([]);
    expect(db.claims).not.toContain(`replace:${block.blockId}`);

    storage.brokenPaths.delete(block.path);
    db.clock += 61_000;
    await run();
    expect(db.archives.get(block.archiveId)!.files_state).toBe("copied");
    expect(db.blocks.get(block.blockId)!.storage_state).toBe("replaced");
  });

  it("is never made for a lifted block: its public object stays byte for byte", async () => {
    const lifted = fileBlock();
    const original = storage.get("public", lifted.path)!;
    const bytes = Buffer.from(original.bytes).toString("base64");
    // The lift (block.ts): a pending replacement becomes cancelled.
    const row = db.blocks.get(lifted.blockId)!;
    row.lifted_at = START;
    row.storage_state = "cancelled";
    row.storage_next_attempt_at = null;

    // ★ And a lifted row the claim still sees as pending (the CHECK keeps a
    // real one from existing; this pins the claim's own clause).
    const raced = fileBlock();
    db.blocks.get(raced.blockId)!.lifted_at = START;
    const racedBytes = Buffer.from(
      storage.get("public", raced.path)!.bytes,
    ).toString("base64");

    await run();
    expect(
      Buffer.from(storage.get("public", lifted.path)!.bytes).toString("base64"),
    ).toBe(bytes);
    expect(storage.get("public", lifted.path)!.generation).toBe(
      original.generation,
    );
    expect(
      Buffer.from(storage.get("public", raced.path)!.bytes).toString("base64"),
    ).toBe(racedBytes);
    expect(storage.publicUploads).toEqual([]);
    expect(db.claims).not.toContain(`replace:${lifted.blockId}`);
    expect(db.claims).not.toContain(`replace:${raced.blockId}`);
  });

  it("deletes a non-image instead of overwriting it", async () => {
    const block = fileBlock({
      path: `stores/${STORE}/uploads/manual.pdf`,
      contentType: "application/pdf",
    });
    await run();
    expect(storage.get("public", block.path)).toBeUndefined();
    expect(db.blocks.get(block.blockId)!.storage_state).toBe("replaced");
    expect(eventsOf("storage_replaced", block.blockId)[0].detail).toEqual({
      removed: true,
    });
  });

  it("fails, with the sentence, when the file changed before the copy", async () => {
    const block = fileBlock();
    db.archives.get(block.archiveId)!.files = [
      pendingEntry(1, block.path, {
        expectedMd5: md5(bytesOf("the blocked bytes")),
      }),
    ];
    await run();
    const entry = entryOf(block.archiveId)!;
    expect(entry.state).toBe("changed");
    expect(entry.md5).toBe(md5(storage.get("public", block.path)!.bytes));
    expect(db.archives.get(block.archiveId)!.files_state).toBe("copied");
    expect(db.blocks.get(block.blockId)!.storage_state).toBe("failed");
    expect(db.blocks.get(block.blockId)!.storage_error).toBe(
      FOLLOW_UP_ERRORS.changedBeforeCopy,
    );
    expect(eventsOf("storage_failed", block.blockId)[0].detail).toEqual({
      reason: "changed_before_copy",
    });
    expect(storage.publicUploads).toEqual([]);
  });

  it("fails when the file changed after the copy", async () => {
    const block = fileBlock({ nextAt: START + 35_000 });
    await run();
    storage.put("public", block.path, bytesOf("a new version"));
    db.clock = START + 36_000;
    await run();
    expect(db.blocks.get(block.blockId)!.storage_state).toBe("failed");
    expect(db.blocks.get(block.blockId)!.storage_error).toBe(
      FOLLOW_UP_ERRORS.changedAfterCopy,
    );
    expect(
      Buffer.from(storage.get("public", block.path)!.bytes).toString(),
    ).toBe("a new version");
  });

  it("backs off on a storage failure and gives up after 24 hours", async () => {
    const block = fileBlock({ nextAt: START + 35_000, attempts: 0 });
    await run();
    storage.failUploads = true;
    db.clock = START + 36_000;
    const result = await run();
    expect(result.replaceRetrying).toBe(1);
    const row = db.blocks.get(block.blockId)!;
    expect(row.storage_state).toBe("pending");
    expect(row.storage_next_attempt_at! - db.clock).toBeGreaterThan(55_000);

    row.storage_attempts = 28;
    db.clock += HOUR;
    await run();
    expect(row.storage_state).toBe("failed");
    expect(eventsOf("storage_failed", block.blockId)[0].detail).toEqual({
      reason: "gave_up",
    });
  });
});

describe("archive copies", () => {
  it("fills in the blocked file's MD5 once and forgets the blocked set", async () => {
    const block = fileBlock({ nextAt: START + 35_000 });
    await run();
    expect(db.blocks.get(block.blockId)!.object_md5).toBe(
      md5(storage.get("public", block.path)!.bytes),
    );
    expect(forgetBlockedObjects).toHaveBeenCalledTimes(1);
    expect(eventsOf("archive_files_copied", block.blockId)).toHaveLength(1);
  });

  it("tries again when the file changed during the copy", async () => {
    const block = fileBlock({ nextAt: START + 35_000 });
    storage.beforeCopy = (from) => {
      if (from === block.path) {
        storage.beforeCopy = null;
        storage.put("public", block.path, bytesOf("replaced mid-copy"));
      }
    };
    const result = await run();
    expect(result.filesRetrying).toBe(1);
    const archive = db.archives.get(block.archiveId)!;
    expect(archive.files_state).toBe("pending");
    expect(archive.files_error).toBe(FOLLOW_UP_ERRORS.changedDuringCopy);
    expect((archive.files[0] as { state: string }).state).toBe("pending");

    db.clock += 61_000;
    await run();
    expect(entryOf(block.archiveId)!.state).toBe("copied");
    expect(entryOf(block.archiveId)!.md5).toBe(
      md5(bytesOf("replaced mid-copy")),
    );
  });

  it("copies this database's chat attachments and only notes any other private file", async () => {
    const storeBlock = id();
    const mine = `stores/${STORE}/mink-attachments/${DB_NAME}/a.webp`;
    const other = `stores/${STORE}/mink-attachments/storemink_staging/b.webp`;
    storage.put("private", mine, bytesOf("mine"));
    storage.put("private", other, bytesOf("other"));
    db.blocks.set(storeBlock, {
      id: storeBlock,
      store_id: STORE,
      item_kind: "store",
      item_id: STORE,
      object_path: null,
      object_md5: null,
      parent_block_id: null,
      tell_store: false,
      storage_state: "none",
      storage_attempts: 0,
      storage_next_attempt_at: null,
      storage_claimed_at: null,
      storage_error: "",
      blocked_at: START,
      merchant_notified_at: null,
      notice_claimed_at: null,
      lifted_at: null,
    });
    const archiveId = id();
    db.archives.set(archiveId, {
      id: archiveId,
      block_id: storeBlock,
      files: [
        {
          n: 0,
          state: "copied",
          source: "bucket",
          path: "content",
          at: iso(START),
        },
        pendingEntry(1, mine, { source: "private" }),
        pendingEntry(2, other, { source: "private" }),
      ],
      files_state: "pending",
      files_attempts: 0,
      files_next_attempt_at: START - 1,
      files_claimed_at: null,
      files_error: "",
    });
    await run();
    expect(entryOf(archiveId, 1)!.state).toBe("copied");
    expect(entryOf(archiveId, 1)!.source).toBe("private");
    expect(entryOf(archiveId, 2)!.state).toBe("recorded");
    expect(storage.copies).toEqual([mine]);
    // The content file at n = 0 is left as it was.
    expect(db.archives.get(archiveId)!.files[0]).toEqual({
      n: 0,
      state: "copied",
      source: "bucket",
      path: "content",
      at: iso(START),
    });
    expect(db.archives.get(archiveId)!.files_state).toBe("copied");
  });

  it("gives up after 24 hours of failures", async () => {
    const block = fileBlock({ archiveAttempts: 28 });
    storage.brokenPaths.add(block.path);
    const result = await run();
    expect(result.archivesFailed).toBe(1);
    expect(db.archives.get(block.archiveId)!.files_state).toBe("failed");
    expect(
      eventsOf("archive_files_failed", block.blockId)[0].detail,
    ).toMatchObject({
      reason: "gave_up",
    });
  });
});

describe("restores", () => {
  async function replacedThenLifted() {
    const block = fileBlock();
    const original = Buffer.from(
      storage.get("public", block.path)!.bytes,
    ).toString();
    await run();
    expect(db.blocks.get(block.blockId)!.storage_state).toBe("replaced");
    // The lift (block.ts) whose inline restore did not finish.
    const row = db.blocks.get(block.blockId)!;
    row.lifted_at = db.clock;
    row.storage_state = "restoring";
    row.storage_claimed_at = null;
    row.storage_next_attempt_at = db.clock;
    return { ...block, original };
  }

  it("puts the original back", async () => {
    const block = await replacedThenLifted();
    const result = await run();
    expect(result.restored).toBe(1);
    expect(db.blocks.get(block.blockId)!.storage_state).toBe("restored");
    expect(
      Buffer.from(storage.get("public", block.path)!.bytes).toString(),
    ).toBe(block.original);
    expect(eventsOf("storage_restored", block.blockId)).toHaveLength(1);
  });

  it("keeps trying through a storage outage and is never failed", async () => {
    const block = await replacedThenLifted();
    storage.brokenPaths.add(block.path);
    const result = await run();
    expect(result.restoreRetrying).toBe(1);
    const row = db.blocks.get(block.blockId)!;
    expect(row.storage_state).toBe("restoring");
    expect(row.storage_next_attempt_at).toBeGreaterThan(db.clock);
  });
});

describe("complaint alerts", () => {
  it("records the stage and the event, and logs the warning", async () => {
    const complaint = overdueComplaint();
    await run();
    expect(db.complaints.get(complaint)!.alerts).toHaveProperty(
      "acknowledge_overdue",
    );
    expect(db.complaints.get(complaint)!.alert_claimed_at).toBeNull();
    expect(
      h.events.find((e) => e.action === "complaint_alerted"),
    ).toMatchObject({
      actor: "system",
      complaintId: complaint,
      storeId: STORE,
      detail: {
        stage: "acknowledge",
        phase: "overdue",
        key: "acknowledge_overdue",
      },
    });
    expect(logWarn).toHaveBeenCalledWith(
      "moderation: complaint due",
      expect.objectContaining({ kind: "court_order", stage: "acknowledge" }),
    );
    // Once: the next run has nothing to say.
    await run();
    expect(notifyComplaintDue).toHaveBeenCalledTimes(1);
  });

  it("tells them again once the claim lapses when the event was not recorded", async () => {
    const complaint = overdueComplaint();
    h.notifyWorks = false;
    const first = await run();
    expect(first.alertsWaiting).toBe(1);
    expect(db.complaints.get(complaint)!.alerts).toEqual({});
    await run();
    expect(notifyComplaintDue).toHaveBeenCalledTimes(1);
    h.notifyWorks = true;
    db.clock += 2 * MINUTE + 1;
    await run();
    expect(notifyComplaintDue).toHaveBeenCalledTimes(2);
    expect(db.complaints.get(complaint)!.alerts).toHaveProperty(
      "acknowledge_overdue",
    );
  });
});

describe("notice emails", () => {
  it("sends the email only when an earlier try already rang the bell", async () => {
    const rang = noticeBlock();
    const silent = noticeBlock();
    h.events.push(
      {
        actor: "system",
        action: "merchant_notify_failed",
        blockId: rang,
        detail: { bell: true },
        at: START - HOUR,
      },
      {
        actor: "system",
        action: "merchant_notify_failed",
        blockId: silent,
        detail: { bell: false },
        at: START - HOUR,
      },
    );
    await run();
    expect(deliverBlockNotice).toHaveBeenCalledWith(rang, "system", {
      bell: false,
    });
    expect(deliverBlockNotice).toHaveBeenCalledWith(silent, "system", {
      bell: true,
    });
  });

  it("waits longer after each failure, and stops after 24 hours", async () => {
    const recent = noticeBlock();
    for (let i = 0; i < 3; i += 1) {
      h.events.push({
        actor: "system",
        action: "merchant_notify_failed",
        blockId: recent,
        detail: { bell: true },
        at: START - 2 * MINUTE,
      });
    }
    const old = noticeBlock(START - 25 * HOUR);
    await run();
    expect(sends).toEqual([]);
    db.clock += 3 * MINUTE;
    await run();
    expect(sends.map((s) => s.blockId)).toEqual([recent]);
    expect(sends.map((s) => s.blockId)).not.toContain(old);
  });
});

describe("isolation and the heartbeat", () => {
  it("logs a throwing step and still runs the steps after it", async () => {
    db.failOn = "update public.content_block_archives a";
    const notice = noticeBlock();
    const result = await run();
    expect(result.failedSteps).toEqual(["archives"]);
    expect(logError).toHaveBeenCalledWith(
      "moderation: follow-up failed",
      expect.any(Error),
      { step: "archives" },
    );
    expect(sends.map((s) => s.blockId)).toEqual([notice]);
    expect(
      db.statements.some((s) => s.includes("x.storage_state = 'restoring'")),
    ).toBe(true);
  });

  it("logs a throwing row and still handles the rows after it", async () => {
    const first = noticeBlock(START - 2 * MINUTE);
    const second = noticeBlock(START - MINUTE);
    vi.mocked(deliverBlockNotice).mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const result = await run();
    expect(result.failedSteps).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "moderation: follow-up failed",
      expect.any(Error),
      { step: "notices", blockId: first },
    );
    expect(sends.map((s) => s.blockId)).toEqual([second]);
    expect(result.noticesSent).toBe(1);
  });

  it("logs the heartbeat on every run", async () => {
    fileBlock();
    await run();
    expect(logInfo).toHaveBeenCalledWith(
      "moderation: follow-ups ran",
      expect.objectContaining({ replaced: 1, ms: expect.any(Number) }),
    );
  });

  it("logs the heartbeat even when the run itself breaks", async () => {
    await expect(
      runModerationFollowUps({
        storage,
        clock: () => {
          throw new Error("the clock broke");
        },
      }),
    ).rejects.toThrow("the clock broke");
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(
      "moderation: follow-ups ran",
      expect.objectContaining({ ms: expect.any(Number) }),
    );
  });
});

describe("bounds", () => {
  it("claims at most 20 rows a step", async () => {
    for (let i = 0; i < 25; i += 1) overdueComplaint();
    const result = await run();
    expect(result.alertsSent).toBe(FOLLOW_UP_LIMITS.rowsPerStep);
    expect(notifyComplaintDue).toHaveBeenCalledTimes(20);
  });

  it("copies at most 50 files a run and leaves the rest due at once", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => {
      const path = `stores/${STORE}/uploads/many-${i}.webp`;
      storage.put("public", path, bytesOf(`file ${i}`));
      return pendingEntry(i + 1, path);
    });
    const block = fileBlock({ entries, nextAt: START + HOUR });
    const result = await run();
    expect(result.filesSettled).toBe(FOLLOW_UP_LIMITS.filesPerRun);
    const archive = db.archives.get(block.archiveId)!;
    expect(archive.files_state).toBe("pending");
    expect(archive.files_attempts).toBe(0);
    expect(archive.files_next_attempt_at).toBeLessThanOrEqual(db.clock);
    expect(
      archive.files.filter(
        (entry) => (entry as { state: string }).state === "pending",
      ),
    ).toHaveLength(10);
  });

  it("starts nothing past its deadline", async () => {
    overdueComplaint();
    fileBlock();
    noticeBlock();
    const result = await run({ deadline: Date.now() + 1_000 });
    expect(result.outOfTime).toBe(true);
    expect(db.statements).toEqual([]);
    expect(logInfo).toHaveBeenCalledWith(
      "moderation: follow-ups ran",
      expect.objectContaining({ outOfTime: true }),
    );
  });

  it("gives back what it claimed and could not start", async () => {
    const block = fileBlock();
    // Time for the alert step and the archive claim, then none.
    let late = false;
    db.onStatement = (text) => {
      if (text.includes("update public.content_block_archives a")) late = true;
    };
    const result = await run({ clock: () => (late ? 1_000_000 : 0) });
    expect(result.outOfTime).toBe(true);
    const archive = db.archives.get(block.archiveId)!;
    expect(archive.files_claimed_at).toBeNull();
    expect(archive.files_attempts).toBe(0);
    expect(storage.copies).toEqual([]);
  });
});
