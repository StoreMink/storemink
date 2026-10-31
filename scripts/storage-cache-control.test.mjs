// scripts/storage-cache-control.mjs (content takedown release, production
// step P2) against an in-memory bucket. No test reaches a network: the
// storage client is injected, the real SDK is replaced by one that throws,
// and fetch throws.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@google-cloud/storage";
import {
  CSV_COLUMNS,
  classify,
  cloudStorage,
  csvFileName,
  csvLine,
  main,
  parseArgs,
  parseCsv,
  restoreRows,
} from "./storage-cache-control.mjs";

vi.mock("@google-cloud/storage", () => ({
  Storage: vi.fn(function Storage() {
    throw new Error("the real storage client is never built in a test");
  }),
}));

const SCRIPT = fileURLToPath(
  new URL("./storage-cache-control.mjs", import.meta.url),
);
const BUCKET = "test-media-bucket";
const TARGET = "public, max-age=60";
const YEAR = "public, max-age=31536000";
const NOW = new Date("2026-10-30T09:15:42.123Z");

/** An object as the bucket lists it. */
function object(name, cacheControl, extra = {}) {
  return {
    name,
    generation: extra.generation ?? "1700000000000001",
    metageneration: extra.metageneration ?? "1",
    cacheControl,
    metadata: extra.metadata ?? {},
  };
}

/** Every row of every CSV in a folder, as objects keyed by column. */
async function csvRowsIn(dir) {
  const rows = [];
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".csv")) continue;
    const [header, ...body] = parseCsv(
      await readFile(path.join(dir, file), "utf8"),
    );
    for (const fields of body) {
      rows.push(Object.fromEntries(header.map((key, i) => [key, fields[i]])));
    }
  }
  return rows;
}

/**
 * An in-memory bucket, listed two objects a page so paging is exercised.
 * With `recordedFirst` (the names the run will change), every change first
 * checks that the CSV on disk already holds the previous value of every one
 * of them; a change made before that is a violation.
 */
function fakeBucket(
  objects,
  { outDir, recordedFirst = null, failures = {} } = {},
) {
  const store = new Map(objects.map((o) => [o.name, structuredClone(o)]));
  const changes = [];
  const violations = [];
  return {
    store,
    changes,
    violations,
    async listPage(bucket, prefix, pageToken) {
      expect(bucket).toBe(BUCKET);
      const names = [...store.keys()]
        .filter((n) => n.startsWith(prefix))
        .sort();
      const start = pageToken ? Number(pageToken) : 0;
      return {
        objects: names
          .slice(start, start + 2)
          .map((n) => structuredClone(store.get(n))),
        nextPageToken: start + 2 < names.length ? String(start + 2) : null,
      };
    },
    async getObject(bucket, name) {
      const found = store.get(name);
      return found ? structuredClone(found) : null;
    },
    async setCacheControl(bucket, name, cacheControl, preconditions) {
      const current = store.get(name);
      if (recordedFirst) {
        const rows = await csvRowsIn(outDir);
        for (const expected of recordedFirst) {
          const before = objects.find((o) => o.name === expected);
          const row = rows.find(
            (r) => r.bucket === bucket && r.object === expected,
          );
          if (
            !row ||
            row.previous_cache_control !== (before.cacheControl ?? "")
          ) {
            violations.push(
              `${name} changed before ${expected}'s previous value was on disk`,
            );
          }
        }
      }
      if (failures[name]) {
        const error = new Error(`storage said ${failures[name]}`);
        error.code = failures[name];
        throw error;
      }
      if (!current) {
        const error = new Error("No such object");
        error.code = 404;
        throw error;
      }
      if (
        preconditions.ifGenerationMatch !== current.generation ||
        preconditions.ifMetagenerationMatch !== current.metageneration
      ) {
        const error = new Error("Precondition failed");
        error.code = 412;
        throw error;
      }
      current.cacheControl = cacheControl;
      current.metageneration = String(Number(current.metageneration) + 1);
      changes.push({ name, cacheControl });
    },
  };
}

function lines() {
  const out = [];
  return {
    out,
    log: (line) => out.push(line),
    error: (line) => out.push(line),
  };
}

