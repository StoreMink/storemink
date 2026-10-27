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
  setMinkVoiceProvider: h.save,
}));
vi.mock("sonner", () => ({ toast: { success: h.success, error: h.error } }));

import { VoiceProviderSwitch } from "./voice-provider-switch";

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  h.save.mockResolvedValue({ success: true, provider: "saaras_v4" });
});

describe("global speech-to-text choice", () => {
  it("shows both models with the one in use selected, never as on/off", () => {
    render(<VoiceProviderSwitch initialProvider="chirp_3" canManage />);
    expect(
      screen.getByRole("radiogroup", {
        name: "Speech-to-text model for every store",
      }),
    ).toBeInTheDocument();
    const chirp = screen.getByRole("radio", { name: "Google Chirp 3" });
    const sarvam = screen.getByRole("radio", { name: "Sarvam Saaras v4" });
    expect(chirp).toHaveAttribute("aria-checked", "true");
    expect(chirp).toHaveClass("bg-violet-600");
    expect(sarvam).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("changes the one global setting immediately", async () => {
    render(<VoiceProviderSwitch initialProvider="chirp_3" canManage />);
    const sarvam = screen.getByRole("radio", { name: "Sarvam Saaras v4" });
    fireEvent.click(sarvam);
    await waitFor(() => expect(h.save).toHaveBeenCalledWith("saaras_v4"));
    await waitFor(() => expect(sarvam).toHaveAttribute("aria-checked", "true"));
    expect(sarvam).toHaveClass("bg-violet-600");
    expect(screen.getByText(/used by Mink for every store/i)).toBeVisible();
  });

  it("does nothing when the chosen model is clicked again", () => {
    render(<VoiceProviderSwitch initialProvider="chirp_3" canManage />);
    fireEvent.click(screen.getByRole("radio", { name: "Google Chirp 3" }));
    expect(h.save).not.toHaveBeenCalled();
  });

  it("moves with the arrow keys", async () => {
    render(<VoiceProviderSwitch initialProvider="chirp_3" canManage />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "Google Chirp 3" }), {
      key: "ArrowRight",
    });
    await waitFor(() => expect(h.save).toHaveBeenCalledWith("saaras_v4"));
  });

  it("is read-only for operators who cannot manage platform settings", () => {
    render(<VoiceProviderSwitch initialProvider="chirp_3" canManage={false} />);
    for (const option of screen.getAllByRole("radio"))
      expect(option).toBeDisabled();
  });
});
