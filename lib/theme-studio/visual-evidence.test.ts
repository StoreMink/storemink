import sharp from "sharp";
import { expect, it, vi } from "vitest";
import {
  buildVisualEvidence,
  prepareVisualScreenshot,
} from "./visual-evidence";
const sample = { assetId: "phone-home", viewport: "phone390", page: "home /" };
const source = () =>
  sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="6000"><rect width="390" height="6000" fill="white"/><rect width="390" height="800" fill="red"/><rect y="2600" width="390" height="800" fill="lime"/><rect y="5200" width="390" height="800" fill="blue"/><text x="20" y="100" font-size="16">Readable product price</text></svg>',
    ),
  )
    .webp()
    .toBuffer();
it("capture preserves a long phone page's width and bounds desktop width before storage", async () => {
  const phone = await prepareVisualScreenshot(await source());
  expect(phone).toMatchObject({ width: 390, height: 6000 });
  expect(phone.sha256).toMatch(/^[a-f0-9]{64}$/);
  const desktop = await prepareVisualScreenshot(
    await sharp({
      create: { width: 2880, height: 10000, channels: 3, background: "white" },
    })
      .webp()
      .toBuffer(),
  );
  expect(desktop).toMatchObject({ width: 1440, height: 5000 });
});
it("preserves native phone width and shows top, middle and footer instead of a 55px strip", async () => {
  const blocks = await buildVisualEvidence(
    [sample],
    async () => source(),
    new AbortController().signal,
  );
  const detail = blocks.find((b) => b.type === "image");
  if (detail?.type !== "image") throw new Error("missing detail");
  const bytes = Buffer.from(detail.base64, "base64");
  expect(await sharp(bytes).metadata()).toMatchObject({
    width: 390,
    height: 2432,
  });
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (y: number) => [
    ...data.subarray(
      (y * info.width + 200) * info.channels,
      (y * info.width + 200) * info.channels + 3,
    ),
  ];
  expect(pixel(400)[0]).toBeGreaterThan(240);
  expect(pixel(1216)[1]).toBeGreaterThan(240);
  expect(pixel(2032)[2]).toBeGreaterThan(240);
  expect(blocks.filter((b) => b.type === "image")).toHaveLength(2);
});
it("stores very tall pages as PNG without exceeding WebP's height limit or shrinking phone text", async () => {
  const original = await sharp({
    create: { width: 390, height: 17000, channels: 3, background: "white" },
  })
    .jpeg()
    .toBuffer();
  const stored = await prepareVisualScreenshot(original);
  expect(stored).toMatchObject({
    width: 390,
    height: 17000,
    mediaType: "image/png",
  });
  expect(await sharp(stored.bytes).metadata()).toMatchObject({ format: "png" });
  const blocks = await buildVisualEvidence(
    [sample],
    async () => stored.bytes,
    new AbortController().signal,
  );
  const detail = blocks.find((b) => b.type === "image");
  if (detail?.type !== "image") throw new Error("missing detail");
  expect(
    await sharp(Buffer.from(detail.base64, "base64")).metadata(),
  ).toMatchObject({ width: 390, height: 2432, format: "webp" });
});
it("loads and processes one full screenshot at a time and stops after cancellation", async () => {
  const controller = new AbortController();
  const load = vi.fn(async () => {
    controller.abort();
    return source();
  });
  await expect(
    buildVisualEvidence(
      [sample, { ...sample, assetId: "second" }],
      load,
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(load).toHaveBeenCalledOnce();
});
