import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import {
  TARGET_ERRORS,
  getComplaint,
  resolveTarget,
  type ComplaintPage,
  type ResolvedTarget,
} from "@/lib/moderation/console-read";
import { loggableError } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import { canManage, requireOperator } from "../../require-operator";
import { complaintHref } from "../complaints-console";
import { BlockForm, type BlockFormComplaint } from "./block-form";

// ---------------------------------------------------------------------------
// Block an item (takedown design 6.5, stage T16b).
//
// ★ GATED ON ITS OWN with `requireOperator()` (CODEBASE §39) before any read:
// the complaint and the store are read under `withService`.
//
// ★ READS ARE T13's: `getComplaint` for `?complaint=SM-000123` (the complaint
// page's "Block an item"), and `resolveTarget` for `?store=<id>&kind=store`
// (the store page's "Suspend on a complaint", T17), so the form opens on the
// store already chosen. A whole store is a superadmin's (design 3.10): a
// member who follows that link is told so and nothing is read for them.
// Everything else is found in the form, through `resolveTargetAction`.
//
// ★ A FAILED READ SAYS SO, and a complaint that cannot be read or found
// renders no form: blocking without it would quietly lose the link to the
// complaint the operator meant to act on.
// ---------------------------------------------------------------------------

export const metadata = { title: "Block an item · StoreMink Admin" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
}

const COMPLAINT_NOT_FOUND = "That complaint was not found.";
const COMPLAINT_READ_FAILED =
  "This complaint could not be read just now. Refresh the page to try again.";

function webAddress(urls: string[]): string | null {
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        return url;
      }
    } catch {
      // Not an address; the next one may be.
    }
  }
  return null;
}

function formComplaint(page: ComplaintPage): BlockFormComplaint {
  const c = page.complaint;
  return {
    id: c.id,
    ref: c.ref,
    kind: c.kind,
    storeId: c.storeId,
    storeLabel: c.storeLabel,
    firstUrl: webAddress(c.urls),
  };
}

export default async function BlockItemPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const viewer = await requireOperator();
  const superadmin = canManage(viewer);
  const params = await searchParams;
  const complaintParam = first(params.complaint);
  const storeParam = first(params.store);
  const wholeStore = first(params.kind) === "store" && storeParam !== "";

  let complaint: BlockFormComplaint | null = null;
  let complaintProblem: string | null = null;
  if (complaintParam) {
    try {
      const page = await getComplaint(complaintParam);
      if (page) complaint = formComplaint(page);
      else complaintProblem = COMPLAINT_NOT_FOUND;
    } catch (err) {
      logError(
        "complaints console: complaint read for a block failed",
        loggableError(err),
      );
      complaintProblem = COMPLAINT_READ_FAILED;
    }
  }

  let initialTarget: ResolvedTarget | null = null;
  let initialError: string | null = null;
  const storeRefused = wholeStore && !superadmin;
  if (wholeStore && superadmin && !complaintProblem) {
    try {
      const found = await resolveTarget({ storeId: storeParam, kind: "store" });
      if (!found.ok) initialError = found.error;
      else if (found.found === "target") initialTarget = found.target;
    } catch (err) {
      logError(
        "complaints console: store read for a block failed",
        loggableError(err),
      );
      initialError = TARGET_ERRORS.readFailed;
    }
  }

  return (
    <div className="dash-page-enter mx-auto w-full max-w-3xl">
      <Link
        href={
          complaint ? complaintHref(complaint.ref) : "/dashboard/complaints"
        }
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--dash-text-2)] hover:text-[var(--dash-text)] pointer-coarse:min-h-11"
      >
        <ChevronLeft aria-hidden className="h-4 w-4" />
        {complaint ? `Complaint ${complaint.ref}` : "Complaints"}
      </Link>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[var(--dash-text)]">
          Block an item
        </h1>
      </div>
      {complaintProblem ? (
        <p role="alert" className="text-sm text-[var(--dash-text)]">
          {complaintProblem}
        </p>
      ) : (
        <BlockForm
          superadmin={superadmin}
          complaint={complaint}
          initialTarget={initialTarget}
          initialError={initialError}
          storeRefused={storeRefused}
        />
      )}
    </div>
  );
}
