// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImageUpload } from "./image-upload";
import { ImageRefineProvider } from "./image-refine-context";

vi.mock("@/lib/storage/uploads", () => ({ uploadImage: vi.fn() }));

const original = "https://storage.googleapis.com/b/stores/s/uploads/a.jpg";
const refinedUrl = "https://storage.googleapis.com/b/stores/s/refined/r.webp";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ImageUpload size guidance", () => {
  it("states the exact size for its slot", () => {
    render(<ImageUpload spec="product" onUploadSuccess={() => {}} />);
    expect(screen.getByText("1200 × 1600 px")).toBeTruthy();
  });

  it("warns when an uploaded photo will be cropped", () => {
    render(
      <ImageUpload
        spec="product"
        defaultImage={original}
        onUploadSuccess={() => {}}
      />,
    );
    const img = screen.getByAltText("Uploaded") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 1080 });
    Object.defineProperty(img, "naturalHeight", { value: 1080 });
    fireEvent.load(img);
    expect(screen.getByText(/crop about 25% from the sides/)).toBeTruthy();
  });
});

describe("Refine with Mink AI", () => {
  it("is not offered outside a provider that allows it", () => {
    render(
      <ImageUpload
        spec="product"
        defaultImage={original}
        onUploadSuccess={() => {}}
      />,
    );
    expect(screen.queryByText(/Refine with Mink AI/)).toBeNull();
  });

  it("is never offered for a logo", () => {
    render(
      <ImageRefineProvider available>
        <ImageUpload
          spec="logo"
          defaultImage={original}
          onUploadSuccess={() => {}}
        />
      </ImageRefineProvider>,
    );
    expect(screen.queryByText(/Refine with Mink AI/)).toBeNull();
  });

  it("compares before replacing, and replaces rather than appends", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ url: refinedUrl, chargedCredits: 3 }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onUploadSuccess = vi.fn();
    const onReplace = vi.fn();
    render(
      <ImageRefineProvider available>
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={onUploadSuccess}
          onReplace={onReplace}
        />
      </ImageRefineProvider>,
    );
    fireEvent.click(screen.getByText(/Refine with Mink AI/));
    expect(await screen.findByAltText("Refined with Mink AI")).toBeTruthy();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      url: original,
      spec: "product",
    });
    // Nothing changes until the merchant chooses.
    expect(onReplace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Use refined photo"));
    expect(onReplace).toHaveBeenCalledWith(original, refinedUrl);
    expect(onUploadSuccess).not.toHaveBeenCalled();
  });

  it("keeping the original changes nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ url: refinedUrl, chargedCredits: 3 })),
      ),
    );
    const onUploadSuccess = vi.fn();
    render(
      <ImageRefineProvider available>
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={onUploadSuccess}
        />
      </ImageRefineProvider>,
    );
    fireEvent.click(screen.getByText(/Refine with Mink AI/));
    fireEvent.click(await screen.findByText("Keep original"));
    expect(onUploadSuccess).not.toHaveBeenCalled();
    expect(screen.getByAltText("Uploaded")).toBeTruthy();
  });

  it("shows the server's reason when refining is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Not enough Mink credits." }), {
            status: 402,
          }),
      ),
    );
    render(
      <ImageRefineProvider available>
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={() => {}}
        />
      </ImageRefineProvider>,
    );
    fireEvent.click(screen.getByText(/Refine with Mink AI/));
    expect(await screen.findByText("Not enough Mink credits.")).toBeTruthy();
  });
});
