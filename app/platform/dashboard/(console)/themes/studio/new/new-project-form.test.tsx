// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// New theme on one screen (wave TS-2, builder 2D): "Create and start" chains
// create, the screenshot uploads and the queue; a refused start lands on the
// theme page with the server's reason; screenshots are checked on drop,
// before anything is created; the industry is preselected from the brief.
// ---------------------------------------------------------------------------

const calls = vi.hoisted(() => ({ order: [] as string[] }));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
type ActionResult = { ok: boolean; id?: string; error?: string };
type Action = (input: Record<string, unknown>) => Promise<ActionResult>;
const actions = vi.hoisted(() => ({
  createThemeStudioProjectAction: vi.fn<Action>(async () => {
    calls.order.push("create");
    return { ok: true, id: "p-1" };
  }),
  queueThemeStudioGenerationAction: vi.fn<Action>(async () => {
    calls.order.push("queue");
    return { ok: true, id: "run-1" };
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/actions/theme-studio-actions", () => actions);
vi.mock("../studio-ui", () => ({
  plainText: (text: string) =>
    text
      .replace(/(\d)\s*\u2013\s*(\d)/g, "$1 to $2")
      .replace(/\s*[\u2013\u2014]\s*/g, ", "),
}));

/** A stand-in for XMLHttpRequest: records each upload, reports half the
 * bytes sent at once, and answers when `auto` is on or `finish()` runs. */
const xhr = vi.hoisted(() => ({
  responses: new Map<string, { status: number; body: unknown }>(),
  sent: [] as { method: string; url: string; name: string; type: string }[],
  auto: true,
  waiting: [] as (() => void)[],
  finish() {
    const next = this.waiting.shift();
    next?.();
  },
}));

class FakeXhr {
  method = "";
  url = "";
  headers: Record<string, string> = {};
  status = 0;
  responseText = "";
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(file: File) {
    calls.order.push(`upload:${file.name}`);
    xhr.sent.push({
      method: this.method,
      url: this.url,
      name: file.name,
      type: this.headers["Content-Type"],
    });
    const response = xhr.responses.get(file.name) ?? {
      status: 201,
      body: { id: `r-${xhr.sent.length}` },
    };
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: 50,
      total: 100,
    } as ProgressEvent);
    const done = () => {
      this.status = response.status;
      this.responseText = JSON.stringify(response.body);
      this.onload?.();
    };
    if (xhr.auto) setTimeout(done, 0);
    else xhr.waiting.push(done);
  }
}

import { NewProjectForm } from "./new-project-form";

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const MB = 1024 * 1024;

const props = {
  models: [
    {
      key: "gemini-3.8-flash" as const,
      label: "Gemini 3.8 Flash",
      purpose: "Default for theme analysis and package synthesis",
    },
    {
      key: "gemini-3.1-pro" as const,
      label: "Gemini 3.1 Pro (preview)",
      purpose: "Deeper reasoning",
    },
  ],
  baseThemes: [
    { id: "basket", name: "Basket" },
    { id: "vitrine", name: "Vitrine" },
  ],
  industries: [
    "general",
    "beauty",
    "clothing",
    "food-and-drink",
    "home",
    "pets",
    "shoes",
    "toys",
  ] as const,
  catalogSizes: ["one-product", "small", "medium", "large"] as const,
  features: ["blogs", "faq", "quick-add"] as const,
  briefMax: 12000,
  limits: { files: 10, fileBytes: 10 * MB, totalBytes: 40 * MB },
  buildingOff: false,
};

function renderForm(
  overrides: Partial<Parameters<typeof NewProjectForm>[0]> = {},
) {
  return render(
    <NewProjectForm
      {...props}
      industries={[...props.industries]}
      catalogSizes={[...props.catalogSizes]}
      features={[...props.features]}
      {...overrides}
    />,
  );
}

function png(name: string, size = 1000, type = "image/png") {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function dropZone() {
  return screen
    .getByText(/Drop or paste screenshots of stores you like/)
    .closest("div") as HTMLElement;
}

function drop(...files: File[]) {
  fireEvent.drop(dropZone(), {
    dataTransfer: { files, types: ["Files"] },
  });
}

function fill(name: string, brief: string) {
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText("Brief"), {
    target: { value: brief },
  });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /Create/ }));
}

