import { after, NextResponse } from "next/server";
import { serializeCsv } from "@/lib/csv/serialize";
import { validateMinkCsv } from "@/lib/mink/csv-input";
import { getMinkConfig } from "@/lib/mink/config";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";
import {
  getMinkCsv,
  previewMinkCsv,
  queueMinkProductImport,
} from "@/lib/mink/product-imports";
import { MinkRequestError } from "@/lib/mink/errors";
import { triggerImportWorker } from "@/lib/import-export/trigger";
import { emitEvent } from "@/lib/notifications/record";
import { logError } from "@/lib/observability/logger";
export const runtime = "nodejs";
const json = (value: unknown, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store, private" },
  });
type Context = { params: Promise<{ fileId: string }> };
async function handle(request: Request, context: Context, execute: boolean) {
  const origin = rejectForeignMinkOrigin(request);
  if (origin) return origin;
  if (!getMinkConfig().enabled)
    return json({ error: "Mink AI is not enabled." }, 404);
  try {
    const { fileId } = await context.params;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        fileId,
      )
    )
      return json({ error: "Invalid CSV attachment." }, 400);
    const actor = await getMinkActorContext(crypto.randomUUID());
    if (execute) {
      const body = (await readMinkBoundedJson(
        request,
        1024,
        request.signal,
      )) as Record<string, unknown>;
      if (!body || body.confirmed !== true || Object.keys(body).length !== 1)
        return json({ error: "Approve the exact CSV before importing." }, 400);
      const result = await queueMinkProductImport(actor, fileId);
      if (!result.repeated)
        emitEvent({
          type: "data.import_started",
          storeId: actor.storeId,
          actor: { type: "admin", id: actor.adminId, label: actor.email },
          subject: { type: "product", id: result.jobId, label: "Products" },
          payload: { resource: "Products", source: "mink_ai" },
        });
      after(() => triggerImportWorker());
      return json(result);
    }
    if (new URL(request.url).searchParams.get("download") === "1") {
      const { file } = await getMinkCsv(actor, fileId);
      const csv = validateMinkCsv(file.csv);
      return new Response(
        serializeCsv(
          csv.header,
          csv.rows.map((row) => row.cells),
        ),
        {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition":
              "attachment; filename=corrected-products.csv",
            "Cache-Control": "no-store, private",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }
    const result = await previewMinkCsv(actor, fileId);
    return json({ artifact: result.artifact, job: result.job });
  } catch (error) {
    if (error instanceof MinkRequestError)
      return json({ error: error.message }, error.status);
    logError("mink.csv request failed", error);
    return json({ error: "Could not complete the CSV request." }, 503);
  }
}
export const GET = (request: Request, context: Context) =>
  handle(request, context, false);
export const POST = (request: Request, context: Context) =>
  handle(request, context, true);
