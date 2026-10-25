import { describe, expect, it } from "vitest";
import {
  THEME_STUDIO_INDUSTRIES,
  THEME_STUDIO_LIMITS,
} from "@/lib/theme-studio/contracts";
import {
  checkScreenshots,
  fileSizeWords,
  guessIndustry,
  newIdempotencyKey,
  nextThemeName,
  SCREENSHOT_ACCEPT,
  startRefusedKey,
  themeIdFromName,
  themeIdProblem,
} from "./new-theme-helpers";

// The pure rules behind New theme (wave TS-2, builder 2D).

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const MB = 1024 * 1024;
const LIMITS = { files: 10, fileBytes: 10 * MB, totalBytes: 40 * MB };

function file(name: string, size = MB, type = "image/png") {
  return { name, size, type };
}

describe("screenshots are checked on drop, before anything is created", () => {
  it("uses the server's own limits", () => {
    // The page passes THEME_STUDIO_LIMITS; these are the numbers it holds.
    expect(THEME_STUDIO_LIMITS.referenceImages).toBe(LIMITS.files);
    expect(THEME_STUDIO_LIMITS.referenceImageBytes).toBe(LIMITS.fileBytes);
    expect(THEME_STUDIO_LIMITS.referenceTotalBytes).toBe(LIMITS.totalBytes);
    expect(SCREENSHOT_ACCEPT).toBe(
      "image/jpeg,image/png,image/webp,image/avif",
    );
  });

  it("accepts the four image types, by type or by name when the type is empty", () => {
    const { accepted, problems } = checkScreenshots(
      [],
      [
        file("a.jpg", MB, "image/jpeg"),
        file("b.png"),
        file("c.webp", MB, "image/webp"),
        file("d.avif", MB, "image/avif"),
        file("e.AVIF", MB, ""),
      ],
      LIMITS,
    );
    expect(accepted.map((f) => f.name)).toEqual([
      "a.jpg",
      "b.png",
      "c.webp",
      "d.avif",
      "e.AVIF",
    ]);
    expect(problems).toEqual([]);
  });

  it("refuses another type, an empty file and one over 10 MB, each with a sentence", () => {
    const { accepted, problems } = checkScreenshots(
      [],
      [
        file("anim.gif", MB, "image/gif"),
        file("vector.svg", MB, "image/svg+xml"),
        file("notes.txt", MB, ""),
        file("empty.png", 0),
        file("huge.png", 10 * MB + 1),
        file("fine.png", 10 * MB),
      ],
      LIMITS,
    );
    expect(accepted.map((f) => f.name)).toEqual(["fine.png"]);
    expect(problems).toEqual([
      "anim.gif: use a JPEG, PNG, WebP or AVIF image.",
      "vector.svg: use a JPEG, PNG, WebP or AVIF image.",
      "notes.txt: use a JPEG, PNG, WebP or AVIF image.",
      "empty.png is empty.",
      "huge.png is larger than 10 MB.",
    ]);
  });

  it("stops at 10 screenshots, counting the ones already listed", () => {
    const current = Array.from({ length: 8 }, (_, i) => file(`old${i}.png`));
    const { accepted, problems } = checkScreenshots(
      current,
      [file("n1.png"), file("n2.png"), file("n3.png")],
      LIMITS,
    );
    expect(accepted.map((f) => f.name)).toEqual(["n1.png", "n2.png"]);
    expect(problems).toEqual([
      "n3.png was not added: a theme starts with up to 10 screenshots.",
    ]);
  });

  it("stops at 40 MB in all, and a smaller file after a refused one still fits", () => {
    const current = [
      file("a.png", 9 * MB),
      file("b.png", 9 * MB),
      file("x.png", 9 * MB),
    ];
    const { accepted, problems } = checkScreenshots(
      current,
      [file("c.png", 9 * MB), file("d.png", 9 * MB), file("e.png", 3 * MB)],
      LIMITS,
    );
    expect(accepted.map((f) => f.name)).toEqual(["c.png", "e.png"]);
    expect(problems).toEqual([
      "d.png was not added: the screenshots may add up to 40 MB at most.",
    ]);
  });

  it("says sizes in plain words", () => {
    expect(fileSizeWords(300)).toBe("1 KB");
    expect(fileSizeWords(850 * 1024)).toBe("850 KB");
    expect(fileSizeWords(1.24 * MB)).toBe("1.2 MB");
    expect(fileSizeWords(10 * MB)).toBe("10 MB");
    expect(fileSizeWords(40 * MB)).toBe("40 MB");
  });
});

