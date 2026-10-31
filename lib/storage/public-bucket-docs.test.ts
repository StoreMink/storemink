// The public media bucket is open by link and never listable: `allUsers`
// holds roles/storage.legacyObjectReader (get, no list), never
// roles/storage.objectViewer (which includes listing). The provisioning doc
// is what an operator copies into a terminal, and the gcs.ts header is what a
// developer reads first, so both must say so. No network, no database.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

describe("the provisioning doc grants the public bucket get, never list", () => {
  const doc = read("docs/gcp-migration-prod-provision.md");

  it("grants allUsers roles/storage.legacyObjectReader", () => {
    expect(doc).toContain(
      "--member=allUsers --role=roles/storage.legacyObjectReader",
    );
  });

  it("grants allUsers nothing else", () => {
    const grants = doc
      .split("\n")
      .filter((line) => line.includes("--member=allUsers"));
    expect(grants.length).toBeGreaterThan(0);
    for (const line of grants) {
      expect(line).toContain("--role=roles/storage.legacyObjectReader");
    }
  });

  it("never names roles/storage.objectViewer", () => {
    expect(doc).not.toContain("roles/storage.objectViewer");
  });
});

describe("the gcs.ts header states the same rule", () => {
  const source = read("lib/storage/gcs.ts");
  const firstImport = source.indexOf("\nimport ");
  const header = firstImport === -1 ? source : source.slice(0, firstImport);

  it("names the grant", () => {
    expect(header).toContain("roles/storage.legacyObjectReader");
  });

  it("says the bucket cannot be listed", () => {
    expect(/never listable|nobody can list/i.test(header)).toBe(true);
  });

  it("sends private data to the private bucket, with no fallback", () => {
    expect(header).toContain("PRIVATE bucket");
    expect(header).toContain("no fallback");
  });
});
