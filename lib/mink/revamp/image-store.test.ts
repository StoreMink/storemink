import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, type DbMock } from "@/app/actions/_test-helpers";
import { mediaAssets, minkRevampImages } from "@/drizzle/schema";

const STORE = "11111111-1111-4111-8111-111111111111";
const OTHER_STORE = "33333333-3333-4333-8333-333333333333";
const REVAMP = "22222222-2222-4222-8222-222222222222";
const PARENT_REVAMP = "44444444-4444-4444-8444-444444444444";
const BUCKET_URL = "https://storage.googleapis.com/test-bucket/";

const dbHolder = vi.hoisted(() => ({ current: null as DbMock | null }));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (work: (db: unknown) => unknown) =>
    work(dbHolder.current!.db),
  ),
}));

// ★ A redesign's photographs go through the store's one writer (takedown
//   design 5.7).
vi.mock("@/lib/storage/store-objects", () => ({
  writeStoreObject: vi.fn(
    async (path: string) =>
      `https://storage.googleapis.com/test-bucket/${path}`,
  ),
}));

vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsDownloadObject: vi.fn(async () => new Uint8Array()),
  gcsDeletePaths: vi.fn(async () => []),
  gcsPathFromUrl: vi.fn((url: string) =>
    url.startsWith("https://storage.googleapis.com/test-bucket/")
      ? url.slice("https://storage.googleapis.com/test-bucket/".length)
      : null,
  ),
}));

vi.mock("../spend-limits", () => ({
  claimSpendLimits: vi.fn(async () => ({ ok: true })),
  releaseSpendLimits: vi.fn(async () => undefined),
}));

vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { logWarn } from "@/lib/observability/logger";
import { BlockedUploadError } from "@/lib/moderation/upload-guard";
import { gcsDeletePaths, gcsDownloadObject } from "@/lib/storage/gcs";
import { writeStoreObject } from "@/lib/storage/store-objects";
import { claimSpendLimits, releaseSpendLimits } from "../spend-limits";
import type { RevampStoredImage } from "./contract";
import {
  REVAMP_IMAGE_FOLDER,
  REVAMP_PHONE_SUFFIX,
  adoptRevampImage,
  claimRevampPhotos,
  isRevampImagePath,
  listRevampImageRecords,
  listRevampImages,
  readRevampImageBytes,
  readStoreOwnedImageBytes,
  releaseRevampPhotos,
  revampImagePath,
  revampImageStoreConfigured,
  revampPhotoLimits,
  safeRevampSlotId,
  storeRevampImage,
  type StoreRevampImageInput,
} from "./image-store";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function input(
  overrides: Partial<StoreRevampImageInput> = {},
): StoreRevampImageInput {
  return {
    revampId: REVAMP,
    storeId: STORE,
    role: "slot",
    slotId: "hero-1",
    bytes: Buffer.from("a photograph"),
    mediaType: "image/webp",
    width: 2520,
    height: 1080,
    review: "passed",
    problems: [],
    alt: "Linen shirts hanging in morning light",
    ...overrides,
  };
}

/** A row as the database returns it for a stored image. */
function row(image: Partial<RevampStoredImage> & { problems?: unknown } = {}) {
  const bytes = Buffer.from("a photograph");
  const digest = sha(bytes);
  const path =
    image.path ??
    revampImagePath({
      storeId: STORE,
      revampId: REVAMP,
      role: image.role ?? "slot",
      slotId: image.slotId ?? "hero-1",
      sha256: image.sha256 ?? digest,
      mediaType: "image/webp",
    });
  return {
    role: image.role ?? "slot",
    slotId: image.slotId ?? "hero-1",
    url: image.url ?? `${BUCKET_URL}${path}`,
    path,
    sha256: image.sha256 ?? digest,
    width: image.width ?? 2520,
    height: image.height ?? 1080,
    review: image.review ?? "passed",
    problems: image.problems ?? [],
    createdAt: "2026-10-21 10:00:00+00",
  };
}

function setDb(opts: Parameters<typeof makeDbMock>[0]) {
  dbHolder.current = makeDbMock(opts);
  return dbHolder.current;
}

beforeEach(() => {
  setDb({});
});

