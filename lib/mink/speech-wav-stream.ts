import "server-only";

/** Decode a streaming mono PCM WAV without waiting for the complete clip. */
export async function* streamWavPcm(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ rate: number; pcm: Buffer }> {
  const reader = body.getReader();
  let buffered: Buffer = Buffer.alloc(0);
  let ended = false;
  let headerBytes = 0;
  const MAX_HEADER = 65_536;
  const MAX_AUDIO = 24_000 * 2 * 120;
  const fail = () => new Error("Read-aloud returned an invalid streaming WAV.");
  const fill = async (size: number) => {
    while (buffered.length < size && !ended) {
      const next = await reader.read();
      ended = next.done;
      if (next.value?.length)
        buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
    }
    return buffered.length >= size;
  };
  const header = async (size: number) => {
    headerBytes += size;
    if (headerBytes > MAX_HEADER || !(await fill(size))) throw fail();
    const bytes = buffered.subarray(0, size);
    buffered = buffered.subarray(size);
    return bytes;
  };
  try {
    const riff = await header(12);
    if (
      riff.toString("ascii", 0, 4) !== "RIFF" ||
      riff.toString("ascii", 8, 12) !== "WAVE"
    )
      throw fail();
    let rate: number | null = null;
    let remaining = 0;
    for (;;) {
      const chunk = await header(8);
      const id = chunk.toString("ascii", 0, 4);
      const size = chunk.readUInt32LE(4);
      if (id === "data") {
        if (rate === null) throw fail();
        // Streaming encoders cannot know the data length when sending headers.
        remaining = size === 0 || size === 0xffffffff ? Infinity : size;
        if (
          Number.isFinite(remaining) &&
          (remaining > MAX_AUDIO || remaining % 2 !== 0)
        )
          throw fail();
        break;
      }
      const bytes = await header(size + (size % 2));
      if (id !== "fmt ") continue;
      if (size < 16 || rate !== null) throw fail();
      let format = bytes.readUInt16LE(0);
      if (format === 0xfffe && size >= 40) {
        const pcmGuid = Buffer.from("0100000000001000800000aa00389b71", "hex");
        if (
          bytes.readUInt16LE(16) < 22 ||
          !bytes.subarray(24, 40).equals(pcmGuid)
        )
          throw fail();
        format = 1;
      }
      rate = bytes.readUInt32LE(4);
      if (
        format !== 1 ||
        bytes.readUInt16LE(2) !== 1 ||
        bytes.readUInt16LE(14) !== 16 ||
        bytes.readUInt16LE(12) !== 2 ||
        rate < 8_000 ||
        rate > 48_000 ||
        bytes.readUInt32LE(8) !== rate * 2
      )
        throw fail();
    }
    let sent = 0;
    while (remaining > 0) {
      if (!(await fill(2))) {
        if (buffered.length || Number.isFinite(remaining)) throw fail();
        break;
      }
      const size = Math.min(buffered.length - (buffered.length % 2), remaining);
      sent += size;
      if (sent > MAX_AUDIO) throw fail();
      const pcm = buffered.subarray(0, size);
      buffered = buffered.subarray(size);
      remaining -= size;
      yield { rate: rate!, pcm };
    }
    if (!sent) throw fail();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