let outDir;

beforeEach(() => {
  outDir = mkdtempSync(path.join(tmpdir(), "storage-cache-control-"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("no test reaches a network");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(outDir, { recursive: true, force: true });
});

const SET = [
  "--bucket",
  BUCKET,
  "--prefix",
  "stores/",
  "--cache-control",
  TARGET,
];

/** The objects most tests start from. */
function sampleObjects() {
  return [
    object("stores/a/uploads/one.webp", YEAR),
    object("stores/a/uploads/two.webp", null),
    object("stores/a/uploads/three.webp", TARGET),
    object("stores/b/uploads/blocked.webp", "no-store", {
      metadata: { "storemink-takedown": "block-1" },
    }),
    object("stores/b/uploads/secret.pdf", "Private, max-age=0"),
    object('stores/b/uploads/odd, "name".webp', "public, max-age=3600"),
    object("theme-releases/t/1.0.0/hero.webp", YEAR),
  ];
}

describe("parseArgs", () => {
  it("reads a set run with every option, in both flag forms", () => {
    expect(
      parseArgs([
        "--bucket=b-1",
        "--prefix",
        "stores/",
        "--prefix=theme-releases/",
        "--prefix",
        "stores/",
        "--cache-control",
        TARGET,
        "--commit",
        "--out",
        "/tmp/x",
        "--concurrency",
        "4",
      ]),
    ).toEqual({
      mode: "set",
      bucket: "b-1",
      prefixes: ["stores/", "theme-releases/"],
      cacheControl: TARGET,
      commit: true,
      concurrency: 4,
      out: "/tmp/x",
    });
  });

  it("is a dry run unless --commit, in the current folder, 8 at a time", () => {
    expect(parseArgs(SET)).toMatchObject({
      commit: false,
      out: ".",
      concurrency: 8,
    });
  });

  it("★ has no default bucket", () => {
    expect(() =>
      parseArgs(["--prefix", "stores/", "--cache-control", TARGET]),
    ).toThrow("--bucket is required; there is no default bucket.");
  });

  it("refuses what it cannot use", () => {
    const refused = [
      [
        "--bucket",
        "Bad_Bucket",
        "--prefix",
        "stores/",
        "--cache-control",
        TARGET,
      ],
      ["--bucket", "a..b", "--prefix", "stores/", "--cache-control", TARGET],
      ["--bucket", BUCKET, "--cache-control", TARGET],
      ["--bucket", BUCKET, "--prefix", "stores", "--cache-control", TARGET],
      ["--bucket", BUCKET, "--prefix", "/stores/", "--cache-control", TARGET],
      ["--bucket", BUCKET, "--prefix", "stores//", "--cache-control", TARGET],
      ["--bucket", BUCKET, "--prefix", "stores/../", "--cache-control", TARGET],
      ["--bucket", BUCKET, "--prefix=", "--cache-control", TARGET],
      ["--bucket", BUCKET, "--prefix", "stores/"],
      ["--bucket", BUCKET, "--prefix", "stores/", "--cache-control", "   "],
      [
        "--bucket",
        BUCKET,
        "--prefix",
        "stores/",
        "--cache-control",
        "public, max-age=60\n",
      ],
      [...SET, "--concurrency", "0"],
      [...SET, "--concurrency", "33"],
      [...SET, "--concurrency", "2.5"],
      [...SET, "--bucket", "other"],
      [...SET, "--force"],
      [...SET, "stray"],
      ["--bucket"],
      ["--restore", "x.csv", "--bucket", BUCKET],
      ["--restore", "x.csv", "--prefix", "stores/"],
      ["--restore", "x.csv", "--cache-control", TARGET],
      ["--restore", "x.csv", "--out", "."],
      ["--restore", " "],
      ["--commit=yes", ...SET],
    ];
    for (const argv of refused) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow();
    }
  });

  it("reads a restore run", () => {
    expect(parseArgs(["--restore", "a.csv"])).toEqual({
      mode: "restore",
      csvPath: "a.csv",
      commit: false,
      concurrency: 8,
    });
    expect(parseArgs(["--restore=a.csv", "--commit"])).toMatchObject({
      commit: true,
    });
  });
});

describe("classify", () => {
  it("changes only what does not already carry the value, and leaves placeholders and private files alone", () => {
    expect(classify(object("a", TARGET), TARGET)).toBe("already");
    expect(classify(object("a", YEAR), TARGET)).toBe("change");
    expect(classify(object("a", null), TARGET)).toBe("change");
    expect(classify(object("a", "public, max-age=60 "), TARGET)).toBe("change");
    expect(
      classify(
        object("a", TARGET, { metadata: { "storemink-takedown": "b" } }),
        TARGET,
      ),
    ).toBe("placeholder");
    expect(
      classify(
        object("a", YEAR, { metadata: { "storemink-takedown": "b" } }),
        TARGET,
      ),
    ).toBe("placeholder");
    expect(classify(object("a", "no-store"), TARGET)).toBe("kept");
    expect(classify(object("a", "Private, Max-Age=0"), TARGET)).toBe("kept");
    expect(classify(object("a", "public, no-store"), TARGET)).toBe("kept");
  });
});

describe("the CSV", () => {
  it("quotes every field and reads back what it wrote", () => {
    const fields = [BUCKET, 'stores/x/a, "b".webp', "12", "3", "", TARGET];
    const text = csvLine(CSV_COLUMNS) + csvLine(fields);
    expect(text.split("\r\n")[1]).toBe(
      `"${BUCKET}","stores/x/a, ""b"".webp","12","3","","public, max-age=60"`,
    );
    expect(parseCsv(text)).toEqual([CSV_COLUMNS, fields]);
  });

  it("is named after the bucket, the prefixes and the UTC second", () => {
    expect(csvFileName(BUCKET, ["stores/", "theme-releases/"], NOW)).toBe(
      `storage-cache-control-${BUCKET}-stores_theme-releases-20261030T091542Z.csv`,
    );
  });

  it("★ a restore refuses a file it does not understand", () => {
    const header = csvLine(CSV_COLUMNS);
    const row = (fields) => header + csvLine(fields);
    expect(() => restoreRows("")).toThrow("empty");
    expect(() => restoreRows(csvLine(["bucket", "object"]))).toThrow("header");
    expect(() => restoreRows(row([BUCKET, "a", "x", "1", "", TARGET]))).toThrow(
      "generations",
    );
    expect(() => restoreRows(row(["Bad", "a", "1", "1", "", TARGET]))).toThrow(
      "bucket",
    );
    expect(() => restoreRows(row([BUCKET, "", "1", "1", "", TARGET]))).toThrow(
      "no object",
    );
    expect(() => restoreRows(row([BUCKET, "a", "1", "1", "", ""]))).toThrow(
      "new value",
    );
    expect(() => restoreRows(header + '"a","b"\r\n')).toThrow("fields");
    expect(() => restoreRows(header + '"unclosed')).toThrow("quoted");
    expect(restoreRows(row([BUCKET, "a", "1", "2", "", TARGET]))).toEqual([
      {
        bucket: BUCKET,
        name: "a",
        generation: "1",
        metageneration: "2",
        previous: null,
        next: TARGET,
      },
    ]);
  });
});

describe("a set run", () => {
  it("★ a dry run lists and counts, and writes and changes nothing", async () => {
    const bucket = fakeBucket(sampleObjects(), { outDir });
    const io = lines();
    const status = await main([...SET, "--out", outDir], {
      storage: bucket,
      now: NOW,
      ...io,
    });
    expect(status).toBe(0);
    expect(bucket.changes).toEqual([]);
    expect(readdirSync(outDir)).toEqual([]);
    const text = io.out.join("\n");
    expect(text).toContain("Listed 6 objects:");
    expect(text).toContain("  3 to change");
    expect(text).toContain("  1 already carry the value (skipped)");
    expect(text).toContain("  1 takedown placeholders (left alone)");
    expect(text).toContain("  1 say no-store or private (left alone)");
    expect(text).toContain(`1 x ${YEAR}`);
    expect(text).toContain("1 x (none)");
    expect(text).toContain("Nothing was changed.");
  });

  it("★★ writes every previous value to disk before it changes any object, then changes exactly those", async () => {
    const toChange = [
      "stores/a/uploads/one.webp",
      "stores/a/uploads/two.webp",
      'stores/b/uploads/odd, "name".webp',
      "theme-releases/t/1.0.0/hero.webp",
    ];
    const bucket = fakeBucket(sampleObjects(), {
      outDir,
      recordedFirst: toChange,
    });
    const io = lines();
    const status = await main(
      [
        ...SET,
        "--prefix",
        "theme-releases/",
        "--commit",
        "--out",
        outDir,
        "--concurrency",
        "3",
      ],
      { storage: bucket, now: NOW, ...io },
    );
    expect(status).toBe(0);
    expect(bucket.violations).toEqual([]);
    expect(bucket.changes.map((c) => c.name).sort()).toEqual(
      [...toChange].sort(),
    );
    expect(bucket.changes.every((c) => c.cacheControl === TARGET)).toBe(true);
    // Untouched: the one already set, the placeholder, the private file.
    expect(bucket.store.get("stores/a/uploads/three.webp").metageneration).toBe(
      "1",
    );
    expect(bucket.store.get("stores/b/uploads/blocked.webp").cacheControl).toBe(
      "no-store",
    );
    expect(bucket.store.get("stores/b/uploads/secret.pdf").cacheControl).toBe(
      "Private, max-age=0",
    );

    const [file] = readdirSync(outDir);
    expect(file).toBe(
      `storage-cache-control-${BUCKET}-stores_theme-releases-20261030T091542Z.csv`,
    );
    const rows = await csvRowsIn(outDir);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.object === "stores/a/uploads/two.webp")).toEqual({
      bucket: BUCKET,
      object: "stores/a/uploads/two.webp",
      generation: "1700000000000001",
      metageneration: "1",
      previous_cache_control: "",
      new_cache_control: TARGET,
    });
    const text = io.out.join("\n");
    expect(text).toContain(
      "Changed 4; changed since the listing (left alone) 0; gone 0; failed 0.",
    );
    expect(text).toContain(`--restore "${path.join(outDir, file)}" --commit`);
  });

  it("leaves an object changed since the listing alone, and fails the run on a storage error", async () => {
    const bucket = fakeBucket(sampleObjects(), {
      outDir,
      failures: {
        "stores/a/uploads/one.webp": 412,
        "stores/a/uploads/two.webp": 404,
        'stores/b/uploads/odd, "name".webp': 503,
      },
    });
    const io = lines();
    const status = await main([...SET, "--commit", "--out", outDir], {
      storage: bucket,
      now: NOW,
      ...io,
    });
    expect(status).toBe(1);
    const text = io.out.join("\n");
    expect(text).toContain(
      "Changed 0; changed since the listing (left alone) 1; gone 1; failed 1.",
    );
    expect(text).toContain("storage said 503");
  });

  it("sends the generation and metageneration it listed, so a replaced object is never overwritten", async () => {
    const objects = sampleObjects();
    const bucket = fakeBucket(objects, { outDir });
    // Replaced between the listing and the change.
    const list = bucket.listPage.bind(bucket);
    bucket.listPage = async (...args) => {
      const page = await list(...args);
      const replaced = bucket.store.get("stores/a/uploads/one.webp");
      if (replaced) replaced.generation = "1800000000000000";
      return page;
    };
    const status = await main([...SET, "--commit", "--out", outDir], {
      storage: bucket,
      now: NOW,
      ...lines(),
    });
    expect(status).toBe(0);
    expect(bucket.store.get("stores/a/uploads/one.webp").cacheControl).toBe(
      YEAR,
    );
  });

  it("writes no CSV when nothing needs changing", async () => {
    const bucket = fakeBucket([object("stores/a/x.webp", TARGET)], { outDir });
    const io = lines();
    expect(
      await main([...SET, "--commit", "--out", outDir], {
        storage: bucket,
        now: NOW,
        ...io,
      }),
    ).toBe(0);
    expect(readdirSync(outDir)).toEqual([]);
    expect(io.out.join("\n")).toContain("Nothing to change; no CSV written.");
  });

  it("★ never overwrites an earlier CSV, and then changes nothing", async () => {
    const first = fakeBucket(sampleObjects(), { outDir });
    await main([...SET, "--commit", "--out", outDir], {
      storage: first,
      now: NOW,
      ...lines(),
    });
    const before = readFileSync(
      path.join(outDir, readdirSync(outDir)[0]),
      "utf8",
    );
    const second = fakeBucket(sampleObjects(), { outDir });
    const io = lines();
    const status = await main([...SET, "--commit", "--out", outDir], {
      storage: second,
      now: NOW,
      ...io,
    });
    expect(status).toBe(1);
    expect(second.changes).toEqual([]);
    expect(io.out.join("\n")).toContain("Stopped:");
    expect(
      readFileSync(path.join(outDir, readdirSync(outDir)[0]), "utf8"),
    ).toBe(before);
  });

  it("stops with status 1 when the bucket cannot be listed", async () => {
    const io = lines();
    const storage = {
      listPage: async () => {
        throw new Error("permission denied");
      },
    };
    expect(await main(SET, { storage, now: NOW, ...io })).toBe(1);
    expect(io.out.join("\n")).toContain("Stopped: permission denied");
  });
});

