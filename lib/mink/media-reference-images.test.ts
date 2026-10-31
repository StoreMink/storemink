import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MinkAttachmentReference } from "./attachments";
import type { MinkActorContext } from "./types";

const rows = vi.hoisted(() => ({ current: [] as Record<string, unknown>[] }));
/** What the blocked-file check answers: the blocked addresses, as rows. */
const blockedRows = vi.hoisted(() => ({
  current: [] as { url: string }[],
}));
const query = vi.hoisted(() => ({
  /** Every reference statement the store lookup executed. */
  executed: [] as unknown[],
  /** Every blocked-file check, with whether the lookup's scope was open. */
  blockChecks: [] as { statement: unknown; open: boolean }[],
  /** True while the store lookup's scope is open. */
  open: false,
}));
const reader = vi.hoisted(() => ({
  /**
   * What `readMinkAttachmentReferences` answers; `null` makes it refuse with
   * the attachments module's sentence.
   */
  read: vi.fn<
    (
      actor: unknown,
      urls: readonly string[],
    ) => Promise<MinkAttachmentReference[] | null>
  >(),
  seenOpen: [] as boolean[],
  /** The attachments module's own sentence (pinned in attachments.test.ts). */
  noLongerAvailable:
    "That attached image is no longer available. Attach it again to use it.",
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (operation: (db: unknown) => unknown) => {
    query.open = true;
    try {
      return await operation({
        execute: vi.fn(async (statement: unknown) => {
          const { PgDialect: Dialect } = await import("drizzle-orm/pg-core");
          const text = new Dialect().sqlToQuery(statement as SQL).sql;
          if (text.includes("content_blocks")) {
            query.blockChecks.push({ statement, open: query.open });
            return { rows: blockedRows.current };
          }
          query.executed.push(statement);
          return { rows: rows.current };
        }),
      });
    } finally {
      query.open = false;
    }
  }),
}));
vi.mock("@/lib/storage/gcs", () => ({
  GCS_BUCKET_NAME: "storemink-media",
  gcsPathFromUrl: (url: string) => {
    const prefix = "https://storage.googleapis.com/storemink-media/";
    return url.startsWith(prefix) ? url.slice(prefix.length) : null;
  },
}));
vi.mock("./attachments", async () => {
  const { MinkToolInputError } = await import("./errors");
  return {
    readMinkAttachmentReferences: vi.fn(
      async (actor: unknown, urls: readonly string[]) => {
        reader.seenOpen.push(query.open);
        const answer = await reader.read(actor, urls);
        if (answer === null) {
          throw new MinkToolInputError(reader.noLongerAvailable);
        }
        return answer;
      },
    ),
  };
});

import { resolveMinkMediaReferenceImages } from "./media-reference-images";
import { readMinkAttachmentReferences } from "./attachments";
import { MinkToolInputError } from "./errors";

const ACTOR = {
  storeId: "store-1",
  adminId: "admin-1",
  isSuperadmin: false,
  permissions: {
    media: ["view"],
    products: ["view"],
    categories: ["view"],
  },
} as unknown as MinkActorContext;

const PRODUCT =
  "https://storage.googleapis.com/storemink-media/stores/store-1/uploads/product-images/milk.webp";
const CATEGORY =
  "https://storage.googleapis.com/storemink-media/stores/store-1/uploads/category-images/dairy.png";
const ATTACHMENT_ID = "0f3a9c42-7b1d-4e6a-9c2b-1d5e8f7a6b3c";
const ATTACHMENT = `/api/mink/attachments/${ATTACHMENT_ID}`;
const INLINE = { mimeType: "image/png" as const, data: "AAAA" };

function params(statement: unknown): unknown[] {
  return new PgDialect().sqlToQuery(statement as SQL).params;
}

