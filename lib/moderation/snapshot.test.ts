import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

/**
 * The block's record of what it removed (takedown T12): the pure helpers,
 * the hash taken over the jsonb read back, the readers' statements on the
 * caller's transaction, and the archive's pending file entries.
 */

import {
  LABEL_MAX,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  addressesFor,
  buildSnapshot,
  contentTypeFromName,
  fileLabelFor,
  filesStateFor,
  hashForStorage,
  isRowKind,
  itemLabelFor,
  itemPath,
  parsePendingArchiveFile,
  pendingArchiveFile,
  readFileUsages,
  readHistory,
  readItemRow,
  readRelated,
  readStoreContext,
  readStoreRow,
  snapshotSha256,
  storeFactsFromRow,
  storeOrigins,
  type ArchiveFileEntry,
  type BlockSnapshot,
} from "./snapshot";

const STORE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ITEM = "11111111-2222-4333-8444-555555555555";
const dialect = new PgDialect();

/** A db whose execute compiles each statement and answers from a list. */
function fakeDb(answers: { match: RegExp; rows: unknown[] }[] = []) {
  const executed: { text: string; params: unknown[] }[] = [];
  const db = {
    execute: async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      const text = compiled.sql.replace(/\s+/g, " ").trim();
      executed.push({ text, params: compiled.params });
      const found = answers.find((answer) => answer.match.test(text));
      return { rows: found ? found.rows : [] };
    },
  };
  return { db: db as unknown as Db, executed };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the item and the store", () => {
  it("knows which kinds are rows", () => {
    expect(isRowKind("product")).toBe(true);
    expect(isRowKind("review")).toBe(true);
    expect(isRowKind("file")).toBe(false);
    expect(isRowKind("store")).toBe(false);
  });

  it("narrows a stores row, refusing settings that are not an object", () => {
    const facts = storeFactsFromRow({
      id: STORE,
      slug: "crumb",
      name: "Crumb",
      status: "active",
      custom_domain: null,
      settings: ["not", "an", "object"],
      plan: "pro",
    });
    expect(facts).toMatchObject({
      id: STORE,
      slug: "crumb",
      settings: null,
      plan: "pro",
      plan_expires_at: null,
      comp_plan: null,
    });
  });

  it("adds a custom domain only when it is verified and the plan still serves it", () => {
    const base = storeFactsFromRow({
      id: STORE,
      slug: "crumb",
      name: "Crumb",
      status: "active",
      custom_domain: " Crumb.IN ",
      settings: { custom_domain_verified: true },
      plan: "pro",
    });
    expect(storeOrigins(base)).toEqual([
      "https://crumb.storemink.com",
      "https://crumb.in",
    ]);
    expect(storeOrigins({ ...base, settings: {} })).toEqual([
      "https://crumb.storemink.com",
    ]);
    expect(storeOrigins({ ...base, plan: "free" })).toEqual([
      "https://crumb.storemink.com",
    ]);
  });

  it("gives each row kind its shopper path", () => {
    expect(itemPath("product", "blue mug")).toBe("/shop/blue%20mug");
    expect(itemPath("page", "")).toBe("/");
    expect(itemPath("page", "about")).toBe("/about");
    expect(itemPath("blog_post", "launch")).toBe("/blogs/launch");
    expect(itemPath("collection", "mugs")).toBe("/collections/mugs");
    expect(itemPath("review", "x")).toBeNull();
    expect(itemPath("product", null)).toBeNull();
    expect(
      addressesFor(["https://a.example", "https://b.example"], "/shop/x"),
    ).toEqual(["https://a.example/shop/x", "https://b.example/shop/x"]);
    expect(addressesFor(["https://a.example"], null)).toEqual([]);
  });

  it("labels an item the way the console shows it", () => {
    expect(itemLabelFor("product", { name: "  Blue mug " })).toBe("Blue mug");
    expect(itemLabelFor("page", { title: "", slug: "" })).toBe("Homepage");
    expect(itemLabelFor("page", { title: "", slug: "about" })).toBe("about");
    expect(itemLabelFor("blog_post", { title: "" })).toBe("Untitled");
    expect(itemLabelFor("store", { name: "", slug: "crumb" })).toBe("crumb");
    expect(itemLabelFor("file", null)).toBe("Untitled");
    const long = "word ".repeat(40);
    const review = itemLabelFor(
      "review",
      { comment: long },
      { parentName: "Blue mug" },
    );
    expect(review.startsWith("Blue mug: word word")).toBe(true);
    expect(review.endsWith("...")).toBe(true);
    expect(review.length).toBeLessThanOrEqual("Blue mug: ".length + 80);
    expect(
      itemLabelFor("blog_comment", { body: "Nice" }, { parentName: "Launch" }),
    ).toBe("Launch: Nice");
    expect(itemLabelFor("product", { name: "x".repeat(400) }).length).toBe(
      LABEL_MAX,
    );
  });

  it("labels a file by the last part of its address", () => {
    expect(fileLabelFor("bucket", `stores/${STORE}/uploads/mug.webp`)).toBe(
      "mug.webp",
    );
    expect(fileLabelFor("external", "https://cdn.example.com/a/b.png")).toBe(
      "b.png",
    );
    expect(fileLabelFor("external", "https://cdn.example.com/")).toBe(
      "cdn.example.com",
    );
    expect(fileLabelFor("bundled", "/themes/basket/hero.webp")).toBe(
      "hero.webp",
    );
    expect(fileLabelFor("bucket", "")).toBe("File");
    expect(contentTypeFromName("a/b.JPG")).toBe("image/jpeg");
    expect(contentTypeFromName("notes.pdf")).toBeNull();
  });
});

