"use client";

import { ResponsiveTable } from "@/app/dashboard/components/responsive-table";

// WhatsApp Logs — the SMS Logs table, with the column SMS cannot have.
//
// ★ `Delivery` IS THE COLUMN THAT EARNS ITS PLACE. An SMS row says "sent" and
// means "handed to the provider"; carriers drop DLT mismatches silently, so the
// SMS log has to warn that sent ≠ delivered. Meta reports back — sent, then
// delivered, then read, or failed with a code — so this column says what
// actually happened to the message, with the time it happened.

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MessageCircle, Search } from "lucide-react";
// Pinned locale + zone — an unpinned formatter here hydrates wrong (lib/dates.ts).
import { formatWhen } from "@/lib/dates";
import { ListPagination } from "../../components/list-pagination";
import type { WhatsAppLogRow } from "@/app/actions/whatsapp-log-actions";

const RANGES: { value: string; label: string }[] = [
  { value: "0", label: "All time" },
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
];

const STATUS_LABEL: Record<string, string> = {
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  skipped: "Not sent",
};

const STATUS_STYLE: Record<string, string> = {
  sent: "text-[var(--dash-text-2)]",
  delivered: "text-emerald-700 dark:text-emerald-400",
  read: "text-emerald-700 dark:text-emerald-400",
  failed: "text-red-700 dark:text-red-400",
  skipped: "text-amber-700 dark:text-amber-400",
};

const STATUS_DOT: Record<string, string> = {
  sent: "bg-neutral-400",
  delivered: "bg-emerald-500",
  read: "bg-emerald-600",
  failed: "bg-red-500",
  skipped: "bg-amber-500",
};

/** The latest point reached on the timeline, with when. */
function timelineLabel(row: WhatsAppLogRow): string {
  if (row.status === "read" && row.read_at)
    return `Read ${formatWhen(row.read_at)}`;
  if (row.status === "delivered" && row.delivered_at)
    return `Delivered ${formatWhen(row.delivered_at)}`;
  if (row.status === "failed" && row.failed_at)
    return `Failed ${formatWhen(row.failed_at)}`;
  return STATUS_LABEL[row.status] ?? row.status;
}

export function WhatsAppLogsView({
  rows,
  total,
  counts,
  page,
  pageSize,
  status,
  q,
  days,
  error,
}: {
  rows: WhatsAppLogRow[];
  total: number;
  counts: {
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    skipped: number;
  };
  page: number;
  pageSize: number;
  status: string;
  q: string;
  days: number;
  error?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(q);
  const [openId, setOpenId] = useState<string | null>(null);

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== "0") params.set(key, value);
    else params.delete(key);
    if (key !== "page") params.delete("page");
    startTransition(() => {
      router.push(`/dashboard/logs/whatsapp-logs?${params.toString()}`);
    });
  };

  const open = rows.find((r) => r.id === openId) ?? null;

  return (
    <div className="dash-page-enter flex flex-col gap-4">
      <header className="dash-page-header row">
        <div>
          <h1>WhatsApp logs</h1>
          <p>
            Every message sent on your WhatsApp number, with its delivery status
            from Meta.
          </p>
        </div>
      </header>

      <section className="dash-card">
        <div className="dash-card-header flex-wrap gap-3">
          <form
            className="relative min-w-[220px] flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setParam("q", search.trim());
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--dash-text-3)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search messages"
              aria-label="Search WhatsApp logs"
              className="w-full rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] py-[7px] pl-9 pr-3 text-[13px] text-[var(--dash-text)] outline-none"
            />
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={status}
              onChange={(e) => setParam("status", e.target.value)}
              disabled={isPending}
              className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-[7px] text-[13px] text-[var(--dash-text)] outline-none"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="sent">Sent ({counts.sent})</option>
              <option value="delivered">Delivered ({counts.delivered})</option>
              <option value="read">Read ({counts.read})</option>
              <option value="failed">Failed ({counts.failed})</option>
              <option value="skipped">Not sent ({counts.skipped})</option>
            </select>

            <select
              value={String(days || 0)}
              onChange={(e) => setParam("days", e.target.value)}
              disabled={isPending}
              className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-[7px] text-[13px] text-[var(--dash-text)] outline-none"
              aria-label="Filter by date"
            >
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error ? (
          <p className="px-5 py-8 text-center text-[13px] text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-[var(--dash-text-3)]">
            <MessageCircle className="mx-auto mb-2 h-5 w-5 opacity-40" />
            No messages yet.
          </p>
        ) : (
          <div className="dash-table-wrap">
            <ResponsiveTable className="dash-table dash-table-wide">
              <thead>
                <tr>
                  <th>To</th>
                  <th>Notification</th>
                  <th>Template</th>
                  <th>Delivery</th>
                  <th>Sent at</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setOpenId(openId === row.id ? null : row.id)}
                    className="cursor-pointer"
                  >
                    <td className="font-mono text-[12px]">{row.to_phone}</td>
                    <td>{row.event_key ?? "-"}</td>
                    <td className="font-mono text-[12px]">
                      {row.template_name ?? "-"}
                    </td>
                    <td>
                      <span
                        className={`inline-flex items-center gap-1.5 ${
                          STATUS_STYLE[row.status] ?? ""
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            STATUS_DOT[row.status] ?? "bg-neutral-400"
                          }`}
                        />
                        {timelineLabel(row)}
                      </span>
                      {/* The reason lives next to the status, because "failed"
                          on its own is not actionable. */}
                      {row.error && openId === row.id && (
                        <span className="mt-1 block text-[12px] text-[var(--dash-text-3)]">
                          {row.error_code ? `${row.error_code}: ` : ""}
                          {row.error}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {formatWhen(row.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          </div>
        )}

        {/* The body on the row you opened rather than in a drawer — a WhatsApp
            update is a few sentences, so a panel would be more chrome than
            content. */}
        {open && (
          <div className="border-t border-[var(--dash-border)] px-5 py-4">
            <p className="mb-1 text-[12px] font-medium text-[var(--dash-text-2)]">
              Message
            </p>
            <p className="whitespace-pre-wrap text-[13px] text-[var(--dash-text)]">
              {open.body ?? "(not recorded)"}
            </p>
            {(open.sent_at || open.delivered_at || open.read_at) && (
              <p className="mt-2 text-[12px] text-[var(--dash-text-3)]">
                {[
                  open.sent_at && `Sent ${formatWhen(open.sent_at)}`,
                  open.delivered_at &&
                    `delivered ${formatWhen(open.delivered_at)}`,
                  open.read_at && `read ${formatWhen(open.read_at)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {open.pricing_category
                  ? ` · billed by Meta as ${open.pricing_category.toLowerCase().replace(/_/g, " ")}`
                  : ""}
              </p>
            )}
          </div>
        )}

        <ListPagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPage={(p) => setParam("page", String(p))}
        />
      </section>
    </div>
  );
}
