import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

// ★ The module keeps the bytes it read, so each test loads a fresh copy of it
//   and counts the reads through this wrapper (the real file is read).
const reads = vi.hoisted(() => ({ failNext: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      if (reads.failNext > 0) {
        reads.failNext -= 1;
        throw Object.assign(new Error("I/O error"), { code: "EIO" });
      }
      return actual.readFile(...args);
    }),
  };
});

const ASSET = path.join(
  process.cwd(),
  "public",
  "moderation",
  "image-unavailable.webp",
);

async function loadPlaceholder() {
  vi.resetModules();
  return import("./placeholder");
}

describe("the placeholder asset (design 3.3 step 2, D7)", () => {
  const bytes = readFileSync(ASSET);

  it("is a WebP file", () => {
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
  });

  it("is 1200 x 1200, opaque and under 30 KB", async () => {
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(1200);
    expect(meta.hasAlpha).toBe(false);
    expect(bytes.length).toBeLessThan(30 * 1024);
  });

  it("is light grey at the edges, with darker words and picture in the middle band", async () => {
    const { data, info } = await sharp(bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    for (const [x, y] of [
      [5, 5],
      [1194, 5],
      [5, 1194],
      [1194, 1194],
      [600, 100],
      [600, 1100],
    ]) {
      for (const channel of at(x, y)) {
        expect(Math.abs(channel - 0xec)).toBeLessThanOrEqual(3);
      }
    }
    // Something darker than the field is drawn in the middle band (the
    // slashed picture and "Image not available"), so a crop keeps it.
    let darkest = 255;
    for (let y = 420; y <= 720; y += 4) {
      for (let x = 300; x <= 900; x += 4) {
        darkest = Math.min(darkest, ...at(x, y));
      }
    }
    expect(darkest).toBeLessThan(0x80);
  });
});

describe("placeholder.ts", () => {
  beforeEach(() => {
    reads.failNext = 0;
  });

  it("names the address pages show and the file behind it", async () => {
    const placeholder = await loadPlaceholder();
    expect(placeholder.PLACEHOLDER_URL_PATH).toBe(
      "/moderation/image-unavailable.webp",
    );
    expect(placeholder.PLACEHOLDER_CONTENT_TYPE).toBe("image/webp");
    expect(placeholder.PLACEHOLDER_SIZE_PX).toBe(1200);
    expect(placeholder.placeholderFilePath()).toBe(ASSET);
  });

  it("★ placeholderWebp gives the file's bytes, reads the file once, and hands each caller its own copy", async () => {
    const placeholder = await loadPlaceholder();
    const first = await placeholder.placeholderWebp();
    expect(Buffer.from(first).equals(readFileSync(ASSET))).toBe(true);
    first[0] = 0;
    const second = await placeholder.placeholderWebp();
    expect(second[0]).toBe("R".charCodeAt(0));
    expect(second).not.toBe(first);
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failed read: the next call reads the file again", async () => {
    const placeholder = await loadPlaceholder();
    reads.failNext = 1;
    await expect(placeholder.placeholderWebp()).rejects.toThrow("I/O error");
    const bytes = await placeholder.placeholderWebp();
    expect(bytes.length).toBe(readFileSync(ASSET).length);
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(2);
  });

  it("placeholderMd5 is the file's MD5 in Google's base64 form", async () => {
    const placeholder = await loadPlaceholder();
    await expect(placeholder.placeholderMd5()).resolves.toBe(
      createHash("md5").update(readFileSync(ASSET)).digest("base64"),
    );
  });
});
