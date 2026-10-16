// ---------------------------------------------------------------------------
// One HTTP byte range (RFC 9110 §14), for routes that stream a stored file.
//
// An <audio> element asks for ranges, and Safari will not play a voice note
// from a server that ignores them. Only a SINGLE range is honoured: a
// multi-range request gets the whole file (a 200), which RFC 9110 allows and
// every media element accepts. Pure, so the route and its tests share it.
// ---------------------------------------------------------------------------

export interface ByteRange {
  /** Inclusive. */
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * The range a `Range` header asks for, against an object of `size` bytes.
 * `null` = serve the whole file (no header, a header this does not handle,
 * or a range covering everything); `"unsatisfiable"` = answer 416.
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  // Not a single bytes range (a list, another unit, junk): the whole file.
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  if (size <= 0) return "unsatisfiable";

  let start: number;
  let end: number;
  if (!rawStart) {
    // "bytes=-500": the last 500 bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return "unsatisfiable";
    }
    if (start >= size || end < start) return "unsatisfiable";
    end = Math.min(end, size - 1);
  }
  if (start === 0 && end === size - 1) return null;
  return { start, end };
}