describe("a restore run", () => {
  async function committed() {
    const bucket = fakeBucket(sampleObjects(), { outDir });
    await main(
      [...SET, "--prefix", "theme-releases/", "--commit", "--out", outDir],
      {
        storage: bucket,
        now: NOW,
        ...lines(),
      },
    );
    return { bucket, csv: path.join(outDir, readdirSync(outDir)[0]) };
  }

  it("★ puts every previous value back, removing the field where there was none", async () => {
    const { bucket, csv } = await committed();
    const dry = lines();
    expect(await main(["--restore", csv], { storage: bucket, ...dry })).toBe(0);
    expect(bucket.store.get("stores/a/uploads/one.webp").cacheControl).toBe(
      TARGET,
    );
    expect(dry.out.join("\n")).toContain("Would restore 4;");

    const io = lines();
    expect(
      await main(["--restore", csv, "--commit"], { storage: bucket, ...io }),
    ).toBe(0);
    expect(bucket.store.get("stores/a/uploads/one.webp").cacheControl).toBe(
      YEAR,
    );
    expect(
      bucket.store.get("stores/a/uploads/two.webp").cacheControl,
    ).toBeNull();
    expect(
      bucket.store.get('stores/b/uploads/odd, "name".webp').cacheControl,
    ).toBe("public, max-age=3600");
    expect(
      bucket.store.get("theme-releases/t/1.0.0/hero.webp").cacheControl,
    ).toBe(YEAR);
    expect(io.out.join("\n")).toContain("Restored 4;");

    // A second restore finds them all back already.
    const again = lines();
    expect(
      await main(["--restore", csv, "--commit"], { storage: bucket, ...again }),
    ).toBe(0);
    expect(again.out.join("\n")).toContain("already back 4;");
  });

  it("★ leaves alone what was replaced, edited or deleted since, and anything it did not set", async () => {
    const { bucket, csv } = await committed();
    // A takedown replaced this file (a new generation).
    bucket.store.get("stores/a/uploads/one.webp").generation =
      "1900000000000000";
    // Someone set another value since.
    bucket.store.get("stores/a/uploads/two.webp").cacheControl = "no-store";
    // Edited again since (same value, a later metageneration).
    bucket.store.get("theme-releases/t/1.0.0/hero.webp").metageneration = "7";
    // Deleted.
    bucket.store.delete('stores/b/uploads/odd, "name".webp');
    const io = lines();
    expect(
      await main(["--restore", csv, "--commit"], { storage: bucket, ...io }),
    ).toBe(0);
    expect(bucket.store.get("stores/a/uploads/one.webp").cacheControl).toBe(
      TARGET,
    );
    expect(bucket.store.get("stores/a/uploads/two.webp").cacheControl).toBe(
      "no-store",
    );
    expect(
      bucket.store.get("theme-releases/t/1.0.0/hero.webp").cacheControl,
    ).toBe(TARGET);
    expect(io.out.join("\n")).toContain(
      "already back 0; replaced since (left alone) 1; changed since (left alone) 2; gone 1; failed 0.",
    );
  });

  it("changes nothing from a CSV it does not understand", async () => {
    const { bucket, csv } = await committed();
    const broken = path.join(outDir, "broken.csv");
    const text = readFileSync(csv, "utf8").replace("1700000000000001", "x");
    await writeFile(broken, text);
    const before = JSON.stringify([...bucket.store.values()]);
    const io = lines();
    expect(
      await main(["--restore", broken, "--commit"], { storage: bucket, ...io }),
    ).toBe(1);
    expect(JSON.stringify([...bucket.store.values()])).toBe(before);
    expect(io.out.join("\n")).toContain("the generations are not numbers");
  });
});

