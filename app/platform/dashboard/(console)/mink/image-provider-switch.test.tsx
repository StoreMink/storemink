// @vitest-environment jsdom
// The operator's image provider control: Google or ElevenLabs for Theme
// Studio and storefront redesign photos, and ElevenLabs' quality (low or
// medium) and resolution.
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
  setImageGenerationSettings: h.save,
}));
vi.mock("sonner", () => ({ toast: { success: h.success, error: h.error } }));

import { ImageProviderSwitch } from "./image-provider-switch";

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  h.save.mockImplementation(async (settings) => ({ success: true, settings }));
});

const GOOGLE = {
  provider: "google",
  elevenlabsQuality: "low",
  elevenlabsResolution: "1K",
} as const;
const ELEVEN = { ...GOOGLE, provider: "elevenlabs" } as const;

describe("image provider choice", () => {
  it("starts on Google, with ElevenLabs' quality and resolution shown but locked", () => {
    render(<ImageProviderSwitch initial={GOOGLE} keyConfigured canManage />);
    expect(
      screen.getByRole("radio", { name: "Google Nano Banana 2.1" }),
    ).toHaveAttribute("aria-checked", "true");
    for (const name of ["Low", "Medium", "1K", "2K"]) {
      expect(screen.getByRole("radio", { name })).toBeDisabled();
    }
    expect(
      screen.getAllByText("Used only when ElevenLabs is chosen above."),
    ).toHaveLength(2);
  });

  it("★ switching to ElevenLabs saves the whole setting and unlocks its two choices", async () => {
    render(<ImageProviderSwitch initial={GOOGLE} keyConfigured canManage />);
    fireEvent.click(
      screen.getByRole("radio", {
        name: "GPT Image 2.5 Sunburst (ElevenLabs)",
      }),
    );
    await waitFor(() => expect(h.save).toHaveBeenCalledWith(ELEVEN));
    await waitFor(() =>
      expect(h.success).toHaveBeenCalledWith("Image provider updated."),
    );
    // The toast is called inside the save's transition, so the choices are
    // still locked for a moment after it: wait for them, never read at once.
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Medium" })).not.toBeDisabled(),
    );
  });

  it("★★ quality is low or medium only, and each choice is saved", async () => {
    render(<ImageProviderSwitch initial={ELEVEN} keyConfigured canManage />);
    expect(screen.queryByRole("radio", { name: /high/i })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Medium" }));
    await waitFor(() =>
      expect(h.save).toHaveBeenCalledWith({
        ...ELEVEN,
        elevenlabsQuality: "medium",
      }),
    );
  });

  it("resolution is 1K or 2K, and 1K says what it means for the photos", async () => {
    render(<ImageProviderSwitch initial={ELEVEN} keyConfigured canManage />);
    expect(
      screen.getByText(
        "1K photos are enlarged to fit the page, so they look softer than 2K.",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: "2K" }));
    await waitFor(() =>
      expect(h.save).toHaveBeenCalledWith({
        ...ELEVEN,
        elevenlabsResolution: "2K",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("2K photos are sharper and cost a little more."),
      ).toBeVisible(),
    );
  });

  it("★★ ElevenLabs chosen with no key in this environment says Google is still drawing", () => {
    render(
      <ImageProviderSwitch initial={ELEVEN} keyConfigured={false} canManage />,
    );
    expect(
      screen.getByText(
        "This environment has no ElevenLabs API key, so photos are still drawn by Google.",
      ),
    ).toBeVisible();
  });

  it("★ a save that fails puts the choice back and shows the reason", async () => {
    h.save.mockResolvedValue({
      error: "Could not change the image provider. Try again.",
    });
    render(<ImageProviderSwitch initial={GOOGLE} keyConfigured canManage />);
    fireEvent.click(
      screen.getByRole("radio", {
        name: "GPT Image 2.5 Sunburst (ElevenLabs)",
      }),
    );
    await waitFor(() =>
      expect(h.error).toHaveBeenCalledWith(
        "Could not change the image provider. Try again.",
      ),
    );
    expect(
      screen.getByRole("radio", { name: "Google Nano Banana 2.1" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("an operator who cannot manage sees the setting and cannot change it", () => {
    render(
      <ImageProviderSwitch initial={ELEVEN} keyConfigured canManage={false} />,
    );
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
    expect(h.save).not.toHaveBeenCalled();
  });

  it("choosing what is already chosen saves nothing", () => {
    render(<ImageProviderSwitch initial={ELEVEN} keyConfigured canManage />);
    fireEvent.click(screen.getByRole("radio", { name: "Low" }));
    expect(h.save).not.toHaveBeenCalled();
  });
});