describe("the theme ID", () => {
  it("is derived from the name the way the server accepts it", () => {
    expect(themeIdFromName("Aurora")).toBe("aurora");
    expect(themeIdFromName("  Aurora Skin & Co. ")).toBe("aurora-skin-co");
    expect(themeIdFromName("Crème Brûlée")).toBe("creme-brulee");
    expect(themeIdFromName("x".repeat(79) + " y")).toBe("x".repeat(79));
    expect(themeIdFromName("सुंदर")).toBe("");
  });

  it("names what the server would refuse", () => {
    expect(themeIdProblem("aurora")).toBeNull();
    expect(themeIdProblem("aurora-2")).toBeNull();
    for (const bad of ["", "ab", "Aurora", "a--b", "-ab", "ab-", "a_b"]) {
      expect(themeIdProblem(bad)).toBe(
        "The ID must be 3 to 80 lowercase letters or numbers, joined by single hyphens.",
      );
    }
    expect(themeIdProblem("x".repeat(81))).not.toBeNull();
    expect(themeIdProblem("demo-aurora")).toBe(
      "The ID may not start with demo-.",
    );
  });

  it("a new theme from another brief takes the next name, so it gets its own ID", () => {
    expect(nextThemeName("Aurora")).toBe("Aurora 2");
    expect(nextThemeName("Aurora 2")).toBe("Aurora 3");
    expect(nextThemeName("  Aurora 9 ")).toBe("Aurora 10");
    expect(nextThemeName("Store 2024 edition")).toBe("Store 2024 edition 2");
    const long = nextThemeName("n".repeat(100));
    expect(long.length).toBe(100);
    expect(long.endsWith(" 2")).toBe(true);
  });
});

describe("the industry is preselected from the brief", () => {
  const offered = [...THEME_STUDIO_INDUSTRIES];

  it("reads the plan's own example as Beauty", () => {
    expect(
      guessIndustry(
        "A calm skincare shop for sensitive skin. Soft greens, white space, big product photos. Avoid clinical blue.",
        offered,
      ),
    ).toBe("beauty");
  });

  it("picks the industry the brief names most", () => {
    expect(
      guessIndustry("Specialty coffee and tea, with a small bakery", offered),
    ).toBe("food-and-drink");
    expect(guessIndustry("Handmade sneakers and boots", offered)).toBe("shoes");
    expect(guessIndustry("Dog toys and cat beds for pets", offered)).toBe(
      "pets",
    );
    expect(guessIndustry("Ayurvedic supplements for wellness", offered)).toBe(
      "wellness",
    );
  });

  it("matches whole words only, and never guesses from 'home page' or 'art direction'", () => {
    expect(guessIndustry("A skinny layout", offered)).toBeNull();
    expect(
      guessIndustry(
        "Bold art direction, and the home page should feel calm",
        offered,
      ),
    ).toBeNull();
  });

  it("guesses nothing from an empty brief and never guesses General", () => {
    expect(guessIndustry("", offered)).toBeNull();
    expect(guessIndustry("   ", offered)).toBeNull();
    expect(guessIndustry("A general store for everyone", offered)).toBeNull();
  });

  it("only guesses an offered industry, the earlier one on a tie", () => {
    expect(guessIndustry("coffee", ["beauty"])).toBeNull();
    // One word each for clothing and shoes: clothing comes first.
    expect(guessIndustry("dresses and sandals", offered)).toBe("clothing");
    expect(guessIndustry("dresses and sandals", ["shoes", "clothing"])).toBe(
      "shoes",
    );
  });
});

describe("the chain's small pieces", () => {
  it("leaves a refused start under the key the theme page reads", () => {
    expect(startRefusedKey("p-1")).toBe("studio:start-refused:p-1");
  });

  it("makes an idempotency key the server accepts, with or without randomUUID", () => {
    const pattern = /^[A-Za-z0-9_-]{16,80}$/;
    expect(newIdempotencyKey()).toMatch(pattern);
    // An http page that is not a secure context: no randomUUID.
    const insecure: Pick<Crypto, "getRandomValues"> = {
      getRandomValues: globalThis.crypto.getRandomValues.bind(
        globalThis.crypto,
      ),
    };
    const key = newIdempotencyKey(insecure);
    expect(key).toMatch(pattern);
    expect(key).toHaveLength(32);
    expect(newIdempotencyKey(insecure)).not.toBe(key);
  });

  it("never writes a long dash", () => {
    const text = [
      ...checkScreenshots(
        [],
        [
          file("a.gif", MB, "image/gif"),
          file("b.png", 0),
          file("c.png", 99 * MB),
        ],
        LIMITS,
      ).problems,
      themeIdProblem("x") ?? "",
      themeIdProblem("demo-x") ?? "",
    ].join(" ");
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
  });
});
