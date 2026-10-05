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
it("surfaces the database usage refusal without reporting deletion", async () => {
  state.execute.mockResolvedValue({
    rows: [{ result: { ok: false, error: "A store is using this theme." } }],
  });
  await expect(deleteThemeStudioProject(actor, input)).rejects.toThrow(
    /store is using/,
  );
});
it("returns only the deleted theme ID after a successful transaction", async () => {
  state.execute.mockResolvedValue({
    rows: [{ result: { ok: true, themeId: "clay-co" } }],
  });
  await expect(deleteThemeStudioProject(actor, input)).resolves.toEqual({
    themeId: "clay-co",
  });
});
