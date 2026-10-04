import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  minkCsvFiles,
  dataJobs,
  dataJobPayloads,
  dataJobIssues,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { getResource } from "@/lib/import-export/resources";
import { rateLimit } from "@/lib/rate-limit";
import { MinkRequestError } from "./errors";
import type { MinkActorContext, MinkArtifact } from "./types";
import {
  correctMinkCsv,
  deriveMinkCsvHandles,
  inspectMinkCsv,
  validateMinkCsv,
  type MinkCsvPatch,
  type MinkCsvHeaderChange,
} from "./csv-input";

export function assertMinkImportAuthority(actor: MinkActorContext) {
  if (
    !actor.draftingEnabled ||
    !can(actor.permissions, "products", "manage", actor.isSuperadmin)
  )
    throw new MinkRequestError(
      "import_forbidden",
      "You need permission to manage products to import a product CSV.",
      403,
    );
}
async function reserveCsvVersion(actor: MinkActorContext) {
  for (const [suffix, max, windowSeconds] of [
    ["hour", 30, 3600],
    ["day", 100, 86400],
  ] as const) {
    const limit = await rateLimit(
      `mink-csv-version:${actor.storeId}:${suffix}`,
      { max, windowSeconds },
    );
    if (!limit.allowed)
      throw new MinkRequestError(
        "csv_limited",
        "This store has reached its CSV upload/correction limit. Try again later.",
        429,
      );
  }
}
const owner = (actor: MinkActorContext, id: string) =>
  and(
    eq(minkCsvFiles.id, id),
    eq(minkCsvFiles.storeId, actor.storeId),
    eq(minkCsvFiles.adminId, actor.adminId),
  );
