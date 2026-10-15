/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsUploadObject: vi.fn(async (path: string) => `https://x/${path}`),
}));
vi.mock("./graph", () => ({ uploadMedia: vi.fn() }));
vi.mock("./send", () => ({ sendWhatsAppMedia: vi.fn() }));
vi.mock("./inbox", () => ({
  recordOutboundMessage: vi.fn(async () => "m-img"),
}));
vi.mock("./mink-drafts", () => ({ discardMinkDrafts: vi.fn(async () => 0) }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn({}))),
}));

import { gcsUploadObject } from "@/lib/storage/gcs";
import { uploadMedia } from "./graph";
import { recordOutboundMessage } from "./inbox";
import { discardMinkDrafts } from "./mink-drafts";
import { sendWhatsAppMedia } from "./send";
import {
  outboundMediaPath,
  prepareOutboundMedia,
  sendInboxMedia,
  type PreparedMedia,
} from "./inbox-media";

const STORE = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";

async function png(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: "#3366cc" },
    })
      .png()
      .toBuffer(),
  );
}

describe("prepareOutboundMedia", () => {
  it("★ a photo comes out as a JPEG no wider than 2,048px, whatever it went in as", async () => {
    const r = await prepareOutboundMedia({
      bytes: await png(3000, 1500),
      mime: "image/png",
      name: "Shelf photo.PNG",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.media).toMatchObject({
      kind: "image",
      mime: "image/jpeg",
      ext: ".jpg",
      filename: null,
      name: "Shelf photo.PNG",
    });
    const meta = await sharp(Buffer.from(r.media.bytes)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(1024);
    // No metadata survives: a staff phone's photo carries GPS.
    expect(meta.exif).toBeUndefined();
  });

  it("a small photo is not enlarged", async () => {
    const r = await prepareOutboundMedia({
      bytes: await png(300, 200),
      mime: "image/webp",
      name: "small.webp",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const meta = await sharp(Buffer.from(r.media.bytes)).metadata();
    expect([meta.width, meta.height]).toEqual([300, 200]);
  });

  it("★ the bytes decide, not the declared type: a PDF must start as one, a 'photo' must decode", async () => {
    const pdf = await prepareOutboundMedia({
      bytes: new TextEncoder().encode("%PDF-1.4 ..."),
      mime: "application/pdf",
      name: "size chart",
    });
    expect(pdf).toMatchObject({
      ok: true,
      media: {
        kind: "document",
        mime: "application/pdf",
        filename: "size chart.pdf",
      },
    });
    expect(
      await prepareOutboundMedia({
        bytes: new TextEncoder().encode("<html>"),
        mime: "application/pdf",
        name: "x.pdf",
      }),
    ).toMatchObject({ ok: false, error: "That file is not a PDF." });
    expect(
      await prepareOutboundMedia({
        bytes: new TextEncoder().encode("not an image"),
        mime: "image/jpeg",
        name: "x.jpg",
      }),
    ).toMatchObject({
      ok: false,
      error: "That file could not be read as a photo.",
    });
  });

  it("refuses other types, an empty file and an oversized one", async () => {
    expect(
      (await prepareOutboundMedia({
        bytes: new Uint8Array([1]),
        mime: "video/mp4",
        name: "v.mp4",
      })) as any,
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("Send a photo"),
    });
    expect(
      await prepareOutboundMedia({
        bytes: new Uint8Array(0),
        mime: "image/png",
        name: "e.png",
      }),
    ).toMatchObject({ ok: false, error: "The file is empty." });
    expect(
      await prepareOutboundMedia({
        bytes: new Uint8Array(5 * 1024 * 1024 + 1),
        mime: "image/png",
        name: "big.png",
      }),
    ).toMatchObject({ ok: false, error: "A photo can be at most 5 MB." });
    expect(
      await prepareOutboundMedia({
        bytes: new Uint8Array(16 * 1024 * 1024 + 1),
        mime: "application/pdf",
        name: "big.pdf",
      }),
    ).toMatchObject({ ok: false, error: "A PDF can be at most 16 MB." });
  });
});

describe("sendInboxMedia", () => {
  const MEDIA: PreparedMedia = {
    kind: "image",
    bytes: new Uint8Array([1, 2, 3]),
    mime: "image/jpeg",
    ext: ".jpg",
    filename: null,
    name: "p.jpg",
  };
  const INPUT = {
    storeId: STORE,
    userId: "admin-1",
    conversationId: CONV,
    to: "+919876543210",
    token: "tok",
    phoneNumberId: "PN",
    media: MEDIA,
    caption: " Here ",
    quotedProviderId: "wamid.in1",
  };

  beforeEach(() => {
    vi.mocked(uploadMedia).mockResolvedValue({
      ok: true,
      data: { id: "MEDIA1" },
    });
    vi.mocked(sendWhatsAppMedia).mockResolvedValue({
      sent: true,
      messageId: "wamid.img",
      logId: "l1",
    });
  });

  it("★ Meta first, our copy second, the send last, then the row with our copy's path", async () => {
    const r = await sendInboxMedia(INPUT);
    expect(r).toEqual({ ok: true, messageId: "m-img" });
    expect(uploadMedia).toHaveBeenCalledWith("tok", "PN", {
      bytes: MEDIA.bytes,
      mime: "image/jpeg",
      filename: "p.jpg",
    });
    const [path, bytes, mime, cache] =
      vi.mocked(gcsUploadObject).mock.calls[0]!;
    expect(path).toMatch(
      new RegExp(`^stores/${STORE}/whatsapp/${CONV}/out-[0-9a-f-]{36}\\.jpg$`),
    );
    expect(bytes).toBe(MEDIA.bytes);
    expect(mime).toBe("image/jpeg");
    expect(cache).toBe("private, max-age=0");
    expect(sendWhatsAppMedia).toHaveBeenCalledWith({
      storeId: STORE,
      to: "+919876543210",
      token: "tok",
      phoneNumberId: "PN",
      kind: "image",
      mediaId: "MEDIA1",
      caption: "Here",
      filename: null,
      replyToProviderId: "wamid.in1",
    });
    expect(recordOutboundMessage).toHaveBeenCalledWith(expect.anything(), {
      storeId: STORE,
      conversationId: CONV,
      source: "dashboard",
      kind: "image",
      body: "Here",
      providerMessageId: "wamid.img",
      status: "sent",
      error: null,
      sentByAdminId: "admin-1",
      media: { path, mime: "image/jpeg", name: "p.jpg" },
      quotedProviderId: "wamid.in1",
    });
    expect(discardMinkDrafts).toHaveBeenCalled();
    // The order is the safety argument.
    const order = [
      uploadMedia,
      gcsUploadObject,
      sendWhatsAppMedia,
      recordOutboundMessage,
    ].map((f) => vi.mocked(f as any).mock.invocationCallOrder[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("★ an upload Meta refuses stores nothing, files nothing and sends nothing", async () => {
    vi.mocked(uploadMedia).mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "Unsupported",
    });
    const r = await sendInboxMedia(INPUT);
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(gcsUploadObject).not.toHaveBeenCalled();
    expect(sendWhatsAppMedia).not.toHaveBeenCalled();
    expect(recordOutboundMessage).not.toHaveBeenCalled();
  });

  it("a send Meta refuses is filed as a failed message WITH our copy, so staff see what did not go", async () => {
    vi.mocked(sendWhatsAppMedia).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "Re-engagement",
      code: 131047,
    });
    const r = await sendInboxMedia(INPUT);
    expect(r).toMatchObject({ ok: false, code: "refused", messageId: "m-img" });
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "failed",
        error: "Re-engagement",
        media: expect.objectContaining({ mime: "image/jpeg" }),
      }),
    );
    expect(discardMinkDrafts).not.toHaveBeenCalled();
  });

  it("a caption past WhatsApp's cap is refused before anything is spent", async () => {
    const r = await sendInboxMedia({ ...INPUT, caption: "x".repeat(1025) });
    expect(r.ok).toBe(false);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it("outboundMediaPath keeps a sent file in the conversation's own folder", () => {
    expect(outboundMediaPath(STORE, CONV, ".pdf")).toMatch(
      new RegExp(`^stores/${STORE}/whatsapp/${CONV}/out-[0-9a-f-]{36}\\.pdf$`),
    );
  });
});