beforeEach(() => {
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  calls.order = [];
  xhr.responses.clear();
  xhr.sent = [];
  xhr.auto = true;
  xhr.waiting = [];
});

describe("New theme, the form", () => {
  it("is one screen: name and ID, brief, screenshots, industries, More options, one button", () => {
    const view = renderForm();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByText("(change)")).toBeTruthy();
    expect(screen.getByLabelText("Brief")).toBeTruthy();
    expect(
      screen.getByText(
        "Drop or paste screenshots of stores you like (up to 10)",
      ),
    ).toBeTruthy();
    // The legend the plan names, without the en dash it had.
    expect(screen.getByText("Industries (1 to 5)").tagName).toBe("LEGEND");
    expect(screen.getByText("More options")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create and start" }),
    ).toBeTruthy();
    // More options holds catalogue size, features, base theme and model.
    expect(screen.getByText("Catalogue size")).toBeTruthy();
    expect(screen.getByText("Must-have features")).toBeTruthy();
    expect(screen.getByLabelText("Start from a theme")).toBeTruthy();
    expect(screen.getByLabelText("Model")).toBeTruthy();
    const text = view.container.textContent ?? "";
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
    expect(text).not.toMatch(/\b(candidate|approved|blocked)\b/i);
  });

  it("derives the ID from the name, and (change) opens it for editing", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Aurora Skin" },
    });
    expect(screen.getByText("aurora-skin")).toBeTruthy();
    expect(screen.queryByLabelText("Theme ID")).toBeNull();
    fireEvent.click(screen.getByText("(change)"));
    const id = screen.getByLabelText("Theme ID") as HTMLInputElement;
    expect(id.value).toBe("aurora-skin");
    fireEvent.change(id, { target: { value: "aurora" } });
    // A changed ID is kept when the name changes again.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Aurora Two" },
    });
    expect(id.value).toBe("aurora");
  });

  it("offers only the base themes it is given, after None", () => {
    renderForm();
    const select = screen.getByLabelText(
      "Start from a theme",
    ) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "None",
      "Basket",
      "Vitrine",
    ]);
  });
});

