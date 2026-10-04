import { NextResponse } from "next/server";
import { getMinkConfig } from "@/lib/mink/config";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";
import { uploadMinkCsv } from "@/lib/mink/product-imports";
import { MinkRequestError } from "@/lib/mink/errors";
import { rateLimit } from "@/lib/rate-limit";
import { logError } from "@/lib/observability/logger";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const origin = rejectForeignMinkOrigin(request);
  if (origin) return origin;
  if (!getMinkConfig().enabled)
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  try {
    const actor = await getMinkActorContext(crypto.randomUUID());
    const limit = await rateLimit(
      `mink-csv:${actor.storeId}:${actor.adminId}`,
      { max: 15, windowSeconds: 60 },
    );
    if (!limit.allowed)
      throw new MinkRequestError(
        "csv_limited",
        "Wait a moment before uploading another CSV.",
        429,
      );
    const value = (await readMinkBoundedJson(
      request,
      11 * 1024 * 1024,
      AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
    )) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !["id", "filename", "csv"].includes(key),
      ) ||
      typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.id,
      ) ||
      typeof value.filename !== "string" ||
      !/\.csv$/i.test(value.filename) ||
      value.filename.length > 160 ||
      typeof value.csv !== "string"
    )
      throw new MinkRequestError(
        "csv_invalid",
        "Choose a product CSV file.",
        400,
      );
    let file;
    try {
      file = await uploadMinkCsv(actor, value.id, value.filename, value.csv);
    } catch (error) {
      if (error instanceof MinkRequestError) throw error;
      if (error instanceof Error && /Upload|Split/.test(error.message))
        throw new MinkRequestError("csv_invalid", error.message, 400);
      throw error;
    }
    return NextResponse.json(
      { file },
      { headers: { "Cache-Control": "no-store, private" } },
    );
  } catch (error) {
    if (error instanceof MinkRequestError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    logError("mink.csv upload failed", error);
    return NextResponse.json(
      { error: "Could not save this CSV. Try again." },
      { status: 503 },
    );
  }
}
