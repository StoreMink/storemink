/** Rollback-only checks of the Media Library delete guard against the local
 * database: an image a storefront redesign, a page, the header and footer or
 * a category still uses is refused, and nothing else is. Run with
 * MEDIA_LIBRARY_LOCAL_TEST=1 (or MINK_REVAMP_LOCAL_TEST=1); the fixed loopback
 * address keeps it off Cloud SQL, and everything it writes is rolled back. */
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";

const service = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
  store: "",
}));
vi.mock("@/lib/db/client", () => ({
  async withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const name = `media_delete_${++service.count}`;
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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(async () => "admin-1"),
  getActingStoreId: vi.fn(async () => service.store),
  getViewerAccess: vi.fn(async () => null),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsUploadObject: vi.fn(async () => ""),
  gcsPathFromUrl: vi.fn((url: string) => url.split("/bkt/")[1] ?? null),
  gcsDeletePaths: vi.fn(async () => {}),
}));
vi.mock("@/lib/storage/process-image", () => ({
  processImageUpload: vi.fn(async () => ({ ok: false, error: "unused" })),
}));

import { deleteMediaAsset } from "./media-actions";
import { gcsDeletePaths } from "@/lib/storage/gcs";

const enabled =
  process.env.MEDIA_LIBRARY_LOCAL_TEST === "1" ||
  process.env.MINK_REVAMP_LOCAL_TEST === "1";

const S = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const bucket = "https://storage.googleapis.com/bkt";

/** One Media Library row of store S per case, by name. */
const CASES = [
  "readyCard",
  "readyCardSource",
  "readyCardPhone",
  "expiredCard",
  "queuedRequest",
  "activeParent",
  "appliedUnused",
  "undoneUnused",
  "failed",
  "superseded",
  "pageDraft",
  "pageLive",
  "chrome",
  "chromeDraft",
  "category",
  "otherStore",
  "plain",
] as const;
type Case = (typeof CASES)[number];

const ids = Object.fromEntries(
  CASES.map((c) => [c, crypto.randomUUID()]),
) as Record<Case, string>;
const paths = Object.fromEntries(
  CASES.map((c) => [c, `stores/${S}/media/${c}.webp`]),
) as Record<Case, string>;
const url = (c: Case) => `${bucket}/${paths[c]}`;

const R = {
  ready: crypto.randomUUID(),
  expired: crypto.randomUUID(),
  queued: crypto.randomUUID(),
  applied: crypto.randomUUID(),
  appliedParent: crypto.randomUUID(),
  undone: crypto.randomUUID(),
  failed: crypto.randomUUID(),
  superseded: crypto.randomUUID(),
  other: crypto.randomUUID(),
};
const SHA = "a".repeat(64);
const CHAT = crypto.randomUUID();
const OLD_CHAT = crypto.randomUUID();
const OTHER_CHAT = crypto.randomUUID();