describe("the snapshot and its hash", () => {
  const parts = {
    capturedAt: new Date("2026-10-30T06:00:00.000Z"),
    block: {
      id: ITEM,
      kind: "product" as const,
      reason: "terms_breach" as const,
      complaint: null,
      legalBasis: "",
      tellStore: true,
      blockedBy: "ops@storemink.test",
      parentBlockId: null,
    },
    store: null,
    item: { kind: "product" as const, row: { id: ITEM, name: "Blue mug" } },
  };

  it("records the database it was taken in and fills every part", () => {
    vi.stubEnv("DB_NAME", "storemink_local");
    const snapshot = buildSnapshot(parts);
    expect(snapshot).toMatchObject({
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      database: "storemink_local",
      related: {},
      history: [],
      addresses: [],
      storeContent: null,
      item: { kind: "product", file: null },
    });
  });

  it("hashes the canonical form, so key order never changes the fingerprint", () => {
    expect(snapshotSha256({ b: 1, a: { d: 2, c: 3 } })).toBe(
      snapshotSha256({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(snapshotSha256({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("takes the hash over the jsonb read back, not over the object built", async () => {
    // The fake returns what PostgreSQL would: the JSON parsed, keys reordered.
    const { db, executed } = fakeDb([
      {
        match: /^select \$1::jsonb as v$/,
        rows: [],
      },
    ]);
    const echo = {
      execute: async (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        await (
          db as unknown as { execute: (q: SQL) => Promise<unknown> }
        ).execute(query);
        return { rows: [{ v: JSON.parse(String(compiled.params[0])) }] };
      },
    } as unknown as Db;
    const snapshot = buildSnapshot(parts) as BlockSnapshot;
    const hashed = await hashForStorage(echo, snapshot);
    expect(executed[0].text).toBe("select $1::jsonb as v");
    expect(hashed.json).toBe(JSON.stringify(snapshot));
    expect(hashed.sha256).toBe(snapshotSha256(JSON.parse(hashed.json)));
    // The built object holds a Date, which canonicalJson writes as {}: a
    // hash of the object is not the hash of what the database holds.
    expect(hashed.sha256).not.toBe(snapshotSha256(snapshot));
  });

  it("refuses when nothing comes back", async () => {
    const { db } = fakeDb();
    await expect(hashForStorage(db, buildSnapshot(parts))).rejects.toThrow(
      /could not be read back/,
    );
  });
});

describe("the readers", () => {
  it("locks the store row only when asked", async () => {
    const { db, executed } = fakeDb([
      { match: /from public\.stores s/, rows: [{ row: { id: STORE } }] },
    ]);
    expect(await readStoreRow(db, STORE)).toEqual({ id: STORE });
    await readStoreRow(db, STORE, { lock: true });
    expect(executed[0].text).not.toContain("for update");
    expect(executed[1].text).toMatch(/for update$/);
    expect(executed[1].params).toEqual([STORE]);
  });

  it("reads an item from its own table, in its store, locked", async () => {
    const { db, executed } = fakeDb([
      {
        match: /from public\.product_reviews t/,
        rows: [{ row: { id: ITEM } }],
      },
    ]);
    expect(
      await readItemRow(db, "review", STORE, ITEM, { lock: true }),
    ).toEqual({
      id: ITEM,
    });
    expect(executed[0].text).toBe(
      "select to_jsonb(t) as row from public.product_reviews t where t.id = $1 and t.store_id = $2 for update",
    );
    expect(executed[0].params).toEqual([ITEM, STORE]);
    const missing = fakeDb();
    expect(await readItemRow(missing.db, "page", STORE, ITEM)).toBeNull();
  });

  it("keeps the store's owners once each, with its header, footer and menus", async () => {
    const { db } = fakeDb([
      {
        match: /from public\.admins a/,
        rows: [
          { email: " a@x.co " },
          { email: "a@x.co" },
          { email: "" },
          { email: "b@x.co" },
        ],
      },
      {
        match: /from public\.store_chrome c/,
        rows: [{ row: { published: { header: {} } } }],
      },
      { match: /from public\.store_menus m/, rows: [] },
    ]);
    expect(await readStoreContext(db, STORE)).toEqual({
      owners: ["a@x.co", "b@x.co"],
      chrome: { published: { header: {} } },
      menus: null,
    });
  });

  it("reads a product's variants and category, and a review's product and author", async () => {
    const product = fakeDb([
      {
        match: /from public\.product_variants v/,
        rows: [{ row: { id: "v1" } }],
      },
      { match: /from public\.categories c/, rows: [{ row: { id: "c1" } }] },
    ]);
    expect(
      await readRelated(product.db, "product", STORE, {
        id: ITEM,
        category_id: "c1",
      }),
    ).toEqual({
      related: { variants: [{ id: "v1" }], category: { id: "c1" } },
      parentName: null,
      parentPath: null,
    });

    const review = fakeDb([
      {
        match: /from public\.products p/,
        rows: [{ row: { id: "p1", name: "Blue mug", slug: "blue-mug" } }],
      },
      { match: /from public\.users u/, rows: [{ row: { id: "u1" } }] },
    ]);
    expect(
      await readRelated(review.db, "review", STORE, {
        product_id: "p1",
        user_id: "u1",
      }),
    ).toEqual({
      related: {
        product: {
          id: "p1",
          name: "Blue mug",
          slug: "blue-mug",
          path: "/shop/blue-mug",
        },
        author: { id: "u1" },
      },
      parentName: "Blue mug",
      parentPath: "/shop/blue-mug",
    });

    const post = fakeDb([
      { match: /from public\.users u/, rows: [{ row: { id: "u9" } }] },
    ]);
    expect(
      await readRelated(post.db, "blog_post", STORE, {
        is_customer_submission: true,
        submitted_by: "u9",
      }),
    ).toEqual({
      related: { author: { id: "u9" } },
      parentName: null,
      parentPath: null,
    });
    expect(post.executed).toHaveLength(1);
  });

  it("reads history newest first, bounded", async () => {
    const { db, executed } = fakeDb();
    await readHistory(db, STORE, ITEM);
    expect(executed[0].text).toMatch(
      /order by e\.created_at desc, e\.id desc limit \$3$/,
    );
    expect(executed[0].params).toEqual([STORE, ITEM, 200]);
  });

  it("asks nothing for no keys, and binds the keys as one array once each", async () => {
    const empty = fakeDb();
    expect(await readFileUsages(empty.db, STORE, ["", ""])).toEqual([]);
    expect(empty.executed).toHaveLength(0);

    const { db, executed } = fakeDb([
      {
        match: /^with k\(key\)/,
        rows: [{ tbl: "products", row_id: ITEM, col: "images", key: "a.webp" }],
      },
    ]);
    expect(
      await readFileUsages(db, STORE, ["a.webp", "a.webp", "b.webp"]),
    ).toEqual([
      { table: "products", id: ITEM, column: "images", key: "a.webp" },
    ]);
    expect(executed[0].text).toContain("select unnest($1::text[])");
    expect(executed[0].params[0]).toEqual(["a.webp", "b.webp"]);
  });
});

describe("pending archive entries", () => {
  it("round-trips a pending entry and refuses a malformed one", () => {
    const entry = pendingArchiveFile({
      n: 3,
      source: "private",
      path: `stores/${STORE}/mink-attachments/storemink_local/x.webp`,
      at: "2026-10-30T06:00:00.000Z",
    });
    expect(entry.expectedMd5).toBeNull();
    expect(parsePendingArchiveFile(JSON.parse(JSON.stringify(entry)))).toEqual(
      entry,
    );
    expect(
      parsePendingArchiveFile({ ...entry, expectedMd5: "MD5==" })?.expectedMd5,
    ).toBe("MD5==");
    for (const bad of [
      null,
      [],
      { ...entry, state: "copied" },
      { ...entry, n: -1 },
      { ...entry, n: 1.5 },
      { ...entry, source: "ftp" },
      { ...entry, path: "" },
      { ...entry, at: 5 },
      { ...entry, expectedMd5: 7 },
    ]) {
      expect(parsePendingArchiveFile(bad)).toBeNull();
    }
  });

  it("is copied once nothing is pending, an empty list included", () => {
    const pending = pendingArchiveFile({
      n: 1,
      source: "bucket",
      path: "a",
      at: "t",
    });
    const copied = {
      ...pending,
      state: "copied",
    } as unknown as ArchiveFileEntry;
    expect(filesStateFor([])).toBe("copied");
    expect(filesStateFor([copied])).toBe("copied");
    expect(filesStateFor([copied, pending])).toBe("pending");
  });
});
