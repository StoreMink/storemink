// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const h = vi.hoisted(() => ({
  save: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/app/actions/mink-operator-actions", () => ({
  setMinkSpeechSettings: h.save,
}));
vi.mock("sonner", () => ({ toast: { success: h.success, error: h.error } }));

import { SpeechProviderSwitch } from "./speech-provider-switch";

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  h.save.mockImplementation(async (settings) => ({ success: true, settings }));
});

const off = { enabled: false, provider: "gemini_3_8_flash_lite_tts" } as const;

describe("read-aloud choice", () => {
  it("starts on the browser voice, the model choice grey and locked", () => {
    render(<SpeechProviderSwitch initial={off} canManage />);
    const browser = screen.getByRole("radio", { name: "Browser voice" });
    expect(browser).toHaveAttribute("aria-checked", "true");
    expect(browser).toHaveClass("bg-violet-600");
    const gemini = screen.getByRole("radio", {
      name: "Gemini 3.8 Flash-Lite TTS",
    });
    // Saved but not in use: shown, never in the "running" violet.
    expect(gemini).toHaveAttribute("aria-checked", "true");
    expect(gemini).not.toHaveClass("bg-violet-600");
    expect(gemini).toBeDisabled();
    expect(screen.getByText(/own browser voice/i)).toBeVisible();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("chooses a model, then switches Gemini to Sarvam", async () => {
    render(<SpeechProviderSwitch initial={off} canManage />);
    fireEvent.click(
      screen.getByRole("radio", { name: "Text-to-speech model" }),
    );
    await waitFor(() =>
      expect(h.save).toHaveBeenCalledWith({
        enabled: true,
        provider: "gemini_3_8_flash_lite_tts",
      }),
    );
    expect(
      await screen.findByText(/Gemini 3.8 Flash-Lite TTS reads voice chat/),
    ).toBeVisible();
    const gemini = screen.getByRole("radio", {
      name: "Gemini 3.8 Flash-Lite TTS",
    });
    await waitFor(() => expect(gemini).toHaveClass("bg-violet-600"));
    const sarvam = screen.getByRole("radio", {
      name: "Sarvam Bulbul V4 Flash",
    });
    await waitFor(() => expect(sarvam).toBeEnabled());
    fireEvent.click(sarvam);
    await waitFor(() =>
      expect(h.save).toHaveBeenLastCalledWith({
        enabled: true,
        provider: "bulbul_v4_flash",
      }),
    );
    await waitFor(() => expect(sarvam).toHaveAttribute("aria-checked", "true"));
  });

  it("puts the choice back when saving fails", async () => {
    h.save.mockResolvedValue({
      error: "Could not change the read-aloud voice.",
    });
    render(<SpeechProviderSwitch initial={off} canManage />);
    fireEvent.click(
      screen.getByRole("radio", { name: "Text-to-speech model" }),
    );
    await waitFor(() => expect(h.error).toHaveBeenCalled());
    expect(
      screen.getByRole("radio", { name: "Browser voice" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("is read-only for operators who cannot manage platform settings", () => {
    render(<SpeechProviderSwitch initial={off} canManage={false} />);
    for (const option of screen.getAllByRole("radio"))
      expect(option).toBeDisabled();
  });
});
