import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARCHIVE_ROOT,
  archiveBasename,
  archiveBlockPrefix,
  archiveDatabase,
  archiveObjectPath,
  archivePathDatabase,
  archivePrefix,
  archiveStoreContentPath,
  isThisDatabaseArchivePath,
} from "./archive-paths";

const BLOCK = "0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the database folder", () => {
  it("is DB_NAME when it is a plain name, read on every call", () => {
    vi.stubEnv("DB_NAME", "storemink_staging");
    expect(archiveDatabase()).toBe("storemink_staging");
    expect(archivePrefix()).toBe("takedown-archive/storemink_staging/");
    vi.stubEnv("DB_NAME", "storemink");
    expect(archivePrefix()).toBe("takedown-archive/storemink/");
  });

  it("is default for a missing or unusual name", () => {
    for (const name of ["", "a/b", "../x", "x y", "a".repeat(64)]) {
      vi.stubEnv("DB_NAME", name);
      expect(archiveDatabase(), name).toBe("default");
    }
  });
});

describe("paths", () => {
  it("puts each file in its block's folder, numbered", () => {
    vi.stubEnv("DB_NAME", "storemink");
    expect(archiveBlockPrefix(BLOCK)).toBe(
      `takedown-archive/storemink/${BLOCK}/`,
    );
    expect(archiveObjectPath(BLOCK, 0, "shoe.webp")).toBe(
      `takedown-archive/storemink/${BLOCK}/0-shoe.webp`,
    );
    expect(archiveObjectPath(BLOCK.toUpperCase(), 12, "a.pdf")).toBe(
      `takedown-archive/storemink/${BLOCK}/12-a.pdf`,
    );
    expect(archiveStoreContentPath(BLOCK)).toBe(
      `takedown-archive/storemink/${BLOCK}/store-content.jsonl`,
    );
  });

  it("stays outside stores/<id>/, so deleting a store never reaches it", () => {
    vi.stubEnv("DB_NAME", "storemink");
    expect(archiveObjectPath(BLOCK, 1, "x.jpg").startsWith("stores/")).toBe(
      false,
    );
    expect(ARCHIVE_ROOT).toBe("takedown-archive/");
  });

  it("makes a file's own name safe and never empty", () => {
    expect(archiveBasename("stores/abc/uploads/My Shoe (1).webp")).toBe(
      "My_Shoe__1_.webp",
    );
    expect(archiveBasename("..")).toBe("file");
    expect(archiveBasename(".")).toBe("file");
    expect(archiveBasename("")).toBe("file");
    expect(archiveBasename("a\\b\\c.png")).toBe("c.png");
    expect(archiveBasename("x".repeat(300))).toHaveLength(100);
    expect(archiveObjectPath(BLOCK, 2, "../../etc/passwd")).toMatch(
      /\/2-passwd$/,
    );
  });

  it("refuses a block id that is not a UUID and a bad file number", () => {
    expect(() => archiveBlockPrefix("../other")).toThrow(RangeError);
    expect(() => archiveObjectPath("not-a-uuid", 0, "a")).toThrow(RangeError);
    expect(() => archiveObjectPath(BLOCK, -1, "a")).toThrow(RangeError);
    expect(() => archiveObjectPath(BLOCK, 1.5, "a")).toThrow(RangeError);
  });
});

describe("whose archive a path is", () => {
  it("reads the database from a path and only claims this database's", () => {
    vi.stubEnv("DB_NAME", "storemink");
    const own = archiveObjectPath(BLOCK, 0, "a.webp");
    expect(archivePathDatabase(own)).toBe("storemink");
    expect(isThisDatabaseArchivePath(own)).toBe(true);

    vi.stubEnv("DB_NAME", "storemink_staging");
    // storemink's archive is never storemink_staging's, nor the reverse.
    expect(isThisDatabaseArchivePath(own)).toBe(false);
    expect(
      isThisDatabaseArchivePath(
        `takedown-archive/storemink_staging/${BLOCK}/0-a.webp`,
      ),
    ).toBe(true);
  });

  it("refuses what is not an archive path", () => {
    vi.stubEnv("DB_NAME", "storemink");
    for (const path of [
      `stores/x/takedown-archive/storemink/${BLOCK}/0-a`,
      "takedown-archive/storemink",
      `takedown-archive/storemink/../storemink_staging/${BLOCK}/0-a`,
      `takedown-archive/storemink//0-a`,
      `takedown-archive/a b/${BLOCK}/0-a`,
      "",
    ]) {
      expect(archivePathDatabase(path), path).toBeNull();
      expect(isThisDatabaseArchivePath(path), path).toBe(false);
    }
  });
});
