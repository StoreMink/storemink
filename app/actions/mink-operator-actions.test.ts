import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  viewer: vi.fn(),
  service: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  conflict: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("@/app/actions/platform", () => ({ getPlatformViewer: h.viewer }));
vi.mock("@/lib/db/client", () => ({ withService: h.service }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));
import { setMinkVoiceProvider } from "./mink-operator-actions";
import { minkVoiceSettings } from "@/drizzle/schema";
const storeId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.resetAllMocks();
  h.viewer.mockResolvedValue({
    role: "superadmin",
    email: "operator@example.test",
  });
  h.limit.mockResolvedValue([{ id: storeId }]);
  h.insert.mockReturnValue({ values: h.values });
  h.values.mockReturnValue({ onConflictDoUpdate: h.conflict });
  h.update.mockReturnValue({ set: h.set });
  h.set.mockReturnValue({ where: h.where });
  h.service.mockImplementation((fn) =>
    fn({
      select: () => ({ from: () => ({ where: () => ({ limit: h.limit }) }) }),
      insert: h.insert,
      update: h.update,
    }),
  );
});
describe("single global Mink voice switch", () => {
  it("stores one provider for the platform", async () => {
    expect(await setMinkVoiceProvider("saaras_v4")).toEqual({
      success: true,
      provider: "saaras_v4",
    });
    expect(h.insert).toHaveBeenCalledWith(minkVoiceSettings);
    expect(h.values).toHaveBeenCalledWith(
      expect.objectContaining({ id: true, provider: "saaras_v4" }),
    );
  });

  it("rejects staff and unknown providers without database access", async () => {
    h.viewer.mockResolvedValueOnce({ role: "member" });
    expect((await setMinkVoiceProvider("chirp_3")).error).toMatch(/superadmin/);
    expect((await setMinkVoiceProvider("other")).error).toMatch(/Chirp 3/);
    expect(h.service).not.toHaveBeenCalled();
  });
});
