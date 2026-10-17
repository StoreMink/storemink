// Downloads a model file at image build time and refuses it unless its
// SHA-256 matches the pinned value (docs/image-matting-service.md).
//
//   node fetch-model.mjs <url> <sha256> <destination>
//
// ★ THE HASH IS THE TRUST, NOT THE URL. The BiRefNet release publishes no
// checksums, and a GitHub release asset can be replaced in place under the
// same name. Pinning what we measured means a changed file fails the build
// instead of quietly shipping a different model.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const [url, expected, destination] = process.argv.slice(2);
if (!url || !/^[a-f0-9]{64}$/.test(expected ?? "") || !destination) {
  console.error("Usage: node fetch-model.mjs <url> <sha256> <destination>");
  process.exit(2);
}

const partial = `${destination}.partial`;
await mkdir(dirname(destination), { recursive: true });

const response = await fetch(url, { redirect: "follow" });
if (!response.ok || !response.body) {
  console.error(`Download failed: HTTP ${response.status} for ${url}`);
  process.exit(1);
}

const hash = createHash("sha256");
let bytes = 0;
const counted = Readable.fromWeb(response.body).on("data", (chunk) => {
  hash.update(chunk);
  bytes += chunk.length;
});
await pipeline(counted, createWriteStream(partial));

const actual = hash.digest("hex");
if (actual !== expected) {
  await rm(partial, { force: true });
  console.error(
    `SHA-256 mismatch for ${url}\n  expected ${expected}\n  got      ${actual}`,
  );
  process.exit(1);
}
await rename(partial, destination);
console.log(`Fetched ${bytes} bytes, SHA-256 ${actual}`);
