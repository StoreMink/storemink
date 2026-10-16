// Whether next/image may optimise a URL, mirroring `images.remotePatterns` in
// next.config.ts. Client-safe.
//
// ★ A PRODUCT PHOTO CAN LIVE ANYWHERE. Rows written before the GCS migration
//   still point at the old Supabase host, a CSV import can name any https
//   image, and theme seeds use site paths. next/image THROWS on a host that is
//   not configured, which takes the whole page down, so a URL outside the list
//   is rendered `unoptimized` (a plain request for the original file).
const OPTIMIZABLE_HOSTS = new Set([
  "storage.googleapis.com",
  "images.unsplash.com",
]);

export function canOptimizeImage(src: string | null | undefined): boolean {
  if (!src) return false;
  if (src.startsWith("/") && !src.startsWith("//")) return true;
  try {
    const url = new URL(src);
    return url.protocol === "https:" && OPTIMIZABLE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