describe("Mink image-generation references", () => {
  beforeEach(() => {
    rows.current = [];
    blockedRows.current = [];
    query.executed = [];
    query.blockChecks = [];
    query.open = false;
    vi.stubEnv("GCS_BUCKET", "storemink-media");
    reader.read.mockReset();
    reader.read.mockResolvedValue([] as never);
    reader.seenOpen = [];
    vi.mocked(readMinkAttachmentReferences).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves the model-selected order and converts owned images to GCS parts", async () => {
    rows.current = [
      { url: PRODUCT, source: "product", content_type: null },
      { url: CATEGORY, source: "category", content_type: null },
    ];

    await expect(
      resolveMinkMediaReferenceImages(ACTOR, [CATEGORY, PRODUCT]),
    ).resolves.toEqual([
      {
        url: CATEGORY,
        fileUri:
          "gs://storemink-media/stores/store-1/uploads/category-images/dairy.png",
        mimeType: "image/png",
        source: "category",
      },
      {
        url: PRODUCT,
        fileUri:
          "gs://storemink-media/stores/store-1/uploads/product-images/milk.webp",
        mimeType: "image/webp",
        source: "product",
      },
    ]);
    expect(readMinkAttachmentReferences).not.toHaveBeenCalled();
  });

  it("refuses URLs that no accessible current-store collection returned", async () => {
    await expect(
      resolveMinkMediaReferenceImages(ACTOR, [PRODUCT]),
    ).rejects.toThrow(/exact, accessible URL/);
  });

  // ★ Takedown (fix pass, T20's gap): a file StoreMink blocked is never sent
  //   to the image model, refused in the same words as a URL no collection
  //   returned, and checked on the lookup's own connection.
  it("★★ refuses a blocked file in the same words as an unknown one, checked inside the lookup's own scope", async () => {
    rows.current = [
      { url: PRODUCT, source: "product", content_type: null },
      { url: CATEGORY, source: "category", content_type: null },
    ];
    blockedRows.current = [{ url: CATEGORY }];

    const refused = resolveMinkMediaReferenceImages(ACTOR, [PRODUCT, CATEGORY]);
    await expect(refused).rejects.toBeInstanceOf(MinkToolInputError);
    await expect(refused).rejects.toThrow(/exact, accessible URL/);

    expect(query.blockChecks).toHaveLength(1);
    expect(query.blockChecks[0].open).toBe(true);
    // Keyed the way a file block stores it: this bucket's object name.
    expect(params(query.blockChecks[0].statement)).toEqual([
      [PRODUCT, CATEGORY],
      [
        "stores/store-1/uploads/product-images/milk.webp",
        "stores/store-1/uploads/category-images/dairy.png",
      ],
    ]);
  });

  it("still sends a file with no block, after the same check", async () => {
    rows.current = [{ url: PRODUCT, source: "product", content_type: null }];

    await expect(
      resolveMinkMediaReferenceImages(ACTOR, [PRODUCT]),
    ).resolves.toEqual([
      {
        url: PRODUCT,
        fileUri:
          "gs://storemink-media/stores/store-1/uploads/product-images/milk.webp",
        mimeType: "image/webp",
        source: "product",
      },
    ]);
    expect(query.blockChecks).toHaveLength(1);
    expect(query.executed).toHaveLength(1);
  });

  it("refuses a database URL outside the configured media bucket", async () => {
    const external = "https://cdn.example.com/product.jpg";
    rows.current = [
      { url: external, source: "product", content_type: "image/jpeg" },
    ];
    await expect(
      resolveMinkMediaReferenceImages(ACTOR, [external]),
    ).rejects.toThrow(/supported StoreMink/);
  });

  describe("a picture attached in this chat", () => {
    it("★★ is read privately and comes back inline, in the caller's order beside the store's gs:// parts", async () => {
      rows.current = [
        { url: PRODUCT, source: "product", content_type: null },
        { url: CATEGORY, source: "category", content_type: null },
      ];
      reader.read.mockResolvedValue([
        { url: ATTACHMENT, mimeType: "image/png", inlineData: INLINE },
      ] as never);

      const references = await resolveMinkMediaReferenceImages(ACTOR, [
        PRODUCT,
        ATTACHMENT,
        CATEGORY,
      ]);

      expect(references.map((reference) => reference.source)).toEqual([
        "product",
        "attachment",
        "category",
      ]);
      expect(references[1]).toEqual({
        url: ATTACHMENT,
        inlineData: INLINE,
        mimeType: "image/png",
        source: "attachment",
      });
      // ★ Never a public address for the attachment: no gs:// object and no
      //   https URL, only the bytes.
      expect(references[1]).not.toHaveProperty("fileUri");
      expect(JSON.stringify(references[1])).not.toMatch(/https?:\/\/|gs:\/\//);
      expect(references[0].fileUri).toMatch(/^gs:\/\//);
      expect(references[2].fileUri).toMatch(/^gs:\/\//);
      // Only the attachment addresses reach the reader, the attacher bound.
      expect(readMinkAttachmentReferences).toHaveBeenCalledTimes(1);
      expect(readMinkAttachmentReferences).toHaveBeenCalledWith(ACTOR, [
        ATTACHMENT,
      ]);
      // And the attachment address never reaches the store query.
      expect(query.executed).toHaveLength(1);
      const bound = params(query.executed[0]);
      expect(bound).toContainEqual([PRODUCT, CATEGORY]);
      expect(JSON.stringify(bound)).not.toContain(ATTACHMENT_ID);
    });

    it("★ needs no store query and no collection permission when every reference is an attachment", async () => {
      reader.read.mockResolvedValue([
        { url: ATTACHMENT, mimeType: "image/webp", inlineData: INLINE },
      ] as never);
      const noPermissions = {
        ...ACTOR,
        permissions: {},
      } as unknown as MinkActorContext;

      await expect(
        resolveMinkMediaReferenceImages(noPermissions, [ATTACHMENT]),
      ).resolves.toEqual([
        {
          url: ATTACHMENT,
          inlineData: INLINE,
          mimeType: "image/webp",
          source: "attachment",
        },
      ]);
      expect(query.executed).toEqual([]);
      expect(query.blockChecks).toEqual([]);
    });

    it("★ reads the attachment in its own scope, after the store lookup's has closed", async () => {
      rows.current = [{ url: PRODUCT, source: "product", content_type: null }];
      reader.read.mockResolvedValue([
        { url: ATTACHMENT, mimeType: "image/jpeg", inlineData: INLINE },
      ] as never);

      await resolveMinkMediaReferenceImages(ACTOR, [ATTACHMENT, PRODUCT]);

      expect(reader.seenOpen).toEqual([false]);
      // The query ran first: a refused store URL costs no download.
      expect(query.executed).toHaveLength(1);
    });

    it("★★ refuses an attachment that is not the attacher's with the attachments module's own sentence", async () => {
      reader.read.mockResolvedValue(null as never);

      await expect(
        resolveMinkMediaReferenceImages(ACTOR, [ATTACHMENT]),
      ).rejects.toThrow(reader.noLongerAvailable);
      await expect(
        resolveMinkMediaReferenceImages(ACTOR, [ATTACHMENT]),
      ).rejects.toBeInstanceOf(MinkToolInputError);
    });

    it("refuses a store URL nobody returned before any attachment bytes are read", async () => {
      reader.read.mockResolvedValue([
        { url: ATTACHMENT, mimeType: "image/png", inlineData: INLINE },
      ] as never);

      await expect(
        resolveMinkMediaReferenceImages(ACTOR, [ATTACHMENT, PRODUCT]),
      ).rejects.toThrow(/exact, accessible URL/);
      expect(readMinkAttachmentReferences).not.toHaveBeenCalled();
    });

    it("asks for a repeated address once and answers it at every place", async () => {
      reader.read.mockResolvedValue([
        { url: ATTACHMENT, mimeType: "image/png", inlineData: INLINE },
      ] as never);

      const references = await resolveMinkMediaReferenceImages(ACTOR, [
        ATTACHMENT,
        ATTACHMENT,
      ]);

      expect(readMinkAttachmentReferences).toHaveBeenCalledWith(ACTOR, [
        ATTACHMENT,
      ]);
      expect(references).toHaveLength(2);
      expect(references[0]).toEqual(references[1]);
      expect(references[0].source).toBe("attachment");
    });
  });
});
