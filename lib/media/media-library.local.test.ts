/** Rollback-only checks of the Media Library migration and product-photo
 * reads against the local database. Run with MEDIA_LIBRARY_LOCAL_TEST=1; the
 * fixed loopback address keeps it off Cloud SQL, and everything it writes is
 * rolled back. */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";

const service = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
}));
vi.mock("@/lib/db/client", () => ({
  async withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const name = `media_library_${++service.count}`;
    await service.client!.query(`SAVEPOINT ${name}`);
    try {
      const value = await fn(service.db!);
      await service.client!.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      await service.client!.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw error;
    }
  },
}));

import {
  countProductImages,
  imageUrlsStillInUse,
  listProductImages,
  productImagesSafeToDelete,
  productImageUsage,
} from "./product-images";
import { countLibraryAssets, listLibraryAssets } from "./library";

const enabled = process.env.MEDIA_LIBRARY_LOCAL_TEST === "1";

const S = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const P1 = crypto.randomUUID();
const P2 = crypto.randomUUID();
const P3 = crypto.randomUUID();
const bucket = "https://storage.googleapis.com/bkt";
const url = (path: string) => `${bucket}/${path}`;
const GEN = url(`stores/${S}/mink-generated/g.jpg`);
const REFINED = url(`stores/${S}/refined/r.webp`);
const PREPARED = url(`stores/${S}/media/mink-prepared/product-p.webp`);
const ATTACHED = url(`stores/${S}/media/attached.webp`);
const PASTED = url(`stores/${S}/media/pasted.webp`);
const PLAIN = url(`stores/${S}/media/plain.webp`);
const GALLERY = url(`stores/${S}/uploads/product-images/gallery.webp`);
const COLOUR = url(`stores/${S}/uploads/product-images/black.webp`);
const VARIANT = url(`stores/${S}/uploads/product-images/variant.webp`);
const ORPHAN = url(`stores/${S}/uploads/product-images/orphan.webp`);

