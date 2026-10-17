// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("Where the image comes from", () => {
  // ★ With a library to pick from, the empty box asks first instead of
  //   opening the file dialog.
  it("asks whether to upload or choose from the Media Library", async () => {
    const user = userEvent.setup();
    const onChooseFromLibrary = vi.fn();
    render(
      <ImageUpload
        spec="product"
        onUploadSuccess={() => {}}
        onChooseFromLibrary={onChooseFromLibrary}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Add an image/ }));
    expect(
      await screen.findByRole("menuitem", { name: "Upload from computer" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("menuitem", { name: "Choose from Media Library" }),
    );
    expect(onChooseFromLibrary).toHaveBeenCalledOnce();
  });

  it("opens the file dialog when the computer is chosen", async () => {
    const user = userEvent.setup();
    const click = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});
    const onChooseFromLibrary = vi.fn();
    const { container } = render(
      <ImageUpload
        spec="product"
        onUploadSuccess={() => {}}
        onChooseFromLibrary={onChooseFromLibrary}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Add an image/ }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Upload from computer" }),
    );
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.contexts[0]).toBe(
      container.querySelector('input[type="file"]'),
    );
    expect(onChooseFromLibrary).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it("keeps the plain upload box where there is no library to offer", () => {
    render(<ImageUpload spec="category" onUploadSuccess={() => {}} />);
    expect(screen.getByText("Click to upload")).toBeTruthy();
    expect(screen.queryByText("Add an image")).toBeNull();
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

describe("Change background", () => {
  const editedWhite =
    "https://storage.googleapis.com/b/stores/s/edited/c-product-white.webp";
  const editedClear =
    "https://storage.googleapis.com/b/stores/s/edited/c-product-transparent.webp";

  function respond(...bodies: Record<string, unknown>[]) {
    const fetchMock = vi.fn<typeof fetch>();
    for (const body of bodies) {
      fetchMock.mockImplementationOnce(
        async () =>
          new Response(JSON.stringify(body), {
            status: body.error ? 402 : 200,
          }),
      );
    }
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("is offered only where the layout allows it, and only for product photos", () => {
    const { unmount } = render(
      <ImageRefineProvider available>
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={() => {}}
        />
      </ImageRefineProvider>,
    );
    expect(screen.queryByText(/Change background/)).toBeNull();
    unmount();

    render(
      <ImageRefineProvider available={false} background>
        <ImageUpload
          spec="blog_cover"
          defaultImage={original}
          onUploadSuccess={() => {}}
        />
      </ImageRefineProvider>,
    );
    expect(screen.queryByText(/Change background/)).toBeNull();
  });

  it("compares before replacing, then replaces rather than appends", async () => {
    const fetchMock = respond({
      url: editedWhite,
      chargedCredits: 1,
      reused: false,
      checks: ["touches_edge"],
    });
    const onUploadSuccess = vi.fn();
    const onReplace = vi.fn();
    render(
      <ImageRefineProvider available={false} background>
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={onUploadSuccess}
          onReplace={onReplace}
        />
      </ImageRefineProvider>,
    );
    fireEvent.click(screen.getByText(/Change background/));
    fireEvent.click(screen.getByRole("button", { name: /Remove background/ }));
    expect(await screen.findByAltText("With the new background")).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/mink/image-background");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      url: original,
      spec: "product",
      background: { kind: "white" },
      shadow: true,
    });
    expect(screen.getByText(/touches the edge of your photo/)).toBeTruthy();
    // No price anywhere on the dashboard (owner, 2026-10-18).
    expect(document.body.textContent).not.toMatch(/\d+\s*(Mink )?credits?/);
    // Nothing changes until the merchant chooses.
    expect(onReplace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Use this photo"));
    expect(onReplace).toHaveBeenCalledWith(original, editedWhite);
    expect(onUploadSuccess).not.toHaveBeenCalled();
  });

  it("tries another background for free and shows transparency on a chequerboard", async () => {
    const fetchMock = respond(
      { url: editedWhite, chargedCredits: 1, reused: false, checks: [] },
      { url: editedClear, chargedCredits: 0, reused: true, checks: [] },
    );
    const onUploadSuccess = vi.fn();
    render(
      <ImageRefineProvider available={false} background>
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={onUploadSuccess}
        />
      </ImageRefineProvider>,
    );
    fireEvent.click(screen.getByText(/Change background/));
    fireEvent.click(screen.getByRole("button", { name: /Remove background/ }));
    await screen.findByText("Use this photo");

    fireEvent.click(screen.getByRole("button", { name: "Transparent" }));
    // A different background is chosen, so the shown result is no longer it.
    expect(screen.queryByText("Use this photo")).toBeNull();
    const apply = screen.getByRole("button", { name: "Apply background" });
    expect(apply.textContent).not.toMatch(/credit/);
    fireEvent.click(apply);
    await screen.findByText("Use this photo");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      background: { kind: "transparent" },
    });
    const img = screen.getByAltText(
      "With the new background",
    ) as HTMLImageElement;
    expect(img.src).toBe(editedClear);
    expect(img.parentElement?.hasAttribute("data-checkerboard")).toBe(true);
    fireEvent.click(screen.getByText("Use this photo"));
    expect(onUploadSuccess).toHaveBeenCalledWith(editedClear);
  });

  it("sends the chosen colour", async () => {
    const fetchMock = respond({
      url: editedWhite,
      chargedCredits: 1,
      reused: false,
      checks: [],
    });
    render(
      <ImageRefineProvider available={false} background>
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={() => {}}
        />
      </ImageRefineProvider>,
    );
    fireEvent.click(screen.getByText(/Change background/));
    fireEvent.click(screen.getByRole("button", { name: "Colour" }));
    fireEvent.click(screen.getByRole("button", { name: "Sage" }));
    fireEvent.click(screen.getByRole("button", { name: /Remove background/ }));
    await screen.findByText("Use this photo");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      background: { kind: "colour", hex: "#e5eee4" },
    });
  });

  it("shows the server's reason and keeps the original", async () => {
    respond({ error: "Not enough Mink credits." });
    const onUploadSuccess = vi.fn();
    render(
      <ImageRefineProvider available={false} background>
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={onUploadSuccess}
        />
      </ImageRefineProvider>,
    );
    fireEvent.click(screen.getByText(/Change background/));
    fireEvent.click(screen.getByRole("button", { name: /Remove background/ }));
    expect(await screen.findByText("Not enough Mink credits.")).toBeTruthy();
    fireEvent.click(screen.getByText("Keep original"));
    expect(onUploadSuccess).not.toHaveBeenCalled();
    expect(screen.getByAltText("Uploaded")).toBeTruthy();
  });
});

