/** Rollback-only checks, against local Postgres, of the complaints log, the
 * store hold and the review and comment pre-checks (takedown stage T10,
 * design 3.7, 3.9, 5.4 and 7.4), through the real functions:
 *
 * - a complaint is logged with its kind's deadlines and recorded;
 * - `grievance_complaints_due_check` refuses a deadline later than the law
 *   allows, whatever wrote it;
 * - a change of kind after acknowledgement tightens the deadlines, a looser
 *   kind never moves one later, and a passed deadline is reported and its
 *   alert keys cleared for the follow-up;
 * - the received time moves the deadlines before acknowledgement and is
 *   refused after it;
 * - erasure is all or nothing (`grievance_complaints_erased_check`), and the
 *   sweep erases only old resolved complaints, skipping held ones;
 * - a hold is set once, refuses the store's deletion (the trigger's own
 *   refusal reads as the same sentence), and is released with a note; an
 *   archive still being copied refuses deletion too;
 * - a live review or comment block is found by the pre-check, and the guard's
 *   refusal of a real Drizzle insert reads as the shopper's sentence.
 *
 * Run with MODERATION_LOCAL_TEST=1 after `npm run db:migrate:local -- apply`
 * (migration 20261030_0269_content_takedown). The fixed loopback database
 * keeps it away from Cloud SQL; everything happens inside one transaction that
 * is rolled back, each case in its own savepoint. The code under test runs as
 * `app_service`, the role `withService` takes in production. Nothing reaches a
 * network: `fetch` throws.
 *
 * Identity values (grievance_complaints.ref_no) are never rolled back, so each
 * run moves that sequence on; nothing else outlives the transaction. A store
 * DELETE is attempted (and refused by the hold), so run this file on its own,
 * not beside a dev server writing to the database.
 *
 * Every `moderation_events.at` written here is the same `now()` (one
 * transaction), so events are compared as sets, never by order.
 */
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";

const service = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
  pending: Promise.resolve(),
}));
vi.mock("@/lib/db/client", () => {
  async function withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const previous = service.pending;
    let release!: () => void;
    service.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const name = `t10_scope_${++service.count}`;
    await service.client!.query(`SAVEPOINT ${name}`);
    try {
      await service.client!.query("SET ROLE app_service");
      const value = await fn(service.db!);
      await service.client!.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      await service.client!.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await service.client!.query(`RELEASE SAVEPOINT ${name}`);
      throw error;
    } finally {
      await service.client!.query("RESET ROLE");
      release();
    }
  }
  const notUsed = () => {
    throw new Error("Only withService is used by the code under test.");
  };
  return { withService, withUser: notUsed, withAnon: notUsed };
});
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { productReviews, blogComments } from "@/drizzle/schema";
import {
  COMPLAINT_ERRORS,
  storeLabelFor,
  acknowledgeComplaint,
  eraseResolvedComplaints,
  logComplaint,
  markActioned,
  reopenComplaint,
  resolveComplaint,
  updateComplaint,
} from "./complaints";
import {
  HOLD_ERRORS,
  STORE_DELETE_REFUSALS,
  activeStoreHold,
  deleteRefusalForError,
  releaseStoreHold,
  setStoreHold,
  storeDeleteRefusal,
} from "./holds";
import { authorBlockRefusal, liveAuthorBlock } from "./author-blocks";
import { SHOPPER } from "./copy";
import { complaintRef } from "./kinds";

const enabled = process.env.MODERATION_LOCAL_TEST === "1";

const MIGRATION = "20261030_0269_content_takedown";
const ECHO_SLUG = "echo";
const HOUR = 60 * 60 * 1000;
const CASE_MS = 30_000;
const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const OPS = { email: `t10-${tag}-ops@probe.test`, role: "member" as const };
const SUPER = {
  email: `t10-${tag}-super@probe.test`,
  role: "superadmin" as const,
};
const SHOPPER_ID = `t10-${tag}-shopper`;

type Row = Record<string, unknown>;

