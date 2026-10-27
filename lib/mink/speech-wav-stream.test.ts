import { describe, expect, it, vi } from "vitest";
import { streamWavPcm } from "./speech-wav-stream";

function wav(samples = Buffer.from([1, 0, 2, 0])) {
  const head = Buffer.alloc(44);
  head.write("RIFF");
  head.writeUInt32LE(36 + samples.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(24_000, 24);
  head.writeUInt32LE(48_000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(samples.length, 40);
  return Buffer.concat([head, samples]);
}
function body(bytes: Buffer, split = 1) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += split)
        c.enqueue(bytes.subarray(i, i + split));
      c.close();
    },
  });
}
async function drain(bytes: Buffer, split?: number) {
  const parts = [];
  for await (const part of streamWavPcm(body(bytes, split))) {
    expect(part.rate).toBe(24_000);
    parts.push(part.pcm);
  }
  return Buffer.concat(parts);
}
describe("streamWavPcm", () => {
  it.each([1, 3, 7, 44, 4096])(
    "handles headers and PCM split across %i-byte network chunks",
    async (split) => {
      expect(await drain(wav(), split)).toEqual(Buffer.from([1, 0, 2, 0]));
    },
  );
  it.each([0, 0xffffffff])(
    "accepts unknown streaming data size %i",
    async (size) => {
      const bytes = wav();
      bytes.writeUInt32LE(size, 40);
      expect(await drain(bytes)).toEqual(Buffer.from([1, 0, 2, 0]));
    },
  );
  it("skips padded non-audio chunks and does not play trailing metadata", async () => {
    const file = wav();
    const extra = Buffer.from([76, 73, 83, 84, 3, 0, 0, 0, 1, 2, 3, 0]);
    expect(
      await drain(
        Buffer.concat([file.subarray(0, 36), extra, file.subarray(36), extra]),
      ),
    ).toEqual(Buffer.from([1, 0, 2, 0]));
  });
  it("supports the PCM extensible format without accepting other GUIDs", async () => {
    const file = wav();
    const fmt = Buffer.alloc(48);
    fmt.write("fmt ");
    fmt.writeUInt32LE(40, 4);
    file.copy(fmt, 8, 20, 36);
    fmt.writeUInt16LE(0xfffe, 8);
    fmt.writeUInt16LE(22, 24);
    fmt.writeUInt16LE(16, 26);
    fmt.writeUInt32LE(4, 28);
    Buffer.from("0100000000001000800000aa00389b71", "hex").copy(fmt, 32);
    const full = () =>
      Buffer.concat([file.subarray(0, 12), fmt, file.subarray(36)]);
    expect(await drain(full())).toEqual(Buffer.from([1, 0, 2, 0]));
    fmt[47] = 0;
    await expect(drain(full())).rejects.toThrow("invalid streaming WAV");
  });
  it("rejects truncated headers, truncated samples, wrong formats and oversized headers", async () => {
    const stereo = wav();
    stereo.writeUInt16LE(2, 22);
    const huge = wav();
    huge.writeUInt32LE(0xffffffff, 16);
    const badRate = wav();
    badRate.writeUInt32LE(0, 24);
    const odd = wav();
    odd.writeUInt32LE(3, 40);
    for (const bytes of [
      wav().subarray(0, 20),
      wav().subarray(0, 47),
      Buffer.from("not a wav"),
      stereo,
      huge,
      badRate,
      odd,
    ])
      await expect(drain(bytes)).rejects.toThrow("invalid streaming WAV");
  });
  it("cancels after a parser error", async () => {
    const cancel = vi.fn();
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.alloc(12));
      },
      cancel,
    });
    await expect(streamWavPcm(input).next()).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