describe("naming", () => {
  it("names an image by store, revamp, role, slot and content digest", () => {
    const digest = "abcdef0123456789".padEnd(64, "0");
    expect(
      revampImagePath({
        storeId: STORE,
        revampId: REVAMP,
        role: "slot",
        slotId: "hero-1",
        sha256: digest,
        mediaType: "image/webp",
      }),
    ).toBe(
      `stores/${STORE}/${REVAMP_IMAGE_FOLDER}/${REVAMP}/slot-hero-1-abcdef01.webp`,
    );
    expect(
      revampImagePath({
        storeId: STORE,
        revampId: REVAMP,
        role: "product",
        slotId: "p1",
        sha256: digest,
        mediaType: "image/jpeg",
      }),
    ).toMatch(/\/product-p1-abcdef01\.jpg$/);
    expect(
      revampImagePath({
        storeId: STORE,
        revampId: REVAMP,
        role: "anchor",
        slotId: "anchor",
        sha256: digest,
        mediaType: "image/png",
      }),
    ).toMatch(/\/anchor-anchor-abcdef01\.png$/);
  });

  it("folds a slot id into a safe, bounded file name", () => {
    expect(safeRevampSlotId(`hero${REVAMP_PHONE_SUFFIX}`)).toBe("hero-phone");
    expect(safeRevampSlotId("Café Été! Lookbook")).toBe("cafe-ete-lookbook");
    expect(safeRevampSlotId("~~~")).toBe("image");
    expect(safeRevampSlotId("a".repeat(200))).toHaveLength(60);
    expect(safeRevampSlotId(`${"b".repeat(59)}-c`)).toBe("b".repeat(59));
  });

  it("recognises only paths this module writes, under a store", () => {
    const path = revampImagePath({
      storeId: STORE,
      revampId: REVAMP,
      role: "slot",
      slotId: "hero-1",
      sha256: "f".repeat(64),
      mediaType: "image/webp",
    });
    expect(isRevampImagePath(path)).toBe(true);
    expect(isRevampImagePath(`stores/${STORE}/uploads/photo.webp`)).toBe(false);
    expect(
      isRevampImagePath(
        `stores/not-a-uuid/${REVAMP_IMAGE_FOLDER}/${REVAMP}/slot-hero-ffffffff.webp`,
      ),
    ).toBe(false);
    expect(
      isRevampImagePath(
        `stores/${STORE}/mink-generated/other/${REVAMP}/slot-hero-ffffffff.webp`,
      ),
    ).toBe(false);
    expect(
      isRevampImagePath(
        `stores/${STORE}/${REVAMP_IMAGE_FOLDER}/${REVAMP}/../slot-hero-ffffffff.webp`,
      ),
    ).toBe(false);
    expect(
      isRevampImagePath(
        `stores/${STORE}/${REVAMP_IMAGE_FOLDER}/${REVAMP}/slot-hero-ffffffff.gif`,
      ),
    ).toBe(false);
  });

  it("reports storage as configured when the media bucket is", () => {
    expect(revampImageStoreConfigured()).toBe(true);
  });
});

