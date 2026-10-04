import sharp from "sharp";

/** Applies only in the isolated worker containers, never to merchant image
 * serving. Bound native decoding/cache alongside the container's memory cap. */
export function configureWorkerImages() {
  if (process.env.THEME_STUDIO_WORKER_ONLY !== "true") return;
  sharp.concurrency(1);
  sharp.cache({ memory: 16, files: 0, items: 32 });
}
