import { NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth/server-user";
import { rateLimit } from "@/lib/rate-limit";
import { gcsConfigured, gcsUploadObject } from "@/lib/storage/gcs";
import { processImageUpload } from "@/lib/storage/process-image";
import { logError } from "@/lib/observability/logger";
import { storeUploadPath } from "@/lib/storage/paths";
import { writeStoreObject } from "@/lib/storage/store-objects";
import { resolveUploadOwner } from "@/lib/storage/upload-owner";
import { uploadRefusal } from "@/lib/moderation/copy";
import { isBlockedUploadError } from "@/lib/moderation/upload-guard";

// Run on the Node runtime: uploads are optimized with sharp and stored to
// Google Cloud Storage server-side.
export const runtime = "nodejs";

/** Where an operator's upload on the platform host goes. */
const PLATFORM_UPLOAD_ROOT = "platform/uploads/";

/**
 * An operator's upload on the platform host: `platform/uploads/...` is not a
 * store object, so it is the one write here that does not go through
 * `writeStoreObject` (which refuses any path outside `stores/` and
 * `theme-releases/`, takedown plan A8). Nothing a store shows lives under it,
 * and every store's upload goes through the re-upload guard below.
 */
async function writePlatformUpload(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  if (!path.startsWith(PLATFORM_UPLOAD_ROOT)) {
    throw new Error("upload: a platform upload must stay under platform/.");
  }
  return gcsUploadObject(path, bytes, contentType);
}

export async function POST(request: Request) {
  // Require an authenticated user (admins for dashboard, logged-in customers
  // for blog covers). Prevents anonymous abuse of the media bucket.
  const user = await getServerUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const owner = await resolveUploadOwner(user);
  if (!owner) {
    return NextResponse.json(
      { error: "You don't have access to upload here." },
      { status: 403 },
    );
  }

  // Throttle per user — image processing is CPU-bound, so cap how fast a single
  // account can drive uploads. 60 / minute is generous for real editing.
  const { allowed } = await rateLimit(`upload:${user.id}`, {
    max: 60,
    windowSeconds: 60,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many uploads. Please slow down and try again shortly." },
      { status: 429 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid upload payload." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  const folder = (form.get("folder") as string) || "";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }

  // Validate + optimize (shared with the media-library action).
  const processed = await processImageUpload(file);
  if (!processed.ok) {
    return NextResponse.json(
      { error: processed.error },
      { status: processed.status },
    );
  }
  const { bytes, contentType, ext } = processed.data;

  const fileName = `${Math.random().toString(36).substring(2, 12)}_${Date.now()}.${ext}`;
  const filePath = storeUploadPath(
    owner.kind === "store" ? owner.storeId : null,
    folder,
    fileName,
  );

  if (!gcsConfigured) {
    logError("upload: GCS not configured", new Error("GCS_BUCKET unset"), {
      path: filePath,
    });
    return NextResponse.json(
      { error: "Uploads are not configured." },
      { status: 500 },
    );
  }
  try {
    // A store's upload passes the re-upload guard: bytes StoreMink has
    // blocked are refused (takedown design 5.7, 7.4).
    const url =
      owner.kind === "store"
        ? await writeStoreObject(filePath, bytes, contentType, {
            storeId: owner.storeId,
            via: "upload_route",
            actor: user.id,
          })
        : await writePlatformUpload(filePath, bytes, contentType);
    return NextResponse.json({ url });
  } catch (err) {
    if (isBlockedUploadError(err)) {
      return NextResponse.json(
        {
          // Only the store's own people can open Settings, Notices from
          // StoreMink, so a shopper gets the sentence that names no page.
          error: uploadRefusal({
            told: err.told && owner.kind === "store" && owner.staff,
            kindWord: err.kindWord,
          }),
        },
        { status: 409 },
      );
    }
    logError("upload: GCS upload failed", err, { path: filePath });
    return NextResponse.json(
      { error: "Upload failed. Please try again." },
      { status: 500 },
    );
  }
}
