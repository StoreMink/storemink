#!/usr/bin/env node

// ---------------------------------------------------------------------------
// Set the stored Cache-Control of existing objects in a public media bucket
// (content takedown release, decision D4, production step P2).
//
// New public objects are written `public, max-age=60` (lib/storage/gcs.ts,
// DEFAULT_PUBLIC_CACHE_CONTROL), so a file StoreMink blocks stops being served
// from a browser or an edge copy within a minute. Objects stored before that
// carry whatever they were written with, often a year. This script changes
// only that metadata field: no byte of any object is rewritten.
//
//   node scripts/storage-cache-control.mjs --bucket <bucket> \
//     --prefix stores/ --cache-control "public, max-age=60"
//   ...the same with --commit
//   node scripts/storage-cache-control.mjs --restore <the csv> [--commit]
//
// Rules:
// - A dry run by default: it lists, counts and prints examples, and writes
//   nothing. --commit changes objects.
// - The bucket and every prefix are arguments; there is no default, so it
//   can never act on a bucket nobody named.
// - An object already carrying the value is skipped. So is a takedown
//   placeholder (custom metadata `storemink-takedown`, Cache-Control
//   `no-store`, lib/moderation/storage.ts), which must stay uncacheable, and
//   any object whose Cache-Control says `no-store` or `private`: making either
//   publicly cacheable is not this script's decision. Both are listed.
// - ★ With --commit, every object it is about to change is written to a CSV
//   (bucket, object, generation, metageneration, previous and new value),
//   and the file is flushed to disk and closed BEFORE the first object is
//   changed. A run that dies part way leaves a complete list of what it may
//   have changed. The file is created new (never overwritten), in --out (the
//   current directory by default), named
//   storage-cache-control-<bucket>-<prefixes>-<UTC time>.csv.
// - Each change carries the generation and metageneration it was listed
//   with, so an object replaced or edited since the listing is left alone and
//   reported, never overwritten.
// - --restore <csv> puts each object's previous value back (no value at all
//   when it had none), only when the object is still the same generation and
//   still carries exactly what this script set; anything else is reported
//   and left alone. A dry run unless --commit.
// - Exit status: 0 done, 1 some object failed (or the bucket could not be
//   read), 2 the arguments were refused.
//
// Auth is Application Default Credentials (`gcloud auth application-default
// login`), with storage.objects.list, get and update on the bucket. The
// storage client is a parameter of `main`, so the test never reaches a
// network.
// ---------------------------------------------------------------------------

import { realpathSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The custom metadata key every takedown placeholder carries. */
export const TAKEDOWN_METADATA_KEY = "storemink-takedown";

/** The CSV's columns, in order. A restore refuses any other header. */
export const CSV_COLUMNS = [
  "bucket",
  "object",
  "generation",
  "metageneration",
  "previous_cache_control",
  "new_cache_control",
];

/** Objects listed per request. */
export const PAGE_SIZE = 1000;

/** Changes in flight at once, unless --concurrency says otherwise. */
export const DEFAULT_CONCURRENCY = 8;

/** Examples printed per category in the summary. */
const EXAMPLES = 5;

export const USAGE = `Usage:
  node scripts/storage-cache-control.mjs --bucket <bucket> --prefix <prefix/> \\
    [--prefix <prefix/> ...] --cache-control "<value>" [--commit] [--out <dir>] \\
    [--concurrency <1 to 32>]
  node scripts/storage-cache-control.mjs --restore <csv> [--commit] \\
    [--concurrency <1 to 32>]

A dry run unless --commit. A prefix ends with "/" (for example stores/).`;

/** The arguments were refused: exit status 2, with the usage text. */
export class UsageError extends Error {}

// ── Arguments ──────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set([
  "bucket",
  "prefix",
  "cache-control",
  "out",
  "concurrency",
  "restore",
]);
const BOOLEAN_FLAGS = new Set(["commit", "help"]);

/**
 * A bucket name as Cloud Storage allows it: 3 to 222 characters of lower-case
 * letters, digits, dots, dashes and underscores, starting and ending with a
 * letter or digit, no two dots together.
 */
export function isBucketName(value) {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 222 &&
    /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(value) &&
    !value.includes("..")
  );
}

