import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/server-user", () => ({
  getServerUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsUploadObject: vi.fn(async (path: string) => `https://media/${path}`),
}));
vi.mock("@/lib/storage/store-objects", () => ({
  writeStoreObject: vi.fn(async (path: string) => `https://media/${path}`),
}));
// The re-upload guard's own reads and records never run here (the writer is
// mocked); a database call would be a bug in the test.
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async () => {
    throw new Error("no database in this test");
  }),
}));
vi.mock("@/lib/storage/process-image", () => ({
  processImageUpload: vi.fn(async () => ({
    ok: true,
    data: {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/webp",
      ext: "webp",
    },
  })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/storage/upload-owner", () => ({
  resolveUploadOwner: vi.fn(async () => ({
    kind: "store",
    storeId: "store-1",
    staff: true,
  })),
}));

import { POST } from "./route";
import { gcsUploadObject } from "@/lib/storage/gcs";
import { writeStoreObject } from "@/lib/storage/store-objects";
import { resolveUploadOwner } from "@/lib/storage/upload-owner";
import { BlockedUploadError } from "@/lib/moderation/upload-guard";

const BLOCK = "b0000000-0000-4000-8000-000000000001";

function uploadRequest() {
  const form = new FormData();
  form.append("file", new File(["image"], "photo.png", { type: "image/png" }));
  form.append("folder", "product-images");
  // Keep the jsdom File instance intact. Undici's Request parser constructs a
  // different-realm File, which correctly fails the route's instanceof guard.
  return { formData: async () => form } as Request;
}

describe("POST /api/upload storage ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUploadOwner).mockResolvedValue({
      kind: "store",
      storeId: "store-1",
      staff: true,
    });
  });

  it("places a store-host upload below that store's deletable prefix, through the re-upload guard", async () => {
    const res = await POST(uploadRequest());
    expect(res.status).toBe(200);
    expect(writeStoreObject).toHaveBeenCalledTimes(1);
    expect(writeStoreObject).toHaveBeenCalledWith(
      expect.stringMatching(
        /^stores\/store-1\/uploads\/product-images\/[a-z0-9]+_\d+\.webp$/,
      ),
      expect.any(Uint8Array),
      "image/webp",
      { storeId: "store-1", via: "upload_route", actor: "user-1" },
    );
    expect(gcsUploadObject).not.toHaveBeenCalled();
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^https:\/\/media\/stores\/store-1\/uploads\//);
  });

  // A platform upload is not a store object: writeStoreObject refuses any
  // path outside stores/ and theme-releases/, so it is written directly.
  it("places a platform-host upload below the platform prefix", async () => {
    vi.mocked(resolveUploadOwner).mockResolvedValueOnce({ kind: "platform" });
    expect((await POST(uploadRequest())).status).toBe(200);
    expect(gcsUploadObject).toHaveBeenCalledWith(
      expect.stringMatching(
        /^platform\/uploads\/product-images\/[a-z0-9]+_\d+\.webp$/,
      ),
      expect.any(Uint8Array),
      "image/webp",
    );
    expect(writeStoreObject).not.toHaveBeenCalled();
  });

  it("rejects a signed-in user who does not own the upload scope", async () => {
    vi.mocked(resolveUploadOwner).mockResolvedValueOnce(null);
    expect((await POST(uploadRequest())).status).toBe(403);
    expect(gcsUploadObject).not.toHaveBeenCalled();
    expect(writeStoreObject).not.toHaveBeenCalled();
  });
});

describe("POST /api/upload, bytes StoreMink has blocked (takedown design 7.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUploadOwner).mockResolvedValue({
      kind: "store",
      storeId: "store-1",
      staff: true,
    });
  });

  it("answers 409 with the named sentence when the store was told of the block", async () => {
    vi.mocked(writeStoreObject).mockRejectedValueOnce(
      new BlockedUploadError({ told: true, kindWord: "image", blockId: BLOCK }),
    );
    const res = await POST(uploadRequest());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "StoreMink has blocked this image, so it can't be uploaded again. See Settings, Notices from StoreMink.",
    });
    expect(gcsUploadObject).not.toHaveBeenCalled();
  });

  it("answers a shopper with the nameless sentence even when the store was told", async () => {
    vi.mocked(resolveUploadOwner).mockResolvedValue({
      kind: "store",
      storeId: "store-1",
      staff: false,
    });
    vi.mocked(writeStoreObject).mockRejectedValueOnce(
      new BlockedUploadError({ told: true, kindWord: "image", blockId: BLOCK }),
    );
    const res = await POST(uploadRequest());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "This file can't be uploaded. If you need help, write to support@storemink.com.",
    });
  });

  it("answers 409 with the nameless sentence for a block kept from the store", async () => {
    vi.mocked(writeStoreObject).mockRejectedValueOnce(
      new BlockedUploadError({
        told: false,
        kindWord: "image",
        blockId: BLOCK,
      }),
    );
    const res = await POST(uploadRequest());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "This file can't be uploaded. If you need help, write to support@storemink.com.",
    });
  });

  it("still answers any other storage failure with the plain 500", async () => {
    vi.mocked(writeStoreObject).mockRejectedValueOnce(new Error("GCS down"));
    const res = await POST(uploadRequest());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Upload failed. Please try again.",
    });
  });
});