describe("storeRevampImage", () => {
  it("uploads once under the digest name and records the image and its Media row", async () => {
    const bytes = Buffer.from("a photograph");
    const digest = sha(bytes);
    const path = revampImagePath({
      storeId: STORE,
      revampId: REVAMP,
      role: "slot",
      slotId: "hero-1",
      sha256: digest,
      mediaType: "image/webp",
    });
    const db = setDb({
      selectByTable: {
        mink_revamps: [[{ adminId: "admin-7" }]],
        mink_revamp_images: [[]],
        media_assets: [[]],
      },
      returningQueue: [[row({ path })]],
    });

    const stored = await storeRevampImage(
      input({ bytes, problems: [" off_style ", "", 4 as unknown as string] }),
    );

    expect(writeStoreObject).toHaveBeenCalledTimes(1);
    // ★ Owner decision D4: the store-wide 60-second cache, never "immutable",
    //   so a takedown's placeholder reaches shoppers within a minute.
    expect(writeStoreObject).toHaveBeenCalledWith(path, bytes, "image/webp", {
      storeId: STORE,
      cacheControl: "public, max-age=60",
      via: "mink_revamp",
      actor: "admin-7",
    });
    expect(db.calls.insert[0]).toBe(minkRevampImages);
    expect(db.calls.values[0]).toMatchObject({
      revampId: REVAMP,
      storeId: STORE,
      role: "slot",
      slotId: "hero-1",
      url: `${BUCKET_URL}${path}`,
      path,
      sha256: digest,
      width: 2520,
      height: 1080,
      review: "passed",
      problems: ["off_style"],
    });
    expect(db.calls.onConflict[0]).toEqual({
      target: [
        minkRevampImages.revampId,
        minkRevampImages.role,
        minkRevampImages.slotId,
      ],
    });
    expect(db.calls.insert[1]).toBe(mediaAssets);
    expect(db.calls.values[1]).toEqual({
      storeId: STORE,
      url: `${BUCKET_URL}${path}`,
      path,
      filename: `linen-shirts-hanging-in-morning-light-${digest.slice(0, 8)}.webp`,
      contentType: "image/webp",
      sizeBytes: bytes.byteLength,
      createdBy: "admin-7",
      // ★ Hidden from the Library until the card is applied (ops-1).
      source: "mink_prepared",
    });
    expect(stored).toEqual({
      role: "slot",
      slotId: "hero-1",
      url: `${BUCKET_URL}${path}`,
      path,
      sha256: digest,
      width: 2520,
      height: 1080,
      review: "passed",
    });
  });

  it.each([
    ["slot", "hero-1"],
    ["product", "p1"],
    ["anchor", "anchor"],
  ] as const)(
    "★★ files a %s photo out of the Library until its card is applied (ops-1)",
    async (role, slotId) => {
      // A stopped or failed revamp charges nothing, so what it drew is not
      // the merchant's to pick from the Library; Apply reveals what the card
      // showed (apply-v2.ts).
      const db = setDb({
        selectByTable: {
          mink_revamps: [[{ adminId: "admin-7" }]],
          mink_revamp_images: [[]],
          media_assets: [[]],
        },
        returningQueue: [[row({ role, slotId })]],
      });
      await storeRevampImage(input({ role, slotId }));
      const media = db.calls.values[1] as { source: string };
      expect(media.source).toBe("mink_prepared");
    },
  );

  it("files a phone crop as a prepared copy, hidden from the Library", async () => {
    const db = setDb({
      selectByTable: {
        mink_revamps: [[{ adminId: "admin-7" }]],
        mink_revamp_images: [[]],
        media_assets: [[]],
      },
      returningQueue: [[row({ slotId: `hero-1${REVAMP_PHONE_SUFFIX}` })]],
    });
    await storeRevampImage(
      input({ slotId: `hero-1${REVAMP_PHONE_SUFFIX}`, alt: "" }),
    );
    const media = db.calls.values[1] as { source: string; filename: string };
    expect(media.source).toBe("mink_prepared");
    // With no alt text the file is named by its slot.
    expect(media.filename).toMatch(
      /^revamp-slot-hero-1-phone-[a-f0-9]{8}\.webp$/,
    );
  });

  it("returns the stored row without uploading when the slot is already filled", async () => {
    const existing = row({ review: "flagged" });
    const db = setDb({
      selectByTable: {
        mink_revamps: [[{ adminId: "admin-7" }]],
        mink_revamp_images: [[existing]],
      },
    });
    const stored = await storeRevampImage(input());
    expect(writeStoreObject).not.toHaveBeenCalled();
    expect(db.calls.insert).toHaveLength(0);
    expect(stored.review).toBe("flagged");
    expect(stored.path).toBe(existing.path);
  });

  it("hands a racing loser the winner's row and removes its own unused object", async () => {
    const winner = row({
      path: `stores/${STORE}/${REVAMP_IMAGE_FOLDER}/${REVAMP}/slot-hero-1-00000000.webp`,
      sha256: "0".repeat(64),
    });
    const db = setDb({
      selectByTable: {
        mink_revamps: [[{ adminId: "admin-7" }]],
        mink_revamp_images: [[], [winner], []],
      },
      returningQueue: [[]],
    });

    const stored = await storeRevampImage(input());

    expect(stored.path).toBe(winner.path);
    expect(stored.sha256).toBe("0".repeat(64));
    // No Media row for a slot this call did not win.
    expect(db.calls.insert).toEqual([minkRevampImages]);
    const ours = revampImagePath({
      storeId: STORE,
      revampId: REVAMP,
      role: "slot",
      slotId: "hero-1",
      sha256: sha(Buffer.from("a photograph")),
      mediaType: "image/webp",
    });
    expect(gcsDeletePaths).toHaveBeenCalledWith([ours]);
  });

  it("keeps the uploaded object when another row still points at it", async () => {
    const winner = row({
      path: `stores/${STORE}/${REVAMP_IMAGE_FOLDER}/${REVAMP}/slot-hero-1-00000000.webp`,
    });
    setDb({
      selectByTable: {
        mink_revamps: [[{ adminId: "admin-7" }]],
        mink_revamp_images: [[], [winner], [{ path: "in-use" }]],
      },
      returningQueue: [[]],
    });
    await storeRevampImage(input());
    expect(gcsDeletePaths).not.toHaveBeenCalled();
  });

  it("deletes nothing when the winner's photograph is the very same object", async () => {
    setDb({
      selectByTable: {
        mink_revamps: [[{ adminId: "admin-7" }]],
        mink_revamp_images: [[], [row()]],
      },
      returningQueue: [[]],
    });
    await storeRevampImage(input());
    expect(gcsDeletePaths).not.toHaveBeenCalled();
  });

  it("does not add a second Media row for an object the store already lists", async () => {
    const db = setDb({
      selectByTable: {
        mink_revamps: [[{ adminId: "admin-7" }]],
        mink_revamp_images: [[]],
        media_assets: [[{ id: "media-1" }]],
      },
      returningQueue: [[row()]],
    });
    await storeRevampImage(input());
    expect(db.calls.insert).toEqual([minkRevampImages]);
  });

  it("★★ a photograph StoreMink has blocked records nothing and says why", async () => {
    const db = setDb({
      selectByTable: {
        mink_revamps: [[{ adminId: "admin-7" }]],
        mink_revamp_images: [[]],
      },
    });
    vi.mocked(writeStoreObject).mockRejectedValueOnce(
      new BlockedUploadError({
        told: false,
        kindWord: "image",
        blockId: "55555555-5555-4555-8555-555555555555",
      }),
    );
    await expect(storeRevampImage(input())).rejects.toBeInstanceOf(
      BlockedUploadError,
    );
    expect(db.calls.insert).toEqual([]);
    expect(gcsDeletePaths).not.toHaveBeenCalled();
  });

  it("refuses a revamp of another store before uploading anything", async () => {
    setDb({ selectByTable: { mink_revamps: [[]] } });
    await expect(storeRevampImage(input())).rejects.toThrow(
      "This revamp does not belong to the store.",
    );
    expect(writeStoreObject).not.toHaveBeenCalled();
  });

  it("throws when the row cannot be read back after a lost insert", async () => {
    setDb({
      selectByTable: {
        mink_revamps: [[{ adminId: "admin-7" }]],
        mink_revamp_images: [[], []],
      },
      returningQueue: [[]],
    });
    await expect(storeRevampImage(input())).rejects.toThrow(/read back/);
  });

  it.each([
    ["a revamp id", { revampId: "not-a-uuid" }],
    ["a store id", { storeId: "" }],
    ["a slot id", { slotId: "   " }],
    ["a bounded slot id", { slotId: "x".repeat(161) }],
    ["a known role", { role: "banner" as StoreRevampImageInput["role"] }],
    [
      "a known media type",
      { mediaType: "image/gif" as StoreRevampImageInput["mediaType"] },
    ],
    [
      "a known review state",
      { review: "great" as StoreRevampImageInput["review"] },
    ],
    ["some bytes", { bytes: new Uint8Array() }],
    ["at most 12 MiB", { bytes: new Uint8Array(12 * 1024 * 1024 + 1) }],
    ["a whole width", { width: 10.5 }],
    ["a positive height", { height: 0 }],
    ["at most 8192 pixels a side", { width: 8193 }],
  ])("refuses an image without %s", async (_label, overrides) => {
    const db = setDb({});
    await expect(storeRevampImage(input(overrides))).rejects.toThrow();
    expect(db.calls.select).toHaveLength(0);
    expect(writeStoreObject).not.toHaveBeenCalled();
  });

  it("keeps at most 20 problems of at most 200 characters", async () => {
    const db = setDb({
      selectByTable: {
        mink_revamps: [[{ adminId: "admin-7" }]],
        mink_revamp_images: [[]],
        media_assets: [[]],
      },
      returningQueue: [[row()]],
    });
    await storeRevampImage(
      input({
        problems: [
          "x".repeat(300),
          ...Array.from({ length: 30 }, (_, i) => `p${i}`),
        ],
      }),
    );
    const problems = (db.calls.values[0] as { problems: string[] }).problems;
    expect(problems).toHaveLength(20);
    expect(problems[0]).toHaveLength(200);
  });
});