function randomMobile(): string {
  return `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

describe.skipIf(!enabled)(
  "complaints, holds and the author pre-checks (local database)",
  () => {
    let client: Client;
    let echoId = "";
    let echoLabel = "";
    let productId = "";
    let blogId = "";

    const one = async (text: string, params: unknown[] = []) =>
      ((await client.query(text, params)).rows[0] ?? null) as Row | null;

    async function asService<T>(fn: () => Promise<T>): Promise<T> {
      await client.query("SET ROLE app_service");
      try {
        return await fn();
      } finally {
        await client.query("RESET ROLE");
      }
    }

    /** One statement that must be refused, in its own savepoint. */
    async function refused(
      text: string,
      params: unknown[] = [],
    ): Promise<{
      code: string;
      constraint: string | null;
      message: string;
    } | null> {
      await client.query("SAVEPOINT t10_refusal");
      try {
        await client.query(text, params);
        return null;
      } catch (error) {
        const e = error as {
          code?: string;
          constraint?: string;
          message: string;
        };
        return {
          code: e.code ?? "",
          constraint: e.constraint ?? null,
          message: e.message,
        };
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT t10_refusal");
        await client.query("RELEASE SAVEPOINT t10_refusal");
      }
    }

    async function complaint(id: string) {
      return one(
        `select *,
                round(extract(epoch from received_at) * 1000) as received_ms,
                extract(epoch from acknowledge_due_at - received_at) / 3600 as ack_h,
                extract(epoch from action_due_at - received_at) / 3600 as act_h,
                extract(epoch from resolve_due_at - received_at) / 3600 as resolve_h
           from public.grievance_complaints where id = $1`,
        [id],
      );
    }

    async function events(complaintId: string) {
      return (
        await client.query(
          `select action, actor, detail from public.moderation_events
            where complaint_id = $1`,
          [complaintId],
        )
      ).rows as { action: string; actor: string; detail: Row }[];
    }

    async function actions(complaintId: string) {
      return (await events(complaintId)).map((e) => e.action).sort();
    }

    async function logged(kind: string, receivedAgoH: number, extra: Row = {}) {
      const result = await logComplaint(
        {
          receivedAt: new Date(Date.now() - receivedAgoH * HOUR),
          channel: "email",
          kind,
          complainantName: "Asha Rao",
          complainantContact: "asha@example.com",
          storeId: echoId,
          urls: ["https://echo.storemink.com/shop/probe"],
          summary: "Please remove the photo of me.",
          ...extra,
        },
        OPS,
      );
      if (!result.ok) throw new Error(`logComplaint refused: ${result.error}`);
      return result;
    }

    beforeAll(async () => {
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.MODERATION_LOCAL_TEST_USER || process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      service.client = client;
      service.db = drizzle(client, { schema: { ...schema, ...relations } });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("No network in this test.");
        }),
      );
      const ledger = await one(
        "select 1 as ok from public.schema_migrations where id = $1",
        [MIGRATION],
      );
      if (!ledger) {
        throw new Error(
          `${MIGRATION} is not applied to storemink_local: run npm run db:migrate:local -- apply first.`,
        );
      }
      const echo = await one(
        "select id, name, slug from public.stores where slug = $1",
        [ECHO_SLUG],
      );
      if (!echo) throw new Error("The local store echo is missing.");
      echoId = String(echo.id);
      echoLabel = storeLabelFor({
        name: String(echo.name),
        slug: String(echo.slug),
      });
      const product = await one(
        `select id from public.products
          where store_id = $1 and status = 'published'
            and moderation_blocked_at is null
          order by created_at, id limit 1`,
        [echoId],
      );
      if (!product) throw new Error("echo has no published product.");
      productId = String(product.id);
      await client.query(
        `insert into public.users (id, phone, store_id, first_name)
         values ($1, $2, $3, 'Priya')`,
        [SHOPPER_ID, randomMobile(), echoId],
      );
      blogId = String(
        (
          await one(
            `insert into public.blogs (title, slug, status, store_id, content)
             values ('Probe post', $1, 'published', $2, '<p>x</p>')
             returning id`,
            [`t10-${tag}-probe-post`, echoId],
          )
        )?.id,
      );
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      if (!client) return;
      await client.query("ROLLBACK");
      await client.end();
    });

    beforeEach(async () => {
      await client.query("SAVEPOINT t10_case");
    });
    afterEach(async () => {
      await client.query("ROLLBACK TO SAVEPOINT t10_case");
      await client.query("RELEASE SAVEPOINT t10_case");
    });

    // ── Complaints ─────────────────────────────────────────────────────────

    it(
      "logs an intimate-image complaint with its deadlines from the time it reached us, and records it",
      async () => {
        const result = await logged("intimate_or_impersonation", 1);
        expect(result.urgent).toBe(true);
        const row = await complaint(result.complaint.id);
        expect(Number(row?.ack_h)).toBe(24);
        expect(Number(row?.act_h)).toBe(2);
        expect(Number(row?.resolve_h)).toBe(36);
        expect(row?.store_label).toBe(echoLabel);
        expect(await events(result.complaint.id)).toEqual([
          {
            action: "complaint_logged",
            actor: OPS.email,
            detail: { kind: "intimate_or_impersonation", channel: "email" },
          },
        ]);
      },
      CASE_MS,
    );

    it(
      "refuses a received time in the future or more than a year ago",
      async () => {
        const base = {
          channel: "email",
          kind: "grievance",
          summary: "A probe complaint.",
        };
        expect(
          await logComplaint(
            { ...base, receivedAt: new Date(Date.now() + 2 * HOUR) },
            OPS,
          ),
        ).toMatchObject({ ok: false, error: COMPLAINT_ERRORS.receivedFuture });
        expect(
          await logComplaint(
            { ...base, receivedAt: new Date(Date.now() - 400 * 24 * HOUR) },
            OPS,
          ),
        ).toMatchObject({ ok: false, error: COMPLAINT_ERRORS.receivedTooOld });
      },
      CASE_MS,
    );

    it(
      "the CHECK refuses a deadline later than the law allows, whatever writes it",
      async () => {
        const court = await logged("court_order", 0.5);
        const later = await asService(() =>
          refused(
            `update public.grievance_complaints
                set resolve_due_at = received_at + interval '4 hours'
              where id = $1`,
            [court.complaint.id],
          ),
        );
        expect(later).toMatchObject({
          code: "23514",
          constraint: "grievance_complaints_due_check",
        });
        const intimate = await logged("intimate_or_impersonation", 0.5);
        const lateRemoval = await asService(() =>
          refused(
            `update public.grievance_complaints
                set action_due_at = received_at + interval '3 hours'
              where id = $1`,
            [intimate.complaint.id],
          ),
        );
        expect(lateRemoval?.constraint).toBe("grievance_complaints_due_check");
      },
      CASE_MS,
    );

    it(
      "a kind change after acknowledgement tightens the deadlines, and a looser kind never moves one later",
      async () => {
        const logged1 = await logged("grievance", 1);
        const id = logged1.complaint.id;
        const ack = await acknowledgeComplaint(id, OPS);
        expect(ack).toMatchObject({ ok: true, emailed: false });

        const stricter = await updateComplaint(
          id,
          { kind: "intimate_or_impersonation" },
          OPS,
        );
        expect(stricter).toMatchObject({
          ok: true,
          changed: ["kind", "deadlines"],
          passed: [],
        });
        let row = await complaint(id);
        expect(row?.kind).toBe("intimate_or_impersonation");
        expect(Number(row?.ack_h)).toBe(24);
        expect(Number(row?.act_h)).toBe(2);
        expect(Number(row?.resolve_h)).toBe(36);

        const looser = await updateComplaint(id, { kind: "grievance" }, OPS);
        expect(looser).toMatchObject({ ok: true, changed: ["kind"] });
        row = await complaint(id);
        expect(row?.kind).toBe("grievance");
        expect(Number(row?.act_h)).toBe(2);
        expect(Number(row?.resolve_h)).toBe(36);

        expect(await actions(id)).toEqual([
          "complaint_acknowledged",
          "complaint_logged",
          "complaint_updated",
          "complaint_updated",
        ]);
        const updates = (await events(id)).filter(
          (e) => e.action === "complaint_updated",
        );
        const tightened = updates.find(
          (e) => (e.detail.kind as Row).to === "intimate_or_impersonation",
        );
        const loosened = updates.find(
          (e) => (e.detail.kind as Row).to === "grievance",
        );
        expect(tightened?.detail).toMatchObject({
          fields: ["kind", "deadlines"],
          kind: { from: "grievance", to: "intimate_or_impersonation" },
          deadlines: {
            from: { actionDueAt: expect.any(String) },
            to: { actionDueAt: expect.any(String) },
          },
        });
        expect(loosened?.detail).toEqual({
          fields: ["kind"],
          kind: { from: "intimate_or_impersonation", to: "grievance" },
        });

        // The received time is fixed once it is acknowledged.
        expect(
          await updateComplaint(
            id,
            { receivedAt: new Date(Date.now() - 5 * HOUR) },
            OPS,
          ),
        ).toMatchObject({ ok: false, error: COMPLAINT_ERRORS.receivedLocked });
        expect(Number((await complaint(id))?.act_h)).toBe(2);
      },
      CASE_MS,
    );

    it(
      "reports a deadline the change has already passed, clearing its alert keys for the follow-up",
      async () => {
        const result = await logged("grievance", 3);
        const id = result.complaint.id;
        await client.query(
          `update public.grievance_complaints
              set alerts = '{"act_soon": "2026-10-30T07:00:00Z", "acknowledge_soon": "x"}'
            where id = $1`,
          [id],
        );
        const changed = await updateComplaint(
          id,
          { kind: "intimate_or_impersonation" },
          OPS,
        );
        expect(changed).toMatchObject({ ok: true, passed: ["act"] });
        const row = await complaint(id);
        expect(row?.alerts).toEqual({ acknowledge_soon: "x" });
      },
      CASE_MS,
    );

    it(
      "moves the deadlines with a corrected received time before acknowledgement",
      async () => {
        const result = await logged("grievance", 1);
        const id = result.complaint.id;
        const before = await complaint(id);
        const earlier = new Date(Number(before?.received_ms) - 2 * HOUR);
        const moved = await updateComplaint(id, { receivedAt: earlier }, OPS);
        expect(moved).toMatchObject({
          ok: true,
          changed: ["receivedAt", "deadlines"],
        });
        const row = await complaint(id);
        expect(Number(row?.received_ms)).toBe(earlier.getTime());
        expect(Number(row?.ack_h)).toBe(24);
        expect(Number(row?.act_h)).toBe(7 * 24);
      },
      CASE_MS,
    );

    it(
      "acts on, resolves and reopens a complaint, recording each step",
      async () => {
        const result = await logged("information_order", 1);
        const id = result.complaint.id;
        expect(
          await markActioned(
            id,
            "Sent the order records to the cyber cell.",
            OPS,
          ),
        ).toMatchObject({ ok: true });
        expect(await markActioned(id, "Again", OPS)).toMatchObject({
          ok: false,
          error: COMPLAINT_ERRORS.alreadyActioned,
        });
        expect(
          await resolveComplaint(id, { outcome: "not_removed" }, OPS),
        ).toMatchObject({
          ok: false,
          error: COMPLAINT_ERRORS.outcomeNoteMissing,
        });
        const resolved = await resolveComplaint(
          id,
          { outcome: "answered", note: "Provided." },
          OPS,
        );
        expect(resolved).toMatchObject({ ok: true, emailed: null });
        let row = await complaint(id);
        expect(row).toMatchObject({
          outcome: "answered",
          outcome_note: "Provided.",
          resolved_by: OPS.email,
          actioned_by: OPS.email,
        });
        expect(
          await reopenComplaint(id, "They asked a follow-up.", OPS),
        ).toMatchObject({ ok: true });
        row = await complaint(id);
        expect(row).toMatchObject({
          resolved_at: null,
          resolved_by: null,
          outcome: null,
          outcome_note: "Provided.",
        });
        expect(await actions(id)).toEqual([
          "complaint_actioned",
          "complaint_logged",
          "complaint_reopened",
          "complaint_resolved",
        ]);
      },
      CASE_MS,
    );

    it(
      "erasure is all or nothing, and the sweep erases only old resolved complaints that nothing holds",
      async () => {
        // Half an erasure is refused.
        const recent = await logged("grievance", 1);
        await resolveComplaint(
          recent.complaint.id,
          { outcome: "answered" },
          OPS,
        );
        const half = await asService(() =>
          refused(
            `update public.grievance_complaints
                set erased_at = now(), complainant_name = ''
              where id = $1`,
            [recent.complaint.id],
          ),
        );
        expect(half).toMatchObject({
          code: "23514",
          constraint: "grievance_complaints_erased_check",
        });

        // Three complaints resolved 3 years and 10 days ago.
        async function oldResolved(label: string, storeId: string | null) {
          const row = await one(
            `insert into public.grievance_complaints
               (received_at, channel, kind, complainant_name, complainant_contact,
                acting_for, authority_ref, store_id, store_label, urls, summary,
                acknowledge_due_at, action_due_at, resolve_due_at,
                resolved_at, resolved_by, outcome, outcome_note,
                created_by, created_at, updated_at)
             values (now() - interval '3 years 20 days', 'email', 'grievance',
                     'Asha Rao', 'asha@example.com', 'Her sister', 'ref 9',
                     $1, $2, '{https://echo.storemink.com/shop/x}', $3,
                     now() - interval '3 years 19 days',
                     now() - interval '3 years 14 days',
                     now() - interval '3 years 14 days',
                     now() - interval '3 years 10 days', $4, 'removed', 'Done.',
                     $4, now() - interval '3 years 20 days',
                     now() - interval '3 years 10 days')
             returning id`,
            [storeId, storeId ? "echo" : "", `Probe ${label}`, OPS.email],
          );
          return String(row?.id);
        }
        const free = await oldResolved("free", null);
        const onHeldStore = await oldResolved("held store", echoId);
        const withHeldArchive = await oldResolved("held archive", null);

        const hold = await setStoreHold(
          { storeId: echoId, reason: "Police notice" },
          SUPER,
        );
        expect(hold.ok).toBe(true);

        const blockId = String(
          (
            await asService(() =>
              one(
                `insert into public.content_blocks
                   (store_id, store_label, item_label, reason_kind, store_message,
                    blocked_by, item_kind, item_id, complaint_id)
                 values ($1, 'echo', 'A product', 'terms_breach',
                         'We blocked this.', $2, 'product', $3, $4)
                 returning id`,
                [echoId, OPS.email, productId, withHeldArchive],
              ),
            )
          )?.id,
        );
        await asService(() =>
          one(
            `insert into public.content_block_archives
               (block_id, store_id, snapshot, snapshot_sha256, keep_until,
                legal_hold, legal_hold_set_at, legal_hold_set_by)
             values ($1, $2, '{"kind":"product"}', repeat('a', 64),
                     now() + interval '180 days', true, now(), $3)
             returning id`,
            [blockId, echoId, SUPER.email],
          ),
        );

        const floor = new Date(Date.now() - 3 * 365 * 24 * HOUR);
        const erased = await eraseResolvedComplaints(floor, 500);
        expect(erased).toBeGreaterThanOrEqual(1);

        const gone = await complaint(free);
        expect(gone).toMatchObject({
          complainant_name: "",
          complainant_contact: "",
          acting_for: "",
          authority_ref: "",
          summary: "",
          urls: [],
          outcome_note: "",
          outcome: "removed",
          kind: "grievance",
        });
        expect(gone?.erased_at).not.toBeNull();
        expect(await actions(free)).toEqual(["complaint_erased"]);

        for (const kept of [
          onHeldStore,
          withHeldArchive,
          recent.complaint.id,
        ]) {
          const row = await complaint(kept);
          expect(row?.erased_at).toBeNull();
          expect(row?.complainant_name).toBe("Asha Rao");
        }

        // An erased complaint can't be changed any more.
        expect(
          await updateComplaint(free, { kind: "court_order" }, OPS),
        ).toMatchObject({ ok: false, error: COMPLAINT_ERRORS.erased });
      },
      CASE_MS,
    );

    // ── Holds ──────────────────────────────────────────────────────────────

    it(
      "a hold is a superadmin's, set once, refuses the store's deletion, and is released with a note",
      async () => {
        expect(
          await setStoreHold({ storeId: echoId, reason: "Police notice" }, OPS),
        ).toMatchObject({ ok: false, error: HOLD_ERRORS.setSuperadminOnly });

        const linked = await logged("government_order", 0.5);
        const set = await setStoreHold(
          {
            storeId: echoId,
            reason: "Police notice 12/2026",
            authorityRef: "Cyber cell",
            complaint: complaintRef(linked.complaint.refNo),
            reviewOn: "2027-01-15",
          },
          SUPER,
        );
        if (!set.ok) throw new Error(set.error);
        expect(set.hold).toMatchObject({
          storeId: echoId,
          complaintId: linked.complaint.id,
          reviewOn: "2027-01-15",
          setBy: SUPER.email,
        });
        expect(
          await setStoreHold({ storeId: echoId, reason: "Again" }, SUPER),
        ).toMatchObject({ ok: false, error: HOLD_ERRORS.alreadyHeld });
        expect((await activeStoreHold(echoId))?.id).toBe(set.hold.id);

        expect(
          await storeDeleteRefusal(echoId, { actor: SUPER.email }),
        ).toEqual({
          reason: "hold",
          message: STORE_DELETE_REFUSALS.hold,
          holdId: set.hold.id,
        });
        const refusedEvent = await one(
          `select detail, hold_id from public.moderation_events
            where store_id = $1 and action = 'store_delete_refused'
              and hold_id = $2`,
          [echoId, set.hold.id],
        );
        expect(refusedEvent).toEqual({
          detail: { reason: "hold" },
          hold_id: set.hold.id,
        });

        // Whatever deletes the store, the trigger refuses it in the same words.
        await client.query("SAVEPOINT t10_delete");
        let deleteError: unknown = null;
        try {
          await client.query("delete from public.stores where id = $1", [
            echoId,
          ]);
        } catch (error) {
          deleteError = error;
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT t10_delete");
          await client.query("RELEASE SAVEPOINT t10_delete");
        }
        expect(deleteRefusalForError(deleteError)).toEqual({
          reason: "hold",
          message: STORE_DELETE_REFUSALS.hold,
        });

        expect(await releaseStoreHold(set.hold.id, " ", SUPER)).toMatchObject({
          ok: false,
          error: HOLD_ERRORS.noteMissing,
        });
        const released = await releaseStoreHold(
          set.hold.id,
          "Investigation closed.",
          SUPER,
        );
        expect(released).toMatchObject({ ok: true });
        expect(await activeStoreHold(echoId)).toBeNull();
        expect(
          await releaseStoreHold(set.hold.id, "Again.", SUPER),
        ).toMatchObject({ ok: false, error: HOLD_ERRORS.alreadyReleased });
        const holdActions = (
          await client.query(
            `select action from public.moderation_events where hold_id = $1`,
            [set.hold.id],
          )
        ).rows
          .map((r) => String(r.action))
          .sort();
        expect(holdActions).toEqual([
          "store_delete_refused",
          "store_hold_released",
          "store_hold_set",
        ]);
      },
      CASE_MS,
    );

    it(
      "an archive still being copied refuses the store's deletion too",
      async () => {
        const blockId = String(
          (
            await asService(() =>
              one(
                `insert into public.content_blocks
                   (store_id, store_label, item_label, reason_kind, store_message,
                    blocked_by, item_kind, item_id)
                 values ($1, 'echo', 'A product', 'terms_breach',
                         'We blocked this.', $2, 'product', $3)
                 returning id`,
                [echoId, OPS.email, productId],
              ),
            )
          )?.id,
        );
        await asService(() =>
          one(
            `insert into public.content_block_archives
               (block_id, store_id, snapshot, snapshot_sha256, files_state, keep_until)
             values ($1, $2, '{"kind":"product"}', repeat('a', 64), 'pending',
                     now() + interval '180 days')
             returning id`,
            [blockId, echoId],
          ),
        );
        const refusal = await storeDeleteRefusal(echoId);
        expect(refusal).toEqual({
          reason: "archive",
          message: STORE_DELETE_REFUSALS.archive,
          holdId: null,
        });
      },
      CASE_MS,
    );

    // ── The author pre-checks ──────────────────────────────────────────────

    it(
      "finds a live review block, and the guard's refusal of a real insert reads as the shopper's sentence",
      async () => {
        const review = await one(
          `insert into public.product_reviews
             (product_id, user_id, author_name, rating, comment, store_id)
           values ($1, $2, 'Priya S', 4, 'Probe review', $3)
           returning id`,
          [productId, SHOPPER_ID, echoId],
        );
        const input = {
          kind: "review" as const,
          storeId: echoId,
          authorUserId: SHOPPER_ID,
          parentItemId: productId,
        };
        expect(await liveAuthorBlock(input)).toBeNull();
        const blockId = String(
          (
            await asService(() =>
              one(
                `insert into public.content_blocks
                   (store_id, store_label, item_label, reason_kind, store_message,
                    blocked_by, item_kind, item_id, author_user_id, parent_item_id)
                 values ($1, 'echo', 'A review', 'terms_breach',
                         'We removed this review.', $2, 'review', $3, $4, $5)
                 returning id`,
                [echoId, OPS.email, review?.id, SHOPPER_ID, productId],
              ),
            )
          )?.id,
        );
        expect(await liveAuthorBlock(input)).toEqual({ blockId });

        await client.query("SAVEPOINT t10_upsert");
        let error: unknown = null;
        try {
          await service
            .db!.insert(productReviews)
            .values({
              productId,
              userId: SHOPPER_ID,
              storeId: echoId,
              authorName: "Priya S",
              rating: 5,
              comment: "Edited",
            })
            .onConflictDoUpdate({
              target: [productReviews.productId, productReviews.userId],
              set: { rating: 5, comment: "Edited" },
            });
        } catch (caught) {
          error = caught;
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT t10_upsert");
          await client.query("RELEASE SAVEPOINT t10_upsert");
        }
        expect(authorBlockRefusal(error)).toBe(SHOPPER.reviewRemoved);
      },
      CASE_MS,
    );

    it(
      "finds a live comment block, and the guard's refusal of a real insert reads as the shopper's sentence",
      async () => {
        const comment = await one(
          `insert into public.blog_comments (blog_id, user_id, author_name, body, store_id)
           values ($1, $2, 'Priya S', 'Probe comment', $3)
           returning id`,
          [blogId, SHOPPER_ID, echoId],
        );
        const blockId = String(
          (
            await asService(() =>
              one(
                `insert into public.content_blocks
                   (store_id, store_label, item_label, reason_kind, store_message,
                    blocked_by, item_kind, item_id, author_user_id, parent_item_id)
                 values ($1, 'echo', 'A comment', 'terms_breach',
                         'We removed this comment.', $2, 'blog_comment', $3, $4, $5)
                 returning id`,
                [echoId, OPS.email, comment?.id, SHOPPER_ID, blogId],
              ),
            )
          )?.id,
        );
        expect(
          await liveAuthorBlock({
            kind: "blog_comment",
            storeId: echoId,
            authorUserId: SHOPPER_ID,
            parentItemId: blogId,
          }),
        ).toEqual({ blockId });

        await client.query("SAVEPOINT t10_comment");
        let error: unknown = null;
        try {
          await service.db!.insert(blogComments).values({
            blogId,
            userId: SHOPPER_ID,
            authorName: "Priya S",
            body: "Another",
            storeId: echoId,
          });
        } catch (caught) {
          error = caught;
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT t10_comment");
          await client.query("RELEASE SAVEPOINT t10_comment");
        }
        expect(authorBlockRefusal(error)).toBe(SHOPPER.commentRemoved);
      },
      CASE_MS,
    );
  },
);
