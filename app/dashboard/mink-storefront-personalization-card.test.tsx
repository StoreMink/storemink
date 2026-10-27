// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MinkArtifact } from "@/lib/mink/types";

const actions = vi.hoisted(() => ({
  publishPage: vi.fn(),
  publishChrome: vi.fn(),
}));
vi.mock("@/app/actions/page-actions", () => ({
  publishPage: actions.publishPage,
}));
vi.mock("@/app/actions/chrome-actions", () => ({
  publishChrome: actions.publishChrome,
}));

import { MinkStorefrontPersonalizationCard } from "./mink-storefront-personalization-card";

type Proposal = Extract<
  MinkArtifact,
  { type: "storefront_personalization_proposal" }
>;

const DRAFT = "33333333-3333-4333-8333-333333333333";
const PHOTO =
  "https://storage.googleapis.com/storemink-media/stores/11111111-1111-4111-8111-111111111111/mink-generated/22222222-2222-4222-8222-222222222222.jpg";

const proposal: Proposal = {
  type: "storefront_personalization_proposal",
  draftId: DRAFT,
  title: "Personalised storefront",
  explanation: "Makes the store about candles.",
  planDigest: "a".repeat(64),
  pages: [
    {
      slug: "home",
      title: "Home",
      textChanges: 7,
      photoChanges: 1,
      hidden: [{ type: "testimonials", reason: "Sample customer quotes." }],
    },
  ],
  photos: [{ url: PHOTO, alt: "Amber candles", where: "Home: banner photo" }],
  design: null,
  chrome: [
    { label: "Store tagline", before: "", after: "Candles for slow evenings" },
  ],
  categories: [
    {
      action: "update",
      name: "Pillar candles",
      previousName: "Fruit",
      description: null,
      photoUrl: null,
    },
  ],
  products: [{ name: "Apples (Sample)" }],
  skipped: [
    { label: "2 more photos", reason: "Ask Mink to make the rest next." },
  ],
  live: [
    "Category names, descriptions and photos",
    "Theme sample products taken off the shop",
  ],
  status: "private_preview",
  expectedCredits: 47,
  chargedCredits: 47,
  creditSource: "plan",
};

const APPROVAL = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  toolName: "apply_storefront_personalization",
  operation: "apply",
  status: "pending",
  draftId: DRAFT,
  draftVersion: 0,
  resource: {
    type: "storefront",
    id: "11111111-1111-4111-8111-111111111111",
    label: "Whole storefront",
    dashboardPath: "/dashboard/builder",
  },
  before: {},
  after: {},
  pages: [{ id: "page-home", slug: "home", title: "Home" }],
  chromeChanged: true,
  expiresAt: "2026-10-20T10:05:00.000Z",
  executedAt: null,
};

function stubFetch(executeStatus = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { action: string })
        : null;
      if (body?.action === "preview") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ approval: APPROVAL }),
        };
      }
      if (body?.action === "execute") {
        if (executeStatus !== 200) {
          return {
            ok: false,
            status: executeStatus,
            json: async () => ({ error: "Mink AI is busy." }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              approval: { ...APPROVAL, status: "executed" },
              auditId: "audit",
              repeated: false,
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ result: null }) };
    }),
  );
}

function postedActions() {
  return (fetch as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => {
    const body = call[1]?.body;
    return body
      ? [(JSON.parse(String(body)) as { action: string }).action]
      : [];
  });
}

beforeEach(() => {
  actions.publishPage.mockResolvedValue({});
  actions.publishChrome.mockResolvedValue({});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the personalised storefront card", () => {
  it("★★ says what goes live at once before the Apply button, and never what it cost", async () => {
    stubFetch();
    const { container } = render(
      <MinkStorefrontPersonalizationCard proposal={proposal} />,
    );
    expect(screen.getByAltText("Amber candles")).toHaveAttribute("src", PHOTO);
    expect(
      screen.getByText(
        /Applying also changes these on your live store at once/,
      ),
    ).toHaveTextContent("Theme sample products taken off the shop");
    expect(screen.getByText("Fruit → Pillar candles")).toBeInTheDocument();
    expect(screen.getByText(/Not done this time \(1\)/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/credit/i);
    expect(container.textContent).not.toContain("47");
    // It asks once whether this card was already applied.
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        `/api/mink/drafts/${DRAFT}/personalization-action`,
        expect.objectContaining({ cache: "no-store" }),
      ),
    );
  });

  it("applies with one click (a preview, then the execute), then publishes the pages and the header", async () => {
    stubFetch();
    render(<MinkStorefrontPersonalizationCard proposal={proposal} />);
    fireEvent.click(
      screen.getByRole("button", { name: /apply to website builder draft/i }),
    );
    await screen.findByText(/Saved to your Website Builder draft/);
    expect(postedActions()).toEqual(["preview", "execute"]);

    fireEvent.click(
      screen.getByRole("button", { name: /publish these pages/i }),
    );
    await screen.findByText(/Your new pages are live/);
    expect(actions.publishPage).toHaveBeenCalledWith("page-home");
    expect(actions.publishChrome).toHaveBeenCalledTimes(1);
  });

  it("★ keeps the approval after an unknown outcome so the retry cannot apply twice", async () => {
    stubFetch(503);
    render(<MinkStorefrontPersonalizationCard proposal={proposal} />);
    fireEvent.click(
      screen.getByRole("button", { name: /apply to website builder draft/i }),
    );
    expect(
      await screen.findByText(/could not confirm whether/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /retry applying/i }),
    ).toBeEnabled();
  });

  it("says a publish failure leaves the draft safe", async () => {
    stubFetch();
    actions.publishPage.mockResolvedValueOnce({
      error: "Add a heading first.",
    });
    render(<MinkStorefrontPersonalizationCard proposal={proposal} />);
    fireEvent.click(
      screen.getByRole("button", { name: /apply to website builder draft/i }),
    );
    await screen.findByText(/Saved to your Website Builder draft/);
    fireEvent.click(
      screen.getByRole("button", { name: /publish these pages/i }),
    );
    expect(
      await screen.findByText(/Home: Add a heading first\. Your draft is safe/),
    ).toBeInTheDocument();
    expect(actions.publishChrome).not.toHaveBeenCalled();
  });
});
