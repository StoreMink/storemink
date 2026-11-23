import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) =>
    fn({ execute: state.execute }),
  ),
}));
import { deleteThemeStudioProject } from "./deletion";
const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "test@example.com",
};
const input = {
  projectId: "22222222-2222-4222-8222-222222222222",
  expectedRevision: 3,
  confirmation: "clay-co",
};
it("rejects malformed deletion operands before querying", async () => {
  await expect(
    deleteThemeStudioProject(actor, { ...input, projectId: "invalid" }),
  ).rejects.toThrow(/malformed/);
  await expect(
    deleteThemeStudioProject(actor, { ...input, expectedRevision: -1 }),
  ).rejects.toThrow(/malformed/);
  expect(state.execute).not.toHaveBeenCalled();
});
it("surfaces the database refusal without reporting deletion", async () => {
  state.execute.mockResolvedValue({
    rows: [
      {
        result: {
          ok: false,
          error:
            "A store uses this theme without a fixed release, so deleting it would change how that store looks. Nothing was deleted.",
        },
      },
    ],
  });
  await expect(deleteThemeStudioProject(actor, input)).rejects.toThrow(
    /without a fixed release/,
  );
});
it("returns the deleted theme ID and how many stores keep it", async () => {
  state.execute.mockResolvedValue({
    rows: [{ result: { ok: true, themeId: "clay-co", storesKept: 3 } }],
  });
  await expect(deleteThemeStudioProject(actor, input)).resolves.toEqual({
    themeId: "clay-co",
    storesKept: 3,
  });
});
it("reads an answer without a usable count as no store kept it", async () => {
  // The function before 0289 never says, and only succeeded when no store
  // used the theme.
  for (const storesKept of [undefined, -1, 1.5, "2", null]) {
    state.execute.mockResolvedValue({
      rows: [{ result: { ok: true, themeId: "clay-co", storesKept } }],
    });
    await expect(deleteThemeStudioProject(actor, input)).resolves.toEqual({
      themeId: "clay-co",
      storesKept: 0,
    });
  }
});
