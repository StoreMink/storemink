// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("@/lib/auth/firebase-client", () => ({
  endSession: vi.fn(async () => undefined),
}));
vi.mock("@/components/ui/image-refine-registry", () => ({
  stopAllImageRefines: vi.fn(async () => undefined),
}));

import { endSession } from "@/lib/auth/firebase-client";
import { stopAllImageRefines } from "@/components/ui/image-refine-registry";
import { TopbarProfile } from "./topbar-profile";

describe("TopbarProfile sign-out", () => {
  // ★★ The stop route answers 401 without a session, so a Refine with Mink
  //    AI stopped after endSession could not win, and the refine the
  //    merchant left would be charged.
  it("★★ stops a running Refine with Mink AI BEFORE the session ends", async () => {
    let finishStops: () => void = () => {};
    vi.mocked(stopAllImageRefines).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStops = resolve;
        }),
    );
    render(<TopbarProfile email="owner@example.com" role="Owner" />);
    fireEvent.click(screen.getByText("OW"));
    fireEvent.click(screen.getByRole("button", { name: "Log Out" }));

    expect(stopAllImageRefines).toHaveBeenCalledWith({ waitMs: 1_500 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Still waiting for the stops: the session is untouched.
    expect(endSession).not.toHaveBeenCalled();

    await act(async () => finishStops());
    await waitFor(() => expect(endSession).toHaveBeenCalledOnce());
    expect(push).toHaveBeenCalledWith("/auth/login");
  });
});