async function readFile(db: Db, actor: MinkActorContext, id: string) {
  const [file] = await db
    .select()
    .from(minkCsvFiles)
    .where(owner(actor, id))
    .limit(1);
  if (!file || Date.parse(file.createdAt) < Date.now() - 7 * 86400000)
    throw new MinkRequestError(
      "csv_missing",
      "This private CSV is unavailable or has expired. Attach it again.",
      404,
    );
  return file;
}
export async function uploadMinkCsv(
  actor: MinkActorContext,
  id: string,
  filename: string,
  text: string,
) {
  assertMinkImportAuthority(actor);
  validateMinkCsv(text);
  await reserveCsvVersion(actor);
  return withService(async (db) => {
    await db
      .insert(minkCsvFiles)
      .values({
        id,
        storeId: actor.storeId,
        adminId: actor.adminId,
        filename,
        csv: text,
      })
      .onConflictDoNothing();
    const file = await readFile(db, actor, id);
    if (file.csv !== text || file.filename !== filename)
      throw new MinkRequestError(
        "csv_conflict",
        "That upload key belongs to a different file.",
        409,
      );
    return { id: file.id, filename: file.filename };
  });
}
export async function getMinkCsv(actor: MinkActorContext, id: string) {
  assertMinkImportAuthority(actor);
  return withService(async (db) => {
    const file = await readFile(db, actor, id);
    const [job] = file.jobId
      ? await db
          .select()
          .from(dataJobs)
          .where(
            and(
              eq(dataJobs.id, file.jobId),
              eq(dataJobs.storeId, actor.storeId),
              eq(dataJobs.createdBy, actor.adminId),
            ),
          )
          .limit(1)
      : [];
    const issues = job
      ? await db
          .select({
            line: dataJobIssues.line,
            column: dataJobIssues.columnName,
            severity: dataJobIssues.severity,
            message: dataJobIssues.message,
            value: dataJobIssues.value,
          })
          .from(dataJobIssues)
          .where(
            and(
              eq(dataJobIssues.jobId, job.id),
              eq(dataJobIssues.storeId, actor.storeId),
            ),
          )
          .orderBy(asc(dataJobIssues.line))
          .limit(50)
      : [];
    return { file, job: job ?? null, issues };
  });
}
export async function previewMinkCsv(
  actor: MinkActorContext,
  id: string,
  offset = 0,
) {
  const { file, job, issues: jobIssues } = await getMinkCsv(actor, id);
  const checked = inspectMinkCsv(file.csv);
  const artifact: Extract<MinkArtifact, { type: "product_import" }> = {
    type: "product_import",
    fileId: file.id,
    filename: file.filename,
    rows: checked.csv.rows.length,
    errorCount: checked.errorCount,
    warningCount: checked.warningCount,
    issues: checked.issues
      .slice(0, 50)
      .map((issue) => ({ ...issue, value: issue.value?.slice(0, 300) })),
    changes: Array.isArray(file.changes) ? (file.changes as string[]) : [],
    jobId: job?.id ?? null,
  };
  const previewRows: Array<{
    line: number;
    cells: string[];
    truncatedColumns: number[];
  }> = [];
  let budget = 8000;
  for (const row of checked.csv.rows.slice(offset, offset + 20)) {
    const item = {
      line: row.line,
      cells: row.cells.map((cell) => cell.slice(0, 80)),
      truncatedColumns: row.cells.flatMap((cell, index) =>
        cell.length > 80 ? [index] : [],
      ),
    };
    const size = JSON.stringify(item).length;
    if (previewRows.length && size > budget) break;
    previewRows.push(item);
    budget -= size;
  }
  const nextOffset =
    offset + previewRows.length < checked.csv.rows.length
      ? offset + previewRows.length
      : null;
  return {
    artifact,
    header: checked.csv.header,
    rows: previewRows,
    nextOffset,
    columns: getResource("products")!.columns.map((column) => ({
      key: column.key,
      type: column.type,
      required: column.required,
      enumValues: column.enumValues,
      help: column.help,
      readOnly: column.readOnly,
    })),
    job: job
      ? {
          id: job.id,
          status: job.status,
          processedRows: job.processedRows,
          created: job.createdCount,
          updated: job.updatedCount,
          skipped: job.skippedCount,
          failed: job.failedCount,
          error: job.error,
          droppedIssues: job.droppedIssues,
          issues: jobIssues,
        }
      : null,
  };
}
export async function correctMinkProductCsv(
  actor: MinkActorContext,
  id: string,
  patches: MinkCsvPatch[],
  headers: MinkCsvHeaderChange[],
  deriveHandles = false,
  addColumns: string[] = [],
) {
  const { file, job } = await getMinkCsv(actor, id);
  if (job && ["pending", "running"].includes(job.status))
    throw new MinkRequestError(
      "csv_running",
      "Wait for the import to finish before correcting failed rows.",
      409,
    );
  // Corrections address lines from this version, then select only the original
  // failed/unprocessed rows. Selecting after serialization would change line numbers.
  const original = validateMinkCsv(file.csv);
  let text = correctMinkCsv(file.csv, patches, headers, addColumns);
  const derived = deriveHandles ? deriveMinkCsvHandles(text) : null;
  if (derived) text = derived.text;
  if (job) {
    const failed = new Set(job.failedLines);
    const retryIndexes = original.rows.flatMap((row, index) =>
      failed.has(row.line) || index >= job.cursor ? [index] : [],
    );
    if (!retryIndexes.length)
      throw new MinkRequestError(
        "csv_no_retry",
        "There are no failed or unprocessed rows to retry.",
        409,
      );
    const corrected = validateMinkCsv(text);
    const selected = retryIndexes.map((index) => corrected.rows[index]);
    // Preserve all cells of those rows; skip every previously successful row.
    const { encodeMinkCsv } = await import("./csv-input");
    text = encodeMinkCsv(
      corrected.header,
      selected.map((row) => row.cells),
    );
  }
  const changes = [
    ...addColumns.map((column) => `Added column ${column}`),
    ...(derived
      ? [
          `Derived ${derived.derived} missing handles from supplied product titles.`,
        ]
      : []),
    ...headers.map((change) => `Column ${change.from} → ${change.to}`),
    ...patches.map(
      (patch) =>
        `Line ${patch.line}, ${patch.column}: ${patch.value.slice(0, 160)}`,
    ),
    ...(job ? ["Retry contains only failed or unprocessed rows."] : []),
  ];
  await reserveCsvVersion(actor);
  const [next] = await withService((db) =>
    db
      .insert(minkCsvFiles)
      .values({
        storeId: actor.storeId,
        adminId: actor.adminId,
        filename: `corrected-${file.filename}`.slice(0, 160),
        csv: text,
        changes,
      })
      .returning({ id: minkCsvFiles.id }),
  );
  return previewMinkCsv(actor, next.id);
}
export async function queueMinkProductImport(
  actor: MinkActorContext,
  id: string,
) {
  assertMinkImportAuthority(actor);
  const limited = await rateLimit(`import:${actor.storeId}`, {
    max: 20,
    windowSeconds: 3600,
  });
  if (!limited.allowed)
    throw new MinkRequestError(
      "import_limited",
      "Give it a few minutes before starting another import.",
      429,
    );
  return withService(async (db) => {
    // The immutable file is the exact human-approved payload. Serialize duplicate
    // clicks; the job and payload commit together or neither exists.
    await db.execute(
      sql`SELECT id FROM public.mink_csv_files WHERE id=${id}::uuid AND store_id=${actor.storeId}::uuid AND admin_id=${actor.adminId} FOR UPDATE`,
    );
    const file = await readFile(db, actor, id);
    if (file.jobId) return { jobId: file.jobId, repeated: true };
    const checked = inspectMinkCsv(file.csv);
    if (checked.errorCount)
      throw new MinkRequestError(
        "csv_errors",
        "Correct the CSV errors before importing. Ask Mink to explain or fix the listed cells.",
        409,
      );
    const [job] = await db
      .insert(dataJobs)
      .values({
        storeId: actor.storeId,
        kind: "import",
        resource: "products",
        status: "pending",
        filename: file.filename,
        totalRows: checked.csv.rows.length,
        createdBy: actor.adminId,
        actorEmail: actor.email,
        options: { create: true, update: false, header: checked.csv.header },
      })
      .returning({ id: dataJobs.id });
    await db.insert(dataJobPayloads).values({
      jobId: job.id,
      storeId: actor.storeId,
      header: checked.csv.header,
      csv: file.csv,
    });
    await db
      .update(minkCsvFiles)
      .set({ jobId: job.id })
      .where(owner(actor, id));
    return { jobId: job.id, repeated: false };
  });
}