describe("adoptRevampImage", () => {
  function parentImage(
    overrides: Partial<RevampStoredImage> = {},
  ): RevampStoredImage {
    const path = revampImagePath({
      storeId: STORE,
      revampId: PARENT_REVAMP,
      role: "slot",
      slotId: "hero-1",
      sha256: "a".repeat(64),
      mediaType: "image/webp",
    });
    return {
      role: "slot",
      slotId: "hero-1",
      url: `${BUCKET_URL}${path}`,
      path,
      sha256: "a".repeat(64),
      width: 2520,
      height: 1080,
      review: "passed",
      ...overrides,
    };
  }

  it("records the parent's photograph for this revamp with no upload and no Media row", async () => {
    const image = parentImage();
    const db = setDb({
      selectByTable: { mink_revamps: [[{ id: REVAMP }]] },
      returningQueue: [[row({ ...image, problems: [] })]],
    });
    const adopted = await adoptRevampImage({
      revampId: REVAMP,
      storeId: STORE,
      image,
    });
    expect(writeStoreObject).not.toHaveBeenCalled();
    expect(db.calls.insert).toEqual([minkRevampImages]);
    expect(db.calls.values[0]).toMatchObject({
      revampId: REVAMP,
      storeId: STORE,
      role: "slot",
      slotId: "hero-1",
      url: image.url,
      path: image.path,
      sha256: image.sha256,
      problems: [],
    });
    expect(adopted.path).toBe(image.path);
  });

  it("returns the slot's existing row when it is already filled", async () => {
    const existing = row({ slotId: "hero-1", review: "flagged" });
    setDb({
      selectByTable: {
        mink_revamps: [[{ id: REVAMP }]],
        mink_revamp_images: [[existing]],
      },
      returningQueue: [[]],
    });
    const adopted = await adoptRevampImage({
      revampId: REVAMP,
      storeId: STORE,
      image: parentImage(),
    });
    expect(adopted.review).toBe("flagged");
    expect(adopted.path).toBe(existing.path);
  });

  it("★★ writes the problems it is given on the new row, cleaned and bounded (an unchecked photo keeps its marker)", async () => {
    const image = parentImage({ review: "unreviewed" });
    const db = setDb({
      selectByTable: { mink_revamps: [[{ id: REVAMP }]] },
      returningQueue: [[row({ ...image, problems: ["unchecked"] })]],
    });
    await adoptRevampImage({
      revampId: REVAMP,
      storeId: STORE,
      image,
      problems: [
        "unchecked",
        "",
        "  ",
        "y".repeat(300),
        ...Array.from({ length: 30 }, (_, i) => `p${i}`),
      ],
    });
    expect(writeStoreObject).not.toHaveBeenCalled();
    expect(db.calls.insert).toEqual([minkRevampImages]);
    const problems = (db.calls.values[0] as { problems: string[] }).problems;
    expect(problems[0]).toBe("unchecked");
    expect(problems[1]).toHaveLength(200);
    expect(problems).toHaveLength(20);
    expect(problems.every((p) => p.trim() !== "")).toBe(true);
  });

  it("stores an unknown review state as unreviewed", async () => {
    const db = setDb({
      selectByTable: { mink_revamps: [[{ id: REVAMP }]] },
      returningQueue: [[row()]],
    });
    await adoptRevampImage({
      revampId: REVAMP,
      storeId: STORE,
      image: parentImage({
        review: "odd" as RevampStoredImage["review"],
      }),
    });
    expect((db.calls.values[0] as { review: string }).review).toBe(
      "unreviewed",
    );
  });

  it.each([
    [
      "another store's object",
      () => {
        const path = revampImagePath({
          storeId: OTHER_STORE,
          revampId: PARENT_REVAMP,
          role: "slot",
          slotId: "hero-1",
          sha256: "a".repeat(64),
          mediaType: "image/webp",
        });
        return parentImage({ path, url: `${BUCKET_URL}${path}` });
      },
    ],
    [
      "a path this module did not write",
      () =>
        parentImage({
          path: `stores/${STORE}/uploads/hero.webp`,
          url: `${BUCKET_URL}stores/${STORE}/uploads/hero.webp`,
        }),
    ],
    [
      "a URL that disagrees with its path",
      () => parentImage({ url: "https://example.com/hero.webp" }),
    ],
    ["an invalid digest", () => parentImage({ sha256: "nope" })],
    ["a zero width", () => parentImage({ width: 0 })],
    [
      "an unknown role",
      () => parentImage({ role: "banner" as RevampStoredImage["role"] }),
    ],
  ])("refuses %s without touching the database", async (_label, make) => {
    const db = setDb({});
    await expect(
      adoptRevampImage({ revampId: REVAMP, storeId: STORE, image: make() }),
    ).rejects.toThrow();
    expect(db.calls.select).toHaveLength(0);
  });

  it("refuses a revamp that is not the store's", async () => {
    setDb({ selectByTable: { mink_revamps: [[]] } });
    await expect(
      adoptRevampImage({
        revampId: REVAMP,
        storeId: STORE,
        image: parentImage(),
      }),
    ).rejects.toThrow(/could not be adopted/);
  });
});

