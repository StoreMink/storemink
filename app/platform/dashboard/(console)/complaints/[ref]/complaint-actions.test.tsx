// @vitest-environment jsdom
// The buttons of one complaint (takedown design 6.4): which show where the
// complaint stands, the words of each dialog, the T15 action each calls, and
// that a refusal is shown in the action's own words.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  acknowledge: vi.fn(),
  update: vi.fn(),
  actioned: vi.fn(),
  resolve: vi.fn(),
  reopen: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: state.refresh }),
}));
vi.mock("sonner", () => ({
  toast: {
    success: state.toastSuccess,
    warning: state.toastWarning,
    error: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock("@/app/actions/takedown-actions", () => ({
  acknowledgeComplaintAction: state.acknowledge,
  updateComplaintAction: state.update,
  markComplaintActionedAction: state.actioned,
  resolveComplaintAction: state.resolve,
  reopenComplaintAction: state.reopen,
}));

import {
  ComplaintActions,
  REQUEST_FAILED,
  type ComplaintActionsProps,
} from "./complaint-actions";

afterEach(() => {
  cleanup();
});

function props(
  over: Partial<ComplaintActionsProps> = {},
): ComplaintActionsProps {
  return {
    complaintId: "c-1",
    reference: "SM-000123",
    kind: "grievance",
    email: "asha@example.com",
    acknowledged: false,
    actioned: false,
    resolved: false,
    erased: false,
    ...over,
  };
}

function buttonNames(): string[] {
  return screen.getAllByRole("button").map((b) => b.textContent?.trim() ?? "");
}

function dialog() {
  return within(screen.getByRole("dialog"));
}

describe("which buttons show", () => {
  it("offers everything on a new complaint with an email address", () => {
    render(<ComplaintActions {...props()} />);
    expect(buttonNames()).toEqual([
      "Send acknowledgement",
      "Mark as acknowledged",
      "Change kind",
      "No removal needed",
      "Resolve",
    ]);
    expect(screen.getByRole("link", { name: "Block an item" })).toHaveAttribute(
      "href",
      "/dashboard/complaints/block?complaint=SM-000123",
    );
  });

  it("cannot send an acknowledgement to a contact that is not an email", () => {
    render(<ComplaintActions {...props({ email: null })} />);
    expect(buttonNames()).not.toContain("Send acknowledgement");
    expect(buttonNames()).toContain("Mark as acknowledged");
  });

  it("names the actioned step after the kind", () => {
    render(<ComplaintActions {...props({ kind: "information_order" })} />);
    expect(buttonNames()).toContain("Information provided");
    cleanup();
    render(<ComplaintActions {...props({ kind: "data_request" })} />);
    expect(buttonNames()).toContain("Request answered");
  });

  it("drops the steps already taken", () => {
    render(
      <ComplaintActions {...props({ acknowledged: true, actioned: true })} />,
    );
    expect(buttonNames()).toEqual(["Change kind", "Resolve"]);
    expect(
      screen.getByRole("link", { name: "Block an item" }),
    ).toBeInTheDocument();
  });

  it("offers only Change kind and Reopen once resolved", () => {
    render(<ComplaintActions {...props({ resolved: true })} />);
    expect(buttonNames()).toEqual(["Change kind", "Reopen"]);
    expect(screen.queryByRole("link", { name: "Block an item" })).toBeNull();
  });

  it("offers nothing once the complainant's details are erased", () => {
    const { container } = render(
      <ComplaintActions {...props({ resolved: true, erased: true })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("acknowledging", () => {
  it("sends the acknowledgement email with the design's words", async () => {
    state.acknowledge.mockResolvedValue({
      ok: true,
      message: "Acknowledgement sent.",
    });
    render(<ComplaintActions {...props()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Send acknowledgement" }),
    );
    expect(dialog().getByText("Send acknowledgement")).toBeInTheDocument();
    expect(
      dialog().getByText(
        "Email asha@example.com the reference SM-000123, a copy of the complaint as we recorded it, and when we will resolve it.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(dialog().getByRole("button", { name: "Send" }));
    await waitFor(() => expect(state.refresh).toHaveBeenCalled());
    expect(state.acknowledge).toHaveBeenCalledWith("c-1", { sendEmail: true });
    expect(state.toastSuccess).toHaveBeenCalledWith("Acknowledgement sent.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a refusal in the action's own words and stays open", async () => {
    state.acknowledge.mockResolvedValue({
      ok: false,
      error:
        "The email could not be sent. If you replied from the mailbox, use Mark as acknowledged.",
    });
    render(<ComplaintActions {...props()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Send acknowledgement" }),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Send" }));
    expect(
      await dialog().findByText(
        "The email could not be sent. If you replied from the mailbox, use Mark as acknowledged.",
      ),
    ).toBeInTheDocument();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("says the request failed only when no answer came", async () => {
    state.acknowledge.mockRejectedValue(new Error("network"));
    render(<ComplaintActions {...props()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Mark as acknowledged" }),
    );
    expect(
      dialog().getByText(
        "Mark SM-000123 as acknowledged? Use this when you replied from the support mailbox.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      dialog().getByRole("button", { name: "Mark as acknowledged" }),
    );
    expect(await dialog().findByText(REQUEST_FAILED)).toBeInTheDocument();
    expect(state.acknowledge).toHaveBeenCalledWith("c-1");
  });
});

describe("changing the kind", () => {
  it("asks with the design's words and sends the kind chosen", async () => {
    state.update.mockResolvedValue({ ok: true, message: "Kind changed." });
    render(<ComplaintActions {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change kind" }));
    expect(
      dialog().getByText("What kind of complaint is SM-000123?"),
    ).toBeInTheDocument();
    expect(
      dialog().getByText(
        "If the new kind is stricter, its deadlines apply from when the complaint reached us. A deadline never moves later.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(dialog().getByRole("radio", { name: /^Court order:/ }));
    fireEvent.click(dialog().getByRole("button", { name: "Change kind" }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith("c-1", { kind: "court_order" }),
    );
  });
});

describe("the actioned step", () => {
  it("asks why no removal is needed and sends the note", async () => {
    state.actioned.mockResolvedValue({ ok: true, message: "Recorded." });
    render(<ComplaintActions {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "No removal needed" }));
    fireEvent.change(dialog().getByLabelText("Why is no removal needed?"), {
      target: { value: "The listing is not on the store." },
    });
    fireEvent.click(
      dialog().getByRole("button", { name: "No removal needed" }),
    );
    await waitFor(() =>
      expect(state.actioned).toHaveBeenCalledWith(
        "c-1",
        "The listing is not on the store.",
      ),
    );
  });

  it("asks what was provided for an information order", () => {
    render(<ComplaintActions {...props({ kind: "information_order" })} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Information provided" }),
    );
    expect(
      dialog().getByLabelText("What did we provide, and to whom?"),
    ).toBeInTheDocument();
  });

  it("asks how a data request was answered", () => {
    render(<ComplaintActions {...props({ kind: "data_request" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Request answered" }));
    expect(
      dialog().getByLabelText("How did we answer, and to whom?"),
    ).toBeInTheDocument();
  });
});

describe("resolving", () => {
  it("asks for a note when the outcome needs one, before calling anything", async () => {
    render(<ComplaintActions {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(dialog().getByText("Resolve SM-000123")).toBeInTheDocument();
    fireEvent.click(dialog().getByRole("radio", { name: "Not removed" }));
    expect(
      dialog().getByText(
        "Say why. The complainant can appeal to the Grievance Appellate Committee.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(dialog().getByRole("button", { name: "Resolve" }));
    expect(
      await dialog().findByText("Write a note for this outcome."),
    ).toBeInTheDocument();
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it("emails the outcome by default and shows the warnings", async () => {
    state.resolve.mockResolvedValue({
      ok: true,
      emailed: true,
      message: "Resolved.",
      warnings: ["A block is still in place."],
    });
    render(<ComplaintActions {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    fireEvent.click(dialog().getByRole("radio", { name: "Partly removed" }));
    fireEvent.change(dialog().getByLabelText("Note"), {
      target: { value: "One of two listings was removed." },
    });
    expect(
      dialog().getByRole("checkbox", {
        name: "Email the outcome to asha@example.com",
      }),
    ).toBeChecked();
    fireEvent.click(dialog().getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(state.refresh).toHaveBeenCalled());
    expect(state.resolve).toHaveBeenCalledWith("c-1", {
      outcome: "partly_removed",
      note: "One of two listings was removed.",
      emailComplainant: true,
    });
    expect(state.toastWarning).toHaveBeenCalledWith(
      "A block is still in place.",
    );
  });

  it("does not email when the box is cleared, or when there is no address", async () => {
    state.resolve.mockResolvedValue({
      ok: true,
      emailed: false,
      message: "Resolved.",
    });
    render(<ComplaintActions {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    fireEvent.click(dialog().getByRole("radio", { name: "Removed" }));
    fireEvent.click(
      dialog().getByRole("checkbox", {
        name: "Email the outcome to asha@example.com",
      }),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(state.resolve).toHaveBeenCalledWith("c-1", {
        outcome: "removed",
        note: "",
        emailComplainant: false,
      }),
    );
    cleanup();

    render(<ComplaintActions {...props({ email: null })} />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(dialog().queryByRole("checkbox")).toBeNull();
  });
});

describe("reopening", () => {
  it("asks with the reference and sends the note", async () => {
    state.reopen.mockResolvedValue({ ok: true, message: "Reopened." });
    render(<ComplaintActions {...props({ resolved: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(dialog().getByText("Reopen SM-000123?")).toBeInTheDocument();
    fireEvent.change(dialog().getByLabelText("Note"), {
      target: { value: "The store put it back." },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Reopen" }));
    await waitFor(() =>
      expect(state.reopen).toHaveBeenCalledWith(
        "c-1",
        "The store put it back.",
      ),
    );
  });
});
