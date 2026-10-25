// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioPageApi } from "../tab-types";

// The release controls' client part (wave TS-2, builder 2C; plan section 4,
// "Publish dialog" and "Live"): the Publish dialog with the design, the real
// reach, the warnings, the "you are looking at" line and the re-check line;
// the publishing steps; Try again with the last reasons; the live panel;
// the intents; never a version picker or Restore on screen.

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const nav = vi.hoisted(() => ({ search: "" }));
const actions = vi.hoisted(() => ({
  publishThemeStudioProjectAction: vi.fn(async () => ({
    ok: true,
    kind: "published",
  })),
  changeThemeStudioCatalogAction: vi.fn(async () => ({
    ok: true,
    changed: true,
  })),
}));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/app/actions/theme-studio-actions", () => actions);
vi.mock("sonner", () => ({ toast }));

import { StudioPageProvider } from "../studio-tabs";
import {
  PUBLISH_REACH,
  ReleasePanel,
  publishDialogWords,
  warningsGoLive,
  type ReleasePanelProps,
  type ReleasePublishFacts,
} from "./release-workspace";

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

const api: StudioPageApi = {
  putInChat: vi.fn(),
  openTab: vi.fn(),
  requestIntent: vi.fn(),
  reportPublishWait: vi.fn(),
};

const facts: ReleasePublishFacts = {
  designNumber: 2,
  madeAt: "11:40",
  viewingNumber: null,
  warnings: [
    "Button sizes on phones (Shop at 390 px): A button or link is 20 by 20 px; the smallest easy size to tap is 24 by 24 px.",
    "The design review gave 32 of 40 in all; it asks for 34.",
  ],
  recheck: false,
  recheckReason: null,
  waitReason: null,
  lastReasons: [],
  notifies: true,
};

const base: ReleasePanelProps = {
  projectId: "p",
  name: "Aurora",
  revision: 8,
  row: 15,
  actions: [{ kind: "publish", label: "Publish" }],
  demoOrigin: "https://demo-aurora.storemink.com",
  live: null,
  publish: facts,
};

function panel(overrides: Partial<ReleasePanelProps> = {}) {
  return render(
    <StudioPageProvider api={api}>
      <ReleasePanel {...base} {...overrides} />
    </StudioPageProvider>,
  );
}

function intent(kind: string) {
  nav.search = `do=${kind}`;
  window.history.replaceState(
    null,
    "",
    `/dashboard/themes/studio/p?do=${kind}`,
  );
}

beforeEach(() => {
  nav.search = "";
  window.history.replaceState(null, "", "/dashboard/themes/studio/p");
});
afterEach(() => cleanup());

function noLongDashOrStateNames() {
  const text = document.body.textContent ?? "";
  expect(text.includes(EM) || text.includes(EN)).toBe(false);
  expect(text).not.toMatch(/\b(candidate|approved|blocked)\b/i);
  expect(text).not.toMatch(/signup|second person|review step/i);
}

