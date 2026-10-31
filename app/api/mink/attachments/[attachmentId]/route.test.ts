// The only way to read a chat attachment: gated, bound to the viewer, served
// from the PRIVATE bucket with the lock-down headers, never run as a page.
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gcs = vi.hoisted(() => ({ private: true }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerContext: vi.fn(),
}));
vi.mock("@/lib/mink/attachments", () => ({
  readMinkAttachmentForViewer: vi.fn(),
}));
vi.mock("@/lib/storage/gcs", () => ({
  get gcsPrivateConfigured() {
    return gcs.private;
  },
  get gcsConfigured() {
    return true;
  },
  gcsObjectInfo: vi.fn(),
  gcsObjectStream: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import { GET } from "./route";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { readMinkAttachmentForViewer } from "@/lib/mink/attachments";
import { logError } from "@/lib/observability/logger";
import { gcsObjectInfo, gcsObjectStream } from "@/lib/storage/gcs";

const ID = "11111111-1111-4111-8111-111111111111";
const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATH = `stores/${STORE}/mink-attachments/storemink_local/${ID}.webp`;

const viewer = () => ({
  userId: "admin-1",
  userEmail: "owner@example.com",
  storeId: STORE,
  profile: { role: "superadmin" },
  permissions: {},
  isSuperadmin: true,
  isPlatformAdmin: false,
});

function call(id = ID, headers: Record<string, string> = {}) {
  const request = {
    headers: new Headers(headers),
  } as unknown as Parameters<typeof GET>[0];
  return GET(request, { params: Promise.resolve({ attachmentId: id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  gcs.private = true;
  vi.mocked(getViewerContext).mockResolvedValue(
    viewer() as unknown as Awaited<ReturnType<typeof getViewerContext>>,
  );
  vi.mocked(readMinkAttachmentForViewer).mockResolvedValue({
    path: PATH,
    contentType: "image/webp",
    sizeBytes: 10,
    filename: "shoe.webp",
  });
  vi.mocked(gcsObjectInfo).mockResolvedValue({
    size: 10,
    contentType: "image/webp",
  });
  vi.mocked(gcsObjectStream).mockImplementation(async () =>
    Readable.from([Buffer.from("0123456789")]),
  );
});

describe("GET /api/mink/attachments/[attachmentId]", () => {
  it("a signed-out request gets 401, not the login page", async () => {
    vi.mocked(getViewerContext).mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    expect(readMinkAttachmentForViewer).not.toHaveBeenCalled();
  });

  it("★ an access lookup that failed is 503, never a refusal", async () => {
    vi.mocked(getViewerContext).mockResolvedValueOnce({
      ...viewer(),
      profile: null,
      dbError: true,
    } as unknown as Awaited<ReturnType<typeof getViewerContext>>);
    expect((await call()).status).toBe(503);
    expect(readMinkAttachmentForViewer).not.toHaveBeenCalled();
  });

  it("★ a person with no profile on this store gets 403 and no file", async () => {
    vi.mocked(getViewerContext).mockResolvedValueOnce({
      ...viewer(),
      profile: null,
    } as unknown as Awaited<ReturnType<typeof getViewerContext>>);
    expect((await call()).status).toBe(403);
    expect(readMinkAttachmentForViewer).not.toHaveBeenCalled();
    expect(gcsObjectStream).not.toHaveBeenCalled();
  });

  it("★ 503 with no private bucket, and nothing is read or asked", async () => {
    gcs.private = false;
    expect((await call()).status).toBe(503);
    expect(readMinkAttachmentForViewer).not.toHaveBeenCalled();
    expect(gcsObjectInfo).not.toHaveBeenCalled();
  });

  it("a malformed id is a plain 404", async () => {
    for (const id of ["../etc", "not-a-uuid", `${ID}0`]) {
      expect((await call(id)).status).toBe(404);
    }
    expect(readMinkAttachmentForViewer).not.toHaveBeenCalled();
  });

  it("★ the loader gets the host's store and the viewer's own id, never a value from the request", async () => {
    await call(ID.toUpperCase(), {
      "x-store-id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "x-admin-id": "somebody-else",
    });
    expect(readMinkAttachmentForViewer).toHaveBeenCalledOnce();
    expect(readMinkAttachmentForViewer).toHaveBeenCalledWith({
      storeId: STORE,
      adminId: "admin-1",
      id: ID,
    });
  });

  it("★ a picture the loader does not find is a 404 that says nothing", async () => {
    vi.mocked(readMinkAttachmentForViewer).mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(res.headers.get("ETag")).toBeNull();
    expect(gcsObjectInfo).not.toHaveBeenCalled();
    expect(gcsObjectStream).not.toHaveBeenCalled();
  });

  it("an object missing from the private bucket is 404", async () => {
    vi.mocked(gcsObjectInfo).mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);
    expect(gcsObjectStream).not.toHaveBeenCalled();
  });

  it("★★ serves the picture from the PRIVATE bucket with the lock-down headers", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(gcsObjectInfo).toHaveBeenCalledWith("private", PATH);
    expect(gcsObjectStream).toHaveBeenCalledWith("private", PATH);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("ETag")).toBe(`"${ID}"`);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(res.headers.get("Content-Disposition")).toBe(
      `inline; filename="shoe.webp"; filename*=UTF-8''shoe.webp`,
    );
    expect(res.headers.get("Accept-Ranges")).toBeNull();
    expect(await res.text()).toBe("0123456789");
  });

  it("the file name goes out in both RFC 6266 forms, or not at all", async () => {
    vi.mocked(readMinkAttachmentForViewer).mockResolvedValueOnce({
      path: PATH,
      contentType: "image/png",
      sizeBytes: 10,
      filename: 'Size chart ₹ "A".png',
    });
    let res = await call();
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toBe(
      `inline; filename="Size chart _ _A_.png"; filename*=UTF-8''${encodeURIComponent('Size chart ₹ "A".png')}`,
    );
    vi.mocked(readMinkAttachmentForViewer).mockResolvedValueOnce({
      path: PATH,
      contentType: "image/webp",
      sizeBytes: 10,
      filename: "",
    });
    res = await call();
    expect(res.headers.get("Content-Disposition")).toBe("inline");
  });

  it("★ a matching If-None-Match is 304 after the checks, and storage is never asked", async () => {
    for (const header of [`"${ID}"`, `W/"${ID}"`, `"other", "${ID}"`, "*"]) {
      vi.mocked(readMinkAttachmentForViewer).mockClear();
      const res = await call(ID.toUpperCase(), { "if-none-match": header });
      expect(res.status, header).toBe(304);
      expect(res.headers.get("ETag")).toBe(`"${ID}"`);
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(readMinkAttachmentForViewer).toHaveBeenCalledOnce();
    }
    expect(gcsObjectInfo).not.toHaveBeenCalled();
    expect(gcsObjectStream).not.toHaveBeenCalled();
  });

  it("★ a 304 is never given for a picture the viewer may no longer read", async () => {
    vi.mocked(readMinkAttachmentForViewer).mockResolvedValueOnce(null);
    expect((await call(ID, { "if-none-match": `"${ID}"` })).status).toBe(404);
  });

  it("a stale If-None-Match still serves the picture", async () => {
    const res = await call(ID, { "if-none-match": `"something-else"` });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });

  it("★ a storage failure is 502, logged with ids only", async () => {
    vi.mocked(gcsObjectStream).mockRejectedValueOnce(new Error("gcs down"));
    const res = await call();
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: read failed",
      expect.any(Error),
      { storeId: STORE, adminId: "admin-1", attachmentId: ID },
    );
  });

  it("a loader failure is 502 too, and nothing is streamed", async () => {
    vi.mocked(readMinkAttachmentForViewer).mockRejectedValueOnce(
      new Error("db down"),
    );
    expect((await call()).status).toBe(502);
    expect(gcsObjectStream).not.toHaveBeenCalled();
  });

  it("★★ never asks the public bucket", async () => {
    vi.mocked(gcsObjectInfo).mockResolvedValueOnce(null);
    await call();
    await call();
    await call(ID, { "if-none-match": `"${ID}"` });
    for (const [kind] of vi.mocked(gcsObjectInfo).mock.calls) {
      expect(kind).toBe("private");
    }
    for (const [kind] of vi.mocked(gcsObjectStream).mock.calls) {
      expect(kind).toBe("private");
    }
    expect(gcsObjectInfo).toHaveBeenCalledTimes(2);
  });
});