/** Why a prefix is refused, or null when it is usable. */
export function prefixProblem(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "A prefix cannot be empty.";
  }
  if (value.length > 512) return "A prefix is at most 512 characters.";
  if (!value.endsWith("/")) {
    return `A prefix ends with "/" (got "${value}"), so it names a folder.`;
  }
  if (value.startsWith("/")) return `A prefix does not start with "/".`;
  if (value.includes("//")) return `A prefix has no empty folder ("//").`;
  if (value.split("/").some((part) => part === "." || part === "..")) {
    return `A prefix has no "." or ".." folder.`;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return "A prefix has no control characters.";
  }
  return null;
}

/** A Cache-Control value: 1 to 256 printable ASCII characters. */
export function isCacheControlValue(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    /^[\x20-\x7e]+$/.test(value)
  );
}

/**
 * The command line as an options object. Accepts `--flag value` and
 * `--flag=value`; --prefix may repeat. Throws UsageError for anything it
 * cannot use, before any storage is touched.
 */
export function parseArgs(argv) {
  const values = new Map();
  const prefixes = [];
  const booleans = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new UsageError(`Unexpected argument "${arg}".`);
    }
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    if (BOOLEAN_FLAGS.has(name)) {
      if (equals !== -1) throw new UsageError(`--${name} takes no value.`);
      booleans.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`Unknown flag --${name}.`);
    let value;
    if (equals !== -1) {
      value = arg.slice(equals + 1);
    } else {
      value = argv[i + 1];
      i += 1;
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--${name} needs a value.`);
      }
    }
    if (name === "prefix") {
      prefixes.push(value);
    } else if (values.has(name)) {
      throw new UsageError(`--${name} is given twice.`);
    } else {
      values.set(name, value);
    }
  }

  if (booleans.has("help")) return { mode: "help" };

  const concurrencyText = values.get("concurrency");
  const concurrency =
    concurrencyText === undefined
      ? DEFAULT_CONCURRENCY
      : Number(concurrencyText);
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32 ||
    (concurrencyText !== undefined && !/^\d+$/.test(concurrencyText))
  ) {
    throw new UsageError("--concurrency is a whole number from 1 to 32.");
  }
  const commit = booleans.has("commit");

  const restore = values.get("restore");
  if (restore !== undefined) {
    if (
      values.has("bucket") ||
      prefixes.length > 0 ||
      values.has("cache-control") ||
      values.has("out")
    ) {
      throw new UsageError(
        "--restore takes only --commit and --concurrency: the CSV names the bucket, the objects and the values.",
      );
    }
    if (restore.trim().length === 0) {
      throw new UsageError("--restore needs the CSV's path.");
    }
    return { mode: "restore", csvPath: restore, commit, concurrency };
  }

  const bucket = values.get("bucket");
  if (bucket === undefined) {
    throw new UsageError("--bucket is required; there is no default bucket.");
  }
  if (!isBucketName(bucket)) {
    throw new UsageError(`"${bucket}" is not a Cloud Storage bucket name.`);
  }
  if (prefixes.length === 0) {
    throw new UsageError(
      "At least one --prefix is required (such as stores/).",
    );
  }
  for (const prefix of prefixes) {
    const problem = prefixProblem(prefix);
    if (problem) throw new UsageError(problem);
  }
  const cacheControl = values.get("cache-control");
  if (cacheControl === undefined) {
    throw new UsageError("--cache-control is required.");
  }
  if (!isCacheControlValue(cacheControl)) {
    throw new UsageError(
      "--cache-control is 1 to 256 printable ASCII characters.",
    );
  }
  const out = values.get("out") ?? ".";
  if (out.trim().length === 0) throw new UsageError("--out cannot be empty.");
  return {
    mode: "set",
    bucket,
    prefixes: [...new Set(prefixes)],
    cacheControl,
    commit,
    concurrency,
    out,
  };
}

// ── Deciding ───────────────────────────────────────────────────────────────

/** The directive names of a Cache-Control value, lower case. */
function directives(value) {
  return value
    .split(",")
    .map((part) => part.split("=")[0].trim().toLowerCase())
    .filter(Boolean);
}

/**
 * What the run does with one object: `already` (carries the value),
 * `placeholder` (a takedown placeholder), `kept` (says no-store or private)
 * or `change`.
 */
export function classify(object, target) {
  if (
    object.metadata &&
    Object.prototype.hasOwnProperty.call(object.metadata, TAKEDOWN_METADATA_KEY)
  ) {
    return "placeholder";
  }
  const current = object.cacheControl ?? null;
  if (current === target) return "already";
  if (current !== null) {
    const names = directives(current);
    if (names.includes("no-store") || names.includes("private")) return "kept";
  }
  return "change";
}

// ── CSV ────────────────────────────────────────────────────────────────────

/** One field, always quoted, quotes doubled (RFC 4180). */
function csvField(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/** One CSV line, CRLF ended. */
export function csvLine(fields) {
  return `${fields.map(csvField).join(",")}\r\n`;
}

/**
 * Parse CSV text (RFC 4180: quoted fields may hold commas, quotes doubled
 * and line breaks). Returns the rows as arrays of strings; a blank last line
 * is ignored. Throws on a quote left open.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      fieldStarted = false;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStarted = false;
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (quoted) throw new Error("The CSV ends inside a quoted field.");
  if (fieldStarted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The CSV's file name for a run. */
export function csvFileName(bucket, prefixes, now) {
  const slug = prefixes
    .map((prefix) =>
      prefix
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .join("_");
  const time = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  return `storage-cache-control-${bucket}-${slug}-${time}.csv`;
}

/**
 * The rows of a CSV this script wrote, checked: the exact header, then six
 * fields per row with a usable bucket, object, generation and metageneration
 * and a non-empty new value. Throws, naming the line, on anything else, so a
 * restore changes nothing from a file it does not understand.
 */
export function restoreRows(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("The CSV is empty.");
  const [header, ...body] = rows;
  if (header.join(",") !== CSV_COLUMNS.join(",")) {
    throw new Error(
      `The CSV's header is not this script's (${CSV_COLUMNS.join(",")}).`,
    );
  }
  return body.map((fields, index) => {
    const line = index + 2;
    if (fields.length !== CSV_COLUMNS.length) {
      throw new Error(`Line ${line} has ${fields.length} fields, not 6.`);
    }
    const [bucket, name, generation, metageneration, previous, next] = fields;
    if (!isBucketName(bucket)) {
      throw new Error(`Line ${line}: "${bucket}" is not a bucket name.`);
    }
    if (name.length === 0) throw new Error(`Line ${line} names no object.`);
    if (!/^\d+$/.test(generation) || !/^\d+$/.test(metageneration)) {
      throw new Error(`Line ${line}: the generations are not numbers.`);
    }
    if (next.length === 0) throw new Error(`Line ${line} has no new value.`);
    return {
      bucket,
      name,
      generation,
      metageneration,
      previous: previous.length === 0 ? null : previous,
      next,
    };
  });
}

// ── Running ────────────────────────────────────────────────────────────────

/** Run `work` over `items`, at most `limit` at a time. */
async function inPool(items, limit, work) {
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await work(item);
      }
    },
  );
  await Promise.all(lanes);
}

/** The HTTP status of a storage error, when it has one. */
function statusOf(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return typeof code === "number" ? code : Number(code) || null;
}

function shortError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0].slice(0, 300);
}

function printExamples(log, label, names) {
  if (names.length === 0) return;
  log(`  ${label}:`);
  for (const name of names.slice(0, EXAMPLES)) log(`    ${name}`);
  if (names.length > EXAMPLES) log(`    and ${names.length - EXAMPLES} more`);
}

/** List every prefix, classify every object; nothing is written. */
async function survey(options, storage) {
  const found = { change: [], already: [], placeholder: [], kept: [] };
  const previousValues = new Map();
  for (const prefix of options.prefixes) {
    let pageToken = null;
    do {
      const page = await storage.listPage(options.bucket, prefix, pageToken);
      for (const object of page.objects) {
        const kind = classify(object, options.cacheControl);
        found[kind].push(object);
        if (kind === "change") {
          const key = object.cacheControl ?? "(none)";
          previousValues.set(key, (previousValues.get(key) ?? 0) + 1);
        }
      }
      pageToken = page.nextPageToken ?? null;
    } while (pageToken);
  }
  return { found, previousValues };
}

/**
 * Write every object about to change to a new CSV, flush it to disk and
 * close it. Only then may anything change.
 */
async function recordPrevious(options, objects, now) {
  await mkdir(options.out, { recursive: true });
  const csvPath = path.resolve(
    options.out,
    csvFileName(options.bucket, options.prefixes, now),
  );
  const file = await open(csvPath, "wx");
  try {
    let text = csvLine(CSV_COLUMNS);
    for (const object of objects) {
      text += csvLine([
        options.bucket,
        object.name,
        object.generation,
        object.metageneration,
        object.cacheControl ?? "",
        options.cacheControl,
      ]);
    }
    await file.writeFile(text, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  return csvPath;
}

async function setRun(options, storage, now, log) {
  log(
    `${options.commit ? "Setting" : "Dry run:"} Cache-Control "${options.cacheControl}" on gs://${options.bucket}/ under ${options.prefixes.join(", ")}`,
  );
  const { found, previousValues } = await survey(options, storage);
  const total = Object.values(found).reduce(
    (sum, list) => sum + list.length,
    0,
  );
  log(`Listed ${total} objects:`);
  log(`  ${found.change.length} to change`);
  log(`  ${found.already.length} already carry the value (skipped)`);
  log(`  ${found.placeholder.length} takedown placeholders (left alone)`);
  log(`  ${found.kept.length} say no-store or private (left alone)`);
  if (previousValues.size > 0) {
    log("Values to be replaced:");
    const sorted = [...previousValues.entries()].sort((a, b) => b[1] - a[1]);
    for (const [value, count] of sorted.slice(0, 10)) {
      log(`  ${count} x ${value}`);
    }
  }
  printExamples(
    log,
    "to change",
    found.change.map((o) => o.name),
  );
  printExamples(
    log,
    "takedown placeholders",
    found.placeholder.map((o) => o.name),
  );
  printExamples(
    log,
    "no-store or private",
    found.kept.map((o) => `${o.name} (${o.cacheControl})`),
  );

  if (!options.commit) {
    log("Nothing was changed. Run again with --commit to change them.");
    return 0;
  }
  if (found.change.length === 0) {
    log("Nothing to change; no CSV written.");
    return 0;
  }

  const csvPath = await recordPrevious(options, found.change, now);
  log(`Previous values written to ${csvPath}`);

  const result = { changed: 0, changedSince: [], gone: [], failed: [] };
  await inPool(found.change, options.concurrency, async (object) => {
    try {
      await storage.setCacheControl(
        options.bucket,
        object.name,
        options.cacheControl,
        {
          ifGenerationMatch: object.generation,
          ifMetagenerationMatch: object.metageneration,
        },
      );
      result.changed += 1;
    } catch (error) {
      const status = statusOf(error);
      if (status === 412) result.changedSince.push(object.name);
      else if (status === 404) result.gone.push(object.name);
      else result.failed.push(`${object.name}: ${shortError(error)}`);
    }
  });

  log(
    `Changed ${result.changed}; changed since the listing (left alone) ${result.changedSince.length}; gone ${result.gone.length}; failed ${result.failed.length}.`,
  );
  printExamples(log, "changed since the listing", result.changedSince);
  printExamples(log, "gone", result.gone);
  printExamples(log, "failed", result.failed);
  log(
    `To put the previous values back: node scripts/storage-cache-control.mjs --restore "${csvPath}" --commit`,
  );
  return result.failed.length > 0 ? 1 : 0;
}

