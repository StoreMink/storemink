import { describe, expect, it } from "vitest";
import {
  addMinkCsvReference,
  readMinkCsvReference,
  validateMinkCsv,
  inspectMinkCsv,
  correctMinkCsv,
  minkCsvRetryText,
  MINK_CSV_BYTES,
  deriveMinkCsvHandles,
} from "./csv-input";
import { normalizeMinkDraftContent } from "./draft-types";
import {
  draftContentForAction,
  actionToolForDraftKind,
} from "./product-action-types";
describe("Product CSV chat boundary", () => {
  it("reports a malformed price at its original physical line", () => {
    const checked = inspectMinkCsv(
      'Handle,Title,Base Price\na,"Milk\nBottle",abc\nb,Tea,20\n',
    );
    expect(checked.errorCount).toBe(1);
    expect(checked.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          line: 2,
          column: "Base Price",
          severity: "error",
        }),
      ]),
    );
    expect(checked.csv.rows[1].line).toBe(4);
  });
  it("corrects headers and explicit cells without changing other data", () => {
    const source = 'Handle,Product,Base Price\na,"Milk, large",abc\nb,Tea,20\n';
    const fixed = correctMinkCsv(
      source,
      [{ line: 2, column: "Base Price", value: "99" }],
      [{ from: "Product", to: "Title" }],
    );
    expect(inspectMinkCsv(fixed).errorCount).toBe(0);
    expect(validateMinkCsv(fixed).rows.map((row) => row.cells)).toEqual([
      ["a", "Milk, large", "99"],
      ["b", "Tea", "20"],
    ]);
    expect(source).toContain("abc");
  });
  it("preserves imported formula-like literal cells and unicode exactly", () => {
    const fixed = correctMinkCsv(
      "Handle,Title\na,＝literal\nb,=literal\n",
      [{ line: 2, column: "Title", value: "＝kept" }],
      [],
    );
    expect(validateMinkCsv(fixed).rows.map((row) => row.cells[1])).toEqual([
      "＝kept",
      "=literal",
    ]);
  });
  it("never silently truncates a large CSV or accepts binary data", () => {
    expect(() =>
      validateMinkCsv(
        "Handle,Title\n" +
          Array.from({ length: 5001 }, (_, i) => `${i},Item`).join("\n"),
      ),
    ).toThrow(/5,000/);
    expect(() => validateMinkCsv("a".repeat(MINK_CSV_BYTES + 1))).toThrow(
      /5 MiB/,
    );
    expect(() => validateMinkCsv("Handle,Title\na,\0")).toThrow(/UTF-8/);
  });
  it("rejects unknown rows, ambiguous headers and duplicate edits", () => {
    const source = "Handle,Title\na,Milk\n";
    expect(() =>
      correctMinkCsv(source, [{ line: 99, column: "Title", value: "Tea" }], []),
    ).toThrow(/exact/);
    expect(() =>
      correctMinkCsv(
        source,
        [
          { line: 2, column: "Title", value: "Tea" },
          { line: 2, column: "Title", value: "Coffee" },
        ],
        [],
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      correctMinkCsv(
        "Handle,Title,Title\na,Milk,Milk\n",
        [{ line: 2, column: "Title", value: "Tea" }],
        [],
      ),
    ).toThrow(/exact/);
  });
  it("retries failed and unprocessed rows only, accounting for quoted newlines", () => {
    const source = 'Handle,Title\na,"Milk\nBottle"\nb,Tea\nc,Coffee\n';
    const retry = validateMinkCsv(minkCsvRetryText(source, [4], 2));
    expect(retry.rows.map((row) => row.cells[0])).toEqual(["b", "c"]);
    expect(() => minkCsvRetryText(source, [], 3)).toThrow(/no failed/);
  });
  it("keeps attachment text out of the conversation and round-trips the card reference", () => {
    const file = {
      id: "11111111-1111-4111-8111-111111111111",
      filename: "products.csv",
    };
    const text = addMinkCsvReference("Import these", file);
    expect(readMinkCsvReference(text)).toEqual({
      message: "Import these",
      file,
    });
    expect(text).toContain("untrusted");
    expect(text).not.toContain("Handle");
  });
});
describe("Missing product handles", () => {
  it("adds an explicitly supplied missing column before applying facts", () => {
    const result = correctMinkCsv(
      "Title\nMilk\nMilk\n",
      [
        { line: 2, column: "Handle", value: "milk-500" },
        { line: 3, column: "Handle", value: "milk-1000" },
      ],
      [],
      ["Handle"],
    );
    expect(inspectMinkCsv(result).errorCount).toBe(0);
  });
  it("derives handles from supplied titles and refuses ambiguous collisions", () => {
    const derived = deriveMinkCsvHandles(
      "Title,Base Price\nWhole Milk,99\nTea,20\n",
    );
    expect(inspectMinkCsv(derived.text).errorCount).toBe(0);
    expect(validateMinkCsv(derived.text).rows[0].cells).toEqual([
      "Whole Milk",
      "99",
      "whole-milk",
    ]);
    expect(() => deriveMinkCsvHandles("Title\nMilk\nMilk\n")).toThrow(
      /unique Handle/,
    );
  });
});
describe("Product photo approval contract", () => {
  const photo =
    "https://storage.googleapis.com/bucket/stores/store/media/photo.webp";
  it("changes only primary/gallery fields and preserves exact URL bytes", () => {
    const content = normalizeMinkDraftContent("product_images", {
      image_url: photo,
      images_json: JSON.stringify([photo]),
      price: "1",
      status: "published",
    });
    expect(actionToolForDraftKind("product_images")).toBe(
      "apply_product_images",
    );
    expect(draftContentForAction("apply_product_images", content)).toEqual({
      image_url: photo,
      images_json: JSON.stringify([photo]),
    });
  });
  it("refuses malformed galleries, a mismatched primary and generated catalogue art", () => {
    for (const content of [
      { image_url: photo, images_json: "garbage" },
      { image_url: photo, images_json: "[]" },
      {
        image_url: photo,
        images_json: JSON.stringify([
          "https://x/mink-generated/art.webp",
          photo,
        ]),
      },
    ])
      expect(() =>
        normalizeMinkDraftContent("product_images", content),
      ).toThrow();
  });
});
