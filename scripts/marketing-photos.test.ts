import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IMAGE_SAMPLING_PARAMETERS } from "@/lib/theme-studio/image-models";

// scripts/marketing-photos.mjs runs its plan when it is loaded, so its
// request and its reading of an answer are checked in its source, as
// scripts/revamp-priority-test.test.ts checks the parts of gemini-vertex.ts
// it cannot import.

const SOURCE = readFileSync(
  path.join(__dirname, "marketing-photos.mjs"),
  "utf8",
);

describe("the marketing photos (owner, 25 Oct 2026: one image model)", () => {
  it("★★ draws with Nano Banana 2.1 at 2K", () => {
    expect(SOURCE.match(/const MODEL = "([^"]+)";/)?.[1]).toBe(
      "gemini-nano-banana-2.1",
    );
    // Every request names that constant, and no other model.
    expect(SOURCE.match(/\bmodel: [^,]+,/g)).toEqual(["model: MODEL,"]);
    expect(SOURCE).toContain('imageSize: "2K"');
  });

  it("★★ keeps the last picture that is not a thought, never the draft 2.1 sends first", () => {
    expect(SOURCE).toMatch(
      /\.filter\(\(part\) => part\.thought !== true && part\.inlineData\?\.data\)\s*\.at\(-1\)\?\.inlineData/,
    );
    // The first inline part was the draft.
    expect(SOURCE).not.toMatch(
      /parts\?\.find\(\s*\(part\) => part\.inlineData/,
    );
  });

  it("★ sends no sampling parameter, which 2.1 is documented to refuse", () => {
    for (const parameter of IMAGE_SAMPLING_PARAMETERS) {
      expect(SOURCE).not.toMatch(new RegExp(`\\b${parameter}\\s*:`));
    }
  });
});
