// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RevampArtifact,
  RevampReview,
  RevampStatus,
  RevampStatusView,
} from "@/lib/mink/revamp/contract";
import type { RevampUndoResult } from "@/lib/mink/revamp/lifecycle-types";
const chat = vi.hoisted(() => ({
  send: vi.fn(),
  isReplying: false,
}));
vi.mock("./chat-context", () => ({
  useChat: () => ({ send: chat.send, isReplying: chat.isReplying }),
}));

import { MinkRevampCard, REVAMP_POLL_MS } from "./mink-revamp-card";

const REVAMP = "11111111-2222-4333-8444-555555555555";
const DRAFT = "66666666-7777-4888-9999-000000000000";

function artifact(status: RevampStatus = "running"): RevampArtifact {
  return { type: "storefront_revamp", revampId: REVAMP, kind: "full", status };
}

const review: RevampReview = {
  summary: "A warm, handmade look for your candle shop.",
  pages: [
    {
      slug: "",
      title: "Home",
      create: false,
      sections: [],
      changes: { added: 2, removed: 1, kept: 3, photos: 4 },
    },
    {
      slug: "our-story",
      title: "Our story",
      create: true,
      sections: [],
      changes: { added: 3, removed: 0, kept: 0, photos: 1 },
    },
  ],
  chrome: null,
  photos: [
    {
      url: "https://storage.googleapis.com/media/stores/x/shelf.webp",
      path: "stores/x/shelf.webp",
      alt: "Candles on a shelf",
      where: "Home, opening photo",
    },
  ],
  products: [
    {
      key: "amber-pillar",
      name: "Amber pillar candle",
      imageUrl: null,
      price: 499,
      mrp: 599,
      categorySlug: null,
      sizes: ["Small", "Large"],
    },
  ],
  // The worded action review.ts sends, never the stored "create".
  categories: [
    { action: "New category", name: "Pillar candles", imageUrl: null },
  ],
  hiddenSampleProducts: 2,
  liveChanges: ["Your categories", "Your product goes on your shop"],
  checks: [
    { id: "phone", label: "Phone layout", passed: true, note: null },
    { id: "desktop", label: "Desktop layout", passed: true, note: null },
    {
      id: "contrast",
      label: "Text contrast",
      passed: true,
      note: "Darkened one heading.",
    },
  ],
  skipped: [{ label: "Blog page", reason: "There is no blog yet." }],
  notes: ["Your prices stay as you set them."],
};

function view(overrides: Partial<RevampStatusView> = {}): RevampStatusView {
  return {
    id: REVAMP,
    kind: "full",
    status: "running",
    progress: [
      { step: "snapshot", state: "done", detail: null },
      { step: "plan", state: "done", detail: null },
      { step: "compile", state: "running", detail: "2 of 5" },
      { step: "photos", state: "waiting", detail: null },
      { step: "products", state: "skipped", detail: null },
      { step: "assemble", state: "waiting", detail: null },
      { step: "checks", state: "waiting", detail: null },
      { step: "card", state: "waiting", detail: null },
    ],
    draftId: null,
    error: null,
    appliedAt: null,
    publishedAt: null,
    undoneAt: null,
    review: null,
    supersededBy: null,
    createdAt: "2026-10-21T10:00:00.000Z",
    finishedAt: null,
    cancelRequested: false,
    undo: null,
    ...overrides,
  };
}

function reply(status: number, payload: unknown) {
  return { ok: status < 400, status, json: async () => payload };
}