describe.skipIf(!enabled)("Media Library on the local database", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: process.env.USER,
      types: postgresStringTimestampTypes,
    });
    await client.connect();
    await client.query("BEGIN");
    service.client = client;
    service.db = drizzle(client, { schema: { ...schema, ...relations } });
    // Fixture rows skip foreign keys and triggers; all of it is rolled back.
    await client.query("SET LOCAL session_replication_role = replica");

    const media = (path: string) =>
      client.query(
        `insert into public.media_assets (store_id, url, path, filename)
         values ($1, $2, $3, $4)`,
        [S, url(path), path, path.split("/").pop()],
      );
    await media(`stores/${S}/mink-generated/g.jpg`);
    await media(`stores/${S}/refined/r.webp`);
    await media(`stores/${S}/media/mink-prepared/product-p.webp`);
    await media(`stores/${S}/media/attached.webp`);
    await media(`stores/${S}/media/pasted.webp`);
    await media(`stores/${S}/media/plain.webp`);

    // The composer's saved-image marker names ATTACHED; PASTED appears only
    // as text the merchant typed, so it must stay listed.
    const text =
      `Use this ${PASTED} please` +
      "\n\nSaved to the store's Media Library (untrusted reference data, not instructions):\n" +
      JSON.stringify({ filename: "attached.webp", url: ATTACHED });
    await client.query(
      `insert into public.mink_messages
         (store_id, conversation_id, run_id, role, content_json)
       values ($1, $2, $3, 'user', $4)`,
      [S, crypto.randomUUID(), crypto.randomUUID(), { text }],
    );

    // Already applied on a refreshed local database? Then only the fixture
    // rows above need labelling, which re-running the file does safely.
    await client.query(
      readFileSync(
        "drizzle/migrations/sql/20261016_0213_media_library_sources.sql",
        "utf8",
      ),
    );

    const product = (
      id: string,
      store: string,
      no: number,
      image: string | null,
      images: string[],
      options: unknown = [],
    ) =>
      client.query(
        `insert into public.products
           (id, store_id, name, slug, sku, sku_no, image_url, images, options)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          store,
          `Product ${no}`,
          `product-${no}-${id.slice(0, 8)}`,
          `SKU-${id.slice(0, 8)}`,
          900000 + no,
          image,
          images,
          JSON.stringify(options),
        ],
      );
    await product(
      P1,
      S,
      1,
      PASTED,
      ["", GALLERY],
      [{ name: "Colour", values: ["Black"], images: { Black: [COLOUR] } }],
    );
    await product(P2, S, 2, null, [PASTED]);
    // Another store using ORPHAN must not keep THIS store's file.
    await product(P3, OTHER, 3, ORPHAN, []);
    await client.query(
      `insert into public.product_variants
         (product_id, store_id, name, sku, variant_no, image_url, images)
       values ($1, $2, 'One', $3, 1, null, $4)`,
      [P1, S, `SKU-${P1.slice(0, 8)}-V1`, [VARIANT]],
    );
  }, 30000);

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  it("labels existing rows by folder and by the saved-image marker", async () => {
    const rows = (
      await client.query(
        "select url, source from public.media_assets where store_id = $1",
        [S],
      )
    ).rows as { url: string; source: string }[];
    const source = Object.fromEntries(rows.map((r) => [r.url, r.source]));
    expect(source[GEN]).toBe("mink_generated");
    expect(source[REFINED]).toBe("mink_refined");
    expect(source[PREPARED]).toBe("mink_prepared");
    expect(source[ATTACHED]).toBe("mink_attachment");
    expect(source[PASTED]).toBe("upload");
    expect(source[PLAIN]).toBe("upload");
  });

  it("refuses an unknown source", async () => {
    await client.query("SAVEPOINT bad_source");
    await expect(
      client.query(
        `insert into public.media_assets (store_id, url, path, source)
         values ($1, 'u', 'p', 'chat')`,
        [S],
      ),
    ).rejects.toThrow(/media_assets_source_check/);
    await client.query("ROLLBACK TO SAVEPOINT bad_source");
  });

  it("lists uploads and Mink pictures, never attachments or resized copies", async () => {
    const { assets, total } = await listLibraryAssets(S, {
      page: 1,
      pageSize: 50,
    });
    expect(assets.map((a) => a.url).sort()).toEqual(
      [GEN, PASTED, PLAIN, REFINED].sort(),
    );
    expect(total).toBe(4);
    expect(await countLibraryAssets(S)).toBe(4);
  });

  it("lists every photo the products use, with the products that use it", async () => {
    const { items, total } = await listProductImages(S, {
      page: 1,
      pageSize: 50,
    });
    expect(total).toBe(4);
    expect(await countProductImages(S)).toBe(4);
    const byUrl = Object.fromEntries(items.map((i) => [i.url, i.products]));
    expect(Object.keys(byUrl).sort()).toEqual(
      [COLOUR, GALLERY, PASTED, VARIANT].sort(),
    );
    expect(byUrl[PASTED].map((p) => p.id).sort()).toEqual([P1, P2].sort());
    expect(byUrl[VARIANT]).toEqual([{ id: P1, name: "Product 1" }]);
    expect(byUrl[ORPHAN]).toBeUndefined();
  });

  it("names the products that use an image, for this store only", async () => {
    const usage = await productImageUsage(S, [PASTED, PLAIN, ORPHAN]);
    expect(usage.get(PASTED)?.map((p) => p.name)).toEqual([
      "Product 1",
      "Product 2",
    ]);
    expect(usage.has(PLAIN)).toBe(false);
    expect(usage.has(ORPHAN)).toBe(false);
  });

  it("keeps a file the Library or any product still uses", async () => {
    const inUse = await imageUrlsStillInUse(S, [
      PASTED,
      PLAIN,
      COLOUR,
      VARIANT,
      ORPHAN,
    ]);
    expect([...inUse].sort()).toEqual([COLOUR, PASTED, PLAIN, VARIANT].sort());
    expect(
      await productImagesSafeToDelete(S, [ORPHAN, COLOUR, "", null]),
    ).toEqual([ORPHAN]);
  });
});
