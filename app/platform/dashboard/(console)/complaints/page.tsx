import Link from "next/link";
import { Ban, Plus } from "lucide-react";
import {
  consoleCounts,
  listBlocks,
  listComplaints,
  listHolds,
  type BlockListRow,
  type ComplaintListRow,
  type ConsoleCounts,
  type HoldListRow,
} from "@/lib/moderation/console-read";
import { logError } from "@/lib/observability/logger";
import { loggableError } from "@/lib/db/errors";
import { requireOperator } from "../require-operator";
import {
  BlocksTable,
  ComplaintsTable,
  ComplaintsTabs,
  EMPTY_TEXT,
  EmptyState,
  FilesTable,
  HoldsTable,
  RepliesTable,
  blockItemHref,
  complaintsHref,
  isComplaintsTab,
  type ComplaintsTab,
} from "./complaints-console";

export const metadata = { title: "Complaints · StoreMink Admin" };

// ---------------------------------------------------------------------------
// The complaints list (takedown design 6.2): every complaint, order and data
// request, the blocks made on them, the files still to finish, the store
// holds and the stores waiting for an answer, one tab at a time.
//
// ★ GATED ON ITS OWN with `requireOperator()`: a layout redirect does not
// abort a concurrently rendering page (CODEBASE §39), and these reads run
// across every store under `withService`.
//
// ★ EVERY OPERATOR, member or superadmin, sees the whole list (design 3.10).
//
// ★ A READ THAT FAILS SAYS SO. The counts and the list are read separately,
// so one failing leaves the other on screen, and neither is ever shown as an
// empty list or zeroes.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Listing =
  | { kind: "complaints"; rows: ComplaintListRow[]; total: number }
  | {
      kind: "blocks" | "files" | "replies";
      rows: BlockListRow[];
      total: number;
    }
  | { kind: "holds"; rows: HoldListRow[]; total: number };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readListing(
  tab: ComplaintsTab,
  storeId: string | null,
  page: number,
  now: Date,
): Promise<Listing> {
  const offset = (page - 1) * PAGE_SIZE;
  switch (tab) {
    case "open":
    case "due":
    case "overdue":
    case "resolved": {
      const { rows, total } = await listComplaints({
        view: tab,
        storeId,
        limit: PAGE_SIZE,
        offset,
        now,
      });
      return { kind: "complaints", rows, total };
    }
    case "blocks":
    case "files":
    case "replies": {
      const { rows, total } = await listBlocks({
        view: tab === "blocks" ? "all" : tab,
        storeId,
        limit: PAGE_SIZE,
        offset,
      });
      return { kind: tab, rows, total };
    }
    case "holds": {
      const rows = await listHolds({
        view: "active",
        storeId,
        limit: 200,
        now,
      });
      return { kind: "holds", rows, total: rows.length };
    }
  }
}

export default async function ComplaintsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();

  const sp = await searchParams;
  const rawView = first(sp.view);
  const tab: ComplaintsTab = isComplaintsTab(rawView) ? rawView : "open";
  const rawStore = first(sp.store)?.trim() ?? "";
  const store = UUID.test(rawStore) ? rawStore : null;
  const rawPage = Math.trunc(Number(first(sp.page)));
  const page = Number.isFinite(rawPage) && rawPage > 1 ? rawPage : 1;
  const now = new Date();

  const [counts, listing] = await Promise.all([
    consoleCounts(now).catch((err: unknown): ConsoleCounts | null => {
      logError("complaints console: counts failed", loggableError(err));
      return null;
    }),
    readListing(tab, store, page, now).catch((err: unknown): Listing | null => {
      logError("complaints console: list failed", loggableError(err), {
        tab,
      });
      return null;
    }),
  ]);

  const pages = listing ? Math.max(1, Math.ceil(listing.total / PAGE_SIZE)) : 1;

  return (
    <div className="dash-page-enter">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-[var(--dash-text)]">
            Complaints
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--dash-text-2)]">
            Every complaint, order and data request StoreMink receives, with its
            deadlines. Log each one as soon as it arrives.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/dashboard/complaints/new"
            className="dash-btn dash-btn-primary pointer-coarse:min-h-11"
          >
            <Plus aria-hidden className="h-4 w-4" />
            Log a complaint
          </Link>
          <Link
            href={blockItemHref()}
            className="dash-btn dash-btn-ghost pointer-coarse:min-h-11"
          >
            <Ban aria-hidden className="h-4 w-4" />
            Block an item
          </Link>
        </div>
      </div>

      {store ? (
        <p className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--dash-text-2)]">
          Only one store&apos;s complaints, blocks and holds are shown.
          <Link
            href={complaintsHref({ view: tab })}
            className="font-medium text-[var(--dash-accent)] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
          >
            Show every store
          </Link>
        </p>
      ) : null}

      <ComplaintsTabs tab={tab} counts={counts} store={store} />

      {counts === null ? (
        <p
          role="status"
          className="mb-4 max-w-3xl rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)] bg-[var(--dash-amber-soft)] px-3 py-2 text-sm text-[var(--dash-text)]"
        >
          The counts could not be read just now. Refresh the page to try again.
        </p>
      ) : null}

      <div className="dash-card">
        {listing === null ? (
          <p role="alert" className="px-5 py-6 text-sm text-[var(--dash-text)]">
            This list could not be read just now. Refresh the page to try again.
          </p>
        ) : listing.rows.length === 0 ? (
          <EmptyState text={EMPTY_TEXT[tab]} />
        ) : listing.kind === "complaints" ? (
          <ComplaintsTable rows={listing.rows} now={now} />
        ) : listing.kind === "holds" ? (
          <HoldsTable rows={listing.rows} now={now} />
        ) : listing.kind === "files" ? (
          <FilesTable rows={listing.rows} now={now} />
        ) : listing.kind === "replies" ? (
          <RepliesTable rows={listing.rows} now={now} />
        ) : (
          <BlocksTable rows={listing.rows} now={now} />
        )}
      </div>

      {listing && pages > 1 ? (
        <nav
          aria-label="Pages"
          className="mt-4 flex items-center justify-between gap-3 text-sm text-[var(--dash-text-2)]"
        >
          {page > 1 ? (
            <Link
              href={complaintsHref({ view: tab, store, page: page - 1 })}
              className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
            >
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span>
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link
              href={complaintsHref({ view: tab, store, page: page + 1 })}
              className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
            >
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