describe.skipIf(!enabled)("deleteMediaAsset on the local database", () => {
  let client: Client;

  const exists = async (c: Case) =>
    (
      await client.query(
        "select 1 from public.media_assets where id = $1 and store_id = $2",
        [ids[c], S],
      )
    ).rowCount === 1;

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
    service.store = S;
    // Fixture rows skip foreign keys and triggers; all of it is rolled back.
    await client.query("SET LOCAL session_replication_role = replica");

    for (const c of CASES) {
      await client.query(
        `insert into public.media_assets (id, store_id, url, path, filename, source)
         values ($1, $2, $3, $4, $5, 'mink_generated')`,
        [ids[c], S, url(c), paths[c], `${c}.webp`],
      );
    }

    const revamp = (
      id: string,
      store: string,
      fields: {
        kind?: string;
        status: string;
        parent?: string | null;
        applied?: boolean;
        undone?: boolean;
        request?: unknown;
        result?: unknown;
        conversation?: string | null;
      },
    ) =>
      client.query(
        `insert into public.mink_revamps
           (id, store_id, admin_id, kind, status, request, result, parent_id,
            draft_id, error_code, applied_at, undone_at, conversation_id)
         values ($1, $2, 'admin-1', $3, $4, $5, $6, $7, $8, $9,
                 case when $10 then now() end, case when $11 then now() end,
                 $12)`,
        [
          id,
          store,
          fields.kind ?? "full",
          fields.status,
          JSON.stringify(fields.request ?? { kind: fields.kind ?? "full" }),
          fields.result === undefined ? null : JSON.stringify(fields.result),
          fields.parent ?? null,
          ["ready", "superseded"].includes(fields.status)
            ? crypto.randomUUID()
            : null,
          fields.status === "failed" ? "internal" : null,
          fields.applied ?? false,
          fields.undone ?? false,
          fields.conversation ?? null,
        ],
      );
    const image = (revampId: string, store: string, c: Case, slotId: string) =>
      client.query(
        `insert into public.mink_revamp_images
           (id, revamp_id, store_id, role, slot_id, url, path, sha256, width, height)
         values ($1, $2, $3, 'slot', $4, $5, $6, $7, 1600, 900)`,
        [crypto.randomUUID(), revampId, store, slotId, url(c), paths[c], SHA],
      );

    const chat = (id: string, store: string, expiresIn: string) =>
      client.query(
        `insert into public.mink_conversations
           (id, store_id, admin_id, title, created_at, expires_at)
         values ($1, $2, 'admin-1', 'Redesign', now() - interval '100 days',
                 now() + $3::interval)`,
        [id, store, expiresIn],
      );
    // ★ Every finished card below lives in a chat that still lists it, so
    //   what decides each case is its status, never a missing chat.
    await chat(CHAT, S, "30 days");
    await chat(OLD_CHAT, S, "-1 day");
    await chat(OTHER_CHAT, OTHER, "30 days");

    // A ready card the merchant has not applied: its own photo, its phone
    // crop, and the merchant photo its plan names for a product it creates.
    await revamp(R.ready, S, {
      status: "ready",
      conversation: CHAT,
      result: {
        stored: {
          products: {
            create: [{ key: "p1", sourceImageUrl: url("readyCardSource") }],
          },
        },
      },
    });
    await image(R.ready, S, "readyCard", "hero");
    await image(R.ready, S, "readyCardPhone", "hero~phone");
    // The same, in a chat that has expired: nobody can reach that card now.
    await revamp(R.expired, S, { status: "ready", conversation: OLD_CHAT });
    await image(R.expired, S, "expiredCard", "hero");
    // A refinement still queued names a merchant photo in its request, and
    // may adopt its applied parent's photographs.
    await revamp(R.appliedParent, S, { status: "ready", applied: true });
    await image(R.appliedParent, S, "activeParent", "story");
    await revamp(R.queued, S, {
      kind: "refine",
      status: "queued",
      parent: R.appliedParent,
      request: {
        kind: "refine",
        products: [{ key: "p1", photoUrl: url("queuedRequest") }],
      },
    });
    // Finished with: applied (no page shows the photo now), undone, failed,
    // superseded before anyone applied it.
    await revamp(R.applied, S, {
      status: "ready",
      applied: true,
      conversation: CHAT,
    });
    await image(R.applied, S, "appliedUnused", "gallery-1");
    await revamp(R.undone, S, {
      status: "ready",
      applied: true,
      undone: true,
      conversation: CHAT,
    });
    await image(R.undone, S, "undoneUnused", "gallery-2");
    await revamp(R.failed, S, { status: "failed" });
    await image(R.failed, S, "failed", "hero");
    await revamp(R.superseded, S, {
      status: "superseded",
      conversation: CHAT,
    });
    await image(R.superseded, S, "superseded", "hero");
    // Another store's ready card and page naming THIS store's photo.
    await revamp(R.other, OTHER, {
      status: "ready",
      conversation: OTHER_CHAT,
    });
    await image(R.other, OTHER, "otherStore", "hero");

    const page = (
      store: string,
      slug: string,
      title: string,
      sections: unknown,
      published: unknown,
    ) =>
      client.query(
        `insert into public.store_pages
           (id, store_id, slug, title, status, sections, published_sections)
         values ($1, $2, $3, $4, 'published', $5, $6)`,
        [
          crypto.randomUUID(),
          store,
          slug,
          title,
          JSON.stringify(sections),
          JSON.stringify(published),
        ],
      );
    const section = (c: Case) => [
      {
        id: crypto.randomUUID(),
        type: "media_text",
        config: { heading: "Our process", image_url: url(c) },
      },
    ];
    await page(S, "about", "About", section("pageDraft"), []);
    await page(S, "", "", [], section("pageLive"));
    await page(OTHER, "about", "About", section("otherStore"), []);
    await client.query(
      `insert into public.store_chrome (store_id, draft, published)
       values ($1, $2, $3)`,
      [
        S,
        JSON.stringify({
          footer: {
            groups: [{ title: "Visit", image_url: url("chromeDraft") }],
          },
        }),
        JSON.stringify({
          header: {
            links: [
              {
                label: "Shop",
                href: "/shop",
                image_url: url("chrome"),
                children: [],
              },
            ],
          },
        }),
      ],
    );
    await client.query(
      `insert into public.categories (id, store_id, name, slug, image_url)
       values ($1, $2, 'Juices', 'juices', $3)`,
      [crypto.randomUUID(), S, url("category")],
    );
  }, 30000);

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  beforeEach(() => {
    vi.mocked(gcsDeletePaths).mockClear();
  });

  const refused = async (c: Case, message: RegExp) => {
    const res = await deleteMediaAsset(ids[c]);
    expect(res.success).toBeUndefined();
    expect(res.error).toMatch(message);
    expect(await exists(c)).toBe(true);
    expect(gcsDeletePaths).not.toHaveBeenCalled();
  };
  const deleted = async (c: Case) => {
    const res = await deleteMediaAsset(ids[c]);
    expect(res).toEqual({ success: true });
    expect(await exists(c)).toBe(false);
    expect(gcsDeletePaths).toHaveBeenCalledWith([paths[c]]);
  };

  // ★★ The bug: every one of these was deleted, row and object, so the card's
  //    preview broke and Apply refused for ever ("no longer in this store's
  //    Media Library"), or a live page, the header or a category tile lost
  //    its photo.
  it("refuses a photo of a redesign card that has not been applied", async () => {
    await refused("readyCard", /storefront redesign.*not been applied/i);
  });

  it("refuses the phone crop of that card's photo", async () => {
    await refused("readyCardPhone", /storefront redesign.*not been applied/i);
  });

  it("refuses a merchant photo the card's plan uses for a product", async () => {
    await refused("readyCardSource", /storefront redesign.*not been applied/i);
  });

  it("refuses a photo a redesign still being made names in its request", async () => {
    await refused("queuedRequest", /still making a storefront redesign/i);
  });

  it("refuses an applied card's photo while a refinement of it is being made", async () => {
    await refused("activeParent", /still making a storefront redesign/i);
  });

  it("refuses a photo a page's Builder draft shows", async () => {
    await refused("pageDraft", /The About page uses this image/);
  });

  it("refuses a photo the live homepage shows", async () => {
    await refused("pageLive", /The Home page uses this image/);
  });

  it("refuses a photo the live header shows", async () => {
    await refused("chrome", /header or footer uses this image/i);
  });

  it("refuses a photo the header and footer draft shows", async () => {
    await refused("chromeDraft", /header or footer uses this image/i);
  });

  it("refuses a category's photo", async () => {
    await refused("category", /The Juices category uses this image/);
  });

  // ★ And nothing else: a photo no page, category, header, footer or pending
  //   card shows may still be deleted, or every redesign's photos would be
  //   undeletable for ever behind a message that is no longer true.
  it("deletes a photo of an applied redesign that no page shows any more", async () => {
    await deleted("appliedUnused");
  });

  it("deletes a photo of an undone redesign", async () => {
    await deleted("undoneUnused");
  });

  it("deletes a photo of an unapplied card whose chat has expired", async () => {
    await deleted("expiredCard");
  });

  it("deletes a photo of a failed redesign", async () => {
    await deleted("failed");
  });

  it("deletes a photo of a card a newer version replaced before it was applied", async () => {
    await deleted("superseded");
  });

  it("ignores another store's redesign and pages", async () => {
    await deleted("otherStore");
  });

  it("deletes an image nothing uses", async () => {
    await deleted("plain");
  });
});
