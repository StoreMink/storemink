// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageUpload } from "./image-upload";
import { ImageRefineProvider } from "./image-refine-context";
import { resetImageRefinesForTests } from "./image-refine-registry";
import { sendPageExitRequest } from "@/lib/http/page-exit-request";
import type { ImageSpecKey } from "@/lib/media/image-specs";

vi.mock("@/lib/storage/uploads", () => ({ uploadImage: vi.fn() }));
vi.mock("@/lib/http/page-exit-request", () => ({
  sendPageExitRequest: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));

const original = "https://storage.googleapis.com/b/stores/s/uploads/a.jpg";
const refinedUrl = "https://storage.googleapis.com/b/stores/s/refined/r.webp";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetImageRefinesForTests();
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
      stopToken: expect.stringMatching(UUID_RE),
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
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Not enough Mink credits." }), {
          status: 402,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
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
    // ★ A definitive refusal (a plain-string body, so text/plain: the type
    //   is never consulted) asks no outcome and sends no stop.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sendPageExitRequest).not.toHaveBeenCalled();
  });

  /** A refine whose answer the test sends by hand. */
  function heldRefine() {
    const held: {
      signal?: AbortSignal;
      body?: { url: string; spec: string; stopToken: string };
      answer?: (response: Response) => void;
    } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        if (String(input) !== "/api/mink/image-refine") {
          return Promise.resolve(new Response(null, { status: 503 }));
        }
        held.signal = init?.signal ?? undefined;
        held.body = JSON.parse(String(init?.body));
        return new Promise<Response>((resolve) => {
          held.answer = resolve;
        });
      }),
    );
    return held;
  }

  function Editor({
    show = true,
    image = original,
    spec = "product",
    onUploadSuccess = () => {},
  }: {
    show?: boolean;
    image?: string;
    spec?: ImageSpecKey;
    onUploadSuccess?: (url: string) => void;
  }) {
    return (
      <ImageRefineProvider available>
        {show ? (
          <ImageUpload
            spec={spec}
            defaultImage={image}
            onUploadSuccess={onUploadSuccess}
          />
        ) : null}
      </ImageRefineProvider>
    );
  }

  // ★★ A refine belongs to its page and slot, not to the box: a box that
  //    unmounts on ordinary editing (a collapsed group, another builder
  //    section) neither stops it nor loses it.
  it("★★ unmounting the box alone neither aborts the fetch nor sends a stop, and the box finds it again", async () => {
    const held = heldRefine();
    const { rerender } = render(<Editor />);
    fireEvent.click(screen.getByText(/Refine with Mink AI/));
    expect(await screen.findByRole("status")).toBeTruthy();
    rerender(<Editor show={false} />);
    expect(held.signal?.aborted).toBe(false);
    expect(sendPageExitRequest).not.toHaveBeenCalled();
    rerender(<Editor />);
    expect(screen.getByRole("status").textContent).toMatch(/Refining/);
    await act(async () => {
      held.answer!(new Response(JSON.stringify({ url: refinedUrl })));
    });
    expect(await screen.findByAltText("Refined with Mink AI")).toBeTruthy();
  });

  it("★ a refusal that came while the box was away is shown when it comes back, under Strict Mode too", async () => {
    const held = heldRefine();
    // ★ Strict Mode mounts a box, unmounts it and mounts it again at once:
    //   the message must survive that.
    const App = ({ show }: { show: boolean }) => (
      <StrictMode>
        <Editor show={show} />
      </StrictMode>
    );
    const { rerender } = render(<App show />);
    fireEvent.click(screen.getByText(/Refine with Mink AI/));
    await screen.findByRole("status");
    rerender(<App show={false} />);
    await act(async () => {
      held.answer!(
        new Response(JSON.stringify({ error: "Not enough Mink credits." }), {
          status: 402,
        }),
      );
    });
    rerender(<App show />);
    await act(async () => {});
    expect(screen.getByText("Not enough Mink credits.")).toBeTruthy();
  });

  it("★★ pagehide sends the stop with the SAME token as the refine", async () => {
    const held = heldRefine();
    render(<Editor />);
    fireEvent.click(screen.getByText(/Refine with Mink AI/));
    await screen.findByRole("status");
    expect(held.body?.stopToken).toMatch(UUID_RE);
    fireEvent(
      window,
      Object.assign(new Event("pagehide"), { persisted: false }),
    );
    expect(sendPageExitRequest).toHaveBeenCalledWith(
      "/api/mink/image-refine/stop",
      JSON.stringify({ stopToken: held.body?.stopToken }),
    );
    expect(held.signal?.aborted).toBe(true);
  });

  it("★ a changed defaultImage shows the new photo and moves the box off the refine", async () => {
    heldRefine();
    const other = "https://storage.googleapis.com/b/stores/s/uploads/b.jpg";
    const { rerender } = render(<Editor />);
    fireEvent.click(screen.getByText(/Refine with Mink AI/));
    await screen.findByRole("status");
    rerender(<Editor image={other} />);
    expect((screen.getByAltText("Uploaded") as HTMLImageElement).src).toBe(
      other,
    );
    expect(screen.queryByRole("status")).toBeNull();
    // Moving off is not a stop: the slot may move back (undo).
    expect(sendPageExitRequest).not.toHaveBeenCalled();
    rerender(<Editor image={original} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("★ a slot whose size changes under a running refine stops it, and the box is idle", async () => {
    const held = heldRefine();
    const { rerender } = render(<Editor />);
    fireEvent.click(screen.getByText(/Refine with Mink AI/));
    await screen.findByRole("status");
    rerender(<Editor spec="product_square" />);
    expect(sendPageExitRequest).toHaveBeenCalledWith(
      "/api/mink/image-refine/stop",
      JSON.stringify({ stopToken: held.body?.stopToken }),
    );
    expect(held.signal?.aborted).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/Refine with Mink AI/)).toBeTruthy();
  });

  it("★ the echo of the box's own photo keeps the crop warning measured from the loaded image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ url: refinedUrl }))),
    );
    const onUploadSuccess = vi.fn();
    const { rerender } = render(<Editor onUploadSuccess={onUploadSuccess} />);
    fireEvent.click(screen.getByText(/Refine with Mink AI/));
    fireEvent.click(await screen.findByText("Use refined photo"));
    expect(onUploadSuccess).toHaveBeenCalledWith(refinedUrl);
    const img = screen.getByAltText("Uploaded") as HTMLImageElement;
    expect(img.src).toBe(refinedUrl);
    Object.defineProperty(img, "naturalWidth", { value: 1080 });
    Object.defineProperty(img, "naturalHeight", { value: 1080 });
    fireEvent.load(img);
    expect(screen.getByText(/crop about 25% from the sides/)).toBeTruthy();
    // The caller writes back the URL the box already shows.
    rerender(<Editor image={refinedUrl} onUploadSuccess={onUploadSuccess} />);
    expect(screen.getByText(/crop about 25% from the sides/)).toBeTruthy();
  });

  it("★ the compare view retries a refined photo that is not readable yet; Use writes the clean URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ url: refinedUrl }))),
    );
    const onUploadSuccess = vi.fn();
    render(<Editor onUploadSuccess={onUploadSuccess} />);
    fireEvent.click(screen.getByText(/Refine with Mink AI/));
    const refinedImg = (await screen.findByAltText(
      "Refined with Mink AI",
    )) as HTMLImageElement;
    vi.useFakeTimers();
    try {
      fireEvent.error(refinedImg);
      act(() => vi.advanceTimersByTime(1_999));
      expect(
        (screen.getByAltText("Refined with Mink AI") as HTMLImageElement).src,
      ).toBe(refinedUrl);
      act(() => vi.advanceTimersByTime(1));
      expect(
        (screen.getByAltText("Refined with Mink AI") as HTMLImageElement).src,
      ).toBe(`${refinedUrl}?retry=1`);
    } finally {
      vi.useRealTimers();
    }
    fireEvent.click(screen.getByText("Use refined photo"));
    expect(onUploadSuccess).toHaveBeenCalledWith(refinedUrl);
  });

  it("leaves a refine that already finished alone when the editor goes away", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        if (init?.signal) signals.push(init.signal);
        return new Response(JSON.stringify({ url: refinedUrl }));
      }),
    );
    const { unmount } = render(
      <ImageRefineProvider available>
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={() => {}}
        />
      </ImageRefineProvider>,
    );
    fireEvent.click(screen.getByText(/Refine with Mink AI/));
    expect(await screen.findByAltText("Refined with Mink AI")).toBeTruthy();
    unmount();
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
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

describe("No scenes in the product editor", () => {
  it("offers only the background tool: scenes are made in Mink AI chat", () => {
    render(
      <ImageRefineProvider available background>
        <ImageUpload
          spec="product"
          defaultImage={original}
          onUploadSuccess={() => {}}
        />
      </ImageRefineProvider>,
    );
    expect(screen.queryByText(/Put in a scene/)).toBeNull();
    fireEvent.click(screen.getByText(/Change background/));
    expect(screen.queryByRole("tab", { name: "Scene" })).toBeNull();
    expect(screen.queryByText(/describe your own scene/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Garden/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Remove background/ }),
    ).toBeTruthy();
  });
});
