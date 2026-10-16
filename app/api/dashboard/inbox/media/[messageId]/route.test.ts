// The only way to read WhatsApp chat media: gated, store-scoped, streamed
// from the private bucket, never run as a page.
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gcs = vi.hoisted(() => ({ private: true, public: true }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerContext: vi.fn(async () => ({ userId: "admin-1" })),
}));
vi.mock("@/lib/whatsapp/inbox-gate", () => ({
  inboxGate: vi.fn(async () => ({
    ok: true,
    storeId: "store-1",
    userId: "admin-1",
    isSuperadmin: false,
  })),
  isUuid: (v: string) => /^[0-9a-f-]{36}$/i.test(v),
}));
vi.mock("@/lib/whatsapp/inbox-read", () => ({
  loadInboxMessageMedia: vi.fn(async () => ({
    path: "stores/store-1/whatsapp/c1/m1.jpg",
    mime: "image/jpeg",
    name: null,
  })),
}));
vi.mock("@/lib/storage/gcs", () => ({
  get gcsPrivateConfigured() {
    return gcs.private;
  },
  get gcsConfigured() {
    return gcs.public;
  },
  gcsObjectInfo: vi.fn(async (kind: string) =>
    kind === "private" ? { size: 10, contentType: "image/jpeg" } : null,
  ),
  gcsObjectStream: vi.fn(async () =>
    Readable.from([Buffer.from("0123456789")]),
  ),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import { GET } from "./route";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { inboxGate } from "@/lib/whatsapp/inbox-gate";
import { loadInboxMessageMedia } from "@/lib/whatsapp/inbox-read";
import { gcsObjectInfo, gcsObjectStream } from "@/lib/storage/gcs";

const ID = "11111111-1111-4111-8111-111111111111";

function call(id = ID, range?: string) {
  const headers = new Headers(range ? { range } : {});
  const request = { headers } as unknown as Parameters<typeof GET>[0];
  return GET(request, { params: Promise.resolve({ messageId: id }) });
}

beforeEach(() => {
  gcs.private = true;
  gcs.public = true;
});

describe("GET /api/dashboard/inbox/media/[messageId]", () => {
  it("a signed-out request gets 401, not the login page", async () => {
    vi.mocked(getViewerContext).mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    expect(loadInboxMessageMedia).not.toHaveBeenCalled();
  });

  it("★ a person without Inbox view gets 403 and no file", async () => {
    vi.mocked(inboxGate).mockResolvedValueOnce({ ok: false, error: "no" });
    expect((await call()).status).toBe(403);
    expect(gcsObjectStream).not.toHaveBeenCalled();
  });

  it("★ another store's message, or a malformed id, is a plain 404", async () => {
    expect((await call("../etc")).status).toBe(404);
    vi.mocked(loadInboxMessageMedia).mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);
    expect(loadInboxMessageMedia).toHaveBeenLastCalledWith("store-1", ID);
  });

  it("★★ streams the whole file from the PRIVATE bucket, never as a page", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(gcsObjectStream).toHaveBeenCalledWith(
      "private",
      "stores/store-1/whatsapp/c1/m1.jpg",
      undefined,
    );
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
    expect(await res.text()).toBe("0123456789");
  });

  it("★ answers a byte range with 206 (a voice note in Safari)", async () => {
    vi.mocked(gcsObjectStream).mockResolvedValueOnce(
      Readable.from([Buffer.from("01")]),
    );
    const res = await call(ID, "bytes=0-1");
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-1/10");
    expect(res.headers.get("Content-Length")).toBe("2");
    expect(gcsObjectStream).toHaveBeenCalledWith(
      "private",
      "stores/store-1/whatsapp/c1/m1.jpg",
      { start: 0, end: 1 },
    );
  });

  it("a range past the end is 416 with the size", async () => {
    const res = await call(ID, "bytes=50-");
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */10");
    expect(gcsObjectStream).not.toHaveBeenCalled();
  });

  it("a file stored before the private bucket existed is read from the public one", async () => {
    vi.mocked(gcsObjectInfo).mockImplementation(async (kind) =>
      kind === "public" ? { size: 10, contentType: "image/jpeg" } : null,
    );
    const res = await call();
    expect(res.status).toBe(200);
    expect(vi.mocked(gcsObjectStream).mock.calls[0]?.[0]).toBe("public");
  });

  it("★ a type a browser could run is a download, never inline", async () => {
    vi.mocked(loadInboxMessageMedia).mockResolvedValueOnce({
      path: "stores/store-1/whatsapp/c1/m2.html",
      mime: "text/html",
      name: "invoice.html",
    });
    const res = await call();
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; /);
  });

  it("a PDF opens in place, without the sandbox a PDF viewer refuses", async () => {
    vi.mocked(loadInboxMessageMedia).mockResolvedValueOnce({
      path: "stores/store-1/whatsapp/c1/m3.pdf",
      mime: "application/pdf",
      name: "Size chart ₹.pdf",
    });
    const res = await call();
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Content-Disposition")).toBe(
      `inline; filename="Size chart _.pdf"; filename*=UTF-8''${encodeURIComponent("Size chart ₹.pdf")}`,
    );
  });

  it("no copy anywhere is a 404", async () => {
    gcs.private = false;
    vi.mocked(gcsObjectInfo).mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