/** A fake status route and apply route that remember what was asked. */
function stubServer(
  initial: RevampStatusView,
  options: {
    executeStatus?: number;
    readStatus?: number;
    /** Publish answers like publish.ts when every target was skipped. */
    publishNothing?: Array<{ label: string; reason: string }>;
    /** Undo's answer, also kept on the status view as publish.ts stores it. */
    undoAnswer?: RevampUndoResult;
    /**
     * Stop arrives while the runner holds its lease: jobs.ts only records the
     * request, and the job keeps running until the runner sees it.
     */
    cancelLater?: boolean;
  } = {},
) {
  const server = {
    current: initial,
    posts: [] as Array<{ url: string; body: Record<string, unknown> }>,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      if (body) server.posts.push({ url, body });
      if (url.endsWith("/personalization-action")) {
        if (body?.action === "preview") {
          return reply(200, { approval: { id: "approval-1" } });
        }
        if (options.executeStatus && options.executeStatus !== 200) {
          return reply(options.executeStatus, { error: "Mink AI is busy." });
        }
        server.current = {
          ...server.current,
          appliedAt: "2026-10-21T11:00:00.000Z",
        };
        return reply(200, { result: { repeated: false } });
      }
      if (body?.action === "cancel" && options.cancelLater) {
        server.current = { ...server.current, cancelRequested: true };
        return reply(200, { revamp: server.current });
      }
      if (body?.action === "cancel") {
        server.current = { ...server.current, status: "cancelled" };
        return reply(200, { revamp: server.current });
      }
      if (body?.action === "publish" && options.publishNothing) {
        // ★ Nothing went live, so nothing is recorded: publishedAt stays null.
        return reply(200, {
          result: { published: [], skipped: options.publishNothing },
        });
      }
      if (body?.action === "publish") {
        server.current = {
          ...server.current,
          publishedAt: "2026-10-21T12:00:00.000Z",
        };
        return reply(200, {
          result: { published: ["Home", "Header and footer"], skipped: [] },
        });
      }
      if (body?.action === "undo") {
        const answer = options.undoAnswer ?? { restored: ["Home"], kept: [] };
        server.current = {
          ...server.current,
          undoneAt: "2026-10-21T13:00:00.000Z",
          undo: answer,
        };
        return reply(200, { result: answer });
      }
      if (options.readStatus)
        return reply(options.readStatus, { error: "No." });
      return reply(200, { revamp: server.current });
    }),
  );
  return server;
}