describe("listing", () => {
  it("lists every known image with its problems, skipping unknown roles", async () => {
    setDb({
      selectQueue: [
        [
          row({ role: "anchor", slotId: "anchor", review: "unreviewed" }),
          row({ slotId: "hero-1", problems: ["recropped", 7, " "] }),
          { ...row({ slotId: "x" }), role: "banner" },
          row({
            slotId: "p1",
            role: "product",
            review: "weird" as RevampStoredImage["review"],
            problems: "not an array",
          }),
        ],
      ],
    });
    const records = await listRevampImageRecords(REVAMP, STORE);
    expect(records.map((r) => `${r.role}:${r.slotId}`)).toEqual([
      "anchor:anchor",
      "slot:hero-1",
      "product:p1",
    ]);
    expect(records[1].problems).toEqual(["recropped"]);
    expect(records[2].problems).toEqual([]);
    expect(records[2].review).toBe("unreviewed");
    expect(records[0].createdAt).toBe("2026-10-21 10:00:00+00");
  });

  it("strips the problems and the time from the plain list", async () => {
    setDb({ selectQueue: [[row({ problems: ["off_style"] })]] });
    const images = await listRevampImages(REVAMP, STORE);
    expect(images).toHaveLength(1);
    expect(images[0]).not.toHaveProperty("problems");
    expect(images[0]).not.toHaveProperty("createdAt");
  });

  it("refuses ids that are not uuids", async () => {
    await expect(listRevampImages("x", STORE)).rejects.toThrow();
  });
});

