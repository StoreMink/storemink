// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MinkBuilderProposalCard } from "./mink-builder-proposal-card";
import type { MinkArtifact } from "@/lib/mink/types";
const proposal: Extract<MinkArtifact, { type: "builder_proposal" }> = {
  type: "builder_proposal",
  draftId: "11111111-1111-4111-8111-111111111111",
  title: "Fix Men menu",
  operation: "chrome_update",
  pageSlug: "home",
  explanation: "Use the active Men collection.",
  changes: [
    {
      field: "header.links.0.href",
      before: '"/shop?category=mens-shoes"',
      after: '"/collections/men"',
    },
  ],
  live: false,
  expectedCredits: 2,
  chargedCredits: 2,
  creditSource: "plan",
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(
  executed = false,
  operation: typeof proposal.operation = "chrome_update",
  publication = {
    operation: "chrome_publish",
    pageSlug: "home",
    status: "ready",
    blockers: [] as string[],
  },
) {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") executed = true;
    return {
      ok: true,
      json: async () =>
        init?.method === "POST"
          ? { result: { approvalId: "saved" } }
          : {
              review: executed
                ? {
                    executed: true,
                    operation,
                    approvalId: "saved",
                    publication,
                  }
                : {
                    executed: false,
                    operation,
                    explanation: proposal.explanation,
                    changes: proposal.changes,
                    live: operation === "chrome_publish",
                    codeChecks: [],
                    patchDigest: "a".repeat(64),
                  },
            },
    };
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
it("shows the exact menu correction and saves only after the human click", async () => {
  const fetch = setup();
  render(<MinkBuilderProposalCard proposal={proposal} />);
  const button = screen.getByRole("button", {
    name: "Apply to Website Builder draft",
  });
  await waitFor(() => expect(button).toBeEnabled());
  expect(screen.getByText(/Before:.*mens-shoes/)).toBeInTheDocument();
  expect(screen.getByText(/After:.*collections\/men/)).toBeInTheDocument();
  expect(fetch.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(
    true,
  );
  fireEvent.click(button);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("saved to draft"),
  );
  expect(
    JSON.parse(
      String(
        fetch.mock.calls.find((call) => call[1]?.method === "POST")![1]!.body,
      ),
    ),
  ).toMatchObject({ action: "approve" });
});
it("restores completed approval without offering to apply it again", async () => {
  setup(true);
  render(<MinkBuilderProposalCard proposal={proposal} />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("saved to draft"),
  );
  expect(
    screen.queryByRole("button", { name: "Apply to Website Builder draft" }),
  ).not.toBeInTheDocument();
});

it("offers a fresh publication review in chat after saving without publishing on its own", async () => {
  const fetch = setup();
  const onPrompt = vi.fn();
  render(<MinkBuilderProposalCard proposal={proposal} onPrompt={onPrompt} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Apply to Website Builder draft" }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Apply to Website Builder draft" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Review publication" }),
    ).toBeEnabled(),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "This action did not publish them",
  );
  expect(screen.getByText(/The current draft is not live/)).toBeInTheDocument();
  expect(
    screen.getByText(/including other unpublished edits, then approve/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review publication" }));
  expect(onPrompt).toHaveBeenCalledWith(
    expect.stringContaining(
      "Prepare a publication review for my saved header and footer draft",
    ),
  );
  expect(
    fetch.mock.calls.filter((call) => call[1]?.method === "POST"),
  ).toHaveLength(1);
});

it("shows current blockers and a correction action instead of a publish button", async () => {
  setup(true, "chrome_update", {
    operation: "chrome_publish",
    pageSlug: "home",
    status: "blocked",
    blockers: [
      "Footer link “Men” (/shop?category=mens-shoes): Category is hidden. Suggested destination: /collections/men.",
    ],
  });
  const onPrompt = vi.fn();
  render(<MinkBuilderProposalCard proposal={proposal} onPrompt={onPrompt} />);
  const button = await screen.findByRole("button", {
    name: "Ask Mink to fix publishing issues",
  });
  expect(screen.getByText(/Footer link “Men”/)).toHaveTextContent(
    "Suggested destination: /collections/men",
  );
  expect(
    screen.queryByRole("button", { name: "Review publication" }),
  ).not.toBeInTheDocument();
  fireEvent.click(button);
  expect(onPrompt).toHaveBeenCalledWith(
    expect.stringContaining(
      "Do not remove links or publish pages just to bypass checks",
    ),
  );
});

it("recognizes a later publication when reopening a saved card", async () => {
  setup(true, "chrome_update", {
    operation: "chrome_publish",
    pageSlug: "home",
    status: "live",
    blockers: [],
  });
  render(<MinkBuilderProposalCard proposal={proposal} onPrompt={vi.fn()} />);
  expect(
    await screen.findByText(
      /current header and footer draft matches your live store/,
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/The current draft is not live/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Review publication" }),
  ).not.toBeInTheDocument();
});

it("disables chat follow-ups while another request is running", async () => {
  setup(true);
  const onPrompt = vi.fn();
  render(
    <MinkBuilderProposalCard
      proposal={proposal}
      onPrompt={onPrompt}
      promptDisabled
    />,
  );
  const button = await screen.findByRole("button", {
    name: "Review publication",
  });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(onPrompt).not.toHaveBeenCalled();
});

it("reports publication distinctly after approval", async () => {
  setup(true, "chrome_publish");
  render(
    <MinkBuilderProposalCard
      proposal={{ ...proposal, operation: "chrome_publish", live: true }}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "published to your live store",
    ),
  );
  expect(
    screen.queryByRole("button", { name: "Review publication" }),
  ).not.toBeInTheDocument();
});

it("keeps a successful save completed if its publication check fails and retries only the read", async () => {
  let reads = 0;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => ({
    ok: init?.method === "POST" || ++reads !== 2,
    json: async () =>
      init?.method === "POST"
        ? { result: { approvalId: "saved" } }
        : reads === 1
          ? {
              review: {
                executed: false,
                operation: "chrome_update",
                live: false,
                changes: proposal.changes,
                codeChecks: [],
                patchDigest: "a".repeat(64),
              },
            }
          : reads === 2
            ? { error: "Temporary read failure" }
            : {
                review: {
                  executed: true,
                  operation: "chrome_update",
                  publication: {
                    operation: "chrome_publish",
                    pageSlug: "home",
                    status: "ready",
                    blockers: [],
                  },
                },
              },
  }));
  vi.stubGlobal("fetch", fetch);
  render(<MinkBuilderProposalCard proposal={proposal} onPrompt={vi.fn()} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Apply to Website Builder draft" }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Apply to Website Builder draft" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your change was saved",
    ),
  );
  expect(screen.getByRole("status")).toHaveTextContent("saved to draft");
  fireEvent.click(
    screen.getByRole("button", { name: "Check publication status" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Review publication" }),
    ).toBeEnabled(),
  );
  expect(
    fetch.mock.calls.filter((call) => call[1]?.method === "POST"),
  ).toHaveLength(1);
});
it("blocks changes when the current review cannot be loaded", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      json: async () => ({
        error: "The page changed. Read the current context.",
      }),
    })),
  );
  render(<MinkBuilderProposalCard proposal={proposal} />);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("page changed"),
  );
  expect(
    screen.getByRole("button", { name: "Apply to Website Builder draft" }),
  ).toBeDisabled();
});
it("clearly distinguishes publication from a draft save", async () => {
  setup(false, "chrome_publish");
  await act(async () =>
    render(
      <MinkBuilderProposalCard
        proposal={{ ...proposal, operation: "chrome_publish", live: true }}
      />,
    ),
  );
  // The authoritative review may differ from stale history; it is used once loaded.
  expect(
    screen.getByRole("button", { name: "Publish header and footer" }),
  ).toBeInTheDocument();
});

it("uses the authoritative action rather than a label in old chat history", async () => {
  setup(false, "chrome_publish");
  render(<MinkBuilderProposalCard proposal={proposal} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Publish header and footer" }),
    ).toBeEnabled(),
  );
  expect(
    screen.getByText(/Approval changes the live storefront/),
  ).toBeInTheDocument();
});
