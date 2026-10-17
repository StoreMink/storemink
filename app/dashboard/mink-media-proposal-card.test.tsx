// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const chat = vi.hoisted(() => ({ send: vi.fn(), isReplying: false }));
vi.mock("./chat-context", () => ({ useChat: () => chat }));
vi.mock("@/app/actions/mink-media-actions", () => ({
  saveMinkGeneratedImage: vi.fn(),
}));
vi.mock("./mink-link", () => ({
  MinkLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import {
  MinkMediaProposalCard,
  productPhotoFollowUps,
} from "./mink-media-proposal-card";

const URL =
  "https://storage.googleapis.com/b/stores/s/mink-generated/product-photos/p.jpg";

function proposal(purpose: "product" | "hero") {
  return {
    type: "media_image_proposal" as const,
    draftId: "d1",
    title: "Product photo",
    destinationLabel: "Media Library · Product photo",
    destinationPath: "/dashboard/media",
    url: URL,
    alt: "A black T-shirt hanging from a tree branch in a garden",
    prompt: "The black T-shirt hanging from a tree branch in a garden.",
    referenceImageCount: 1,
    purpose,
    aspectRatio: "3:4",
    placement: "the product's own photo",
    saved: true,
    status: "private_preview" as const,
    expectedCredits: purpose === "product" ? 5 : 3,
    chargedCredits: purpose === "product" ? 5 : 3,
    creditSource: "plan" as const,
  };
}

afterEach(() => {
  cleanup();
  chat.send.mockReset();
  chat.isReplying = false;
});

describe("MinkMediaProposalCard", () => {
  it("offers a product photo's two next steps as chat messages carrying its URL", () => {
    render(<MinkMediaProposalCard proposal={proposal("product") as never} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Use as product photo/ }),
    );
    expect(chat.send).toHaveBeenLastCalledWith(productPhotoFollowUps(URL).use);
    fireEvent.click(screen.getByRole("button", { name: /^Try again$/ }));
    expect(chat.send).toHaveBeenLastCalledWith(
      productPhotoFollowUps(URL).again,
    );
    expect(productPhotoFollowUps(URL).use).toContain(URL);
    expect(screen.getByText(/compare it with the real item/)).toBeTruthy();
    // No price anywhere on the dashboard (owner, 2026-10-18).
    expect(document.body.textContent).not.toMatch(/\d+\s*(Mink )?credits?/);
  });

  it("waits while Mink is replying", () => {
    chat.isReplying = true;
    render(<MinkMediaProposalCard proposal={proposal("product") as never} />);
    expect(
      (
        screen.getByRole("button", {
          name: /Use as product photo/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("offers no product actions on campaign art", () => {
    render(<MinkMediaProposalCard proposal={proposal("hero") as never} />);
    expect(screen.queryByText(/Use as product photo/)).toBeNull();
    expect(screen.getByText(/does not replace an original/)).toBeTruthy();
  });
});