describe("The shadow", () => {
  it("sends the shadow off when the merchant unticks it", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            url: "https://storage.googleapis.com/b/stores/s/edited/c.webp",
            chargedCredits: 1,
            reused: false,
            checks: [],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ImageRefineProvider available={false} background>
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={() => {}}
        />
      </ImageRefineProvider>,
    );
    fireEvent.click(screen.getByText(/Change background/));
    fireEvent.click(screen.getByLabelText("Soft shadow under the product"));
    fireEvent.click(screen.getByRole("button", { name: /Remove background/ }));
    await screen.findByText("Use this photo");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      background: { kind: "white" },
      shadow: false,
    });
  });
});

describe("Put in a scene (Mink AI)", () => {
  const first = "https://storage.googleapis.com/b/stores/s/edited/ai-1.webp";
  const second = "https://storage.googleapis.com/b/stores/s/edited/ai-2.webp";

  /** Each POST answers with the next body. */
  function server(posts: Record<string, unknown>[]) {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const body = posts.shift() ?? { error: "unexpected" };
      return new Response(JSON.stringify(body), {
        status: body.error ? 402 : 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const posted = (fetchMock: ReturnType<typeof server>, n: number) =>
    JSON.parse(String(fetchMock.mock.calls[n][1]?.body));

  function renderUpload(
    flags: { background?: boolean; scenes?: boolean },
    onReplace = vi.fn(),
  ) {
    render(
      <ImageRefineProvider
        available={false}
        background={flags.background ?? false}
        scenes={flags.scenes ?? true}
      >
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={() => {}}
          onReplace={onReplace}
        />
      </ImageRefineProvider>,
    );
    return onReplace;
  }

  it("is offered where the layout allows it, even without background removal", () => {
    server([]);
    renderUpload({ background: false, scenes: true });
    expect(
      screen.getByRole("button", { name: /^Put in a scene$/ }),
    ).toBeTruthy();
    expect(screen.queryByText(/Change background/)).toBeNull();
    cleanup();

    renderUpload({ background: true, scenes: false });
    expect(screen.queryByText(/Put in a scene/)).toBeNull();
    cleanup();

    // Never for a slot that is a scene already.
    render(
      <ImageRefineProvider available={false} background scenes>
        <ImageUpload
          spec="blog_cover"
          defaultImage={original}
          onUploadSuccess={() => {}}
        />
      </ImageRefineProvider>,
    );
    expect(screen.queryByText(/Put in a scene/)).toBeNull();
  });

  it("creates a photo from a preset, compares, then replaces", async () => {
    const fetchMock = server([{ url: first, chargedCredits: 5 }]);
    const onReplace = renderUpload({ scenes: true });
    fireEvent.click(screen.getByRole("button", { name: /Put in a scene/ }));
    fireEvent.click(screen.getByRole("button", { name: /Garden/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Create photo$/ }));
    expect(await screen.findByAltText("In the new scene")).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/mink/image-edit");
    expect(posted(fetchMock, 0)).toEqual({
      url: original,
      spec: "product",
      preset: "garden",
    });
    expect(document.body.textContent).not.toMatch(/\d+\s*(Mink )?credits?/);
    // Said plainly: the product is redrawn, so compare before using it.
    expect(screen.getByText(/redraws the\s+product too/)).toBeTruthy();
    expect(onReplace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Use this photo"));
    expect(onReplace).toHaveBeenCalledWith(original, first);
  });

  it("sends the merchant's own words, tries again, and keeps every photo", async () => {
    const fetchMock = server([
      { url: first, chargedCredits: 5 },
      { url: second, chargedCredits: 5 },
    ]);
    const onReplace = renderUpload({ scenes: true });
    fireEvent.click(screen.getByRole("button", { name: /Put in a scene/ }));
    fireEvent.change(screen.getByLabelText(/Or describe your own scene/), {
      target: { value: "  hanging from a tree branch  in a garden " },
    });
    // Typing replaces the preset.
    expect(
      screen
        .getByRole("button", { name: /Studio/ })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /Create photo/ }));
    await screen.findByAltText("In the new scene");
    expect(posted(fetchMock, 0)).toEqual({
      url: original,
      spec: "product",
      instruction: "hanging from a tree branch in a garden",
    });

    fireEvent.click(screen.getByRole("button", { name: /^Try again$/ }));
    await screen.findByRole("button", { name: /Photo 2:/ });
    expect(posted(fetchMock, 1)).toEqual(posted(fetchMock, 0));
    expect(document.body.textContent).not.toMatch(/\d+\s*(Mink )?credits?/);
    expect(
      (screen.getByAltText("In the new scene") as HTMLImageElement).src,
    ).toBe(second);

    // The first photo was paid for too: it can still be chosen.
    fireEvent.click(screen.getByRole("button", { name: /Photo 1:/ }));
    expect(
      (screen.getByAltText("In the new scene") as HTMLImageElement).src,
    ).toBe(first);
    fireEvent.click(screen.getByText("Use this photo"));
    expect(onReplace).toHaveBeenCalledWith(original, first);
  });

  it("shows the server's reason and offers nothing to use", async () => {
    server([{ error: "No credits left." }]);
    renderUpload({ scenes: true });
    fireEvent.click(screen.getByRole("button", { name: /Put in a scene/ }));
    fireEvent.click(screen.getByRole("button", { name: /Create photo/ }));
    expect(await screen.findByText("No credits left.")).toBeTruthy();
    expect(screen.queryByText("Use this photo")).toBeNull();
  });

  it("switches between the background and scene tools", () => {
    server([]);
    renderUpload({ background: true, scenes: true });
    fireEvent.click(screen.getByText(/Change background/));
    expect(
      screen.getByRole("button", { name: /Remove background/ }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Scene" }));
    expect(
      screen.queryByRole("button", { name: /Remove background/ }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /Create photo/ })).toBeTruthy();
  });
});
