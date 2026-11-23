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
import {
  setImageGenerationSettings,
  setMinkSpeechSettings,
  setMinkVoiceProvider,
} from "./mink-operator-actions";
import { imageGenerationSettings, minkVoiceSettings } from "@/drizzle/schema";
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

describe("global read-aloud switch", () => {
  it("stores whether a model reads answers, and which", async () => {
    expect(
      await setMinkSpeechSettings({
        enabled: true,
        provider: "bulbul_v4_flash",
      }),
    ).toEqual({
      success: true,
      settings: { enabled: true, provider: "bulbul_v4_flash" },
    });
    expect(h.insert).toHaveBeenCalledWith(minkVoiceSettings);
    expect(h.values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: true,
        speechEnabled: true,
        speechProvider: "bulbul_v4_flash",
      }),
    );
    // The transcription model is a separate choice and is left alone.
    expect(h.values.mock.calls[0][0]).not.toHaveProperty("provider");
    expect(h.conflict).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          speechEnabled: true,
          speechProvider: "bulbul_v4_flash",
        }),
      }),
    );
  });

  it("rejects staff, unknown models and a non-boolean switch", async () => {
    h.viewer.mockResolvedValueOnce({ role: "member" });
    expect(
      (
        await setMinkSpeechSettings({
          enabled: true,
          provider: "bulbul_v4_flash",
        })
      ).error,
    ).toMatch(/superadmin/);
    expect(
      (await setMinkSpeechSettings({ enabled: true, provider: "elevenlabs" }))
        .error,
    ).toMatch(/Gemini 3.8 Flash-Lite TTS or Sarvam Bulbul V4 Flash/);
    expect(
      (
        await setMinkSpeechSettings({
          enabled: "yes",
          provider: "bulbul_v4_flash",
        })
      ).error,
    ).toMatch(/Choose whether/);
    expect(h.service).not.toHaveBeenCalled();
  });
});

// 22 Nov 2026: which provider draws Theme Studio's and the storefront
// redesign's photos, and ElevenLabs' quality and resolution.
describe("image provider setting", () => {
  const CHOICE = {
    provider: "elevenlabs",
    elevenlabsQuality: "medium",
    elevenlabsResolution: "2K",
  } as const;

  it("stores the provider, the quality and the resolution in the one row", async () => {
    expect(await setImageGenerationSettings(CHOICE)).toEqual({
      success: true,
      settings: CHOICE,
    });
    expect(h.insert).toHaveBeenCalledWith(imageGenerationSettings);
    expect(h.values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: true,
        provider: "elevenlabs",
        elevenlabsQuality: "medium",
        elevenlabsResolution: "2K",
        updatedBy: "operator@example.test",
      }),
    );
    expect(h.conflict).toHaveBeenCalledWith(
      expect.objectContaining({
        target: imageGenerationSettings.id,
        set: expect.objectContaining({ provider: "elevenlabs" }),
      }),
    );
  });

  it("★★ only a superadmin, and only the values that exist: nothing else reaches the database", async () => {
    h.viewer.mockResolvedValue({ role: "member", email: "staff@example.test" });
    expect((await setImageGenerationSettings(CHOICE)).error).toMatch(
      /superadmin/,
    );
    h.viewer.mockResolvedValue({
      role: "superadmin",
      email: "operator@example.test",
    });
    for (const bad of [
      { ...CHOICE, provider: "openai" },
      // The API also offers high, xhigh and max; they are never asked for.
      { ...CHOICE, elevenlabsQuality: "high" },
      { ...CHOICE, elevenlabsQuality: "max" },
      { ...CHOICE, elevenlabsResolution: "4K" },
      { provider: "elevenlabs" },
    ]) {
      expect(
        (await setImageGenerationSettings(bad as never)).error,
      ).toBeTruthy();
    }
    expect(h.service).not.toHaveBeenCalled();
  });

  it("a write that fails says so, and reports no success", async () => {
    h.service.mockRejectedValue(new Error("db down"));
    const result = await setImageGenerationSettings(CHOICE);
    expect(result.success).toBeUndefined();
    expect(result.error).toMatch(/Could not change the image provider/);
  });
});
