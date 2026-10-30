import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireOperator } from "../../require-operator";
import { istNowForInput } from "../complaints-console";
import { ComplaintForm } from "./complaint-form";

export const metadata = { title: "Log a complaint · StoreMink Admin" };

// ---------------------------------------------------------------------------
// Log a complaint (takedown design 6.3). Every operator may log one (design
// 3.10). Gated on its own with `requireOperator()` (CODEBASE §39).
// ---------------------------------------------------------------------------

export default async function NewComplaintPage() {
  await requireOperator();
  return (
    <div className="dash-page-enter mx-auto w-full max-w-3xl">
      <Link
        href="/dashboard/complaints"
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--dash-text-2)] hover:text-[var(--dash-text)] pointer-coarse:min-h-11"
      >
        <ChevronLeft aria-hidden className="h-4 w-4" />
        Complaints
      </Link>
      <h1 className="mb-5 text-2xl font-bold text-[var(--dash-text)]">
        Log a complaint
      </h1>
      <ComplaintForm maxReceivedAt={istNowForInput()} />
    </div>
  );
}