async function restoreRun(options, storage, log) {
  const rows = restoreRows(await readFile(options.csvPath, "utf8"));
  log(
    `${options.commit ? "Restoring" : "Dry run: restore of"} ${rows.length} objects from ${options.csvPath}`,
  );
  const result = {
    restored: 0,
    wouldRestore: 0,
    alreadyBack: [],
    replaced: [],
    changedSince: [],
    gone: [],
    failed: [],
  };
  await inPool(rows, options.concurrency, async (row) => {
    const label = `gs://${row.bucket}/${row.name}`;
    try {
      const current = await storage.getObject(row.bucket, row.name);
      if (!current) {
        result.gone.push(label);
        return;
      }
      if (String(current.generation) !== row.generation) {
        result.replaced.push(label);
        return;
      }
      const value = current.cacheControl ?? null;
      if (value === row.previous) {
        result.alreadyBack.push(label);
        return;
      }
      const setOnce = String(BigInt(row.metageneration) + 1n);
      if (value !== row.next || String(current.metageneration) !== setOnce) {
        result.changedSince.push(label);
        return;
      }
      if (!options.commit) {
        result.wouldRestore += 1;
        return;
      }
      await storage.setCacheControl(row.bucket, row.name, row.previous, {
        ifGenerationMatch: String(current.generation),
        ifMetagenerationMatch: String(current.metageneration),
      });
      result.restored += 1;
    } catch (error) {
      const status = statusOf(error);
      if (status === 412) result.changedSince.push(label);
      else if (status === 404) result.gone.push(label);
      else result.failed.push(`${label}: ${shortError(error)}`);
    }
  });
  log(
    options.commit
      ? `Restored ${result.restored};`
      : `Would restore ${result.wouldRestore};`,
  );
  log(
    `  already back ${result.alreadyBack.length}; replaced since (left alone) ${result.replaced.length}; changed since (left alone) ${result.changedSince.length}; gone ${result.gone.length}; failed ${result.failed.length}.`,
  );
  printExamples(log, "replaced since", result.replaced);
  printExamples(log, "changed since", result.changedSince);
  printExamples(log, "failed", result.failed);
  if (!options.commit) {
    log("Nothing was changed. Run again with --commit to restore them.");
  }
  return result.failed.length > 0 ? 1 : 0;
}

