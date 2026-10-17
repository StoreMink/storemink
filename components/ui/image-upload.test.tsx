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
      newScene: false,
    });
    expect(screen.getByText(/touches the edge of your photo/)).toBeTruthy();
    expect(screen.getByText(/1 Mink credit was used/)).toBeTruthy();
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

describe("Scenes and the shadow", () => {
  const placed =
    "https://storage.googleapis.com/b/stores/s/edited/c-product-scene-1.webp";
  const woodScene = "https://storage.googleapis.com/b/stores/s/scenes/w.webp";

  /** GET lists saved scenes; each POST answers with the next body. */
  function server(posts: Record<string, unknown>[]) {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (!init?.method || init.method === "GET") {
        expect(String(input)).toBe("/api/mink/image-background?spec=product");
        return new Response(
          JSON.stringify({ scenes: [{ preset: "wood", url: woodScene }] }),
        );
      }
      const body = posts.shift() ?? { error: "unexpected" };
      return new Response(JSON.stringify(body), {
        status: body.error ? 402 : 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const posted = (fetchMock: ReturnType<typeof server>, n: number) =>
    JSON.parse(
      String(
        fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")[n][1]
          ?.body,
      ),
    );

  function renderEditor(scenes = true) {
    render(
      <ImageRefineProvider available={false} background scenes={scenes}>
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={() => {}}
        />
      </ImageRefineProvider>,
    );
    fireEvent.click(screen.getByText(/Change background/));
  }

  it("offers scenes only where the layout allows them", () => {
    server([]);
    renderEditor(false);
    expect(screen.queryByRole("button", { name: "Scene" })).toBeNull();
  });

  it("prices a new scene with the cut-out, then marks it saved and free", async () => {
    const fetchMock = server([
      {
        url: placed,
        chargedCredits: 6,
        reused: false,
        checks: [],
        scene: { url: "https://storage.googleapis.com/b/s/studio.webp" },
      },
    ]);
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Scene" }));
    const create = await screen.findByRole("button", {
      name: /Create scene\s*·\s*6 credits/,
    });
    fireEvent.click(create);
    await screen.findByText("Use this photo");
    expect(posted(fetchMock, 0)).toMatchObject({
      background: { kind: "scene", preset: "studio" },
      newScene: true,
      shadow: false,
    });
    expect(screen.getByText(/6 Mink credits were used/)).toBeTruthy();
    const studio = screen.getByRole("button", { name: /Studio/ });
    expect(studio.textContent).toContain("Saved · free");
  });

  it("uses a saved scene free, and charges 5 only to draw a new one", async () => {
    server([]);
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Scene" }));
    const wood = await screen.findByRole("button", { name: /Wooden table/ });
    expect(wood.textContent).toContain("Saved · free");
    fireEvent.click(wood);
    expect(
      screen.getByText(/Uses your saved wooden table scene, free/),
    ).toBeTruthy();
    // Only the first cut-out of this photo is charged.
    expect(
      screen.getByRole("button", { name: /Remove background\s*·\s*1 credit/ }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Draw a new one\s*·\s*5 credits/ }),
    );
    expect(
      screen.getByRole("button", { name: /Create scene\s*·\s*6 credits/ }),
    ).toBeTruthy();
  });

  it("sends the shadow off when the merchant unticks it", async () => {
    const fetchMock = server([
      { url: placed, chargedCredits: 1, reused: false, checks: [] },
    ]);
    renderEditor();
    fireEvent.click(screen.getByLabelText("Soft shadow under the product"));
    fireEvent.click(screen.getByRole("button", { name: /Remove background/ }));
    await screen.findByText("Use this photo");
    expect(posted(fetchMock, 0)).toMatchObject({
      background: { kind: "white" },
      shadow: false,
    });
  });
});
