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
  setRevampImageSettings: h.save,
}));
vi.mock("sonner", () => ({ toast: { success: h.success, error: h.error } }));

import { ImageProviderSwitch } from "./image-provider-switch";

const vertex = {
  provider: "vertex",
  elevenLabsModel: "gemini-3.1-flash-image",
} as const;

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  h.save.mockImplementation(async ({ provider, model }) => ({
    success: true,
    settings: { provider, elevenLabsModel: model },
  }));
});

describe("storefront redesign photo switch", () => {
  it("starts on Vertex with the model select locked", () => {
    render(<ImageProviderSwitch initial={vertex} canManage keyConfigured />);
    expect(
      screen.getByRole("radio", { name: "Google Vertex AI" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("combobox", { name: /ElevenLabs model/ }),
    ).toBeDisabled();
    expect(screen.getByText(/at most 2 a minute/)).toBeInTheDocument();
  });

  it("switches to ElevenLabs, then changes the model", async () => {
    render(<ImageProviderSwitch initial={vertex} canManage keyConfigured />);
    fireEvent.click(screen.getByRole("radio", { name: "ElevenLabs" }));
    await waitFor(() =>
      expect(h.save).toHaveBeenCalledWith({
        provider: "elevenlabs",
        model: "gemini-3.1-flash-image",
      }),
    );
    const select = screen.getByRole("combobox", { name: /ElevenLabs model/ });
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: "gpt-image-2" } });
    await waitFor(() =>
      expect(h.save).toHaveBeenLastCalledWith({
        provider: "elevenlabs",
        model: "gpt-image-2",
      }),
    );
    expect(
      screen.getByText(/ElevenLabs draws them with GPT Image 2/),
    ).toBeInTheDocument();
  });

  it("puts the choice back when the server refuses", async () => {
    h.save.mockResolvedValueOnce({
      error: "ElevenLabs needs ELEVENLABS_API_KEY on this server.",
    });
    render(
      <ImageProviderSwitch initial={vertex} canManage keyConfigured={false} />,
    );
    expect(screen.getByText(/needs ELEVENLABS_API_KEY/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "ElevenLabs" }));
    await waitFor(() => expect(h.error).toHaveBeenCalled());
    expect(
      screen.getByRole("radio", { name: "Google Vertex AI" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("is read-only for a member", () => {
    render(
      <ImageProviderSwitch initial={vertex} canManage={false} keyConfigured />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "ElevenLabs" }));
    expect(h.save).not.toHaveBeenCalled();
  });
});