describe("reading bytes", () => {
  const bytes = Buffer.from("stored photograph");
  const image = (): RevampStoredImage => {
    const path = revampImagePath({
      storeId: STORE,
      revampId: REVAMP,
      role: "slot",
      slotId: "hero-1",
      sha256: sha(bytes),
      mediaType: "image/webp",
    });
    return {
      role: "slot",
      slotId: "hero-1",
      url: `${BUCKET_URL}${path}`,
      path,
      sha256: sha(bytes),
      width: 10,
      height: 10,
      review: "passed",
    };
  };

  it("reads a stored photograph by its path and checks its digest", async () => {
    vi.mocked(gcsDownloadObject).mockResolvedValueOnce(bytes);
    const read = await readRevampImageBytes(image());
    expect(read).toEqual(bytes);
    expect(gcsDownloadObject).toHaveBeenCalledWith(
      image().path,
      20 * 1024 * 1024,
    );
  });

  it("returns null for bytes that are not the recorded photograph", async () => {
    vi.mocked(gcsDownloadObject).mockResolvedValueOnce(Buffer.from("other"));
    expect(await readRevampImageBytes(image())).toBeNull();
    expect(logWarn).toHaveBeenCalledWith(
      "mink.revamp: image bytes do not match their digest",
      expect.anything(),
    );
  });

  it("returns null when the object cannot be read", async () => {
    vi.mocked(gcsDownloadObject).mockRejectedValueOnce(new Error("gone"));
    expect(await readRevampImageBytes(image())).toBeNull();
  });

  it("never downloads a path this module did not write", async () => {
    const foreign = {
      ...image(),
      path: `stores/${STORE}/uploads/x.webp`,
    };
    expect(await readRevampImageBytes(foreign)).toBeNull();
    expect(gcsDownloadObject).not.toHaveBeenCalled();
  });

  it("reads a store-owned image and refuses anything else unread", async () => {
    vi.mocked(gcsDownloadObject).mockResolvedValueOnce(bytes);
    expect(
      await readStoreOwnedImageBytes(
        `${BUCKET_URL}stores/${STORE}/uploads/shoe.jpg`,
        STORE,
      ),
    ).toEqual(bytes);
    expect(
      await readStoreOwnedImageBytes(
        `${BUCKET_URL}stores/${OTHER_STORE}/uploads/shoe.jpg`,
        STORE,
      ),
    ).toBeNull();
    expect(
      await readStoreOwnedImageBytes("https://example.com/shoe.jpg", STORE),
    ).toBeNull();
    expect(gcsDownloadObject).toHaveBeenCalledTimes(1);
  });

  it("returns null when a store-owned image cannot be read", async () => {
    vi.mocked(gcsDownloadObject).mockRejectedValueOnce(new Error("gone"));
    expect(
      await readStoreOwnedImageBytes(
        `${BUCKET_URL}stores/${STORE}/uploads/shoe.jpg`,
        STORE,
      ),
    ).toBeNull();
  });
});

