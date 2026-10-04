import { describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withService: h.read }));
import {
  getMinkStoreAccess,
  isMinkStoreInvited,
  requireMinkStoreInvite,
} from "./access";
describe("Mink availability for all stores", () => {
  it("allows a new store with no access row and does not read the invitation table", async () => {
    expect(await getMinkStoreAccess("new-store")).toEqual({
      enabled: true,
      draftingEnabled: true,
    });
    expect(await isMinkStoreInvited("new-store")).toBe(true);
    expect(await requireMinkStoreInvite("new-store", true)).toEqual({
      enabled: true,
      draftingEnabled: true,
    });
    expect(h.read).not.toHaveBeenCalled();
  });
});
