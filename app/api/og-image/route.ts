import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { GCS_PUBLIC_HOST, GCS_BUCKET_NAME } from "@/lib/storage/gcs";
import {
  blockedMedia,
  isBlockedAddressIn,
  type BlockedMediaSet,
} from "@/lib/moderation/blocked-objects";
import {
  isInvalidMediaAddress,
  isMediaKey,
  mediaKeyFromUrl,
} from "@/lib/moderation/media-key";
import { placeholderWebp } from "@/lib/moderation/placeholder";
import { logError } from "@/lib/observability/logger";

/**
 * OG Image proxy — serves a compressed, WhatsApp-friendly version of any
 * managed GCS storage image.
 *
 * Usage:  /api/og-image?url=<encodeURIComponent(managed_storage_url)>
 *
 * Why this exists:
 *  1. WhatsApp's crawler silently drops og:image when the file is > ~300 KB.
 *  2. This route fetches the original image, compresses it to a small JPEG
 *     via sharp, and returns it with proper cache headers.
 *
 * Caching: no server-side persistence — the `Cache-Control`/`CDN-Cache-Control`
 * headers below let the browser/CDN cache the optimized JPEG, so repeat requests
 * for the same card are served from cache without re-running sharp.
 *
 * Blocked files (takedown design 3.3 step 4, 5.7): the address is put in its
 * normal form (mediaKeyFromUrl) before anything else, so `%2E`, `%2F`, a
 * virtual-hosted bucket or `http` cannot slip a blocked object past the check.
 * An address that cannot be read safely is answered 400. A blocked one is
 * answered with the placeholder as a share card (the same 1200 x 630 JPEG
 * treatment, made once per process from placeholderWebp()) with
 * `Cache-Control: no-store`, and the original is never fetched. The bucket
 * check below also asks for the normal form, so only an address that names an
 * object in our own bucket is ever fetched.
 */

export const runtime = "nodejs";

// A true 1200×630 card — the standard OG ratio (1.91:1) that Facebook,
// Twitter/X and LinkedIn expect, so the width/height we declare in page
// metadata is honest. `contain` + white pad keeps the whole product/cover
// visible (no awkward cropping) while still filling the fixed canvas.
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const JPEG_QUALITY = 70;

const CACHE_HEADERS = {
  "Content-Type": "image/jpeg",
  "Cache-Control":
    "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
  "CDN-Cache-Control": "public, max-age=86400",
  "Access-Control-Allow-Origin": "*",
};

/**
 * The placeholder card is never kept by a browser or a CDN: a cached copy
 * would go on hiding the picture after the block is lifted.
 */
const BLOCKED_HEADERS = {
  "Content-Type": "image/jpeg",
  "Cache-Control": "no-store",
  "CDN-Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

/** Any picture as a share card: 1200 x 630, white padding, small JPEG. */
async function toCard(input: Buffer | Uint8Array): Promise<Buffer> {
  return sharp(input)
    .resize(OG_WIDTH, OG_HEIGHT, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
      withoutEnlargement: true,
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: JPEG_QUALITY, progressive: true })
    .toBuffer();
}

/** The placeholder as a share card, made once per process. */
let placeholderCard: Promise<Buffer> | null = null;

function placeholderCardBytes(): Promise<Buffer> {
  if (placeholderCard === null) {
    const attempt = placeholderWebp().then((bytes) => toCard(bytes));
    placeholderCard = attempt;
    // A failure is not kept: the next request tries again.
    attempt.catch(() => {
      if (placeholderCard === attempt) placeholderCard = null;
    });
  }
  return placeholderCard;
}

/** The answer for a blocked picture: the placeholder card, never the file. */
async function blockedCard(): Promise<NextResponse> {
  try {
    const card = await placeholderCardBytes();
    // Every response gets its own copy of the bytes.
    return new NextResponse(new Uint8Array(card), {
      status: 200,
      headers: BLOCKED_HEADERS,
    });
  } catch (error) {
    logError("og-image: placeholder card could not be made", error);
    return NextResponse.json(
      { error: "Image not available" },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "CDN-Cache-Control": "no-store",
        },
      },
    );
  }
}

/**
 * Whether the address names a blocked file, as given or as the WHATWG URL
 * parser writes it (which is what fetch() would ask for).
 */
function isBlockedAddress(set: BlockedMediaSet, url: string): boolean {
  if (isBlockedAddressIn(set, url)) return true;
  try {
    return isBlockedAddressIn(set, new URL(url).href);
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");

  if (!url) {
    return NextResponse.json(
      { error: "Missing ?url= parameter" },
      { status: 400 },
    );
  }

  // Normal form first: an unreadable address is refused, a blocked one gets
  // the placeholder and is never fetched.
  const media = mediaKeyFromUrl(url, { bucket: GCS_BUCKET_NAME });
  if (isInvalidMediaAddress(media)) {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  if (isBlockedAddress(await blockedMedia(), url)) return blockedCard();

  // Only allow proxying our OWN managed media (Google Cloud Storage). Parse and
  // validate STRUCTURALLY — a substring test (`url.includes("googleapis.com")`)
  // is trivially bypassable with a URL like
  // `http://169.254.169.254/?x=storage.googleapis.com`, turning this fetch()
  // into an SSRF vector against internal/metadata hosts. Scope strictly to the
  // configured bucket so this can't proxy arbitrary public GCS objects.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  const isGcs =
    parsed.hostname === GCS_PUBLIC_HOST &&
    GCS_BUCKET_NAME !== null &&
    parsed.pathname.startsWith(`/${GCS_BUCKET_NAME}/`) &&
    isMediaKey(media) &&
    media.source === "bucket";
  if (parsed.protocol !== "https:" || !isGcs) {
    return NextResponse.json(
      { error: "Only managed storage URLs are allowed" },
      { status: 403 },
    );
  }

  // Cheap guard against cache-busting floods hammering sharp. Generous because
  // legitimate social crawlers may fan out across pages.
  const { allowed } = await rateLimit(`og:${clientIp(request.headers)}`, {
    max: 120,
    windowSeconds: 60,
  });
  if (!allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Fetch the original, compress, and return (cached by the response headers).
  try {
    const upstream = await fetch(url, { headers: { Accept: "image/*" } });
    if (!upstream.ok) {
      return NextResponse.json(
        { error: "Upstream image not found" },
        { status: upstream.status },
      );
    }

    const inputBuffer = Buffer.from(await upstream.arrayBuffer());
    const optimized = await toCard(inputBuffer);

    return new NextResponse(new Uint8Array(optimized), {
      status: 200,
      headers: CACHE_HEADERS,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch or process image" },
      { status: 502 },
    );
  }
}
