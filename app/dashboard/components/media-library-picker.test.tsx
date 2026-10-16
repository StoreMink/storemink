// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaLibraryPicker } from "./media-library-picker";
import { getMediaPickerPage } from "@/app/actions/media-actions";

vi.mock("@/app/actions/media-actions", () => ({
  getMediaPickerPage: vi.fn(),
}));

const A = "https://example.test/a.webp";
const B = "https://example.test/b.webp";
const C = "https://example.test/c.webp";

function page(urls: string[], extra: Record<string, unknown> = {}) {
  return {
    items: urls.map((url) => ({
      url,
      filename: url.split("/").pop()!,
      label: null,
      products: [],
    })),
    total: urls.length,
    page: 1,
    pageSize: 24,
    ...extra,
  };
}

describe("MediaLibraryPicker", () => {
  beforeEach(() => {
    vi.mocked(getMediaPickerPage).mockResolvedValue(page([A, B, C]));
  });

  it("opens on the Media Library and returns the one photo picked", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<MediaLibraryPicker open onClose={onClose} onSelect={onSelect} />);
    expect(getMediaPickerPage).toHaveBeenCalledWith({
      tab: "library",
      page: 1,
    });
    fireEvent.click(await screen.findByRole("button", { name: "a.webp" }));
    // Single pick: choosing another replaces the first.
    fireEvent.click(screen.getByRole("button", { name: "b.webp" }));
    fireEvent.click(screen.getByRole("button", { name: "Use photo" }));
    expect(onSelect).toHaveBeenCalledWith([B]);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not offer a photo that is already added", async () => {
    render(
      <MediaLibraryPicker
        open
        multiple
        exclude={[A]}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    const added = await screen.findByRole("button", {
      name: "a.webp, already added",
    });
    expect(added).toBeDisabled();
    expect(screen.getByText("Already added")).toBeInTheDocument();
  });

  it("stops at the room left when a limit is given", async () => {
    const onSelect = vi.fn();
    render(
      <MediaLibraryPicker
        open
        multiple
        max={2}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "a.webp" }));
    fireEvent.click(screen.getByRole("button", { name: "b.webp" }));
    expect(screen.getByRole("button", { name: "c.webp" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add 2 photos" }));
    expect(onSelect).toHaveBeenCalledWith([A, B]);
  });

  it("keeps picks across tabs and loads product photos on that tab", async () => {
    const onSelect = vi.fn();
    vi.mocked(getMediaPickerPage).mockImplementation(async ({ tab }) =>
      tab === "products" ? page([C]) : page([A]),
    );
    render(
      <MediaLibraryPicker
        open
        multiple
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "a.webp" }));
    fireEvent.click(screen.getByRole("tab", { name: /Product images/ }));
    await waitFor(() =>
      expect(getMediaPickerPage).toHaveBeenLastCalledWith({
        tab: "products",
        page: 1,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "c.webp" }));
    fireEvent.click(screen.getByRole("button", { name: "Add 2 photos" }));
    expect(onSelect).toHaveBeenCalledWith([A, C]);
  });

  it("shows why a tab cannot be listed", async () => {
    vi.mocked(getMediaPickerPage).mockResolvedValue({
      ...page([]),
      error: "Your role can't view the Media Library.",
    });
    render(<MediaLibraryPicker open onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(
      await screen.findByText("Your role can't view the Media Library."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use photo" })).toBeDisabled();
  });
});
