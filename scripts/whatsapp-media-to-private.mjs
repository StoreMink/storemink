#!/usr/bin/env node

// ---------------------------------------------------------------------------
// Move WhatsApp chat media out of the PUBLIC media bucket into the private one.
//
// Before migration 0211's release, inbound photos, voice notes and PDFs (and
// files staff sent from the inbox) were stored in the public media bucket
// under stores/{store}/whatsapp/{conversation}/. That bucket granted allUsers
// objectViewer, which included LISTING, so anyone could enumerate and
// download them. Since the storage release (owner step P1) it grants
// roles/storage.legacyObjectReader (get, no list), so a file can no longer be
// found by listing, but anyone holding its URL can still read it. New files
// go to the private bucket; this moves the old ones, keeping the same path,
// so the inbox's media route finds them there and
// whatsapp_messages.media_path needs no rewrite.
//
// Dry run by default (lists what it would move). `--commit` copies each
// object server-side, checks the copy's size, then deletes the public one.
// Re-running is safe: an object already in the private bucket with the same
// size is not copied again, and its public copy is still removed.
//
//   GCS_BUCKET=storemink-media GCS_PRIVATE_BUCKET=storemink-chat-media \
//     npm run whatsapp:media-to-private -- --commit
//
// Auth is Application Default Credentials (`gcloud auth application-default
// login`), with storage.objects.get/list/delete on the public bucket and
// storage.objects.create/get on the private one.
// ---------------------------------------------------------------------------

import { Storage } from "@google-cloud/storage";

const argv = process.argv.slice(2);
const commit = argv.includes("--commit");
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const from = flag("from") ?? process.env.GCS_BUCKET;
const to = flag("to") ?? process.env.GCS_PRIVATE_BUCKET;
if (!from || !to) {
  console.error(
    "Set GCS_BUCKET and GCS_PRIVATE_BUCKET (or pass --from= and --to=).",
  );
  process.exit(2);
}
if (from === to) {
  console.error("The public and private buckets must be different.");
  process.exit(2);
}

const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
const source = storage.bucket(from);
const target = storage.bucket(to);

// Chat media only: stores/<store id>/whatsapp/<conversation id>/<file>.
const CHAT_PATH = /^stores\/[0-9a-f-]{36}\/whatsapp\/[0-9a-f-]{36}\/[^/]+$/i;

let seen = 0;
let moved = 0;
let skipped = 0;
let failed = 0;

const [files] = await source.getFiles({ matchGlob: "stores/*/whatsapp/**" });
for (const file of files) {
  if (!CHAT_PATH.test(file.name)) continue;
  seen++;
  const size = Number(file.metadata.size ?? 0);
  if (!commit) {
    console.log(`would move ${file.name} (${size} bytes)`);
    continue;
  }
  try {
    const copy = target.file(file.name);
    const [exists] = await copy.exists();
    let copiedSize = -1;
    if (exists) {
      const [meta] = await copy.getMetadata();
      copiedSize = Number(meta.size ?? -1);
    }
    if (copiedSize !== size) {
      await file.copy(copy);
      const [meta] = await copy.getMetadata();
      copiedSize = Number(meta.size ?? -1);
    } else {
      skipped++;
    }
    if (copiedSize !== size) {
      throw new Error(`copy is ${copiedSize} bytes, source is ${size}`);
    }
    await file.delete({ ignoreNotFound: true });
    moved++;
  } catch (err) {
    failed++;
    console.error(
      `failed ${file.name}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

console.log(
  commit
    ? `Moved ${moved} of ${seen} chat files (${skipped} were already copied, ${failed} failed).`
    : `Dry run: ${seen} chat files would move from ${from} to ${to}. Re-run with --commit.`,
);
process.exit(failed > 0 ? 1 : 0);
