// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ThemeStudioProjectDetail,
  ThemeStudioRunView,
  ThemeStudioVersionView,
} from "@/lib/theme-studio/repository";

const actions = vi.hoisted(() => ({
  queueThemeStudioGenerationAction: vi.fn(async () => ({ ok: true })),
  reviseThemeStudioVersionAction: vi.fn(async () => ({
    ok: true,
    error: undefined as string | undefined,
  })),
  submitThemeStudioDetailsAction: vi.fn(async () => ({ ok: true })),
  removeThemeStudioReferenceAction: vi.fn(async () => ({ ok: true })),
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/theme-studio-actions", () => actions);
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
import { ThemeConversation, type ComposerApi } from "./conversation";

const version: ThemeStudioVersionView = {
  id: "v1",
  versionNumber: 1,
  parentVersionId: null,
  runId: "r1",
  origin: "run",
  editedSlots: [],
  intentDigest: "i",
  packageDigest: "digest-v1",
  summary: "A warm grocery theme.",
  assumptions: [],
  hasPackage: true,
  qaStatus: "passed",
  qaIteration: 0,
  packageSummary: null,
  createdAt: "2026-09-29T10:01:00Z",
};
const project: ThemeStudioProjectDetail = {
  id: "project",
  themeId: "crave",
  name: "Crave",
  status: "ready",
  modelKey: "gemini-3.8-flash",
  industries: ["food-and-drink"],
  catalogSizes: ["small"],
  requiredFeatures: [],
  baseThemeId: null,
  draftBrief: "Build a warm grocery theme.",
  currentVersionId: version.id,
  revision: 3,
  createdByEmail: "op@test.dev",
  createdAt: "2026-09-29T10:00:00Z",
  updatedAt: "2026-09-29T10:01:00Z",
  references: Array.from({ length: 10 }, (_, i) => ({
    id: `old-${i}`,
    width: 100,
    height: 100,
    byteSize: 100,
    originalByteSize: 100,
    originalMediaType: "image/png",
    createdAt: "2026-09-29T10:00:00Z",
    cited: true,
  })),
  messages: [
    {
      id: "m1",
      kind: "brief",
      body: "Build a grocery theme",
      referenceCount: 10,
      referenceAssetIds: ["old-0"],
      automatic: false,
      createdAt: "2026-09-29T10:00:00Z",
    },
  ],
  runs: [],
  versions: [version],
  previews: [],
  events: [],
};
const props = {
  project,
  generationEnabled: true,
  referenceLimit: 10,
  target: version,
  canRevise: true,
  onSelectVersion: vi.fn(),
  now: "2026-09-29T10:30:00Z",
  working: false,
};
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const message = () =>
  screen.getByRole("textbox", { name: "Message Theme Studio" });
const send = (name = "Send message") => screen.getByRole("button", { name });
const openScreenshots = () =>
  fireEvent.click(screen.getByRole("button", { name: /^Screenshots/ }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the theme page's chat", () => {
  it("takes a drafted fix as editable text and sends only after the operator presses Send", async () => {
    render(
      <ThemeConversation
        {...props}
        initialBody="Fix contrast in Design 1: .shop-card-base"
      />,
    );
    expect((message() as HTMLTextAreaElement).value).toContain(
      ".shop-card-base",
    );
    expect(actions.reviseThemeStudioVersionAction).not.toHaveBeenCalled();
    fireEvent.change(message(), {
      target: { value: "Fix contrast; preserve the golden header." },
    });
    openScreenshots();
    fireEvent.click(screen.getByLabelText("Attach screenshot 1"));
    fireEvent.click(send());
    await waitFor(() =>
      expect(actions.reviseThemeStudioVersionAction).toHaveBeenCalledWith(
        expect.objectContaining({
          versionId: "v1",
          expectedPackageDigest: "digest-v1",
          body: "Fix contrast; preserve the golden header.",
          referenceAssetIds: ["old-0"],
        }),
      ),
    );
  });

  it("attaches a new screenshot after ten earlier ones and sends only the selected image", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: "new-image" }),
    }));
    vi.stubGlobal("fetch", fetcher);
    render(<ThemeConversation {...props} />);
    fireEvent.change(screen.getByLabelText("Upload screenshots"), {
      target: {
        files: [
          new File(["image"], "broken-header.png", { type: "image/png" }),
        ],
      },
    });
    await screen.findByAltText("Screenshot 1 to send");
    fireEvent.change(message(), {
      target: { value: "Fix the header as shown in my screenshot" },
    });
    fireEvent.click(send());
    await waitFor(() =>
      expect(actions.reviseThemeStudioVersionAction).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project",
          versionId: "v1",
          expectedRevision: 3,
          expectedPackageDigest: "digest-v1",
          body: "Fix the header as shown in my screenshot",
          referenceAssetIds: ["new-image"],
        }),
      ),
    );
    expect(actions.queueThemeStudioGenerationAction).not.toHaveBeenCalled();
    expect((send() as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(["paste", "drop"])("accepts screenshots via %s", async (method) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ id: "pasted" }) })),
    );
    render(<ThemeConversation {...props} />);
    const files = [new File(["image"], "screen.png", { type: "image/png" })];
    if (method === "paste")
      fireEvent.paste(message(), { clipboardData: { files } });
    else fireEvent.drop(message(), { dataTransfer: { files } });
    await screen.findByAltText("Screenshot 1 to send");
  });

  it("keeps the message and attachments when sending fails and reuses its idempotency key", async () => {
    actions.reviseThemeStudioVersionAction.mockResolvedValueOnce({
      ok: false,
      error: "Try again",
    });
    render(<ThemeConversation {...props} />);
    openScreenshots();
    fireEvent.click(screen.getByLabelText("Attach screenshot 1"));
    fireEvent.change(message(), { target: { value: "Fix spacing" } });
    fireEvent.click(send());
    // Wait for the failure to be handled and the composer to re-enable, or
    // the retry lands on a disabled button and is dropped.
    await waitFor(() =>
      expect((send() as HTMLButtonElement).disabled).toBe(false),
    );
    expect(actions.reviseThemeStudioVersionAction).toHaveBeenCalledTimes(1);
    expect((message() as HTMLTextAreaElement).value).toBe("Fix spacing");
    expect(screen.getByAltText("Screenshot 1 to send")).toBeTruthy();
    fireEvent.click(send());
    await waitFor(() =>
      expect(actions.reviseThemeStudioVersionAction).toHaveBeenCalledTimes(2),
    );
    expect(actions.reviseThemeStudioVersionAction.mock.calls[0]).toEqual(
      actions.reviseThemeStudioVersionAction.mock.calls[1],
    );
  });

  it("makes its key on the first send, without crypto.randomUUID, and a new one per message", async () => {
    // http on a LAN address (a phone reaching the dev server) is not a
    // secure context: randomUUID is missing there, and rendering must not
    // need it.
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: real.getRandomValues.bind(real),
    });
    const view = render(<ThemeConversation {...props} />);
    fireEvent.change(message(), { target: { value: "Fix spacing" } });
    fireEvent.click(send());
    await waitFor(() =>
      expect(actions.reviseThemeStudioVersionAction).toHaveBeenCalledTimes(1),
    );
    const first = (
      actions.reviseThemeStudioVersionAction.mock.calls[0] as unknown[]
    )[0] as { idempotencyKey: string };
    expect(first.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
    await waitFor(() =>
      expect((message() as HTMLTextAreaElement).value).toBe(""),
    );
    // The page refreshes with the theme's new revision.
    view.rerender(
      <ThemeConversation {...props} project={{ ...project, revision: 4 }} />,
    );
    fireEvent.change(message(), { target: { value: "Now the footer" } });
    await waitFor(() =>
      expect((send() as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(send());
    await waitFor(() =>
      expect(actions.reviseThemeStudioVersionAction).toHaveBeenCalledTimes(2),
    );
    const second = (
      actions.reviseThemeStudioVersionAction.mock.calls[1] as unknown[]
    )[0] as { idempotencyKey: string };
    expect(second.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("keeps its hidden upload field out of the Tab order: Upload screenshots opens it", () => {
    const { container } = render(<ThemeConversation {...props} />);
    const field =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(field?.tabIndex).toBe(-1);
  });

  it("starts building from the edited brief with Start building", async () => {
    render(
      <ThemeConversation
        {...props}
        canRevise={false}
        target={null}
        project={{ ...project, status: "draft", messages: [], versions: [] }}
      />,
    );
    fireEvent.change(message(), { target: { value: "Build a bakery theme" } });
    fireEvent.click(send("Start building"));
    await waitFor(() =>
      expect(actions.queueThemeStudioGenerationAction).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "Build a bakery theme",
          referenceAssetIds: [],
          expectedRevision: 3,
        }),
      ),
    );
  });

  it("answers the AI's questions with the selected screenshots instead of starting a change", async () => {
    const run = {
      id: "r1",
      questions: ["Which header is the reference?"],
      status: "succeeded",
      createdAt: "2026-09-29T10:02:00Z",
      finishedAt: "2026-09-29T10:03:00Z",
    } as ThemeStudioRunView;
    render(
      <ThemeConversation
        {...props}
        canRevise={false}
        project={{ ...project, status: "blocked", runs: [run] }}
      />,
    );
    expect(screen.getByText("Which header is the reference?")).toBeTruthy();
    fireEvent.change(message(), { target: { value: "Use this header" } });
    fireEvent.click(send("Send answer"));
    await waitFor(() =>
      expect(actions.submitThemeStudioDetailsAction).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "Use this header",
          referenceAssetIds: ["old-0"],
        }),
      ),
    );
    expect(actions.reviseThemeStudioVersionAction).not.toHaveBeenCalled();
  });

  it("tells the operator how much of the theme each change touched", () => {
    const run = (
      id: string,
      change: NonNullable<ThemeStudioRunView["change"]>,
    ) =>
      ({
        id,
        kind: "revise",
        questions: [],
        declineReason: null,
        change,
        status: "succeeded",
        createdAt: "2026-09-29T10:02:00Z",
        finishedAt: "2026-09-29T10:03:00Z",
      }) as unknown as ThemeStudioRunView;
    render(
      <ThemeConversation
        {...props}
        project={{
          ...project,
          runs: [
            run("edit", {
              scope: "edit",
              summary: "Changed the hero heading to Spring Sale.",
              changed: 1,
              redraws: 1,
              fellBack: false,
              redrawsDeferred: true,
            }),
            run("recreate", {
              scope: "recreate",
              summary: "Starting a new design.",
              changed: 0,
              redraws: 0,
              fellBack: false,
              redrawsDeferred: false,
            }),
          ],
        }}
      />,
    );
    expect(
      screen.getByText("Small edit - only what you asked for changes"),
    ).toBeTruthy();
    expect(screen.getByText(/1 setting changed; everything else/)).toBeTruthy();
    expect(screen.getByText(/from the Pictures tab to finish/)).toBeTruthy();
    expect(screen.getByText(/earlier designs stay available/)).toBeTruthy();
  });

  it("removes an attachment from the next message without deleting the screenshot", () => {
    render(<ThemeConversation {...props} />);
    openScreenshots();
    fireEvent.click(screen.getByLabelText("Attach screenshot 1"));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove screenshot 1 from message" }),
    );
    expect(screen.queryByLabelText("Message attachments")).toBeNull();
    expect(screen.getByAltText("Attached screenshot 1")).toBeTruthy();
    expect(actions.removeThemeStudioReferenceAction).not.toHaveBeenCalled();
  });

  it("lists earlier screenshots and deletes only one no message used", async () => {
    render(
      <ThemeConversation
        {...props}
        project={{
          ...project,
          references: [
            { ...project.references[0], id: "used", cited: true },
            { ...project.references[0], id: "spare", cited: false },
          ],
        }}
      />,
    );
    openScreenshots();
    expect(screen.getByText("Earlier screenshots (2)")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Delete screenshot 1" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete screenshot 2" }),
    );
    await waitFor(() =>
      expect(actions.removeThemeStudioReferenceAction).toHaveBeenCalledWith({
        projectId: "project",
        assetId: "spare",
      }),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("locks the composer while Theme Studio works, says why, and hides automatic repair prompts", () => {
    render(
      <ThemeConversation
        {...props}
        canRevise={false}
        working
        lockedReason="You can send changes when it finishes."
        progressCard={<section aria-label="Progress card">steps</section>}
        project={{
          ...project,
          status: "generating",
          messages: [
            ...project.messages,
            {
              ...project.messages[0],
              id: "internal",
              body: "internal repair prompt",
              automatic: true,
            },
          ],
        }}
      />,
    );
    expect((message() as HTMLTextAreaElement).disabled).toBe(true);
    expect(message().getAttribute("placeholder")).toBe(
      "You can send changes when it finishes.",
    );
    expect(
      screen.getByText("You can send changes when it finishes.", {
        selector: "p",
      }),
    ).toBeTruthy();
    openScreenshots();
    expect(
      (
        screen.getByRole("button", {
          name: /Upload screenshots/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByText("internal repair prompt")).toBeNull();
    // The progress card sits at the end of the chat.
    expect(screen.getByRole("region", { name: "Progress card" })).toBeTruthy();
    // Marked locked, so a phone folds it to its one-line reason.
    expect(
      screen
        .getByRole("form", { name: "Message Theme Studio" })
        .getAttribute("data-locked"),
    ).toBe("true");
  });

  it("is never marked locked while it takes a message", () => {
    render(<ThemeConversation {...props} />);
    expect(
      screen
        .getByRole("form", { name: "Message Theme Studio" })
        .hasAttribute("data-locked"),
    ).toBe(false);
  });

  it("says building is switched off when it is", () => {
    render(<ThemeConversation {...props} generationEnabled={false} />);
    expect(
      screen.getByText(
        "Building is switched off on this deployment, so messages can't be sent now.",
      ),
    ).toBeTruthy();
  });

  it("takes a change, not an answer, when the theme is blocked with no questions open", async () => {
    render(
      <ThemeConversation
        {...props}
        project={{ ...project, status: "blocked", runs: [] }}
      />,
    );
    expect(message().getAttribute("placeholder")).toMatch(/Describe a change/);
    fireEvent.change(message(), { target: { value: "Remove the script" } });
    fireEvent.click(send());
    await waitFor(() =>
      expect(actions.reviseThemeStudioVersionAction).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Remove the script", versionId: "v1" }),
      ),
    );
    expect(actions.submitThemeStudioDetailsAction).not.toHaveBeenCalled();
  });

  it("treats questions a Make current set aside as closed", () => {
    const run = {
      id: "r1",
      questions: ["Which header is the reference?"],
      status: "succeeded",
      createdAt: "2026-09-29T10:02:00Z",
      finishedAt: "2026-09-29T10:03:00Z",
    } as ThemeStudioRunView;
    render(
      <ThemeConversation
        {...props}
        project={{
          ...project,
          status: "blocked",
          runs: [run],
          events: [
            {
              id: "e2",
              eventType: "version_restored",
              actorKind: "operator",
              actorEmail: "op@test.dev",
              runId: null,
              detail: {},
              createdAt: "2026-09-29T10:04:00Z",
            },
          ],
        }}
      />,
    );
    expect(message().getAttribute("placeholder")).toMatch(/Describe a change/);
  });

  it("says why a request stopped in a sentence, never a bare code", () => {
    const run = {
      id: "r9",
      kind: "images",
      questions: [],
      declineReason: null,
      status: "failed",
      errorCode: "images_none",
      createdAt: "2026-09-29T10:02:00Z",
      finishedAt: "2026-09-29T10:03:00Z",
    } as unknown as ThemeStudioRunView;
    render(
      <ThemeConversation {...props} project={{ ...project, runs: [run] }} />,
    );
    expect(
      screen.getByText(/^No picture came back, so no version was made\./),
    ).toBeTruthy();
    expect(screen.queryByText(/images_none/)).toBeNull();
  });

  it("never points a first build stopped before its first design at earlier designs", () => {
    const stopped = (status: "failed" | "cancelled") =>
      ({
        id: `r-${status}`,
        kind: "generate",
        questions: [],
        declineReason: null,
        status,
        errorCode: status === "failed" ? "provider_timeout" : "cancelled",
        createdAt: "2026-09-29T10:02:00Z",
        finishedAt: "2026-09-29T10:03:00Z",
      }) as unknown as ThemeStudioRunView;
    const view = render(
      <ThemeConversation
        {...props}
        project={{
          ...project,
          status: "failed",
          currentVersionId: null,
          versions: [],
          runs: [stopped("cancelled"), stopped("failed")],
        }}
      />,
    );
    expect(
      screen.getByText("This request was stopped before a design was made."),
    ).toBeTruthy();
    expect(
      screen.getByText("The model provider took too long to answer."),
    ).toBeTruthy();
    expect(screen.queryByText(/earlier designs/)).toBeNull();
    expect(screen.queryByText(/Runs below/)).toBeNull();
    view.rerender(
      <ThemeConversation
        {...props}
        project={{ ...project, runs: [stopped("cancelled")] }}
      />,
    );
    expect(
      screen.getByText(
        "This request was stopped. Your earlier designs are still available.",
      ),
    ).toBeTruthy();
  });

  it("names designs by number and opens them in the Preview and Checks tabs", () => {
    const onViewDesign = vi.fn();
    const onOpenChecks = vi.fn();
    render(
      <ThemeConversation
        {...props}
        onViewDesign={onViewDesign}
        onOpenChecks={onOpenChecks}
        project={{
          ...project,
          events: [
            {
              id: "e3",
              eventType: "auto_qa_failed",
              actorKind: "worker",
              actorEmail: null,
              runId: null,
              detail: {
                qaRunId: "q",
                versionId: "v1",
                errorCode: "quality_bar_not_met",
              },
              createdAt: "2026-09-29T10:06:00Z",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Theme Studio, Design 1")).toBeTruthy();
    expect(
      screen.getByText(
        /stopped on Design 1\. Read why in Checks, then describe/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview Design 1" }));
    expect(onViewDesign).toHaveBeenCalledWith("v1");
    fireEvent.click(screen.getByRole("button", { name: "Open Checks" }));
    expect(onOpenChecks).toHaveBeenCalledWith("v1");
  });

  it("never asks for a fix when the checks only could not finish", () => {
    render(
      <ThemeConversation
        {...props}
        project={{
          ...project,
          events: [
            {
              id: "e3",
              eventType: "auto_qa_failed",
              actorKind: "worker",
              actorEmail: null,
              runId: null,
              detail: {
                qaRunId: "q",
                versionId: "v1",
                errorCode: "checks_incomplete",
              },
              createdAt: "2026-09-29T10:06:00Z",
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByText(/the theme itself does not need a change/),
    ).toBeTruthy();
    expect(screen.queryByText(/describe what to fix/)).toBeNull();
  });

  it("is filled by the page without sending, below what is already there", () => {
    const apiRef = createRef<ComposerApi>();
    render(<ThemeConversation {...props} apiRef={apiRef} />);
    fireEvent.change(message(), { target: { value: "Keep the logo." } });
    act(() => apiRef.current!.fill("Fix the contrast of the struck price."));
    expect((message() as HTMLTextAreaElement).value).toBe(
      "Keep the logo.\n\nFix the contrast of the struck price.",
    );
    // The same draft twice is not added twice.
    act(() => apiRef.current!.fill("Fix the contrast of the struck price."));
    expect((message() as HTMLTextAreaElement).value).toBe(
      "Keep the logo.\n\nFix the contrast of the struck price.",
    );
    expect(document.activeElement).toBe(message());
    expect(actions.reviseThemeStudioVersionAction).not.toHaveBeenCalled();
  });

  it("sends the saved brief when the page starts building on an empty message", async () => {
    const apiRef = createRef<ComposerApi>();
    render(
      <ThemeConversation
        {...props}
        apiRef={apiRef}
        canRevise={false}
        target={null}
        project={{ ...project, status: "draft", messages: [], versions: [] }}
      />,
    );
    fireEvent.change(message(), { target: { value: "" } });
    act(() => apiRef.current!.send("Build a warm grocery theme."));
    await waitFor(() =>
      expect(actions.queueThemeStudioGenerationAction).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Build a warm grocery theme." }),
      ),
    );
  });

  it("tells the page while the composer has focus", () => {
    const onComposerActive = vi.fn();
    render(
      <ThemeConversation {...props} onComposerActive={onComposerActive} />,
    );
    fireEvent.focus(message());
    expect(onComposerActive).toHaveBeenLastCalledWith(true);
    fireEvent.blur(message(), { relatedTarget: document.body });
    expect(onComposerActive).toHaveBeenLastCalledWith(false);
  });

  it("keeps long dashes out of the model's words", () => {
    render(
      <ThemeConversation
        {...props}
        project={{
          ...project,
          versions: [{ ...version, summary: `Warm ${EM} and calm ${EN} kind` }],
        }}
      />,
    );
    expect(screen.getByText("Warm, and calm, kind")).toBeTruthy();
  });
});
