// The temporary legacy move (design next-release/storage.md 5.10, 9.1): the
// guard, the candidates' backoff, the record upsert, and every outcome of the
// per-picture steps, with storage and the database as recorders. The compiled
// statements are what is pinned, the shape conversation-retention.test.ts uses.

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { withService } from "@/lib/db/client";
import { storefrontImageUsage } from "@/lib/media/image-usage";
import { productImageUsage } from "@/lib/media/product-images";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  MINK_LEGACY_BATCH_SIZE,
  MINK_LEGACY_DATABASES,
  MINK_LEGACY_GIVE_UP_AFTER,
  MINK_LEGACY_PICTURE_RESERVE_MS,
  MINK_LEGACY_RETRY_AFTER_HOURS,
  legacyCandidatesSql,
  legacyChatLiveSql,
  legacyChatsSql,
  legacyLiveProposalSql,
  legacyLogSql,
  legacyMoveAllowed,
  legacyProgressSql,
  legacyStoreUsageSql,
  moveLegacyMinkAttachments,
  type MinkLegacyBatch,
  type MinkLegacyCandidate,
} from "./attachments-legacy";

interface ObjectFacts {
  size: number;
  contentType: string;
  md5: string | null;
}

/** Storage as a recorder; the implementations are set per test. */
const gcs = vi.hoisted(() => ({
  privateConfigured: true,
  copy: vi.fn<
    (
      fromKind: string,
      fromPath: string,
      toKind: string,
      toPath: string,
    ) => Promise<void>
  >(),
  metadata:
    vi.fn<(kind: string, path: string) => Promise<ObjectFacts | null>>(),
  deletePaths: vi.fn<(paths: string[], kind?: string) => Promise<string[]>>(),
}));

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/storage/gcs", () => ({
  get gcsPrivateConfigured() {
    return gcs.privateConfigured;
  },
  gcsCopyObject: (...args: Parameters<typeof gcs.copy>) => gcs.copy(...args),
  gcsObjectMetadata: (...args: Parameters<typeof gcs.metadata>) =>
    gcs.metadata(...args),
  gcsDeletePaths: (...args: Parameters<typeof gcs.deletePaths>) =>
    gcs.deletePaths(...args),
  // What lib/mink/attachments.ts imports and this job never calls.
  gcsDownloadObject: vi.fn(),
  gcsPrivateUploadObject: vi.fn(),
  gcsPublicUrl: vi.fn((path: string) => `https://media.test/${path}`),
  gcsUploadObject: vi.fn(),
}));
vi.mock("@/lib/storage/process-image", () => ({
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  processImageUpload: vi.fn(),
}));
vi.mock("@/lib/media/product-images", () => ({
  productImageUsage: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/media/image-usage", () => ({
  storefrontImageUsage: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const FLOOR = "2026-10-26T03:00:00.000Z";
const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_STORE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHAT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECOND_CHAT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ADMIN = "owner-uid";
const SIZE = 5242;
const MD5 = "legacy-md5==";
const FIVE_MB = 5 * 1024 * 1024;

/** A candidate; one with attempts has a record, as the candidates read says. */
function picture(
  n: number,
  over: Partial<MinkLegacyCandidate> = {},
): MinkLegacyCandidate {
  const id = `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const path = `stores/${STORE}/media/${n}.webp`;
  const attempts = over.attempts ?? 0;
  return {
    id,
    store_id: STORE,
    url: `https://storage.googleapis.com/bucket/${path}`,
    path,
    filename: `photo-${n}.webp`,
    content_type: "image/webp",
    size_bytes: SIZE,
    attempts,
    recorded: attempts > 0,
    ...over,
  };
}

const privatePathOf = (p: MinkLegacyCandidate, ext = "webp") =>
  `stores/${p.store_id}/mink-attachments/storemink/${p.id}.${ext}`;
const newUrlOf = (p: MinkLegacyCandidate) => `/api/mink/attachments/${p.id}`;
const liveChat = (conversation_id = CHAT) => ({
  conversation_id,
  admin_id: ADMIN,
  live: true,
});

const compiled = (query: unknown) =>
  new PgDialect()
    .sqlToQuery(query as SQL)
    .sql.replace(/\s+/g, " ")
    .trim();
const paramsOf = (query: unknown) =>
  new PgDialect().sqlToQuery(query as SQL).params;

/** Which statement a compiled text is, by its opening. */
const LABELS: [string, string][] = [
  ["select m.id, m.store_id, m.url", "candidates"],
  ["select count(*)::int as left", "progress"],
  ["insert into public.mink_attachment_legacy_log", "log"],
  ["update public.media_assets set source = 'upload'", "keep"],
  ["delete from public.media_assets", "remove"],
  ["select (exists (select 1 from public.blogs", "usage"],
  ["select exists ( select 1 from public.mink_drafts", "proposal"],
  ["select distinct m.conversation_id", "chats"],
  ["select pg_try_advisory_xact_lock", "lock"],
  ["select c.admin_id, exists (", "live"],
  ["insert into public.mink_attachments", "link"],
  ["update public.mink_messages", "messages"],
  ["update public.mink_conversations set summary_json", "summary"],
  ["select a.id from public.mink_attachments", "row"],
];
function labelOf(text: string): string {
  return LABELS.find(([prefix]) => text.startsWith(prefix))?.[1] ?? "other";
}

type Statement = { label: string; text: string; params: unknown[] };
type Answer = (label: string, params: unknown[]) => unknown[] | Error;

/** Everything that happened, storage and database alike, in order. */
let events: string[] = [];
/** Storage: what exists, what was copied, what was deleted, what refuses. */
let objects: Map<string, ObjectFacts>;
let copies: string[];
let deleted: string[];
let failDelete: Set<string>;
let corruptCopy: boolean;

/**
 * A database per `withService` scope that records compiled statements and
 * answers by statement. Scopes run one after the other.
 */
function databaseAnswering(answer: Answer) {
  const scopes: Statement[][] = [];
  vi.mocked(withService).mockImplementation(async (fn) => {
    const statements: Statement[] = [];
    scopes.push(statements);
    const db = {
      execute: vi.fn(async (query: SQL) => {
        const text = compiled(query);
        const params = paramsOf(query);
        const label = labelOf(text);
        statements.push({ label, text, params });
        events.push(label);
        const rows = answer(label, params);
        if (rows instanceof Error) throw rows;
        return { rows };
      }),
    };
    return fn(db as unknown as Db);
  });
  return scopes;
}

interface Scenario {
  candidates: MinkLegacyCandidate[];
  used?: boolean;
  /** The usage read's proposal answer. */
  proposal?: boolean;
  /** The proposal answer re-read under the chat's lock. */
  lateProposal?: boolean;
  chats?: {
    conversation_id: string;
    admin_id: string;
    live: boolean;
    running?: boolean;
  }[];
  locked?: boolean;
  chatLive?: boolean;
  /** A reply running in the chat, seen under the lock. */
  replyRunning?: boolean;
  hasRow?: boolean;
  /** The media change touched no row (another run or a delete took it). */
  gone?: boolean;
  progress?: { left: number; given_up: number; held?: number };
  /** The statement label that throws. */
  throwOn?: string;
}

function scenario(s: Scenario) {
  let proposals = 0;
  return databaseAnswering((label, params) => {
    if (s.throwOn === label) return new Error(`${label} failed`);
    switch (label) {
      case "candidates":
        return s.candidates;
      case "progress":
        return [s.progress ?? { left: 0, given_up: 0 }];
      case "log":
        return [{ attempts: 1, outcome: params[3] }];
      case "keep":
      case "remove":
        return s.gone ? [] : [{ id: params[0] }];
      case "usage":
        return [{ used: s.used ?? false }];
      case "proposal":
        proposals += 1;
        return [
          {
            live_proposal:
              proposals === 1
                ? (s.proposal ?? false)
                : (s.lateProposal ?? false),
          },
        ];
      case "chats":
        return (s.chats ?? []).map((chat) => ({ running: false, ...chat }));
      case "lock":
        return [{ locked: s.locked ?? true }];
      case "live":
        return (s.chatLive ?? true)
          ? [{ admin_id: ADMIN, running: s.replyRunning ?? false }]
          : [];
      case "row":
        return s.hasRow ? [{ id: params[1] }] : [];
      default:
        return [];
    }
  });
}

function seed(p: MinkLegacyCandidate, over: Partial<ObjectFacts> = {}) {
  objects.set(`public:${p.path}`, {
    size: SIZE,
    contentType: p.content_type,
    md5: MD5,
    ...over,
  });
}

/** A private copy an earlier night left at the picture's private path. */
function seedLeftover(p: MinkLegacyCandidate) {
  objects.set(`private:${privatePathOf(p)}`, {
    size: SIZE,
    contentType: p.content_type,
    md5: MD5,
  });
}

/** Whether a record statement counts an attempt (`+ 1`) or is a wait (`+ 0`). */
const counts = (statement: Statement) =>
  statement.text.includes("attempts = l.attempts + 1");

/** The record statement's outcome and reason, from its parameters. */
const recorded = (statement: Statement) => ({
  id: statement.params[0],
  path: statement.params[2],
  outcome: statement.params[3],
  reason: statement.params[4],
});

const batchLine = () =>
  vi
    .mocked(logInfo)
    .mock.calls.find(
      ([message]) => message === "mink.attachments: legacy batch",
    )
    ?.at(1);

beforeEach(() => {
  vi.stubEnv("DB_NAME", "storemink");
  events = [];
  objects = new Map();
  copies = [];
  deleted = [];
  failDelete = new Set();
  corruptCopy = false;
  gcs.privateConfigured = true;
  gcs.copy.mockImplementation(async (fromKind, fromPath, toKind, toPath) => {
    events.push("copy");
    copies.push(toPath);
    const source = objects.get(`${fromKind}:${fromPath}`);
    if (!source) throw new Error("source missing");
    objects.set(
      `${toKind}:${toPath}`,
      corruptCopy ? { ...source, size: source.size + 1 } : { ...source },
    );
  });
  gcs.metadata.mockImplementation(async (kind, path) => {
    events.push(`read:${kind}`);
    return objects.get(`${kind}:${path}`) ?? null;
  });
  gcs.deletePaths.mockImplementation(async (paths, kind = "public") => {
    events.push(`delete:${kind}`);
    deleted.push(...paths.map((path) => `${kind}:${path}`));
    for (const path of paths) {
      if (!failDelete.has(path)) objects.delete(`${kind}:${path}`);
    }
    return paths.filter((path) => failDelete.has(path));
  });
  vi.mocked(productImageUsage).mockResolvedValue(new Map());
  vi.mocked(storefrontImageUsage).mockResolvedValue({
    redesignInProgress: false,
    redesignCard: false,
    pages: [],
    categories: [],
    headerFooter: false,
  } as Awaited<ReturnType<typeof storefrontImageUsage>>);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the guard", () => {
  it("★ runs only against the two real databases, says so once and touches nothing", async () => {
    vi.stubEnv("DB_NAME", "storemink_local");
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(0);
    expect(withService).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "mink.attachments: legacy move skipped",
      { database: "storemink_local", reason: "database" },
    );
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("★ and only with a private bucket configured", async () => {
    gcs.privateConfigured = false;
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(0);
    expect(withService).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      "mink.attachments: legacy move skipped",
      { database: "storemink", reason: "no_private_bucket" },
    );
  });

  it("names exactly storemink and storemink_staging", () => {
    expect([...MINK_LEGACY_DATABASES]).toEqual([
      "storemink",
      "storemink_staging",
    ]);
    expect(legacyMoveAllowed("storemink")).toBe(true);
    expect(legacyMoveAllowed("storemink_staging")).toBe(true);
    expect(legacyMoveAllowed("storemink_local")).toBe(false);
    expect(legacyMoveAllowed("default")).toBe(false);
    expect(MINK_LEGACY_BATCH_SIZE).toBe(25);
  });
});

describe("the statements", () => {
  it("★ the candidates: public attachment rows before the floor, with no record or a failing one past its 20-hour backoff under four attempts, oldest first", () => {
    const query = legacyCandidatesSql(FLOOR, 25);
    const text = compiled(query);
    expect(text).toContain(
      "coalesce(l.attempts, 0)::int as attempts, (l.media_asset_id is not null) as recorded from public.media_assets m left join public.mink_attachment_legacy_log l on l.media_asset_id = m.id",
    );
    expect(text).toContain("where m.source = 'mink_attachment'");
    expect(text).toContain("and m.created_at < $1::timestamptz");
    expect(text).toContain(
      "and (l.media_asset_id is null or (l.outcome = 'failing' and l.attempts < 4 and l.last_attempt_at < now() - make_interval(hours => 20)))",
    );
    expect(text).toContain("order by m.created_at, m.id limit $2");
    expect(paramsOf(query)).toEqual([FLOOR, 25]);
    expect(MINK_LEGACY_GIVE_UP_AFTER).toBe(3);
    expect(MINK_LEGACY_RETRY_AFTER_HOURS).toBe(20);
    // ★ D10: a store under an active legal hold is left out, right after
    //   the record arm (design 14.1 point 3, takedown plan A6).
    expect(text).toContain(
      "and l.last_attempt_at < now() - make_interval(hours => 20))) and not exists (select 1 from public.store_legal_holds h where h.store_id = m.store_id and h.released_at is null) order by m.created_at, m.id limit $2",
    );
    expect(text.split("store_legal_holds")).toHaveLength(2);
  });

  it("★ the record: a failure counts an attempt and stays failing; a decision sets decided_at; a decided row is never reopened", () => {
    const failing = legacyLogSql({
      mediaAssetId: "m1",
      storeId: STORE,
      publicPath: "stores/s/media/a.webp",
      outcome: "failing",
      reason: "copy_failed",
    });
    const text = compiled(failing);
    expect(text).toContain(
      "insert into public.mink_attachment_legacy_log as l (media_asset_id, store_id, public_path, outcome, reason, attempts, last_attempt_at, decided_at) values ($1, $2, $3, $4, $5, 1, now(), null)",
    );
    expect(text).toContain(
      "on conflict (media_asset_id) do update set outcome = excluded.outcome, reason = excluded.reason, attempts = l.attempts + 1, last_attempt_at = now(), decided_at = excluded.decided_at where l.outcome = 'failing'",
    );
    expect(paramsOf(failing)).toEqual([
      "m1",
      STORE,
      "stores/s/media/a.webp",
      "failing",
      "copy_failed",
    ]);
    const decided = legacyLogSql({
      mediaAssetId: "m1",
      storeId: STORE,
      publicPath: "stores/s/media/a.webp",
      outcome: "kept",
      reason: "in_use",
    });
    expect(compiled(decided)).toContain(
      "values ($1, $2, $3, $4, $5, 1, now(), now())",
    );
  });

  it("★ a wait that is not a failure: a failing record that sets the backoff without counting an attempt; a decision always counts", () => {
    const wait = legacyLogSql({
      mediaAssetId: "m1",
      storeId: STORE,
      publicPath: "stores/s/media/a.webp",
      outcome: "failing",
      reason: "chat_busy",
      countsAttempt: false,
    });
    const text = compiled(wait);
    expect(text).toContain("values ($1, $2, $3, $4, $5, 0, now(), null)");
    expect(text).toContain(
      "attempts = l.attempts + 0, last_attempt_at = now(), decided_at = excluded.decided_at where l.outcome = 'failing'",
    );
    const decided = legacyLogSql({
      mediaAssetId: "m1",
      storeId: STORE,
      publicPath: "stores/s/media/a.webp",
      outcome: "kept",
      reason: "in_use",
      countsAttempt: false,
    });
    expect(compiled(decided)).toContain("attempts = l.attempts + 1");
  });

  it("★ R11: the candidates leave out what the run set aside, as one array parameter", () => {
    const skip = [picture(1).id, picture(2).id];
    const query = legacyCandidatesSql(FLOOR, 25, skip);
    const text = compiled(query);
    expect(text).toContain(
      "and l.last_attempt_at < now() - make_interval(hours => 20))) and not exists (select 1 from public.store_legal_holds h where h.store_id = m.store_id and h.released_at is null) and not (m.id = any($2::uuid[])) order by m.created_at, m.id limit $3",
    );
    expect(paramsOf(query)).toEqual([FLOOR, skip, 25]);
    // Nothing set aside: the statement is the one without the clause.
    expect(compiled(legacyCandidatesSql(FLOOR, 25, []))).toBe(
      compiled(legacyCandidatesSql(FLOOR, 25)),
    );
    expect(compiled(legacyCandidatesSql(FLOOR, 25))).not.toContain("any(");
  });

  it("★ S13: the store usage read searches the object PATH, product descriptions and the notification templates", () => {
    const path = `stores/${STORE}/media/x.webp`;
    const query = legacyStoreUsageSql(STORE, path);
    const text = compiled(query);
    expect(text).toContain(
      "strpos(coalesce(b.cover_image_url, '') || ' ' || coalesce(b.content, ''), $2) > 0",
    );
    expect(text).toContain(
      "select 1 from public.store_billing_settings bs where bs.store_id = $9 and strpos(coalesce(bs.logo_url, ''), $10) > 0",
    );
    expect(text).toContain(
      "select 1 from public.products p where p.store_id = $11 and strpos(coalesce(p.description, ''), $12) > 0",
    );
    expect(text).toContain(
      "select 1 from public.notification_settings ns where ns.store_id = $13 and strpos(ns.templates::text, $14) > 0",
    );
    // No exact-URL comparison is left: a URL with a query string or another
    // host form still contains the path.
    expect(text).not.toContain("btrim(");
    expect(paramsOf(query)).toEqual([
      STORE,
      path,
      STORE,
      path,
      STORE,
      path,
      STORE,
      path,
      STORE,
      path,
      STORE,
      path,
      STORE,
      path,
    ]);
    expect(compiled(legacyLiveProposalSql(STORE, path))).toContain(
      "strpos(d.content_json::text, $2) > 0",
    );
  });

  it("★ R6: the chats read and the re-read under the lock both say whether a reply is running", () => {
    const running =
      "exists ( select 1 from public.mink_runs r where r.store_id = c.store_id and r.conversation_id = c.id and r.status = 'running') as running";
    expect(compiled(legacyChatsSql(STORE, "u"))).toContain(
      `(c.status = 'active' and c.expires_at > now()) as live, ${running} from public.mink_messages m`,
    );
    const live = compiled(legacyChatLiveSql(STORE, CHAT));
    expect(live).toContain(`select c.admin_id, ${running} from`);
    expect(live).toContain(
      "where c.id = $1 and c.store_id = $2 and c.status = 'active' and c.expires_at > now()",
    );
  });
});

describe("the per-picture steps", () => {
  it("★ in use by a product keeps the picture as an upload, in one transaction with its record, with no copy", async () => {
    const p = picture(1);
    seed(p);
    vi.mocked(productImageUsage).mockResolvedValue(
      new Map([
        [p.url, [{ id: "prod", name: "Shake", slug: "shake" }]],
      ]) as never,
    );
    const scopes = scenario({ candidates: [p] });

    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).toEqual([
      "candidates",
      "read:public",
      "keep",
      "log",
      "progress",
    ]);
    expect(scopes[1].map((s) => s.label)).toEqual(["keep", "log"]);
    expect(scopes[1][0].params).toEqual([p.id]);
    expect(recorded(scopes[1][1])).toEqual({
      id: p.id,
      path: p.path,
      outcome: "kept",
      reason: "in_use",
    });
    expect(copies).toEqual([]);
    expect(deleted).toEqual([]);
    expect(batchLine()).toMatchObject({ kept: 1, moved: 0, deleted: 0 });
  });

  it("★ in use by a page or the store's settings keeps it too, and the usage reads come before any chat read", async () => {
    const shown = picture(2);
    seed(shown);
    vi.mocked(storefrontImageUsage).mockResolvedValueOnce({
      redesignInProgress: false,
      redesignCard: false,
      pages: ["Home"],
      categories: [],
      headerFooter: false,
    } as Awaited<ReturnType<typeof storefrontImageUsage>>);
    const settings = picture(3);
    seed(settings);
    const scopes = databaseAnswering((label, params) => {
      switch (label) {
        case "candidates":
          return [shown, settings];
        case "usage":
          return [{ used: params[1] === settings.path }];
        case "proposal":
          return [{ live_proposal: false }];
        case "keep":
        case "remove":
          return [{ id: params[0] }];
        case "log":
          return [{ attempts: 1 }];
        case "progress":
          return [{ left: 0, given_up: 0 }];
        default:
          return [];
      }
    });

    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(2);
    expect(events).toEqual([
      "candidates",
      "read:public",
      "keep",
      "log",
      "read:public",
      "usage",
      "proposal",
      "keep",
      "log",
      "progress",
    ]);
    expect(recorded(scopes[1][1])).toMatchObject({
      id: shown.id,
      reason: "in_use",
    });
    expect(recorded(scopes[3][1])).toMatchObject({
      id: settings.id,
      reason: "in_use",
    });
    expect(copies).toEqual([]);
  });

  it("★ a proposal that can still be approved keeps it (live_proposal)", async () => {
    const p = picture(4);
    seed(p);
    const scopes = scenario({ candidates: [p], proposal: true });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).not.toContain("chats");
    expect(recorded(scopes[2][1])).toMatchObject({
      outcome: "kept",
      reason: "live_proposal",
    });
    // Seven surfaces, each scoped to the store and searched by the path.
    expect(scopes[1].map((s) => s.params)).toEqual([
      [
        STORE,
        p.path,
        STORE,
        p.path,
        STORE,
        p.path,
        STORE,
        p.path,
        STORE,
        p.path,
        STORE,
        p.path,
        STORE,
        p.path,
      ],
      [STORE, p.path],
    ]);
    expect(scopes[1][1].text).toContain(
      "where d.store_id = $1 and c.status = 'active' and c.expires_at > now() and strpos(d.content_json::text, $2) > 0",
    );
    expect(scopes[1][1].text).toContain(
      "and (a.status <> 'pending' or a.expires_at <= now())",
    );
  });

  it("★ exactly one live chat: the start recorded, copied, checked by size and MD5, linked under the chat's lock with the messages rewritten, then the public file goes, then the row", async () => {
    const p = picture(5);
    seed(p);
    const scopes = scenario({ candidates: [p], chats: [liveChat()] });

    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).toEqual([
      "candidates",
      "read:public",
      "usage",
      "proposal",
      "chats",
      "log",
      "copy",
      "read:private",
      "lock",
      "live",
      "proposal",
      "link",
      "messages",
      "summary",
      "delete:public",
      "remove",
      "log",
      "progress",
    ]);
    // ★ R8: the move's start is recorded before the copy, as a wait that
    //   counts no attempt, so a run that dies after the copy leaves a record.
    expect(recorded(scopes[3][0])).toEqual({
      id: p.id,
      path: p.path,
      outcome: "failing",
      reason: "copy_failed",
    });
    expect(counts(scopes[3][0])).toBe(false);
    expect(copies).toEqual([privatePathOf(p)]);
    const link = scopes[4];
    expect(link.map((s) => s.label)).toEqual([
      "lock",
      "live",
      "proposal",
      "link",
      "messages",
      "summary",
    ]);
    expect(link[0].text).toBe(
      "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked",
    );
    expect(link[0].params).toEqual([`mink-conversation:${CHAT}`]);
    expect(link[1].text).toContain(
      "where c.id = $1 and c.store_id = $2 and c.status = 'active' and c.expires_at > now()",
    );
    // ★ S7: the proposals naming the picture, re-read under the lock.
    expect(link[2].params).toEqual([STORE, p.path]);
    expect(link[3].text).toContain("on conflict (id) do nothing");
    expect(link[3].text).toContain("left($6, 160)");
    expect(link[3].params).toEqual([
      p.id,
      STORE,
      ADMIN,
      CHAT,
      privatePathOf(p),
      p.filename,
      "image/webp",
      SIZE,
    ]);
    expect(link[4].text).toContain(
      "jsonb_set(content_json, '{text}', to_jsonb(replace(content_json ->> 'text', $1, $2)))",
    );
    expect(link[4].params).toEqual([p.url, newUrlOf(p), STORE, CHAT, p.url]);
    expect(link[5].text).toContain(
      "set summary_json = replace(summary_json::text, $1, $2)::jsonb",
    );
    expect(link[5].params).toEqual([p.url, newUrlOf(p), CHAT, STORE, p.url]);
    expect(deleted).toEqual([`public:${p.path}`]);
    expect(scopes[5].map((s) => s.label)).toEqual(["remove", "log"]);
    expect(recorded(scopes[5][1])).toEqual({
      id: p.id,
      path: p.path,
      outcome: "moved",
      reason: "moved_with_chat",
    });
    expect(counts(scopes[5][1])).toBe(true);
    expect(batchLine()).toMatchObject({ moved: 1 });
  });

  it("★ given up after three failed nights: kept as an upload, with no public read; the private path is only looked at for a leftover", async () => {
    const p = picture(6, { attempts: 3 });
    seed(p);
    const scopes = scenario({ candidates: [p] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).toEqual([
      "candidates",
      "row",
      "read:private",
      "keep",
      "log",
      "progress",
    ]);
    expect(recorded(scopes[2][1])).toMatchObject({
      outcome: "kept",
      reason: "gave_up",
    });
    expect(deleted).toEqual([]);
  });

  it("★ a public object that is gone: the row goes, recorded missing, nothing copied or deleted", async () => {
    const p = picture(7);
    const scopes = scenario({ candidates: [p] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).toEqual([
      "candidates",
      "read:public",
      "remove",
      "log",
      "progress",
    ]);
    expect(scopes[1][0].params).toEqual([p.id]);
    expect(recorded(scopes[1][1])).toMatchObject({
      outcome: "missing",
      reason: "object_missing",
    });
    expect(batchLine()).toMatchObject({ missing: 1 });
  });

  it("★ a copy whose size differs keeps the public file, discards the copy (no private row holds the id) and records copy_mismatch", async () => {
    const p = picture(8);
    seed(p);
    corruptCopy = true;
    const scopes = scenario({ candidates: [p], chats: [liveChat()] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).toEqual([
      "candidates",
      "read:public",
      "usage",
      "proposal",
      "chats",
      "log",
      "copy",
      "read:private",
      "row",
      "delete:private",
      "log",
      "progress",
    ]);
    expect(deleted).toEqual([`private:${privatePathOf(p)}`]);
    expect(recorded(scopes[5][0])).toMatchObject({
      outcome: "failing",
      reason: "copy_mismatch",
    });
    expect(counts(scopes[5][0])).toBe(true);
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: legacy picture failed",
      expect.anything(),
      expect.objectContaining({ mediaAssetId: p.id, reason: "copy_mismatch" }),
    );
    expect(batchLine()).toMatchObject({ failed: 1, moved: 0 });
  });

  it("★ a copy whose MD5 the bucket does not report is never trusted", async () => {
    const p = picture(9);
    seed(p, { md5: null });
    const scopes = scenario({ candidates: [p], chats: [liveChat()] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).not.toContain("lock");
    expect(recorded(scopes[5][0])).toMatchObject({ reason: "copy_mismatch" });
  });

  it("★ two live chats keep it as an upload, with no copy", async () => {
    const p = picture(10);
    seed(p);
    const scopes = scenario({
      candidates: [p],
      chats: [liveChat(), liveChat(SECOND_CHAT)],
    });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).not.toContain("copy");
    expect(recorded(scopes[3][1])).toMatchObject({
      outcome: "kept",
      reason: "several_chats",
    });
  });

  it("★ a type the private store does not take, or a size outside 1 to 5 MB, is kept rather than moved", async () => {
    const pdf = picture(11, { content_type: "application/pdf" });
    seed(pdf);
    const empty = picture(12);
    seed(empty, { size: 0 });
    const big = picture(13);
    seed(big, { size: FIVE_MB + 1 });
    const scopes = scenario({
      candidates: [pdf, empty, big],
      chats: [liveChat()],
    });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(3);
    expect(events).not.toContain("copy");
    const records = scopes
      .flat()
      .filter((s) => s.label === "log")
      .map(recorded);
    expect(records).toEqual([
      expect.objectContaining({ id: pdf.id, reason: "not_movable" }),
      expect.objectContaining({ id: empty.id, reason: "not_movable" }),
      expect.objectContaining({ id: big.id, reason: "not_movable" }),
    ]);
  });

  it("★ a picture exactly 5 MB is still moved", async () => {
    const p = picture(14);
    seed(p, { size: FIVE_MB });
    scenario({ candidates: [p], chats: [liveChat()] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).toContain("link");
  });

  it("★ no live chat: the public file goes, a private leftover goes only when no private row holds the id, then the row", async () => {
    const p = picture(15);
    seed(p);
    const scopes = scenario({
      candidates: [p],
      chats: [{ conversation_id: CHAT, admin_id: ADMIN, live: false }],
    });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).toEqual([
      "candidates",
      "read:public",
      "usage",
      "proposal",
      "chats",
      "delete:public",
      "row",
      "delete:private",
      "remove",
      "log",
      "progress",
    ]);
    expect(scopes[3][0].params).toEqual([p.id, STORE]);
    expect(deleted).toEqual([
      `public:${p.path}`,
      `private:${privatePathOf(p)}`,
    ]);
    expect(recorded(scopes[4][1])).toEqual({
      id: p.id,
      path: p.path,
      outcome: "deleted",
      reason: "no_live_use",
    });
    expect(batchLine()).toMatchObject({ deleted: 1 });
  });

  it("★ a private row with the id keeps the private object; a type with no private form asks nothing", async () => {
    const held = picture(16);
    seed(held);
    const pdf = picture(17, { content_type: "application/pdf" });
    seed(pdf);
    scenario({ candidates: [held, pdf], chats: [], hasRow: true });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(2);
    expect(events).toEqual([
      "candidates",
      "read:public",
      "usage",
      "proposal",
      "chats",
      "delete:public",
      "row",
      "remove",
      "log",
      "read:public",
      "usage",
      "proposal",
      "chats",
      "delete:public",
      "remove",
      "log",
      "progress",
    ]);
    expect(deleted).toEqual([`public:${held.path}`, `public:${pdf.path}`]);
  });
});

describe("every failure is recorded, counted and tried again the next night", () => {
  it("★ a storage read that throws: read_failed, nothing changed", async () => {
    const p = picture(20);
    gcs.metadata.mockRejectedValue(new Error("bucket unavailable"));
    const scopes = scenario({ candidates: [p] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(scopes.map((s) => s.map((x) => x.label))).toEqual([
      ["candidates"],
      ["log"],
      ["progress"],
    ]);
    expect(recorded(scopes[1][0])).toMatchObject({
      outcome: "failing",
      reason: "read_failed",
    });
    expect(batchLine()).toMatchObject({ failed: 1 });
  });

  it("★ a usage read that throws is read_failed too, never 'nothing uses it'", async () => {
    const p = picture(21);
    seed(p);
    vi.mocked(storefrontImageUsage).mockRejectedValue(new Error("down"));
    const scopes = scenario({ candidates: [p], chats: [liveChat()] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).not.toContain("chats");
    expect(events).not.toContain("copy");
    expect(recorded(scopes[1][0])).toMatchObject({ reason: "read_failed" });
  });

  it("★ C8: a copy that throws: its possible copy is discarded (no private row holds the id), copy_failed counted", async () => {
    const p = picture(22);
    seed(p);
    gcs.copy.mockRejectedValue(new Error("copy refused"));
    const scopes = scenario({ candidates: [p], chats: [liveChat()] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).not.toContain("lock");
    expect(events.slice(events.indexOf("chats"))).toEqual([
      "chats",
      "log",
      "row",
      "delete:private",
      "log",
      "progress",
    ]);
    expect(deleted).toEqual([`private:${privatePathOf(p)}`]);
    expect(recorded(scopes[5][0])).toMatchObject({ reason: "copy_failed" });
    expect(counts(scopes[5][0])).toBe(true);
  });

  it("★ C2: the copy is judged by `md5`, the shared helper's field", async () => {
    const p = picture(33);
    seed(p);
    gcs.metadata.mockImplementation(async (kind, path) => {
      events.push(`read:${kind}`);
      const found = objects.get(`${kind}:${path}`);
      // The old field name alone is not an MD5 the move trusts.
      return found && kind === "private"
        ? ({ ...found, md5: null, md5Hash: MD5 } as ObjectFacts)
        : (found ?? null);
    });
    const scopes = scenario({ candidates: [p], chats: [liveChat()] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).not.toContain("link");
    expect(recorded(scopes[5][0])).toMatchObject({ reason: "copy_mismatch" });
  });

  it("★ the chat's lock held elsewhere: the copy is discarded and the picture waits (chat_busy), a wait and not an error", async () => {
    const p = picture(23);
    seed(p);
    const scopes = scenario({
      candidates: [p],
      chats: [liveChat()],
      locked: false,
    });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(scopes[4].map((s) => s.label)).toEqual(["lock"]);
    expect(events.slice(events.indexOf("lock"))).toEqual([
      "lock",
      "row",
      "delete:private",
      "log",
      "progress",
    ]);
    expect(deleted).toEqual([`private:${privatePathOf(p)}`]);
    expect(recorded(scopes[6][0])).toMatchObject({
      outcome: "failing",
      reason: "chat_busy",
    });
    expect(counts(scopes[6][0])).toBe(true);
    expect(logWarn).toHaveBeenCalledWith(
      "mink.attachments: legacy picture waits",
      expect.objectContaining({ mediaAssetId: p.id, reason: "chat_busy" }),
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it("★ a chat no longer live under the lock: the same wait, and tomorrow's run deletes the picture", async () => {
    const p = picture(24);
    seed(p);
    const scopes = scenario({
      candidates: [p],
      chats: [liveChat()],
      chatLive: false,
    });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(scopes[4].map((s) => s.label)).toEqual(["lock", "live"]);
    expect(recorded(scopes[6][0])).toMatchObject({ reason: "chat_busy" });
    expect(counts(scopes[6][0])).toBe(true);
  });

  it("★ the link transaction throwing: rolled back, the copy discarded, chat_busy with the error logged", async () => {
    const p = picture(25);
    seed(p);
    const scopes = scenario({
      candidates: [p],
      chats: [liveChat()],
      throwOn: "link",
    });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(deleted).toEqual([`private:${privatePathOf(p)}`]);
    expect(recorded(scopes[6][0])).toMatchObject({ reason: "chat_busy" });
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: legacy picture failed",
      expect.anything(),
      expect.objectContaining({ reason: "chat_busy" }),
    );
  });

  it("★ a public delete that fails after the link: the move stays committed, recorded delete_failed, the row kept", async () => {
    const p = picture(26);
    seed(p);
    failDelete.add(p.path);
    const scopes = scenario({ candidates: [p], chats: [liveChat()] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(scopes[4].map((s) => s.label)).toEqual([
      "lock",
      "live",
      "proposal",
      "link",
      "messages",
      "summary",
    ]);
    expect(events.slice(events.indexOf("delete:public"))).toEqual([
      "delete:public",
      "log",
      "progress",
    ]);
    expect(events).not.toContain("remove");
    expect(recorded(scopes[5][0])).toMatchObject({ reason: "delete_failed" });
  });

  it("★ the row-and-record transaction throwing: delete_failed", async () => {
    const p = picture(27);
    const scopes = scenario({ candidates: [p], throwOn: "remove" });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(recorded(scopes[2][0])).toMatchObject({ reason: "delete_failed" });
  });

  it("★ the keep transaction throwing: keep_failed", async () => {
    const p = picture(28, { attempts: 3 });
    const scopes = scenario({ candidates: [p], throwOn: "keep" });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(scopes.map((s) => s.map((x) => x.label))).toEqual([
      ["candidates"],
      ["row"],
      ["keep"],
      ["log"],
      ["progress"],
    ]);
    expect(recorded(scopes[3][0])).toMatchObject({ reason: "keep_failed" });
  });

  it("★ a record that cannot be written is logged and the picture still counts as failed", async () => {
    const p = picture(29);
    scenario({ candidates: [p], throwOn: "log" });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: legacy failure not recorded",
      expect.anything(),
      expect.objectContaining({ mediaAssetId: p.id, reason: "delete_failed" }),
    );
    expect(batchLine()).toMatchObject({ failed: 1, missing: 0 });
  });

  it("★ a path the record cannot hold (another store's prefix, or traversal) is kept as an upload without a record and logged", async () => {
    const foreign = picture(30, {
      path: `stores/${OTHER_STORE}/media/x.webp`,
    });
    const traversal = picture(31, {
      path: `stores/${STORE}/media/../x.webp`,
    });
    const scopes = scenario({ candidates: [foreign, traversal] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(2);
    expect(scopes.map((s) => s.map((x) => x.label))).toEqual([
      ["candidates"],
      ["keep"],
      ["keep"],
      ["progress"],
    ]);
    expect(events).not.toContain("delete:public");
    expect(logError).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: legacy picture outside its store, kept as an upload without a record",
      expect.anything(),
      expect.objectContaining({ mediaAssetId: foreign.id }),
    );
    expect(batchLine()).toMatchObject({ kept: 2 });
  });

  it("★ the private delete of another store's object is refused before the bucket is asked", async () => {
    // A candidate whose row says one store and whose path another; the
    // record refuses it first, so the public delete never runs.
    const p = picture(32, { store_id: OTHER_STORE });
    scenario({ candidates: [p], chats: [] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(deleted).toEqual([]);
  });
});

describe("the batch", () => {
  it("★ returns the number handled, failures included, and logs one content-free line with left, givenUp and held", async () => {
    const kept = picture(40);
    seed(kept);
    vi.mocked(productImageUsage).mockImplementation(async (_store, urls) =>
      urls.includes(kept.url)
        ? (new Map([[kept.url, [{ id: "prod" }]]]) as never)
        : new Map(),
    );
    const missing = picture(41);
    const broken = picture(42);
    gcs.metadata.mockImplementation(async (kind, path) => {
      events.push(`read:${kind}`);
      if (path === broken.path) throw new Error("bucket unavailable");
      return objects.get(`${kind}:${path}`) ?? null;
    });
    scenario({
      candidates: [kept, missing, broken],
      progress: { left: 9, given_up: 2, held: 3 },
    });

    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(3);
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith("mink.attachments: legacy batch", {
      kept: 1,
      moved: 0,
      deleted: 0,
      missing: 1,
      failed: 1,
      left: 9,
      givenUp: 2,
      held: 3,
    });
    const line = batchLine() as Record<string, unknown>;
    for (const value of Object.values(line)) {
      expect(typeof value).toBe("number");
    }
  });

  it("★ an empty batch returns 0 and still reports progress", async () => {
    scenario({ candidates: [], progress: { left: 4, given_up: 4 } });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(0);
    expect(batchLine()).toEqual({
      kept: 0,
      moved: 0,
      deleted: 0,
      missing: 0,
      failed: 0,
      left: 4,
      givenUp: 4,
      held: 0,
    });
  });

  it("★ the candidates and the progress are their own scopes, before and after the pictures", async () => {
    const p = picture(43, { attempts: 3 });
    const scopes = scenario({ candidates: [p] });
    await moveLegacyMinkAttachments(FLOOR, 7);
    expect(scopes[0].map((s) => s.label)).toEqual(["candidates"]);
    expect(scopes[0][0].params).toEqual([FLOOR, 7]);
    expect(scopes.at(-1)?.map((s) => s.label)).toEqual(["progress"]);
    expect(scopes.at(-1)?.[0].text).toContain(
      "count(*) filter (where l.outcome = 'failing' and l.attempts > 3)::int as given_up",
    );
  });

  it("★ D10: the progress counts, over the same rows, the pictures of a store under an active legal hold", () => {
    const text = compiled(legacyProgressSql());
    expect(text).toBe(
      "select count(*)::int as left, count(*) filter (where l.outcome = 'failing' and l.attempts > 3)::int as given_up, count(*) filter (where exists (select 1 from public.store_legal_holds h where h.store_id = m.store_id and h.released_at is null))::int as held from public.media_assets m left join public.mink_attachment_legacy_log l on l.media_asset_id = m.id where m.source = 'mink_attachment'",
    );
  });
});

describe("★ R1: a copy is deleted only when no private row holds the id", () => {
  const cases: [string, Partial<Scenario>, () => void][] = [
    ["the chat's lock held elsewhere", { locked: false }, () => {}],
    ["the link transaction throwing", { throwOn: "link" }, () => {}],
    [
      "a copy whose size differs",
      {},
      () => {
        corruptCopy = true;
      },
    ],
    [
      "a copy that throws after landing",
      {},
      () => {
        gcs.copy.mockImplementation(async (_fk, fromPath, _tk, toPath) => {
          events.push("copy");
          copies.push(toPath);
          objects.set(`private:${toPath}`, {
            ...objects.get(`public:${fromPath}`)!,
          });
          throw new Error("answer lost");
        });
      },
    ],
  ];

  it.each(cases)(
    "%s: a private row holding the id keeps the copy",
    async (_name, over, arrange) => {
      const p = picture(60);
      seed(p);
      arrange();
      scenario({ candidates: [p], chats: [liveChat()], hasRow: true, ...over });
      await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
      expect(events).toContain("row");
      expect(events).not.toContain("delete:private");
      expect(deleted).toEqual([]);
      expect(objects.has(`private:${privatePathOf(p)}`)).toBe(true);
    },
  );

  it("★ a row check that fails keeps the copy and says so; the picture still waits", async () => {
    const p = picture(61);
    seed(p);
    const scopes = scenario({
      candidates: [p],
      chats: [liveChat()],
      locked: false,
      throwOn: "row",
    });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(deleted).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: legacy private copy kept, row check failed",
      expect.anything(),
      expect.objectContaining({ mediaAssetId: p.id }),
    );
    expect(recorded(scopes.at(-2)![0])).toMatchObject({ reason: "chat_busy" });
  });
});

describe("★ R6: a chat with a reply running is never moved", () => {
  it("★ a reply running at the chats read: the picture waits a night, nothing copied, no attempt counted", async () => {
    const p = picture(62);
    seed(p);
    const scopes = scenario({
      candidates: [p],
      chats: [{ ...liveChat(), running: true }],
    });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).toEqual([
      "candidates",
      "read:public",
      "usage",
      "proposal",
      "chats",
      "log",
      "progress",
    ]);
    expect(copies).toEqual([]);
    expect(recorded(scopes[3][0])).toMatchObject({
      outcome: "failing",
      reason: "chat_busy",
    });
    expect(counts(scopes[3][0])).toBe(false);
    expect(scopes[3][0].text).toContain(
      "values ($1, $2, $3, $4, $5, 0, now(), null)",
    );
    expect(logWarn).toHaveBeenCalledWith(
      "mink.attachments: legacy picture waits",
      expect.objectContaining({
        mediaAssetId: p.id,
        reason: "chat_busy",
        replyRunning: true,
      }),
    );
    expect(logError).not.toHaveBeenCalled();
    expect(batchLine()).toMatchObject({ failed: 1, moved: 0 });
  });

  it("★ a reply that started after the chats read is seen under the lock: the copy is discarded, nothing linked, no attempt counted", async () => {
    const p = picture(63);
    seed(p);
    const scopes = scenario({
      candidates: [p],
      chats: [liveChat()],
      replyRunning: true,
    });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(scopes[4].map((s) => s.label)).toEqual(["lock", "live"]);
    expect(events).not.toContain("link");
    expect(events).not.toContain("messages");
    expect(events).not.toContain("delete:public");
    expect(deleted).toEqual([`private:${privatePathOf(p)}`]);
    const last = scopes.at(-2)![0];
    expect(recorded(last)).toMatchObject({ reason: "chat_busy" });
    expect(counts(last)).toBe(false);
    expect(batchLine()).toMatchObject({ failed: 1, moved: 0 });
  });
});

describe("★ S7: a proposal made while the copy ran keeps the picture", () => {
  it("★ the proposals are read again under the chat's lock; one naming the picture keeps it as an upload, the copy discarded", async () => {
    const p = picture(64);
    seed(p);
    const scopes = scenario({
      candidates: [p],
      chats: [liveChat()],
      lateProposal: true,
    });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(scopes[4].map((s) => s.label)).toEqual(["lock", "live", "proposal"]);
    expect(events).not.toContain("link");
    expect(events).not.toContain("delete:public");
    expect(deleted).toEqual([`private:${privatePathOf(p)}`]);
    const keepScope = scopes.find((s) => s[0]?.label === "keep")!;
    expect(recorded(keepScope[1])).toMatchObject({
      outcome: "kept",
      reason: "live_proposal",
    });
    expect(batchLine()).toMatchObject({ kept: 1, moved: 0 });
  });
});

describe("★ R8: a copy an earlier night left behind is found again", () => {
  it("★ the move records its start before the copy; a record that cannot be written stops it before any copy", async () => {
    const p = picture(65);
    seed(p);
    scenario({ candidates: [p], chats: [liveChat()], throwOn: "log" });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events.slice(events.indexOf("chats"))).toEqual([
      "chats",
      "log",
      "log",
      "progress",
    ]);
    expect(copies).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: legacy picture failed",
      expect.anything(),
      expect.objectContaining({ reason: "copy_failed" }),
    );
  });

  it("★ a picture with a record and a private object no row holds: the object goes before the keep", async () => {
    const p = picture(66, { attempts: 3 });
    seedLeftover(p);
    const scopes = scenario({ candidates: [p] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).toEqual([
      "candidates",
      "row",
      "read:private",
      "delete:private",
      "keep",
      "log",
      "progress",
    ]);
    expect(deleted).toEqual([`private:${privatePathOf(p)}`]);
    expect(recorded(scopes[2][1])).toMatchObject({
      outcome: "kept",
      reason: "gave_up",
    });
  });

  it("★ a private row holding the id keeps the object, and the storage is not even asked", async () => {
    const p = picture(67, { attempts: 3 });
    seedLeftover(p);
    scenario({ candidates: [p], hasRow: true });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).toEqual(["candidates", "row", "keep", "log", "progress"]);
    expect(deleted).toEqual([]);
  });

  it("★ a missing public object with a leftover: the leftover goes, then the row, recorded missing", async () => {
    const p = picture(68, { attempts: 1 });
    seedLeftover(p);
    const scopes = scenario({ candidates: [p] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).toEqual([
      "candidates",
      "read:public",
      "row",
      "read:private",
      "delete:private",
      "remove",
      "log",
      "progress",
    ]);
    const removeScope = scopes.find((s) => s[0]?.label === "remove")!;
    expect(recorded(removeScope[1])).toMatchObject({ outcome: "missing" });
  });

  it("★ a picture never tried has no copy to look for", async () => {
    const p = picture(69);
    scenario({ candidates: [p] });
    await moveLegacyMinkAttachments(FLOOR, 25);
    expect(events).toEqual([
      "candidates",
      "read:public",
      "remove",
      "log",
      "progress",
    ]);
  });

  it("★ a leftover check that fails is logged and the decision goes ahead", async () => {
    const p = picture(70, { attempts: 3 });
    seedLeftover(p);
    scenario({ candidates: [p], throwOn: "row" });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events).toEqual(["candidates", "row", "keep", "log", "progress"]);
    expect(deleted).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: legacy leftover check failed",
      expect.anything(),
      expect.objectContaining({ mediaAssetId: p.id }),
    );
    expect(batchLine()).toMatchObject({ kept: 1 });
  });
});

describe("★ R9: a decision is recorded only when its change touched a row", () => {
  it("★ a keep that finds the row gone records nothing, counts failed and sets the picture aside", async () => {
    const p = picture(71, { attempts: 3 });
    const batch: MinkLegacyBatch = { skip: new Set() };
    scenario({ candidates: [p], gone: true });
    await expect(moveLegacyMinkAttachments(FLOOR, 25, batch)).resolves.toBe(1);
    expect(events).toEqual([
      "candidates",
      "row",
      "read:private",
      "keep",
      "progress",
    ]);
    expect(logWarn).toHaveBeenCalledWith(
      "mink.attachments: legacy picture changed underneath",
      expect.objectContaining({ mediaAssetId: p.id, outcome: "kept" }),
    );
    expect(batch.skip).toEqual(new Set([p.id]));
    expect(batchLine()).toMatchObject({ kept: 0, failed: 1 });
  });

  it("★ a delete that finds the row gone records nothing either", async () => {
    const p = picture(72);
    seed(p);
    scenario({ candidates: [p], chats: [], gone: true });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events.slice(events.indexOf("remove"))).toEqual([
      "remove",
      "progress",
    ]);
    expect(batchLine()).toMatchObject({ deleted: 0, failed: 1 });
  });

  it("★ a move whose row went after the link is not reported moved", async () => {
    const p = picture(73);
    seed(p);
    scenario({ candidates: [p], chats: [liveChat()], gone: true });
    await expect(moveLegacyMinkAttachments(FLOOR, 25)).resolves.toBe(1);
    expect(events.slice(events.indexOf("remove"))).toEqual([
      "remove",
      "progress",
    ]);
    expect(logWarn).toHaveBeenCalledWith(
      "mink.attachments: legacy picture changed underneath",
      expect.objectContaining({ mediaAssetId: p.id, outcome: "moved" }),
    );
    expect(batchLine()).toMatchObject({ moved: 0, failed: 1 });
  });
});

describe("★ R11: a picture whose record cannot be written is set aside for the run", () => {
  it("★ the next batch of the same run leaves it out", async () => {
    const p = picture(74);
    const batch: MinkLegacyBatch = { skip: new Set() };
    const scopes = scenario({ candidates: [p], throwOn: "log" });
    await expect(moveLegacyMinkAttachments(FLOOR, 25, batch)).resolves.toBe(1);
    expect(batch.skip).toEqual(new Set([p.id]));
    await moveLegacyMinkAttachments(FLOOR, 25, batch);
    const second = scopes.filter((s) => s[0]?.label === "candidates")[1][0];
    expect(second.text).toContain("and not (m.id = any($2::uuid[]))");
    expect(second.params).toEqual([FLOOR, [p.id], 25]);
  });

  it("★ a picture outside its store whose relabel fails is set aside too", async () => {
    const p = picture(75, { path: `stores/${OTHER_STORE}/media/x.webp` });
    const batch: MinkLegacyBatch = { skip: new Set() };
    scenario({ candidates: [p], throwOn: "keep" });
    await moveLegacyMinkAttachments(FLOOR, 25, batch);
    expect(batch.skip).toEqual(new Set([p.id]));
  });

  it("★ without a run context the first batch reads every candidate", async () => {
    const scopes = scenario({ candidates: [] });
    await moveLegacyMinkAttachments(FLOOR, 25);
    expect(scopes[0][0].params).toEqual([FLOOR, 25]);
  });
});

describe("★ R2: the run's deadline reaches the batch", () => {
  it("★ inside the reserve at entry: nothing read, the batch reports it is out of time", async () => {
    const deadline = 1_000_000;
    const batch: MinkLegacyBatch = {
      deadline,
      clock: () => deadline - MINK_LEGACY_PICTURE_RESERVE_MS + 1,
    };
    scenario({ candidates: [picture(76)] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25, batch)).resolves.toBe(0);
    expect(withService).not.toHaveBeenCalled();
    expect(batch.outOfTime).toBe(true);
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("★ no picture is started inside the reserve; the batch stops, still reports progress, and says so", async () => {
    const deadline = 1_000_000;
    const clock = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(deadline - MINK_LEGACY_PICTURE_RESERVE_MS + 1);
    const batch: MinkLegacyBatch = { deadline, clock };
    const first = picture(77, { attempts: 3 });
    const second = picture(78, { attempts: 3 });
    scenario({ candidates: [first, second] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25, batch)).resolves.toBe(1);
    expect(events.filter((e) => e === "keep")).toHaveLength(1);
    expect(events.at(-1)).toBe("progress");
    expect(batch.outOfTime).toBe(true);
    expect(batchLine()).toMatchObject({ kept: 1 });
  });

  it("★ with time left the whole batch runs and the flag stays unset", async () => {
    const batch: MinkLegacyBatch = { deadline: 1_000_000, clock: () => 0 };
    scenario({ candidates: [picture(79, { attempts: 3 })] });
    await expect(moveLegacyMinkAttachments(FLOOR, 25, batch)).resolves.toBe(1);
    expect(batch.outOfTime).toBeUndefined();
  });
});