describe("photo limits", () => {
  it("counts every photograph against the store's day and the platform's hour", () => {
    expect(revampPhotoLimits(STORE, 4)).toEqual([
      {
        key: `mink-revamp-photos-day:${STORE}`,
        max: 120,
        windowSeconds: 86_400,
        cost: 4,
      },
      {
        key: "mink-revamp-photos-hour",
        max: 400,
        windowSeconds: 3_600,
        cost: 4,
      },
    ]);
  });

  it("claims both limits at once for the photographs about to be drawn", async () => {
    vi.mocked(claimSpendLimits).mockResolvedValueOnce({ ok: true });
    expect(await claimRevampPhotos(STORE, 3.7)).toEqual({ ok: true });
    expect(claimSpendLimits).toHaveBeenCalledWith(revampPhotoLimits(STORE, 3));
  });

  it("passes a refusal back with the limit that refused", async () => {
    vi.mocked(claimSpendLimits).mockResolvedValueOnce({
      ok: false,
      refusedKey: "mink-revamp-photos-hour",
    });
    expect(await claimRevampPhotos(STORE, 2)).toEqual({
      ok: false,
      refusedKey: "mink-revamp-photos-hour",
    });
  });

  it("claims nothing for nothing", async () => {
    expect(await claimRevampPhotos(STORE, 0)).toEqual({ ok: true });
    expect(await claimRevampPhotos(STORE, -2)).toEqual({ ok: true });
    expect(claimSpendLimits).not.toHaveBeenCalled();
  });

  it("propagates a database failure, so nothing is drawn unchecked", async () => {
    vi.mocked(claimSpendLimits).mockRejectedValueOnce(new Error("db down"));
    await expect(claimRevampPhotos(STORE, 1)).rejects.toThrow("db down");
  });

  it("gives back photographs that were never drawn", async () => {
    await releaseRevampPhotos(STORE, 2);
    expect(releaseSpendLimits).toHaveBeenCalledWith([
      { key: `mink-revamp-photos-day:${STORE}`, cost: 2 },
      { key: "mink-revamp-photos-hour", cost: 2 },
    ]);
    await releaseRevampPhotos(STORE, 0);
    await releaseRevampPhotos(STORE, 0.5);
    expect(releaseSpendLimits).toHaveBeenCalledTimes(1);
  });
});
