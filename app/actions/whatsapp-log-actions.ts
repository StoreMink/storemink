"use server";

// ---------------------------------------------------------------------------
// Reading the WhatsApp log — the SMS log's shape (app/actions/sms-log-actions.ts),
// gated on the SAME `activity` section: an audit trail, and a second
// permission for the same class of data is a grant somebody forgets to give.
//
// What it adds over SMS is the DELIVERY TIMELINE: Meta reports delivered and
// read, so a row says more than "sent" — and `failed` carries Meta's code.
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { getViewerAccess, getActingStoreId } from "@/app/dashboard/lib/access";
import { logError } from "@/lib/observability/logger";
import { likePattern } from "@/lib/pos/search";

export interface WhatsAppLogRow {
  id: string;
  to_phone: string;
  event_key: string | null;
  template_name: string | null;
  body: string | null;
  /** sent | delivered | read | failed | skipped */
  status: string;
  error: string | null;
  error_code: number | null;
  pricing_category: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  created_at: string;
}

export interface WhatsAppLogPage {
  rows: WhatsAppLogRow[];
  total: number;
  pageSize: number;
  counts: {
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    skipped: number;
  };
  error?: string;
}

const PAGE_SIZE = 50;
const STATUSES = ["sent", "delivered", "read", "failed", "skipped"] as const;

const EMPTY: WhatsAppLogPage = {
  rows: [],
  total: 0,
  pageSize: PAGE_SIZE,
  counts: { sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 },
};

export async function getWhatsAppLogs(input: {
  page?: number;
  status?: string;
  q?: string;
  days?: number;
}): Promise<WhatsAppLogPage> {
  const access = await getViewerAccess();
  if (!access) return { ...EMPTY, error: "Not signed in." };
  if (!access.can("activity", "view")) {
    return { ...EMPTY, error: "You don't have access to logs." };
  }

  // ★ STORE-SCOPED ONLY. Every WhatsApp message is sent on a MERCHANT's own
  // number — the platform has none — so, unlike the email and SMS logs, there
  // is no platform scope to serve and `store_id` is NOT NULL on the table.
  const storeId = await getActingStoreId();

  const page = Math.max(1, Math.floor(input.page ?? 1));
  const offset = (page - 1) * PAGE_SIZE;

  // Re-validated here, not trusted from the URL: `status` reaches a SQL
  // predicate, so it is an ALLOWLIST.
  const status =
    input.status && (STATUSES as readonly string[]).includes(input.status)
      ? input.status
      : null;
  const days = Number.isFinite(input.days)
    ? Math.min(Number(input.days), 365)
    : 0;
  const q = (input.q ?? "").trim().slice(0, 60);

  const base = [sql`store_id = ${storeId}::uuid`];
  if (days > 0)
    base.push(sql`created_at > now() - (${days} || ' days')::interval`);
  if (q) {
    // ★ The backslash is escaped as well as % and _ (likePattern), or a "\"
    // in the box would neutralise the escape of whatever follows it.
    const pattern = likePattern(q);
    base.push(sql`(to_phone ilike ${pattern} or event_key ilike ${pattern})`);
  }
  const baseWhere = sql.join(base, sql` and `);
  const where = status
    ? sql.join([baseWhere, sql`status = ${status}`], sql` and `)
    : baseWhere;

  try {
    const [rows, summary] = await Promise.all([
      withService((db) =>
        db.execute(sql`
          select id, to_phone, event_key, template_name, body, status, error,
                 error_code, pricing_category, sent_at, delivered_at, read_at,
                 failed_at, created_at
            from public.whatsapp_logs
           where ${where}
           order by created_at desc
           limit ${PAGE_SIZE} offset ${offset}
        `),
      ),
      // Counts over the SAME filters minus `status`, so the chips show what
      // switching to them would find.
      withService((db) =>
        db.execute(sql`
          select status, count(*)::int as n
            from public.whatsapp_logs
           where ${baseWhere}
           group by status
        `),
      ),
    ]);

    const list = asRows(rows) as WhatsAppLogRow[];
    const counts = { ...EMPTY.counts };
    let total = 0;
    for (const r of asRows(summary) as { status: string; n: number }[]) {
      if (r.status in counts) counts[r.status as keyof typeof counts] = r.n;
      if (!status || r.status === status) total += r.n;
    }
    return { rows: list, total, pageSize: PAGE_SIZE, counts };
  } catch (err) {
    logError("whatsapp log read failed", err, { storeId });
    // An outage is reported AS an outage — "no messages" would read as
    // "nothing was sent".
    return { ...EMPTY, error: "Couldn't load the WhatsApp log. Try again." };
  }
}

function asRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return ((result as { rows?: unknown[] })?.rows ?? []) as unknown[];
}
