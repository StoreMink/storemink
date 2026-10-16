// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({
  connect: vi.fn(),
  setup: vi.fn(),
  signup: vi.fn(),
}));

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- stands in for next/image in jsdom
  default: ({ src, alt }: any) => <img src={src} alt={alt} />,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/app/actions/whatsapp-provider-actions", () => ({
  connectWhatsApp: h.connect,
  disconnectWhatsApp: vi.fn(),
  refreshWhatsApp: vi.fn(),
  setupWhatsAppTemplates: h.setup,
  setWhatsAppEnabled: vi.fn(),
}));
vi.mock("./embedded-signup", () => ({ runEmbeddedSignup: h.signup }));
vi.mock("./whatsapp-qr", () => ({
  WhatsAppQr: ({ href }: { href: string }) => <p>{href}</p>,
}));
vi.mock("@/app/dashboard/components/feature-toggles", () => ({
  FeatureToggles: () => null,
}));

import { WhatsAppModal } from "./whatsapp-modal";
import type { WhatsAppChannelState } from "@/app/actions/whatsapp-provider-actions";

const state = (
  over: Partial<WhatsAppChannelState> = {},
): WhatsAppChannelState => ({
  connected: true,
  enabled: true,
  status: "connected",
  displayPhone: "+91 98765 43210",
  verifiedName: "Echos",
  nameStatus: "APPROVED",
  messagingTier: "TIER_1K",
  qualityRating: "GREEN",
  coexistence: false,
  lastError: null,
  planAllows: true,
  templates: { approved: 20, pending: 0, unsubmitted: 0, total: 20 },
  chatLink: null,
  configured: true,
  appId: "APP",
  configId: "CFG",
  graphVersion: "v26.0",
  ...over,
});

function show(s: WhatsAppChannelState) {
  return render(
    <WhatsAppModal
      state={s}
      canManage
      onClose={vi.fn()}
      onState={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
}

beforeEach(() => {
  h.setup.mockResolvedValue({ success: true, submitted: 3, approved: 17 });
  h.connect.mockResolvedValue({ success: true, displayPhone: "+91 98765" });
});

describe("Set up templates", () => {
  it("★★ is offered while Meta holds nothing for some templates, and says how many", async () => {
    // 17 approved and 3 refused at submission: the refused rows are PENDING
    // too, which used to read as "in review" and hide this button.
    show(
      state({
        templates: { approved: 17, pending: 0, unsubmitted: 3, total: 20 },
      }),
    );
    expect(screen.getByText(/3 still to submit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up templates" }));
    await waitFor(() => expect(h.setup).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["all approved or in review", { approved: 18, pending: 2 }],
    ["Meta turned them down after review", { approved: 0, pending: 0 }],
  ])("is not offered when there is nothing to send (%s)", (_n, counts) => {
    show(state({ templates: { ...counts, unsubmitted: 0, total: 20 } }));
    expect(
      screen.queryByRole("button", { name: "Set up templates" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/still to submit/)).not.toBeInTheDocument();
  });
});

describe("Connect", () => {
  it("★ hands a Coexistence finish with no number to the server as it came", async () => {
    h.signup.mockResolvedValue({
      ok: true,
      code: "CODE",
      wabaId: "2323545385144849",
      phoneNumberId: null,
    });
    show(
      state({
        connected: false,
        enabled: false,
        status: null,
        displayPhone: null,
      }),
    );
    fireEvent.click(screen.getByLabelText(/Yes - I use the app on my phone/));
    fireEvent.click(screen.getByRole("button", { name: /Connect with Meta/ }));
    await waitFor(() =>
      expect(h.connect).toHaveBeenCalledWith({
        code: "CODE",
        wabaId: "2323545385144849",
        phoneNumberId: null,
        coexistence: true,
      }),
    );
    expect(h.signup).toHaveBeenCalledWith(
      expect.objectContaining({ coexistence: true }),
    );
  });
});
