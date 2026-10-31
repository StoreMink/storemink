"use client";

import { useState, useTransition } from "react";
import { Download, Loader2 } from "lucide-react";
import { exportInvoiceList } from "@/app/actions/platform";
import { INVOICE_LIST_CARD, recentIstMonths } from "@/lib/billing/tax-copy";

// ---------------------------------------------------------------------------
// Card 4, the monthly invoice list (GST design 6.6): every invoice StoreMink
// issued in a month, for the accountant's GST returns, saved in the browser as
// a CSV (a Blob download, no route).
//
// ★ SUPERADMIN ONLY. The page renders this card for a superadmin alone, and
// `exportInvoiceList` refuses anyone else: it names every merchant StoreMink
// invoiced, with their GSTINs and what they paid.
// ---------------------------------------------------------------------------

/** How many months before the current one the select offers. */
const PREVIOUS_MONTHS = 24;

/** Save `csv` as `fileName` in the browser. */
export function saveCsv(fileName: string, csv: string): void {
  // The CSV already starts with a byte order mark, so spreadsheet programs
  // read its rupee signs and names as UTF-8.
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Released a moment later: some browsers start reading the file after the
  // click has returned.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function InvoiceListCard({ now }: { now: string }) {
  const months = recentIstMonths(new Date(now), PREVIOUS_MONTHS);
  const [month, setMonth] = useState(months[0]?.value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function download() {
    setError(null);
    start(async () => {
      try {
        const res = await exportInvoiceList(month);
        if ("error" in res) {
          setError(res.error);
          return;
        }
        saveCsv(res.fileName, res.csv);
      } catch {
        setError(INVOICE_LIST_CARD.failed);
      }
    });
  }

  return (
    <section
      aria-labelledby="invoice-list-title"
      className="dash-card mt-6 max-w-3xl p-6"
    >
      <h2
        id="invoice-list-title"
        className="text-base font-semibold text-[var(--dash-text)]"
      >
        {INVOICE_LIST_CARD.title}
      </h2>
      <p className="mt-1 text-sm text-[var(--dash-text-2)]">
        {INVOICE_LIST_CARD.body}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="invoice-list-month">
          Month
        </label>
        <select
          id="invoice-list-month"
          className="dash-input w-56"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          disabled={pending}
        >
          {months.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={download}
          disabled={pending || !month}
          className="dash-btn dash-btn-primary inline-flex items-center gap-2 pointer-coarse:min-h-11"
        >
          {pending ? (
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          ) : (
            <Download aria-hidden className="h-4 w-4" />
          )}
          {pending ? INVOICE_LIST_CARD.preparing : INVOICE_LIST_CARD.download}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--dash-red)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
