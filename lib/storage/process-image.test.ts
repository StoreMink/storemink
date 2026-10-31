import { beforeEach, describe, expect, it, vi } from "vitest";

const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/logger", () => ({
  logError,
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

/**
 * sharp is mocked PER TEST with `vi.doMock`, not once at the top.
 *
 * ⚠ A hoisted `vi.mock` factory is cached, so `vi.resetModules()` does not
 * re-run it — the "missing module" case silently behaved like the working one.
 * `doMock` is not hoisted, so each test installs the behaviour it needs before
 * importing the module under test.
 */
type SharpMode = "ok" | "missing" | "throws";

/** What the mocked sharp was asked: the factory's options and the encoder. */
const sharpCalls: { options: unknown; encoder: string | null }[] = [];

async function load(mode: SharpMode = "ok") {
  vi.resetModules();
  sharpCalls.length = 0;
  vi.doMock("sharp", () => {
    if (mode === "missing") {
      throw new Error(
        'Could not load the "sharp" module using the linux-x64 runtime',
      );
    }
    return {
      default: (_input: Uint8Array, options?: unknown) => {
        const call = { options, encoder: null as string | null };
        sharpCalls.push(call);
        const chain = {
          rotate: () => chain,
          resize: () => chain,
          webp: () => ((call.encoder = "webp"), chain),
          gif: () => ((call.encoder = "gif"), chain),
          avif: () => ((call.encoder = "avif"), chain),
          toBuffer: async () => {
            if (mode === "throws") throw new Error("unsupported image");
            return Buffer.from(`${call.encoder}-bytes`);
          },
        };
        return chain;
      },
    };
  });
  return import("./process-image");
}

const file = (type: string, name = "shot.png", size = 1000) =>
  ({
    type,
    name,
    size,
    arrayBuffer: async () => new ArrayBuffer(8),
  }) as unknown as File;

/** A file whose bytes are given (the magic-byte check reads them). */
const fileOf = (type: string, bytes: number[] | Uint8Array, name = "shot") =>
  ({
    type,
    name,
    size: bytes.length,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  }) as unknown as File;

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

/** The first bytes of each type, as the magic-byte check expects them. */
const MAGIC: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0],
  "image/webp": [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8 ")],
  "image/gif": [...ascii("GIF89a"), 0, 0],
  "image/avif": [
    0,
    0,
    0,
    0x1c,
    ...ascii("ftypavif"),
    0,
    0,
    0,
    0,
    ...ascii("mif1miaf"),
  ],
  "image/svg+xml": ascii('<?xml version="1.0"?><svg xmlns="x"></svg>'),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.doUnmock("sharp");
});

