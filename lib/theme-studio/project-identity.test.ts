import { expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { resolveRecreatedThemeId } from "./project-identity";

function database(rows: { theme_id: string; deleted: boolean }[]) {
  return { execute: vi.fn(async () => ({ rows })) } as unknown as Db;
}

it("keeps a never-deleted ID unchanged, including active conflicts", async () => {
  expect(await resolveRecreatedThemeId(database([]), "bubble")).toBe("bubble");
  expect(
    await resolveRecreatedThemeId(
      database([{ theme_id: "bubble", deleted: false }]),
      "bubble",
    ),
  ).toBe("bubble");
});

it("allocates a fresh identity only for an exact deletion receipt", async () => {
  expect(
    await resolveRecreatedThemeId(
      database([{ theme_id: "bubble-2", deleted: true }]),
      "bubble",
    ),
  ).toBe("bubble");
  expect(
    await resolveRecreatedThemeId(
      database([{ theme_id: "bubble", deleted: true }]),
      "bubble",
    ),
  ).toBe("bubble-2");
});

it("skips both deleted suffixes and occupied project/release/catalog IDs", async () => {
  const db = database([
    { theme_id: "bubble", deleted: true },
    { theme_id: "bubble-2", deleted: true },
    { theme_id: "bubble-3", deleted: false },
    { theme_id: "bubble-4", deleted: false },
    { theme_id: "bubble-5", deleted: false },
  ]);
  expect(await resolveRecreatedThemeId(db, "bubble")).toBe("bubble-6");
});

it("keeps long IDs valid when appending a suffix", async () => {
  const id = "a".repeat(77) + "-bc";
  const allocated = await resolveRecreatedThemeId(
    database([{ theme_id: id, deleted: true }]),
    id,
  );
  expect(allocated).toBe("a".repeat(77) + "-2");
  expect(allocated!.length).toBeLessThanOrEqual(80);
  expect(allocated).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
});

it("bounds allocation when every suffix is occupied", async () => {
  const rows = [{ theme_id: "bubble", deleted: true }];
  for (let n = 2; n <= 10_000; n++) {
    rows.push({ theme_id: `bubble-${n}`, deleted: false });
  }
  expect(await resolveRecreatedThemeId(database(rows), "bubble")).toBeNull();
});
