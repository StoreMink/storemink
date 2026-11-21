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
  setMinkSpeechSettings,
  setMinkVoiceProvider,
  setRevampImageSettings,
} from "./mink-operator-actions";
import { minkImageSettings, minkVoiceSettings } from "@/drizzle/schema";
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

describe("storefront redesign photo switch", () => {
  it("stores ElevenLabs and its model when the key is set", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "set");
    expect(
      await setRevampImageSettings({
        provider: "elevenlabs",
        model: "gpt-image-2",
      }),
    ).toEqual({
      success: true,
      settings: { provider: "elevenlabs", elevenLabsModel: "gpt-image-2" },
    });
    expect(h.insert).toHaveBeenCalledWith(minkImageSettings);
    expect(h.values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: true,
        revampProvider: "elevenlabs",
        elevenlabsModel: "gpt-image-2",
        updatedBy: "operator@example.test",
      }),
    );
    vi.unstubAllEnvs();
  });

  it("refuses ElevenLabs on a server with no key, and allows Vertex", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    expect(
      (
        await setRevampImageSettings({
          provider: "elevenlabs",
          model: "gemini-3.1-flash-image",
        })
      ).error,
    ).toMatch(/ELEVENLABS_API_KEY/);
    expect(h.insert).not.toHaveBeenCalled();
    expect(
      (
        await setRevampImageSettings({
          provider: "vertex",
          model: "gemini-3.1-flash-image",
        })
      ).success,
    ).toBe(true);
    vi.unstubAllEnvs();
  });

  it("refuses staff, unknown providers and unknown models", async () => {
    h.viewer.mockResolvedValueOnce({ role: "member" });
    expect(
      (
        await setRevampImageSettings({
          provider: "vertex",
          model: "gpt-image-2",
        })
      ).error,
    ).toMatch(/superadmin/);
    expect(
      (
        await setRevampImageSettings({
          provider: "other",
          model: "gpt-image-2",
        })
      ).error,
    ).toMatch(/Vertex AI or ElevenLabs/);
    expect(
      (await setRevampImageSettings({ provider: "vertex", model: "dall-e" }))
        .error,
    ).toMatch(/image model/);
    expect(h.insert).not.toHaveBeenCalled();
  });
});