describe("Publish", () => {
  it("names the design, when it was made, the real reach and the warnings that go live", async () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Publish Design 2 (made 11:40)?"),
    ).toBeTruthy();
    expect(dialog.textContent).toContain(
      `It appears in ${PUBLISH_REACH}, with a live demo store. Stores that install it keep this exact version. You can stop offering it at any time.`,
    );
    expect(
      within(dialog).getByText("2 warnings go live with it:"),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(facts.warnings);
    expect(actions.publishThemeStudioProjectAction).not.toHaveBeenCalled();
    noLongDashOrStateNames();
  });

  it("publishes in one step, showing the publishing steps in the header while it runs", async () => {
    let finish: (value: unknown) => void = () => {};
    actions.publishThemeStudioProjectAction.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)) as never,
    );
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Publish now",
      }),
    );
    expect(actions.publishThemeStudioProjectAction).toHaveBeenCalledWith({
      projectId: "p",
      expectedRevision: 8,
    });
    expect(
      await screen.findByText(
        /Copying the pictures, saving the release, building the demo store, checking the demo pages and adding it to the catalog\./,
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Publishing/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () => finish({ ok: true, kind: "published" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Aurora is live."),
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("tells you when you are looking at another design, and opens the Design list to make it current", async () => {
    // The Design list takes focus when it opens (its first button).
    const listButton = document.createElement("button");
    listButton.textContent = "Show it";
    document.body.appendChild(listButton);
    vi.mocked(api.requestIntent).mockImplementation(() => listButton.focus());
    panel({ publish: { ...facts, viewingNumber: 1 } });
    const publish = screen.getByRole("button", { name: "Publish" });
    fireEvent.click(publish);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "You are looking at Design 1; Design 2 is the one that will go live. Make Design 1 current first.",
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Choose the design to make current",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(api.requestIntent).toHaveBeenCalledWith("make_current"),
    );
    expect(api.requestIntent).toHaveBeenCalledTimes(1);
    // The closed dialog never takes focus back to Publish, which would
    // close the Design list again.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(listButton);
    expect(document.activeElement).not.toBe(publish);
    expect(actions.publishThemeStudioProjectAction).not.toHaveBeenCalled();
    listButton.remove();
  });

  it("opens no dialog for do=publish while Publish waits, and moves focus to the button and its reason", async () => {
    intent("publish");
    panel({
      publish: {
        ...facts,
        waitReason:
          "This theme can't be published as it is: 2 image slots still have a placeholder.",
      },
    });
    const button = screen.getByRole("button", { name: "Publish" });
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(screen.queryByRole("dialog")).toBeNull();
    const reason = document.getElementById(
      button.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toMatch(/can't be published as it is/);
    expect(actions.publishThemeStudioProjectAction).not.toHaveBeenCalled();
  });

  it("tells the page why Publish waits, so the phone bar holds back too", () => {
    const reason =
      "This theme can't be published as it is: 2 image slots still have a placeholder.";
    const view = panel({ publish: { ...facts, waitReason: reason } });
    expect(api.reportPublishWait).toHaveBeenLastCalledWith(reason);
    view.unmount();
    expect(api.reportPublishWait).toHaveBeenLastCalledWith(null);
    panel();
    expect(api.reportPublishWait).toHaveBeenLastCalledWith(null);
  });

  it("gives focus back to the control that opened it, such as the phone bar's Publish", async () => {
    const bar = document.createElement("button");
    bar.textContent = "Publish from the bar";
    document.body.appendChild(bar);
    bar.focus();
    intent("publish");
    panel();
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(bar));
    bar.remove();
  });

  it("re-checks first when StoreMink was updated, and treats that answer as news", async () => {
    actions.publishThemeStudioProjectAction.mockResolvedValueOnce({
      ok: true,
      kind: "rechecking",
      message: `StoreMink was updated since this design was checked ${EM} checking again.`,
    } as never);
    panel({
      row: 16,
      publish: {
        ...facts,
        recheck: true,
        recheckReason: "StoreMink was updated since these checks.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Re-check Design 2 before publishing?"),
    ).toBeTruthy();
    expect(dialog.textContent).toContain(
      "StoreMink was updated since these checks. Design 2 is re-checked on today's build first, about 3 to 5 minutes; you can leave this page, and we'll tell you when it's ready to publish. Nothing is redrawn.",
    );
    // The warnings wait for the re-check.
    expect(within(dialog).queryByText(/go live with it/)).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Re-check now" }),
    );
    expect(
      await screen.findByText(
        "StoreMink was updated since this design was checked, checking again.",
      ),
    ).toBeTruthy();
    expect(toast.info).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("promises a notice only to the operator who started the theme", () => {
    expect(
      publishDialogWords(
        "Aurora",
        { ...facts, recheck: true, recheckReason: null, notifies: false },
        false,
      ).lead,
    ).toMatch(/it shows Ready to publish when it passes/);
  });

  it("waits, with the reason under it, when Publish can do nothing now", () => {
    panel({
      publish: {
        ...facts,
        waitReason:
          "This theme can't be published as it is: 2 image slots still have a placeholder.",
      },
    });
    const button = screen.getByRole("button", { name: "Publish" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.parentElement?.textContent).toMatch(
      /can't be published as it is: 2 image slots/,
    );
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes with Escape and gives focus back to Publish", async () => {
    panel();
    const button = screen.getByRole("button", { name: "Publish" });
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });
});

describe("a publish that didn't finish", () => {
  const retry: Partial<ReleasePanelProps> = {
    row: 3,
    actions: [{ kind: "retry_publish", label: "Try again" }],
    publish: {
      ...facts,
      lastReasons: ["The demo store didn't build, storage was busy."],
    },
  };

  it("says which design Try again publishes, and offers no Make current, while another design is shown", async () => {
    panel({ ...retry, publish: { ...retry.publish!, viewingNumber: 1 } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "You are looking at Design 1; Try again publishes Design 2, the design the attempt started with.",
    );
    expect(dialog.textContent).not.toMatch(/Make Design 1 current/);
    expect(
      within(dialog).queryByRole("button", {
        name: "Choose the design to make current",
      }),
    ).toBeNull();
  });

  it("puts the last attempt's reasons beside Try again", async () => {
    panel(retry);
    const button = screen.getByRole("button", { name: "Try again" });
    expect(button.parentElement?.textContent).toMatch(
      /Its last attempt said:.*The demo store didn't build, storage was busy\./,
    );
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Try publishing Design 2 (made 11:40) again?"),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Try again" }),
    ).toBeTruthy();
  });

  it("says why a new attempt did not finish, then shows the page's new state", async () => {
    actions.publishThemeStudioProjectAction.mockResolvedValueOnce({
      ok: false,
      kind: "failed",
      error: "The demo pages did not open.",
      problems: ["The demo pages did not open."],
    } as never);
    panel(retry);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Try again",
      }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The demo pages did not open."),
    );
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe("publishing now", () => {
  it("shows the steps it goes through, and no button", () => {
    panel({ row: 2, actions: [], publish: null });
    expect(screen.getByText("Publishing now")).toBeTruthy();
    expect(
      screen.getByText(/Copying the pictures, saving the release/),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the live panel", () => {
  const live: Partial<ReleasePanelProps> = {
    row: 1,
    actions: [
      { kind: "open_live_demo", label: "Open live demo" },
      { kind: "stop_offering", label: "Stop offering this theme" },
      {
        kind: "start_new_from_brief",
        label: "Start a new theme from this brief",
      },
    ],
    live: { offered: true, version: "1.0.0", since: "1 Oct" },
    publish: null,
  };

  it("offers the live demo, Stop offering this theme and a new theme from this brief, never a version picker", () => {
    const { container } = panel(live);
    const demo = screen.getByRole("link", { name: /Open live demo/ });
    expect(demo.getAttribute("href")).toBe("https://demo-aurora.storemink.com");
    expect(demo.getAttribute("target")).toBe("_blank");
    expect(
      screen.getByText(
        /Live, v1\.0\.0, since 1 Oct\. Stores that installed it keep this exact version\. Live themes can't be changed yet\./,
      ),
    ).toBeTruthy();
    const again = screen.getByRole("link", {
      name: "Start a new theme from this brief",
    });
    expect(again.getAttribute("href")).toBe(
      "/dashboard/themes/studio/new?from=p",
    );
    // The live row's next step is a button (44 px on touch), not a link in
    // words.
    expect(again.classList.contains("dash-btn")).toBe(true);
    expect(container.querySelector("select")).toBeNull();
    expect(screen.queryByText(/Restore this version/)).toBeNull();
    expect(screen.queryByText(/Hide from new stores/)).toBeNull();
    noLongDashOrStateNames();
  });

  it("stops offering the theme behind a dialog that says what it does", async () => {
    panel(live);
    fireEvent.click(
      screen.getByRole("button", { name: "Stop offering this theme" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(
      /it leaves the Theme library of every store that has not installed it/,
    );
    expect(actions.changeThemeStudioCatalogAction).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Stop offering" }),
    );
    await waitFor(() =>
      expect(actions.changeThemeStudioCatalogAction).toHaveBeenCalledWith({
        projectId: "p",
        change: { action: "hide" },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Aurora is no longer offered to new stores.",
    );
  });

  it("offers it again behind a dialog", async () => {
    panel({
      ...live,
      actions: [
        { kind: "offer_again", label: "Offer again" },
        { kind: "open_live_demo", label: "Open live demo" },
      ],
      live: { offered: false, version: "1.0.0", since: null },
    });
    expect(screen.getByText(/^Not offered to new stores\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Offer again" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Offer again",
      }),
    );
    await waitFor(() =>
      expect(actions.changeThemeStudioCatalogAction).toHaveBeenCalledWith({
        projectId: "p",
        change: { action: "show" },
      }),
    );
  });

  it("shows the server's refusal inside the dialog", async () => {
    actions.changeThemeStudioCatalogAction.mockResolvedValueOnce({
      ok: false,
      error: "Only a published release with a healthy demo can be public.",
    } as never);
    panel({
      ...live,
      actions: [{ kind: "offer_again", label: "Offer again" }],
      live: { offered: false, version: "1.0.0", since: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "Offer again" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Offer again",
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Only a published release with a healthy demo can be public.",
    );
  });
});

describe("intents", () => {
  it("opens the Publish dialog for do=publish, and only opens it", async () => {
    intent("publish");
    panel();
    expect(
      await screen.findByText("Publish Design 2 (made 11:40)?"),
    ).toBeTruthy();
    expect(actions.publishThemeStudioProjectAction).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("opens Try again's dialog for do=retry_publish", async () => {
    intent("retry_publish");
    panel({
      row: 3,
      actions: [{ kind: "retry_publish", label: "Try again" }],
    });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("opens Stop offering's dialog for do=stop_offering, and moves focus to the demo for do=open_live_demo", async () => {
    intent("stop_offering");
    panel({
      row: 1,
      actions: [
        { kind: "open_live_demo", label: "Open live demo" },
        { kind: "stop_offering", label: "Stop offering this theme" },
      ],
      live: { offered: true, version: "1.0.0", since: null },
      publish: null,
    });
    expect(await screen.findByText("Stop offering Aurora?")).toBeTruthy();
    cleanup();
    intent("open_live_demo");
    panel({
      row: 1,
      actions: [{ kind: "open_live_demo", label: "Open live demo" }],
      live: { offered: true, version: "1.0.0", since: null },
      publish: null,
    });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toMatch(/Open live demo/),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

it("counts the warnings that go live in plain grammar", () => {
  expect(warningsGoLive(1, ":")).toBe("1 warning goes live with it:");
  expect(warningsGoLive(3, ".")).toBe("3 warnings go live with it.");
});
