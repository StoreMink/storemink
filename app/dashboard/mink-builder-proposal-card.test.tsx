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
) {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => ({
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
  }));
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
    expect(screen.getByRole("status")).toHaveTextContent("completed"),
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
    expect(screen.getByRole("status")).toHaveTextContent("completed"),
  );
  expect(
    screen.queryByRole("button", { name: "Apply to Website Builder draft" }),
  ).not.toBeInTheDocument();
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