function reads(): number {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method)
    .length;
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the storefront revamp card", () => {
  it("shows each step with its state and count, asks every few seconds while it builds, and stops once it is ready", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const server = stubServer(view());
    render(<MinkRevampCard artifact={artifact()} />);
    await flush();
    expect(screen.getByText("Writing every page")).toBeInTheDocument();
    expect(screen.getByText("2 of 5")).toBeInTheDocument();
    expect(screen.getByText(/Reading your store/)).toHaveTextContent("Done");
    expect(screen.getByText(/Photographing your products/)).toHaveTextContent(
      "Skipped",
    );
    expect(reads()).toBe(1);

    await flush(REVAMP_POLL_MS);
    expect(reads()).toBe(2);

    server.current = view({ status: "ready", draftId: DRAFT, review });
    await flush(REVAMP_POLL_MS);
    expect(reads()).toBe(3);
    expect(screen.getByText(review.summary)).toBeInTheDocument();

    await flush(REVAMP_POLL_MS * 5);
    expect(reads()).toBe(3);
  });

  it("pauses while the tab is hidden and asks again when it comes back", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    stubServer(view());
    render(<MinkRevampCard artifact={artifact()} />);
    await flush();
    expect(reads()).toBe(1);

    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush(REVAMP_POLL_MS * 4);
    expect(reads()).toBe(1);

    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush(REVAMP_POLL_MS);
    expect(reads()).toBeGreaterThan(1);
  });

  it("stops a job that is still building", async () => {
    const server = stubServer(view());
    render(<MinkRevampCard artifact={artifact()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(
      await screen.findByText(/You stopped this redesign/),
    ).toBeInTheDocument();
    expect(server.posts).toEqual([
      { url: `/api/mink/revamps/${REVAMP}`, body: { action: "cancel" } },
    ]);
  });

  it("★★ a Stop the runner has not seen yet says it was taken, and the button stays down", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const server = stubServer(view(), { cancelLater: true });
    render(<MinkRevampCard artifact={artifact()} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await flush();
    const button = screen.getByRole("button", { name: "Stopping…" });
    expect(button).toBeDisabled();
    expect(screen.getByText(/^Stopping the redesign/)).toBeInTheDocument();
    // The header says so too, not "Working on it".
    expect(screen.getByText("Stopping", { selector: "p" })).toBeInTheDocument();
    // The next poll still finds the job running with the stop recorded.
    await flush(REVAMP_POLL_MS);
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(server.posts.map((post) => post.body.action)).toEqual(["cancel"]);
  });

  it("shows only the reason when the job failed", async () => {
    stubServer(
      view({
        status: "failed",
        error:
          "We couldn't finish your redesign. Nothing on your store changed.",
      }),
    );
    render(<MinkRevampCard artifact={artifact("failed")} />);
    expect(
      await screen.findByText(/couldn't finish your redesign/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Writing every page")).toBeNull();
  });

  it("★★ says what changes on the shop at once before the Apply button, and never what it cost", async () => {
    stubServer(view({ status: "ready", draftId: DRAFT, review }));
    const { container } = render(
      <MinkRevampCard artifact={artifact("ready")} />,
    );
    const live = await screen.findByText(
      "These change on your shop as soon as you apply:",
    );
    const apply = screen.getByRole("button", {
      name: "Apply to Website Builder draft",
    });
    expect(
      live.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Your categories")).toBeInTheDocument();
    expect(screen.getByText("New page")).toBeInTheDocument();
    expect(
      screen.getByText(
        "2 sections added, 1 section removed, 3 sections kept, 4 new photos",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Small, Large")).toBeInTheDocument();
    expect(container.textContent).toContain("₹499");
    expect(container.textContent).toContain("₹599");
    expect(
      screen.getByText("New category: Pillar candles"),
    ).toBeInTheDocument();
    expect(screen.getByText("3 checks passed")).toBeInTheDocument();
    expect(screen.getByText("Darkened one heading.")).toBeInTheDocument();
    expect(screen.getByText(/Not done this time \(1\)/)).toBeInTheDocument();
    expect(
      screen.getByText("Your prices stay as you set them."),
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/credit/i);
  });

  it("★ words each category change the way the review sends it, never as a generic change", async () => {
    stubServer(
      view({
        status: "ready",
        draftId: DRAFT,
        review: {
          ...review,
          categories: [
            { action: "Hidden from your shop", name: "Dairy", imageUrl: null },
            { action: "Renamed from Fruit", name: "Seeds", imageUrl: null },
          ],
        },
      }),
    );
    render(<MinkRevampCard artifact={artifact("ready")} />);
    expect(
      await screen.findByText("Hidden from your shop: Dairy"),
    ).toBeInTheDocument();
    expect(screen.getByText("Renamed from Fruit: Seeds")).toBeInTheDocument();
    expect(screen.queryByText(/Changed:/)).toBeNull();
  });

  it("★ shows every size at the price it goes live at, struck MRP included", async () => {
    stubServer(
      view({
        status: "ready",
        draftId: DRAFT,
        review: {
          ...review,
          products: [
            {
              key: "p1",
              name: "Mango pickle",
              imageUrl: null,
              price: 199,
              mrp: null,
              categorySlug: null,
              sizes: ["250 g", "1 kg"],
              sizePrices: [
                { label: "250 g", price: 199, mrp: null },
                { label: "1 kg", price: 6990, mrp: 7990 },
              ],
            },
          ],
        },
      }),
    );
    render(<MinkRevampCard artifact={artifact("ready")} />);
    const sizes = await screen.findByRole("list", {
      name: "Mango pickle sizes and prices",
    });
    const rows = Array.from(sizes.querySelectorAll("li")).map(
      (row) => row.textContent,
    );
    expect(rows).toEqual(["250 g ₹199", "1 kg ₹6,990 was ₹7,990"]);
  });

  it("applies with a preview then the execute, then publishes, then undoes behind a confirm", async () => {
    const server = stubServer(
      view({ status: "ready", draftId: DRAFT, review }),
    );
    render(<MinkRevampCard artifact={artifact("ready")} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Apply to Website Builder draft",
      }),
    );
    const publish = await screen.findByRole("button", {
      name: "Publish to your store",
    });
    expect(server.posts.map((post) => post.body.action)).toEqual([
      "preview",
      "execute",
    ]);
    expect(server.posts[0].url).toBe(
      `/api/mink/drafts/${DRAFT}/personalization-action`,
    );
    expect(server.posts[0].body).toMatchObject({
      expectedDraftVersion: 0,
      idempotencyKey: expect.any(String),
    });
    expect(server.posts[1].body).toEqual({
      action: "execute",
      approvalId: "approval-1",
    });

    fireEvent.click(publish);
    expect(
      await screen.findByText("Your redesign is live on your store."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Published: Home, Header and footer"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      screen.getByText(/Undo puts your store back the way it was/),
    ).toBeInTheDocument();
    expect(server.posts.some((post) => post.body.action === "undo")).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo the redesign" }));
    expect(
      await screen.findByText("You undid this redesign."),
    ).toBeInTheDocument();
    expect(server.posts.map((post) => post.body.action)).toEqual([
      "preview",
      "execute",
      "publish",
      "undo",
    ]);
  });

  it("★★ a Publish that put nothing live keeps the Publish button and says why, never that the redesign is live", async () => {
    stubServer(
      view({
        status: "ready",
        draftId: DRAFT,
        review,
        appliedAt: "2026-10-21T11:00:00.000Z",
      }),
      {
        publishNothing: [
          { label: "Home", reason: "A section on this page is not finished." },
        ],
      },
    );
    const { container } = render(
      <MinkRevampCard artifact={artifact("ready")} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Publish to your store" }),
    );
    expect(
      await screen.findByText(/Nothing went live yet/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Home: A section on this page is not finished."),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain(
      "Your redesign is live on your store.",
    );
    expect(container.textContent).not.toContain("Live on your store");
    // The header still says where the redesign is, and Publish stays.
    expect(
      screen.getAllByText("Saved to your Website Builder draft").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Publish to your store" }),
    ).toBeEnabled();
    expect(screen.getByText(/Publishing puts the whole/)).toBeInTheDocument();
  });

  it("★★ after an Undo that kept the merchant's own changes, names what it kept and never claims the store is fully back", async () => {
    const undoAnswer: RevampUndoResult = {
      restored: ["Homepage", "Removed Mango pickle"],
      kept: [
        {
          label: "About page",
          reason: "You changed it after the redesign, so it was left as it is.",
        },
      ],
    };
    stubServer(
      view({
        status: "ready",
        draftId: DRAFT,
        review,
        appliedAt: "2026-10-21T11:00:00.000Z",
      }),
      { undoAnswer },
    );
    const { container } = render(
      <MinkRevampCard artifact={artifact("ready")} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo the redesign" }));
    expect(
      await screen.findByText("You undid this redesign."),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain("back the way it was");
    expect(container.textContent).not.toContain("Put back:");
    expect(
      screen.getByText("Undone: Homepage, Removed Mango pickle"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "About page: You changed it after the redesign, so it was left as it is.",
      ),
    ).toBeInTheDocument();
  });

  it("★ names what Undo kept after a reload too, from the status view", async () => {
    stubServer(
      view({
        status: "ready",
        draftId: DRAFT,
        review,
        appliedAt: "2026-10-21T11:00:00.000Z",
        undoneAt: "2026-10-21T13:00:00.000Z",
        undo: {
          restored: ["Homepage"],
          kept: [{ label: "Header and footer", reason: "You changed them." }],
        },
      }),
    );
    const { container } = render(
      <MinkRevampCard artifact={artifact("ready")} />,
    );
    expect(
      await screen.findByText("Header and footer: You changed them."),
    ).toBeInTheDocument();
    expect(screen.getByText("Undone: Homepage")).toBeInTheDocument();
    expect(container.textContent).not.toContain("back the way it was");
  });

  it("says the store is back the way it was only when Undo kept nothing", async () => {
    stubServer(
      view({
        status: "ready",
        draftId: DRAFT,
        review,
        appliedAt: "2026-10-21T11:00:00.000Z",
        undoneAt: "2026-10-21T13:00:00.000Z",
        undo: { restored: ["Homepage"], kept: [] },
      }),
    );
    render(<MinkRevampCard artifact={artifact("ready")} />);
    expect(
      await screen.findByText(/Your store is back the way it was before it/),
    ).toBeInTheDocument();
  });

  it("★ keeps the approval after an unknown outcome so a retry cannot apply twice", async () => {
    stubServer(view({ status: "ready", draftId: DRAFT, review }), {
      executeStatus: 503,
    });
    render(<MinkRevampCard artifact={artifact("ready")} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Apply to Website Builder draft",
      }),
    );
    expect(
      await screen.findByText(/could not confirm whether/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry applying" }),
    ).toBeEnabled();
  });

  it("★★ offers the follow-up changes once the review is ready, and sends one when tapped (chat-8)", async () => {
    chat.send.mockClear();
    stubServer(view({ status: "ready", draftId: DRAFT, review }));
    render(<MinkRevampCard artifact={artifact("ready")} />);
    const warmer = await screen.findByRole("button", {
      name: "Make the colours warmer",
    });
    expect(
      screen.getByRole("button", { name: "Redo the opening photo" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add my products" }),
    ).toBeInTheDocument();
    fireEvent.click(warmer);
    expect(chat.send).toHaveBeenCalledWith("Make the colours warmer");
  });

  it("★ offers no follow-up change while the redesign is still being made (chat-8)", async () => {
    stubServer(view({ status: "running" }));
    render(<MinkRevampCard artifact={artifact("running")} />);
    expect(await screen.findByText("Working on it")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Make the colours warmer" }),
    ).toBeNull();
  });

  it("says when a newer version replaced this one", async () => {
    stubServer(
      view({
        status: "superseded",
        supersededBy: DRAFT,
        review,
        draftId: DRAFT,
      }),
    );
    render(<MinkRevampCard artifact={artifact("ready")} />);
    expect(
      await screen.findByText(
        "A newer version of this redesign replaced this one.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply/i })).toBeNull();
  });

  it("★★ keeps Publish and Undo on an applied redesign a refinement replaced, with a line saying a newer version exists", async () => {
    const server = stubServer(
      view({
        status: "superseded",
        supersededBy: "99999999-8888-4777-8666-555555555555",
        appliedAt: "2026-10-21T11:00:00.000Z",
        review,
        draftId: DRAFT,
      }),
    );
    render(<MinkRevampCard artifact={artifact("ready")} />);
    expect(
      await screen.findByRole("button", { name: "Publish to your store" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    expect(
      screen.getByText(/A newer version of this redesign/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Apply to Website Builder/ }),
    ).toBeNull();
    // The header says where this one is, not only that it was replaced.
    expect(
      screen.getAllByText("Saved to your Website Builder draft").length,
    ).toBeGreaterThan(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Publish to your store" }),
    );
    expect(
      await screen.findByText("Your redesign is live on your store."),
    ).toBeInTheDocument();
    expect(server.posts.map((post) => post.body.action)).toEqual(["publish"]);
  });

  it("stops asking once the requester can no longer open Website Builder", async () => {
    stubServer(view(), { readStatus: 403 });
    render(<MinkRevampCard artifact={artifact()} />);
    expect(
      await screen.findByText(/no longer have access to Website Builder/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("★ once applied, the preview compares the live store with the draft", async () => {
    stubServer(
      view({
        status: "ready",
        draftId: DRAFT,
        review,
        appliedAt: "2026-10-21T11:00:00.000Z",
      }),
    );
    render(<MinkRevampCard artifact={artifact("ready")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(screen.getByTitle("Home, live now")).toHaveAttribute("src", "/");
    expect(screen.getByTitle("Home, your draft")).toBeInTheDocument();
  });

  it("opens the before-and-after preview from the review", async () => {
    stubServer(view({ status: "ready", draftId: DRAFT, review }));
    render(<MinkRevampCard artifact={artifact("ready")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(
      screen.getByRole("dialog", { name: "Preview your redesign" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Preview" })).toHaveFocus();
  });
});
