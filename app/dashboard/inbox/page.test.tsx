// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The inbox page decides between the inbox and "connect a number" from a read
// behind the INBOX gate, so a role with the Inbox and without Channels can use
// the inbox the sidebar shows it.

vi.mock("../lib/access", () => ({
  requireSectionAccess: vi.fn(),
}));
vi.mock("@/app/actions/inbox-actions", () => ({
  getInboxChannelState: vi.fn(),
  getInboxConversations: vi.fn(async () => ({
    rows: [],
    total: 0,
    counts: { needs_reply: 0, open: 0, closed: 0, all: 0 },
  })),
  getInboxTemplates: vi.fn(async () => ({ templates: [] })),
  getInboxWorkspace: vi.fn(async () => ({
    workspace: {
      me: { id: "a1", name: "Priya" },
      assignees: [],
      labels: [],
      cannedReplies: [],
    },
  })),
}));
// The Channels state action must not decide this page any more.
vi.mock("@/app/actions/whatsapp-provider-actions", () => ({
  getWhatsAppChannelState: vi.fn(async () => ({
    connected: false,
    planAllows: false,
  })),
}));
vi.mock("./inbox-client", () => ({
  InboxClient: vi.fn(() => "inbox client"),
}));

import { requireSectionAccess } from "../lib/access";
import { getInboxChannelState } from "@/app/actions/inbox-actions";
import { getWhatsAppChannelState } from "@/app/actions/whatsapp-provider-actions";
import { InboxClient } from "./inbox-client";
import InboxPage from "./page";

/** A role holding exactly these sections (view and manage alike). */
function role(...sections: string[]) {
  vi.mocked(requireSectionAccess).mockResolvedValue({
    can: (section: string) => sections.includes(section),
  } as any);
}

const page = async () =>
  render(await InboxPage({ searchParams: Promise.resolve({}) }));

beforeEach(() => {
  role("inbox", "channels", "ai");
});

describe("Inbox page", () => {
  it("★ a role with the Inbox and WITHOUT Channels gets the inbox of a connected store", async () => {
    role("inbox");
    vi.mocked(getInboxChannelState).mockResolvedValue({
      channel: { connected: true, live: true, planAllows: true },
    });
    await page();
    expect(screen.getByText("inbox client")).toBeInTheDocument();
    expect(vi.mocked(InboxClient).mock.calls[0][0]).toMatchObject({
      channelLive: true,
      canManage: true,
    });
    expect(screen.queryByText(/Connect a WhatsApp number/)).toBeNull();
    expect(getWhatsAppChannelState).not.toHaveBeenCalled();
  });

  it("a paused number opens the inbox read-only for sending", async () => {
    vi.mocked(getInboxChannelState).mockResolvedValue({
      channel: { connected: true, live: false, planAllows: true },
    });
    await page();
    expect(vi.mocked(InboxClient).mock.calls[0][0]).toMatchObject({
      channelLive: false,
    });
  });

  it("no number: says so, with Open Channels only for someone who can open it", async () => {
    vi.mocked(getInboxChannelState).mockResolvedValue({
      channel: { connected: false, live: false, planAllows: true },
    });
    const { unmount } = await page();
    expect(
      screen.getByText("Connect a WhatsApp number to use the inbox"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Channels" })).toHaveAttribute(
      "href",
      "/dashboard/channels",
    );
    expect(InboxClient).not.toHaveBeenCalled();
    unmount();

    role("inbox");
    await page();
    expect(
      screen.getByText("Connect a WhatsApp number to use the inbox"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("a plan without WhatsApp points at Plans, for someone who can open it", async () => {
    vi.mocked(getInboxChannelState).mockResolvedValue({
      channel: { connected: false, live: false, planAllows: false },
    });
    await page();
    expect(
      screen.getByText(/included from the Basic plan/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See plans" })).toHaveAttribute(
      "href",
      "/dashboard/plans",
    );
  });

  it("★ an unreadable state says so, never 'connect a number'", async () => {
    vi.mocked(getInboxChannelState).mockResolvedValue({
      channel: null,
      error:
        "Couldn't check your WhatsApp number. Reload the page to try again.",
    });
    await page();
    expect(
      screen.getByText("Couldn't check your WhatsApp number"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Connect a WhatsApp number/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(InboxClient).not.toHaveBeenCalled();
  });
});