describe("the industry is preselected from the brief, and stays editable", () => {
  it("picks Beauty for a skincare brief and says so", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Brief"), {
      target: { value: "A calm skincare shop for sensitive skin." },
    });
    const beauty = screen.getByRole("button", { name: "Beauty" });
    expect(beauty.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Picked from your brief: Beauty\./)).toBeTruthy();
    // The operator's own choice replaces the guess.
    fireEvent.click(screen.getByRole("button", { name: "Pets" }));
    expect(
      screen.getByRole("button", { name: "Pets" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(beauty.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText(/Picked from your brief/)).toBeNull();
    fireEvent.click(beauty);
    expect(beauty.getAttribute("aria-pressed")).toBe("false");
    // Once chosen by hand, a new brief no longer changes it.
    fireEvent.change(screen.getByLabelText("Brief"), {
      target: { value: "Sneakers and boots" },
    });
    expect(
      screen
        .getByRole("button", { name: "Shoes" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("allows 5 at most, and says why the rest are off", () => {
    renderForm();
    for (const name of ["General", "Beauty", "Clothing", "Pets", "Shoes"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    const toys = screen.getByRole("button", { name: "Toys" });
    expect((toys as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        "That is the most a theme takes. Remove one to choose another.",
      ),
    ).toBeTruthy();
  });
});

describe("screenshots are checked on drop, before anything is created", () => {
  it("lists a good screenshot as checked and refuses a bad one with a sentence", () => {
    renderForm();
    drop(
      png("shop-a.png"),
      png("anim.gif", 1000, "image/gif"),
      png("huge.png", 11 * MB),
    );
    const list = screen.getByRole("list", { name: "Screenshots" });
    expect(within(list).getByText("shop-a.png")).toBeTruthy();
    expect(within(list).getByText("Checked")).toBeTruthy();
    expect(within(list).queryByText("anim.gif")).toBeNull();
    expect(
      screen.getByText("anim.gif: use a JPEG, PNG, WebP or AVIF image."),
    ).toBeTruthy();
    expect(screen.getByText("huge.png is larger than 10 MB.")).toBeTruthy();
    expect(actions.createThemeStudioProjectAction).not.toHaveBeenCalled();
    expect(xhr.sent).toEqual([]);
  });

  it("takes pasted images too, and a listed screenshot can be removed", () => {
    renderForm();
    fireEvent.paste(screen.getByLabelText("Brief"), {
      clipboardData: { files: [png("pasted.png")] },
    });
    expect(screen.getByText("pasted.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
    expect(screen.queryByText("pasted.png")).toBeNull();
  });
});

describe("Create and start", () => {
  it("creates, adds each screenshot with its progress, then queues revision 0 with those screenshots", async () => {
    xhr.auto = false;
    renderForm();
    fill("Aurora", "A calm skincare shop for sensitive skin.");
    drop(png("shop-a.png"), png("shop-b.png"));
    submit();

    await waitFor(() =>
      expect(actions.createThemeStudioProjectAction).toHaveBeenCalledTimes(1),
    );
    expect(actions.createThemeStudioProjectAction).toHaveBeenCalledWith({
      name: "Aurora",
      themeId: "aurora",
      brief: "A calm skincare shop for sensitive skin.",
      industries: ["beauty"],
      catalogSizes: ["small"],
      requiredFeatures: [],
      baseThemeId: null,
      modelKey: "gemini-3.8-flash",
    });
    // Each file shows its own progress while it uploads.
    expect(await screen.findByText("Uploading, 50%")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Uploading shop-a.png" }),
    ).toHaveAttribute("aria-valuenow", "50");
    xhr.finish();
    await waitFor(() => expect(xhr.sent).toHaveLength(2));
    xhr.finish();

    await waitFor(() =>
      expect(actions.queueThemeStudioGenerationAction).toHaveBeenCalledTimes(1),
    );
    const queued = actions.queueThemeStudioGenerationAction.mock.calls[0][0];
    expect(queued).toMatchObject({
      projectId: "p-1",
      expectedRevision: 0,
      body: "A calm skincare shop for sensitive skin.",
      referenceAssetIds: ["r-1", "r-2"],
    });
    expect(String(queued.idempotencyKey)).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
    expect(xhr.sent).toEqual([
      {
        method: "POST",
        url: "/api/platform/theme-studio/projects/p-1/references",
        name: "shop-a.png",
        type: "application/octet-stream",
      },
      {
        method: "POST",
        url: "/api/platform/theme-studio/projects/p-1/references",
        name: "shop-b.png",
        type: "application/octet-stream",
      },
    ]);
    expect(calls.order).toEqual([
      "create",
      "upload:shop-a.png",
      "upload:shop-b.png",
      "queue",
    ]);
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/dashboard/themes/studio/p-1"),
    );
    expect(
      window.sessionStorage.getItem("studio:start-refused:p-1"),
    ).toBeNull();
  });

  it("a refused start lands on the theme page with the server's reason kept for it", async () => {
    actions.queueThemeStudioGenerationAction.mockImplementation(async () => {
      calls.order.push("queue");
      return {
        ok: false,
        error: "You already have 2 builds running \u2014 wait for one.",
      };
    });
    renderForm();
    fill("Aurora", "A calm skincare shop.");
    submit();
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/dashboard/themes/studio/p-1"),
    );
    expect(window.sessionStorage.getItem("studio:start-refused:p-1")).toBe(
      "You already have 2 builds running, wait for one.",
    );
    // Created once, never again.
    expect(actions.createThemeStudioProjectAction).toHaveBeenCalledTimes(1);
  });

  it("a screenshot the server refuses stops the start, keeps the rest and says which", async () => {
    xhr.responses.set("anim.png", {
      status: 400,
      body: {
        error: "Animated images aren't accepted. Upload a still screenshot.",
      },
    });
    renderForm();
    fill("Aurora", "A calm skincare shop.");
    drop(png("anim.png"), png("good.png"));
    submit();
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    // Every screenshot was tried, so the good one is kept on the theme.
    expect(xhr.sent.map((s) => s.name)).toEqual(["anim.png", "good.png"]);
    expect(actions.queueThemeStudioGenerationAction).not.toHaveBeenCalled();
    const reason = window.sessionStorage.getItem("studio:start-refused:p-1");
    expect(reason).toContain(
      "A screenshot couldn't be added, so nothing was started.",
    );
    expect(reason).toContain(
      "anim.png: Animated images aren't accepted. Upload a still screenshot.",
    );
  });

  it("with building switched off the button only creates, and says so", async () => {
    renderForm({
      buildingOff: true,
      buildingOffReason: "Building is switched off on this deployment.",
    });
    const button = screen.getByRole("button", {
      name: "Create (building is switched off)",
    });
    expect(
      screen.getByText(
        /Building is switched off on this deployment\. The theme is created/,
      ),
    ).toBeTruthy();
    fill("Aurora", "A calm skincare shop.");
    drop(png("shop-a.png"));
    fireEvent.click(button);
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(calls.order).toEqual(["create", "upload:shop-a.png"]);
    expect(actions.queueThemeStudioGenerationAction).not.toHaveBeenCalled();
    expect(
      window.sessionStorage.getItem("studio:start-refused:p-1"),
    ).toBeNull();
  });

  it("a refused create stays on the form with the reason and opens the ID", async () => {
    actions.createThemeStudioProjectAction.mockImplementation(async () => ({
      ok: false,
      error: "That id already has a theme release.",
    }));
    renderForm();
    fill("Aurora", "A calm skincare shop.");
    drop(png("shop-a.png"));
    submit();
    expect(
      await screen.findByText("That id already has a theme release."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Theme ID")).toBeTruthy();
    expect(xhr.sent).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
    // The button is back for another try.
    expect(
      (
        screen.getByRole("button", {
          name: "Create and start",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("says what is missing under each field, and creates nothing", async () => {
    renderForm();
    submit();
    expect(await screen.findByText("Give the theme a name.")).toBeTruthy();
    expect(
      screen.getByText("Describe the store this theme is for."),
    ).toBeTruthy();
    expect(screen.getByText("Choose at least one industry.")).toBeTruthy();
    expect(
      screen.getByText(
        "The ID must be 3 to 80 lowercase letters or numbers, joined by single hyphens.",
      ),
    ).toBeTruthy();
    expect(actions.createThemeStudioProjectAction).not.toHaveBeenCalled();
  });
});

describe("a new theme from another theme's brief", () => {
  it("starts from the values the page read, the operator's industries included", () => {
    renderForm({
      initial: {
        name: "Aurora 2",
        brief: "A calm skincare shop.",
        industries: ["wellness" as never, "beauty"],
        catalogSizes: ["medium"],
        requiredFeatures: ["faq"],
        baseThemeId: "vitrine",
        modelKey: "gemini-3.1-pro",
      },
    });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Aurora 2",
    );
    expect(screen.getByText("aurora-2")).toBeTruthy();
    expect((screen.getByLabelText("Brief") as HTMLTextAreaElement).value).toBe(
      "A calm skincare shop.",
    );
    expect(
      screen
        .getByRole("button", { name: "Beauty" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByText(/Picked from your brief/)).toBeNull();
    expect(
      (screen.getByLabelText("Start from a theme") as HTMLSelectElement).value,
    ).toBe("vitrine");
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe(
      "gemini-3.1-pro",
    );
    expect(
      screen
        .getByRole("button", { name: "Medium" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
