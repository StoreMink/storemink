"use client";
import { useEffect, useState } from "react";
import type { MinkArtifact } from "@/lib/mink/types";
import { MinkLink } from "./mink-link";
type ImportArtifact = Extract<MinkArtifact, { type: "product_import" }>;
type Job = {
  id: string;
  status: string;
  processedRows: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  error: string | null;
  droppedIssues: number;
  issues: ImportArtifact["issues"];
};
export function MinkProductImportCard({
  artifact,
  onPrompt,
  promptDisabled,
}: {
  artifact: ImportArtifact;
  onPrompt?: (prompt: string) => void;
  promptDisabled: boolean;
}) {
  const [current, setCurrent] = useState(artifact);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch(
          `/api/mink/product-imports/${artifact.fileId}`,
          { cache: "no-store", signal: controller.signal },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Could not check this import.");
        setCurrent(data.artifact);
        setJob(data.job);
        setError("");
        if (data.job && ["pending", "running"].includes(data.job.status))
          timer = setTimeout(load, 3000);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not check this import.",
          );
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [artifact.fileId, busy]);
  async function start() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/mink/product-imports/${artifact.fileId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed: true }),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Could not start the import.");
      setCurrent((old) => ({ ...old, jobId: data.jobId }));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start the import.",
      );
    } finally {
      setBusy(false);
    }
  }
  const issues = job ? job.issues : current.issues;
  const running = job && ["pending", "running"].includes(job.status);
  return (
    <section className="rounded-xl border border-[#e5def6] bg-white p-3 text-xs">
      <h3 className="font-semibold">Product CSV: {current.filename}</h3>
      <p className="mt-1">
        {current.rows.toLocaleString()} rows · {current.errorCount} validation
        errors · {current.warningCount} warnings
      </p>
      <p className="mt-2 text-[#666]">
        Imports new products only; existing handles are skipped. Rows with
        Status published go live. Closing chat doesn&apos;t stop a queued
        import.
      </p>
      {current.changes.length > 0 && (
        <details className="mt-2">
          <summary>Review {current.changes.length} corrections</summary>
          <ul className="list-disc space-y-1 pl-4">
            {current.changes.map((change, index) => (
              <li key={index}>{change}</li>
            ))}
          </ul>
        </details>
      )}
      {job && (
        <p role="status" className="mt-2 font-medium">
          {job.status}: {job.processedRows} rows processed · {job.created}{" "}
          products created · {job.skipped} skipped · {job.failed} failed
        </p>
      )}
      {job?.error && <p className="mt-2 text-red-700">{job.error}</p>}
      {issues.length > 0 && (
        <details className="mt-2" open>
          <summary>
            {job ? "Import issues" : "Validation issues"} (up to 50 shown)
          </summary>
          <ul className="mt-1 space-y-1">
            {issues.map((issue, index) => (
              <li
                key={index}
                className={
                  issue.severity === "error" ? "text-red-700" : "text-amber-700"
                }
              >
                {issue.line ? `Line ${issue.line}` : "File"}
                {issue.column ? `, ${issue.column}` : ""}: {issue.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {job?.droppedIssues ? (
        <p className="mt-2">
          Some issues were omitted from the job log. Failed-row retries still
          include every failed row.
        </p>
      ) : null}
      {error && (
        <p role="alert" className="mt-2 text-red-700">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-3">
        <MinkLink
          className="text-[#5b3fd0] underline"
          href={`/api/mink/product-imports/${artifact.fileId}?download=1`}
        >
          Download CSV
        </MinkLink>
        {current.jobId ? (
          <MinkLink
            className="text-[#5b3fd0] underline"
            href={`/dashboard/logs/import-export/${current.jobId}`}
          >
            Import details
          </MinkLink>
        ) : (
          <button
            type="button"
            className="rounded-lg bg-[#6d4dff] px-3 py-2 text-white disabled:opacity-40"
            disabled={busy || !!error || current.errorCount > 0}
            onClick={() => void start()}
          >
            {busy ? "Starting…" : "Approve and import new products"}
          </button>
        )}
        {onPrompt && !running && (
          <button
            type="button"
            className="text-[#5b3fd0] underline"
            disabled={promptDisabled}
            onClick={() =>
              onPrompt(
                `Inspect product CSV attachment ${artifact.fileId}${job ? " and the completed import errors. Correct only failed or unprocessed rows using unambiguous fixes; ask me for missing facts, then prepare a retry import card." : ". Explain each error and correct unambiguous CSV mistakes. Ask me for missing facts, then prepare a corrected import card."}`,
              )
            }
          >
            Ask Mink to check and correct
          </button>
        )}
      </div>
    </section>
  );
}