describe("the command line and the real client", () => {
  it("★ refuses to run without a bucket, before loading anything (status 2)", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--prefix", "stores/"], {
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      "--bucket is required; there is no default bucket.",
    );
    expect(run.stderr).toContain("Usage:");
  });

  it("★ names no bucket of its own", () => {
    expect(readFileSync(SCRIPT, "utf8")).not.toMatch(
      /storemink-media|storemink-chat/,
    );
  });

  it("reports a client that cannot be built as a stopped run", async () => {
    const io = lines();
    expect(await main(SET, { now: NOW, ...io })).toBe(1);
    expect(io.out.join("\n")).toContain(
      "Stopped: the real storage client is never built in a test",
    );
  });

  it("lists, reads and patches through the SDK with the listed preconditions", async () => {
    const setMetadata = vi.fn(async () => [{}]);
    const notFound = Object.assign(new Error("No such object"), { code: 404 });
    const file = vi.fn((name) => ({
      setMetadata,
      getMetadata: vi.fn(async () => {
        if (name === "gone") throw notFound;
        return [
          {
            generation: 5,
            metageneration: "2",
            cacheControl: TARGET,
            metadata: { a: "b", n: 1 },
          },
        ];
      }),
    }));
    const getFiles = vi.fn(async () => [
      [
        {
          name: "stores/x.webp",
          metadata: { generation: "9", metageneration: "1" },
        },
      ],
      { pageToken: "next" },
    ]);
    const bucketFn = vi.fn(() => ({ getFiles, file }));
    vi.mocked(Storage).mockImplementation(function Fake() {
      return { bucket: bucketFn };
    });

    const storage = cloudStorage("proj");
    expect(await storage.listPage(BUCKET, "stores/", null)).toEqual({
      objects: [
        {
          name: "stores/x.webp",
          generation: "9",
          metageneration: "1",
          cacheControl: null,
          metadata: {},
        },
      ],
      nextPageToken: "next",
    });
    expect(getFiles).toHaveBeenCalledWith({
      prefix: "stores/",
      autoPaginate: false,
      maxResults: 1000,
    });
    await storage.listPage(BUCKET, "stores/", "next");
    expect(getFiles).toHaveBeenLastCalledWith({
      prefix: "stores/",
      autoPaginate: false,
      maxResults: 1000,
      pageToken: "next",
    });
    expect(await storage.getObject(BUCKET, "here")).toEqual({
      name: "here",
      generation: "5",
      metageneration: "2",
      cacheControl: TARGET,
      metadata: { a: "b" },
    });
    expect(await storage.getObject(BUCKET, "gone")).toBeNull();
    await storage.setCacheControl(BUCKET, "here", null, {
      ifGenerationMatch: "5",
      ifMetagenerationMatch: "2",
    });
    expect(setMetadata).toHaveBeenCalledWith(
      { cacheControl: null },
      { ifGenerationMatch: "5", ifMetagenerationMatch: "2" },
    );
    expect(Storage).toHaveBeenCalledTimes(1);
    expect(Storage).toHaveBeenCalledWith({ projectId: "proj" });
    expect(bucketFn).toHaveBeenCalledWith(BUCKET);
  });
});
