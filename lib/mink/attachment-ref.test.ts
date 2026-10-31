import { describe, expect, it } from "vitest";
import {
  MINK_ATTACHMENT_ONLY_AS_A_PICTURE,
  MINK_ATTACHMENT_PATH,
  MINK_ATTACHMENT_WALK_DEPTH,
  MINK_ATTACHMENT_WALK_STRINGS,
  minkAttachmentIdOf,
  minkAttachmentIdsIn,
  minkAttachmentIdsInValue,
  minkAttachmentUrl,
  rewriteMinkAttachmentRefs,
  scanMinkAttachmentValue,
} from "./attachment-ref";
import { MinkToolInputError } from "./errors";

const ID_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ID_C = "16fd2706-8baf-433b-82eb-8c7fada847da";

/** A valid v4-style id with a given 4-digit block, for lists of many ids. */
function idNumber(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

describe("minkAttachmentUrl", () => {
  it("builds the bare path", () => {
    expect(minkAttachmentUrl(ID_A)).toBe(`/api/mink/attachments/${ID_A}`);
    expect(minkAttachmentUrl(ID_A).startsWith(MINK_ATTACHMENT_PATH)).toBe(true);
  });
});

describe("minkAttachmentIdsIn", () => {
  it("finds an id in a bare path", () => {
    expect(
      minkAttachmentIdsIn(`See /api/mink/attachments/${ID_A} here`),
    ).toEqual([ID_A]);
  });

  it("finds an id behind any host, with or without a port", () => {
    expect(
      minkAttachmentIdsIn(
        `https://echoss.storemink.com/api/mink/attachments/${ID_A}`,
      ),
    ).toEqual([ID_A]);
    expect(
      minkAttachmentIdsIn(`http://localhost:3000/api/mink/attachments/${ID_B}`),
    ).toEqual([ID_B]);
  });

  it("lower-cases an upper-case id", () => {
    expect(
      minkAttachmentIdsIn(`/api/mink/attachments/${ID_A.toUpperCase()}`),
    ).toEqual([ID_A]);
    expect(
      minkAttachmentIdsIn(`/API/MINK/ATTACHMENTS/${ID_A.toUpperCase()}`),
    ).toEqual([ID_A]);
  });

  it("finds several in one text, once each, in order of first appearance", () => {
    const text = [
      `first /api/mink/attachments/${ID_B}`,
      `then https://x.example/api/mink/attachments/${ID_A}`,
      `and again /api/mink/attachments/${ID_B.toUpperCase()}`,
    ].join("\n");
    expect(minkAttachmentIdsIn(text)).toEqual([ID_B, ID_A]);
  });

  it("stops at 20 by default, or at the max it is given", () => {
    const text = Array.from({ length: 25 }, (_, i) =>
      minkAttachmentUrl(idNumber(i + 1)),
    ).join(" ");
    expect(minkAttachmentIdsIn(text)).toHaveLength(20);
    expect(minkAttachmentIdsIn(text, 3)).toEqual([
      idNumber(1),
      idNumber(2),
      idNumber(3),
    ]);
  });

  it("★ never cuts a longer hex run down to an id", () => {
    expect(minkAttachmentIdsIn(`/api/mink/attachments/${ID_A}abc`)).toEqual([]);
    expect(minkAttachmentIdsIn(`/api/mink/attachments/${ID_A}-1`)).toEqual([]);
    expect(minkAttachmentIdsIn(`/api/mink/attachments/${ID_A}0`)).toEqual([]);
    // A query string or punctuation after the id is not part of it.
    expect(minkAttachmentIdsIn(`(/api/mink/attachments/${ID_A}?w=1).`)).toEqual(
      [ID_A],
    );
  });

  it("ignores a value that is not a UUID of the shapes we mint", () => {
    expect(minkAttachmentIdsIn("/api/mink/attachments/not-an-id")).toEqual([]);
    // Variant nibble outside [89ab] is not one of ours.
    expect(
      minkAttachmentIdsIn(
        "/api/mink/attachments/0f8fad5b-d9cb-469f-c165-70867728950e",
      ),
    ).toEqual([]);
    expect(minkAttachmentIdsIn("")).toEqual([]);
  });
});

describe("minkAttachmentIdOf", () => {
  it("accepts the bare path and the path with any host", () => {
    expect(minkAttachmentIdOf(minkAttachmentUrl(ID_A))).toBe(ID_A);
    expect(
      minkAttachmentIdOf(
        `https://echoss.storemink.com/api/mink/attachments/${ID_A}`,
      ),
    ).toBe(ID_A);
    expect(
      minkAttachmentIdOf(`http://localhost:3000/api/mink/attachments/${ID_A}`),
    ).toBe(ID_A);
    expect(minkAttachmentIdOf(minkAttachmentUrl(ID_A.toUpperCase()))).toBe(
      ID_A,
    );
  });

  it("★ matches the whole string only", () => {
    expect(minkAttachmentIdOf(`see ${minkAttachmentUrl(ID_A)}`)).toBeNull();
    expect(minkAttachmentIdOf(`${minkAttachmentUrl(ID_A)} please`)).toBeNull();
    expect(minkAttachmentIdOf(`${minkAttachmentUrl(ID_A)}?w=1`)).toBeNull();
    expect(minkAttachmentIdOf(`${minkAttachmentUrl(ID_A)}abc`)).toBeNull();
    expect(minkAttachmentIdOf(` ${minkAttachmentUrl(ID_A)}`)).toBeNull();
  });

  it("is null for an ordinary image URL or an empty value", () => {
    expect(
      minkAttachmentIdOf(
        "https://storage.googleapis.com/bucket/stores/s/media/a.webp",
      ),
    ).toBeNull();
    expect(minkAttachmentIdOf("")).toBeNull();
    expect(minkAttachmentIdOf(MINK_ATTACHMENT_PATH)).toBeNull();
  });
});

describe("minkAttachmentIdsInValue", () => {
  it("finds ids in nested objects, arrays and JSON strings", () => {
    const value = {
      image_url: minkAttachmentUrl(ID_A),
      sections: [
        { config: { items: [{ image_url: minkAttachmentUrl(ID_B) }] } },
        "plain words",
      ],
      changes_json: JSON.stringify({
        header: { image_url: `https://x.example${minkAttachmentUrl(ID_C)}` },
      }),
      count: 3,
      nothing: null,
      on: true,
    };
    expect(minkAttachmentIdsInValue(value)).toEqual([ID_A, ID_B, ID_C]);
  });

  it("reports each id once and honours max", () => {
    const value = [
      minkAttachmentUrl(ID_A),
      { a: minkAttachmentUrl(ID_A.toUpperCase()), b: minkAttachmentUrl(ID_B) },
    ];
    expect(minkAttachmentIdsInValue(value)).toEqual([ID_A, ID_B]);
    expect(minkAttachmentIdsInValue(value, 1)).toEqual([ID_A]);
  });

  it("reads a bare string, and nothing from a number or null", () => {
    expect(minkAttachmentIdsInValue(minkAttachmentUrl(ID_A))).toEqual([ID_A]);
    expect(minkAttachmentIdsInValue(42)).toEqual([]);
    expect(minkAttachmentIdsInValue(null)).toEqual([]);
    expect(minkAttachmentIdsInValue(undefined)).toEqual([]);
  });

  it("★ R7: past depth 8 it fails closed when an address is there, and reads nothing more when none is", () => {
    const deep = (levels: number, leaf: string): unknown => {
      let node: unknown = leaf;
      for (let i = 0; i < levels; i += 1) node = { inner: node };
      return node;
    };
    expect(
      minkAttachmentIdsInValue(
        deep(MINK_ATTACHMENT_WALK_DEPTH, minkAttachmentUrl(ID_A)),
      ),
    ).toEqual([ID_A]);
    const tooDeep = () =>
      minkAttachmentIdsInValue(
        deep(MINK_ATTACHMENT_WALK_DEPTH + 1, minkAttachmentUrl(ID_A)),
      );
    expect(tooDeep).toThrow(MinkToolInputError);
    expect(tooDeep).toThrow(MINK_ATTACHMENT_ONLY_AS_A_PICTURE);
    expect(
      minkAttachmentIdsInValue(deep(MINK_ATTACHMENT_WALK_DEPTH + 1, "a/b")),
    ).toEqual([]);
  });

  it("★ R7: past 2,000 strings it fails closed when an address is there, and reads nothing more when none is", () => {
    const filler = Array.from(
      { length: MINK_ATTACHMENT_WALK_STRINGS },
      () => "no reference here",
    );
    expect(() =>
      minkAttachmentIdsInValue([...filler, minkAttachmentUrl(ID_A)]),
    ).toThrow(MINK_ATTACHMENT_ONLY_AS_A_PICTURE);
    expect(
      minkAttachmentIdsInValue([
        ...filler.slice(0, MINK_ATTACHMENT_WALK_STRINGS - 1),
        minkAttachmentUrl(ID_A),
      ]),
    ).toEqual([ID_A]);
    expect(minkAttachmentIdsInValue([...filler, "a/b"])).toEqual([]);
  });
});

describe("★★ scanMinkAttachmentValue: what it accepts, and every form it refuses (review S6)", () => {
  const address = minkAttachmentUrl(ID_A);

  it("accepts the strict form: any case, any host, with a query or fragment, in a JSON object or array inside a string (escaped slashes included)", () => {
    for (const value of [
      address,
      address.toUpperCase(),
      `https://echoss.storemink.com:8080${address}`,
      `${address}?width=200`,
      `${address}#top`,
      JSON.stringify({ image_url: address }),
      JSON.stringify({ image_url: address }).replaceAll("/", "\\/"),
      JSON.stringify([address]),
    ]) {
      expect(scanMinkAttachmentValue(value), value).toEqual({
        ids: [ID_A],
        problem: null,
      });
    }
  });

  it("★ refuses an address hidden by any decoding a later step might apply", () => {
    const hidden: [string, string][] = [
      ["percent-encoded", encodeURIComponent(address)],
      ["percent-encoded id only", address.replace(ID_A[0], "%30")],
      [
        "percent-encoded twice",
        encodeURIComponent(encodeURIComponent(address)),
      ],
      ["JSON-escaped in plain text", `see ${address.replaceAll("/", "\\/")}`],
      ["JavaScript unicode escapes", address.replaceAll("/", "\\u002f")],
      ["hex escapes", address.replaceAll("/", "\\x2f")],
      ["HTML numeric references", address.replaceAll("/", "&#47;")],
      ["HTML hex references", address.replaceAll("/", "&#x2F;")],
      ["HTML named reference", address.replaceAll("/", "&sol;")],
      ["backslashes", address.replaceAll("/", "\\")],
      ["a doubled slash", address.replace("/mink/", "//mink/")],
      ["no leading slash", address.slice(1)],
      [
        "beside the strict form",
        `${address} and ${encodeURIComponent(address)}`,
      ],
    ];
    for (const [label, value] of hidden) {
      expect(scanMinkAttachmentValue(value).problem, label).toBe("disguised");
      expect(() => minkAttachmentIdsInValue(value), label).toThrow(
        MINK_ATTACHMENT_ONLY_AS_A_PICTURE,
      );
    }
  });

  it("★ refuses an address as an object key, in any form, in JSON inside a string too", () => {
    expect(scanMinkAttachmentValue({ [address]: "x" }).problem).toBe("key");
    expect(
      scanMinkAttachmentValue({ [encodeURIComponent(address)]: "x" }).problem,
    ).toBe("key");
    expect(
      scanMinkAttachmentValue(JSON.stringify({ [address]: "x" })).problem,
    ).toBe("key");
  });

  it("★ keeps reading past max, so a problem after the max-th id is still found", () => {
    expect(
      scanMinkAttachmentValue([address, encodeURIComponent(address)], 1),
    ).toEqual({ ids: [ID_A], problem: "disguised" });
    expect(
      scanMinkAttachmentValue(
        [
          minkAttachmentUrl(ID_A),
          minkAttachmentUrl(ID_B),
          minkAttachmentUrl(ID_C),
        ],
        2,
      ),
    ).toEqual({ ids: [ID_A, ID_B], problem: null });
  });

  it("passes ordinary text, links and image URLs, slashes and percent signs included", () => {
    for (const value of [
      "https://storage.googleapis.com/b/stores/s/media/a.webp",
      "50% off everything / today only",
      "/api/mink/attachments/not-an-id",
      { href: "/collections/men", label: "Men & women" },
    ]) {
      expect(scanMinkAttachmentValue(value), JSON.stringify(value)).toEqual({
        ids: [],
        problem: null,
      });
    }
    // ★ A longer hex run is never read as an id (minkAttachmentIdsIn), and
    //   the scan refuses it rather than passing something that starts like one.
    expect(
      scanMinkAttachmentValue(`/api/mink/attachments/${ID_A}0`).problem,
    ).toBe("disguised");
  });

  it("refuses a value no walk or text can read (a cycle past the depth)", () => {
    const cycle: Record<string, unknown> = { a: address };
    let node: Record<string, unknown> = cycle;
    for (let i = 0; i < MINK_ATTACHMENT_WALK_DEPTH + 1; i += 1) {
      const next: Record<string, unknown> = {};
      node.next = next;
      node = next;
    }
    node.back = cycle;
    expect(scanMinkAttachmentValue(cycle).problem).toBe("limit");
  });
});

describe("rewriteMinkAttachmentRefs", () => {
  const PUBLIC_A =
    "https://storage.googleapis.com/bucket/stores/s/media/mink-attachment-local-a.webp";
  const PUBLIC_B =
    "https://storage.googleapis.com/bucket/stores/s/media/mink-attachment-local-b.webp";
  const urlFor = new Map([
    [ID_A, PUBLIC_A],
    [ID_B, PUBLIC_B],
  ]);

  it("replaces inside nested objects, arrays, Markdown and a JSON string", () => {
    const input = {
      image_url: minkAttachmentUrl(ID_A),
      image_urls: [
        `https://echoss.storemink.com${minkAttachmentUrl(ID_B)}`,
        "https://storage.googleapis.com/bucket/stores/s/media/own.webp",
      ],
      content: `# Hello\n\n![cover](${minkAttachmentUrl(ID_A)})\n\nand ![two](${minkAttachmentUrl(ID_B.toUpperCase())})`,
      changes_json: JSON.stringify({
        sections: [{ config: { image_url: minkAttachmentUrl(ID_A) } }],
      }),
      title: "Leave me alone",
      count: 2,
      flag: false,
      nothing: null,
    };
    const out = rewriteMinkAttachmentRefs(input, urlFor) as typeof input;
    expect(out.image_url).toBe(PUBLIC_A);
    expect(out.image_urls).toEqual([
      PUBLIC_B,
      "https://storage.googleapis.com/bucket/stores/s/media/own.webp",
    ]);
    expect(out.content).toBe(
      `# Hello\n\n![cover](${PUBLIC_A})\n\nand ![two](${PUBLIC_B})`,
    );
    expect(JSON.parse(out.changes_json)).toEqual({
      sections: [{ config: { image_url: PUBLIC_A } }],
    });
    expect(out.title).toBe("Leave me alone");
    expect(out.count).toBe(2);
    expect(out.flag).toBe(false);
    expect(out.nothing).toBeNull();
  });

  it("leaves a reference whose id is not in the map, and other strings", () => {
    const input = {
      kept: minkAttachmentUrl(ID_C),
      text: "no reference",
    };
    expect(rewriteMinkAttachmentRefs(input, urlFor)).toEqual(input);
    expect(rewriteMinkAttachmentRefs(input, new Map())).toEqual(input);
  });

  it("★ never mutates its input and returns a new value", () => {
    const input = {
      image_url: minkAttachmentUrl(ID_A),
      sections: [{ image_url: minkAttachmentUrl(ID_B) }],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = rewriteMinkAttachmentRefs(input, urlFor);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect((out as typeof input).sections).not.toBe(input.sections);
    expect((out as typeof input).sections[0]).not.toBe(input.sections[0]);
  });

  it("rewrites a bare string and passes a number, null or a non-plain object through", () => {
    expect(rewriteMinkAttachmentRefs(minkAttachmentUrl(ID_A), urlFor)).toBe(
      PUBLIC_A,
    );
    expect(rewriteMinkAttachmentRefs(7, urlFor)).toBe(7);
    expect(rewriteMinkAttachmentRefs(null, urlFor)).toBeNull();
    const date = new Date(0);
    expect(rewriteMinkAttachmentRefs(date, urlFor)).toBe(date);
  });

  it("★ stops at depth 8", () => {
    const deep = (levels: number): unknown => {
      let node: unknown = minkAttachmentUrl(ID_A);
      for (let i = 0; i < levels; i += 1) node = { inner: node };
      return node;
    };
    const dig = (node: unknown, levels: number): unknown => {
      let cursor = node;
      for (let i = 0; i < levels; i += 1)
        cursor = (cursor as { inner: unknown }).inner;
      return cursor;
    };
    const within = rewriteMinkAttachmentRefs(
      deep(MINK_ATTACHMENT_WALK_DEPTH),
      urlFor,
    );
    expect(dig(within, MINK_ATTACHMENT_WALK_DEPTH)).toBe(PUBLIC_A);
    const past = deep(MINK_ATTACHMENT_WALK_DEPTH + 1);
    const out = rewriteMinkAttachmentRefs(past, urlFor);
    expect(dig(out, MINK_ATTACHMENT_WALK_DEPTH + 1)).toBe(
      minkAttachmentUrl(ID_A),
    );
    // The subtree past the limit is handed back as it was, untouched.
    expect(dig(out, MINK_ATTACHMENT_WALK_DEPTH)).toBe(
      dig(past, MINK_ATTACHMENT_WALK_DEPTH),
    );
  });

  it("★ rewrites at most 2,000 strings", () => {
    const filler = Array.from(
      { length: MINK_ATTACHMENT_WALK_STRINGS },
      () => "no reference here",
    );
    const past = rewriteMinkAttachmentRefs(
      [...filler, minkAttachmentUrl(ID_A)],
      urlFor,
    ) as string[];
    expect(past[MINK_ATTACHMENT_WALK_STRINGS]).toBe(minkAttachmentUrl(ID_A));
    const within = rewriteMinkAttachmentRefs(
      [
        ...filler.slice(0, MINK_ATTACHMENT_WALK_STRINGS - 1),
        minkAttachmentUrl(ID_A),
      ],
      urlFor,
    ) as string[];
    expect(within[MINK_ATTACHMENT_WALK_STRINGS - 1]).toBe(PUBLIC_A);
  });
});