describe("processImageUpload", () => {
  it("optimizes a supported image to WebP", async () => {
    const { processImageUpload } = await load();
    const r = await processImageUpload(file("image/png"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.contentType).toBe("image/webp");
      expect(r.data.ext).toBe("webp");
    }
  });

  it("refuses a type it will not process", async () => {
    const { processImageUpload } = await load();
    const r = await processImageUpload(file("application/pdf", "a.pdf"));
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a file over the 5 MB input cap", async () => {
    const { processImageUpload } = await load();
    const r = await processImageUpload(
      file("image/png", "big.png", 6 * 1024 * 1024),
    );
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (!r.ok) expect(r.error).toMatch(/maximum is 5 mb/i);
  });

  describe("a broken install and an awkward image are different failures", () => {
    it("FAILS CLOSED when sharp itself cannot load", async () => {
      // ★★ THE PRODUCTION FAULT (2026-09-10). sharp's native libvips was
      // missing from the container, which is a MODULE-LOAD failure — so no
      // route could catch it and /api/upload answered a bare framework 500
      // with no JSON body in 6 ms.
      const { processImageUpload } = await load("missing");
      const r = await processImageUpload(file("image/png"));
      expect(r).toMatchObject({ ok: false, status: 503 });
      if (!r.ok) expect(r.error).toMatch(/image processing is unavailable/i);
      expect(logError).toHaveBeenCalledWith(
        "image processing unavailable",
        expect.anything(),
        expect.objectContaining({ type: "image/png" }),
      );
    });

    it("does NOT store the original when sharp is missing", async () => {
      // ⚠ THE REASON IT FAILS CLOSED RATHER THAN FALLING BACK. The fallback
      // below is right for one awkward file and wrong for a broken install:
      // every upload would keep its EXIF (a photo carries GPS) and skip the
      // SVG rasterisation this module exists to enforce — silently, for as
      // long as nobody noticed.
      const { processImageUpload } = await load("missing");
      const r = await processImageUpload(file("image/jpeg", "photo.jpg"));
      expect(r.ok).toBe(false);
    });

    it("stores the original when ONE image will not optimize", async () => {
      const { processImageUpload } = await load("throws");
      const r = await processImageUpload(file("image/png"));
      expect(r.ok).toBe(true);
      // Kept as it arrived, so an awkward file does not block the upload...
      if (r.ok) expect(r.data.contentType).toBe("image/png");
      // ...but loudly enough to be found in Error Reporting.
      expect(logError).toHaveBeenCalledWith(
        "image optimization failed, storing original",
        expect.anything(),
        expect.objectContaining({ type: "image/png" }),
      );
    });

    it("never stores an SVG raw, whichever way sharp failed", async () => {
      // A crafted SVG can carry <script> that runs on the storage origin.
      for (const mode of ["missing", "throws"] as const) {
        const { processImageUpload } = await load(mode);
        const r = await processImageUpload(file("image/svg+xml", "logo.svg"));
        expect(r.ok, `mode=${mode}`).toBe(false);
      }
    });
  });

  it("passes an animated GIF through without touching sharp", async () => {
    // Re-encoding would drop the animation, so these skip optimization — and
    // therefore keep working even when sharp cannot load at all.
    const { processImageUpload } = await load("missing");
    const r = await processImageUpload(file("image/gif", "loop.gif"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.contentType).toBe("image/gif");
  });

  it("loads sharp once and remembers it is unavailable", async () => {
    const { processImageUpload } = await load("missing");
    await processImageUpload(file("image/png"));
    await processImageUpload(file("image/png"));
    // Two refusals, but the failed import is not retried per upload.
    expect(logError).toHaveBeenCalledTimes(2);
  });

  describe("★★ strict mode (review S3: Mink chat attachments)", () => {
    it("is off unless asked for: a GIF still passes through, and an awkward image is still stored", async () => {
      const { processImageUpload } = await load("throws");
      const gif = await processImageUpload(
        fileOf("image/gif", MAGIC["image/gif"]),
      );
      expect(gif.ok).toBe(true);
      expect(sharpCalls).toHaveLength(0);
      const png = await processImageUpload(fileOf("image/png", [1, 2, 3]));
      expect(png.ok).toBe(true);
    });

    it("★ refuses bytes that do not start like the declared type, before sharp sees them", async () => {
      const { processImageUpload, NOT_A_VALID_IMAGE } = await load();
      for (const [type, bytes] of [
        ["image/png", MAGIC["image/jpeg"]],
        ["image/jpeg", ascii("<html><body>hi</body></html>")],
        ["image/webp", ascii("RIFF0000AVI LIST")],
        ["image/gif", ascii("GIF90a......")],
        ["image/avif", [0, 0, 0, 0x1c, ...ascii("ftypheic")]],
        ["image/svg+xml", ascii("<html><script>x</script></html>")],
      ] as const) {
        const r = await processImageUpload(fileOf(type, [...bytes]), {
          strict: true,
        });
        expect(r, type).toEqual({
          ok: false,
          error: NOT_A_VALID_IMAGE,
          status: 400,
        });
      }
      expect(sharpCalls).toHaveLength(0);
      expect(NOT_A_VALID_IMAGE).toBe(
        "This file isn't a valid image. Please upload a PNG, JPG, WebP, GIF or AVIF image.",
      );
    });

    it("accepts each type's real first bytes", async () => {
      const { bytesMatchImageType } = await load();
      for (const [type, bytes] of Object.entries(MAGIC)) {
        expect(bytesMatchImageType(new Uint8Array(bytes), type), type).toBe(
          true,
        );
      }
      expect(bytesMatchImageType(new Uint8Array([1]), "image/tiff")).toBe(
        false,
      );
    });

    it("★ refuses an image sharp cannot decode instead of storing it as sent", async () => {
      const { processImageUpload, NOT_A_VALID_IMAGE } = await load("throws");
      const r = await processImageUpload(
        fileOf("image/png", MAGIC["image/png"]),
        {
          strict: true,
        },
      );
      expect(r).toEqual({ ok: false, error: NOT_A_VALID_IMAGE, status: 400 });
      expect(logError).toHaveBeenCalledWith(
        "image processing refused an undecodable upload",
        expect.anything(),
        { type: "image/png" },
      );
    });

    it("★ re-encodes a GIF with its animation, and an AVIF, so neither keeps its metadata", async () => {
      const { processImageUpload } = await load();
      const gif = await processImageUpload(
        fileOf("image/gif", MAGIC["image/gif"]),
        {
          strict: true,
        },
      );
      expect(gif).toMatchObject({
        ok: true,
        data: { contentType: "image/gif", ext: "gif" },
      });
      expect(sharpCalls[0]).toEqual({
        options: { animated: true },
        encoder: "gif",
      });
      if (gif.ok)
        expect(Buffer.from(gif.data.bytes).toString()).toBe("gif-bytes");

      const avif = await processImageUpload(
        fileOf("image/avif", MAGIC["image/avif"]),
        {
          strict: true,
        },
      );
      expect(avif).toMatchObject({
        ok: true,
        data: { contentType: "image/avif", ext: "avif" },
      });
      expect(sharpCalls[1]).toMatchObject({ encoder: "avif" });
    });

    it("a PNG still becomes WebP, and a missing sharp refuses every type, GIF included", async () => {
      let mod = await load();
      const png = await mod.processImageUpload(
        fileOf("image/png", MAGIC["image/png"]),
        {
          strict: true,
        },
      );
      expect(png).toMatchObject({
        ok: true,
        data: { contentType: "image/webp" },
      });

      mod = await load("missing");
      const gif = await mod.processImageUpload(
        fileOf("image/gif", MAGIC["image/gif"]),
        {
          strict: true,
        },
      );
      expect(gif).toMatchObject({ ok: false, status: 503 });
    });
  });
});