// ── Cloud Storage ──────────────────────────────────────────────────────────

/** One listed or read object, as the run needs it. */
function storedObject(name, metadata) {
  const custom = {};
  if (metadata.metadata && typeof metadata.metadata === "object") {
    for (const [key, value] of Object.entries(metadata.metadata)) {
      if (typeof value === "string") custom[key] = value;
    }
  }
  return {
    name,
    generation: String(metadata.generation),
    metageneration: String(metadata.metageneration),
    cacheControl:
      typeof metadata.cacheControl === "string" ? metadata.cacheControl : null,
    metadata: custom,
  };
}

/**
 * The real storage client, on Application Default Credentials. The SDK is
 * loaded only when a call is made, so `--help` and a refused argument never
 * load it.
 */
export function cloudStorage(projectId) {
  let client = null;
  const bucketOf = async (name) => {
    if (!client) {
      const { Storage } = await import("@google-cloud/storage");
      client = new Storage(projectId ? { projectId } : {});
    }
    return client.bucket(name);
  };
  return {
    async listPage(bucket, prefix, pageToken) {
      const [files, nextQuery] = await (
        await bucketOf(bucket)
      ).getFiles({
        prefix,
        autoPaginate: false,
        maxResults: PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      });
      return {
        objects: files.map((file) => storedObject(file.name, file.metadata)),
        nextPageToken: nextQuery?.pageToken ?? null,
      };
    },
    async getObject(bucket, name) {
      try {
        const [metadata] = await (await bucketOf(bucket))
          .file(name)
          .getMetadata();
        return storedObject(name, metadata);
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
    },
    async setCacheControl(bucket, name, cacheControl, preconditions) {
      // `null` removes the field. The preconditions become the request's
      // ifGenerationMatch and ifMetagenerationMatch.
      await (await bucketOf(bucket))
        .file(name)
        .setMetadata({ cacheControl }, preconditions);
    },
  };
}

/**
 * The command, as a function: the arguments, then the storage client, the
 * clock and the output lines as parameters. Returns the exit status.
 */
export async function main(argv, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));
  let options;
  try {
    options = parseArgs(argv);
  } catch (problem) {
    if (problem instanceof UsageError) {
      error(problem.message);
      error(USAGE);
      return 2;
    }
    throw problem;
  }
  if (options.mode === "help") {
    log(USAGE);
    return 0;
  }
  const storage = deps.storage ?? cloudStorage(process.env.GCP_PROJECT_ID);
  try {
    return options.mode === "restore"
      ? await restoreRun(options, storage, log)
      : await setRun(options, storage, deps.now ?? new Date(), log);
  } catch (problem) {
    error(`Stopped: ${shortError(problem)}`);
    return 1;
  }
}

function invokedDirectly() {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
