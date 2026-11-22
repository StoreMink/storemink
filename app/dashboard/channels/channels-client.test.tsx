// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({
  routerRefresh: vi.fn(),
  setWhatsAppEnabled: vi.fn(),
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.routerRefresh }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/app/actions/payment-provider-actions", () => ({
  disconnectRazorpay: vi.fn(),
  generateWebhookSecret: vi.fn(),
  saveRazorpayCredentials: vi.fn(),
  setRazorpayEnabled: vi.fn(),
}));
vi.mock("@/app/actions/sms-provider-actions", () => ({
  disconnectSms: vi.fn(),
  saveSmsCredentials: vi.fn(),
  setSmsEnabled: vi.fn(),
}));
vi.mock("@/app/actions/logistics-provider-actions", () => ({
  disconnectShiprocket: vi.fn(),
  rotateShiprocketWebhookSecret: vi.fn(),
  saveShiprocketCredentials: vi.fn(),
  setShiprocketEnabled: vi.fn(),
  syncShiprocketPickupLocations: vi.fn(),
}));
vi.mock("@/app/actions/whatsapp-provider-actions", () => ({
  connectWhatsApp: vi.fn(),
  disconnectWhatsApp: vi.fn(),
  refreshWhatsApp: vi.fn(),
  setupWhatsAppTemplates: vi.fn(),
  setWhatsAppEnabled: h.setWhatsAppEnabled,
}));
vi.mock("./embedded-signup", () => ({ runEmbeddedSignup: vi.fn() }));
vi.mock("./whatsapp-qr", () => ({
  WhatsAppQr: ({ href }: { href: string }) => <p>QR for {href}</p>,
}));
vi.mock("@/app/dashboard/components/feature-toggles", () => ({
  FeatureToggles: () => null,
}));

import { ChannelsClient } from "./channels-client";
import type { WhatsAppChannelState } from "@/app/actions/whatsapp-provider-actions";

const PAYMENT = {
  connected: false,
  keyId: null,
  enabled: false,
  planAllowsOnlinePayments: true,
  webhookConfigured: false,
  webhookLastEventAt: null,
  webhookUrl: null,
};
const SHIPROCKET = {
  availableOnPlan: true,
  connected: false,
  enabled: false,
  accountEmail: null,
  connectionId: null,
  webhookUrl: null,
  mappedLocations: 0,
  eligibleLocations: 0,
};
const SMS = {
  connected: false,
  enabled: false,
  accountSid: null,
  senderHeader: null,
  dltEntityId: null,
  verifiedAt: null,
};

/** What the server knew right after connecting: the action patched in the
 *  number, nothing else. */
const JUST_CONNECTED: WhatsAppChannelState = {
  connected: true,
  enabled: true,
  status: "connected",
  displayPhone: "+91 98765 43210",
  verifiedName: null,
  nameStatus: null,
  messagingTier: null,
  qualityRating: null,
  coexistence: false,
  lastError: null,
  planAllows: true,
  templates: { approved: 0, pending: 0, unsubmitted: 20, total: 20 },
  chatLink: null,
  configured: true,
  appId: "APP",
  configId: "CFG",
  graphVersion: "v26.0",
};

function page(whatsApp: WhatsAppChannelState) {
  return (
    <ChannelsClient
      initialState={PAYMENT}
      initialShiprocketState={SHIPROCKET}
      initialSmsState={SMS}
      initialWhatsAppState={whatsApp}
      canManage
    />
  );
}

/** The WhatsApp card on the grid (the modal repeats some of its words). */
function whatsAppCard(): HTMLElement {
  const card = screen
    .getAllByText("WhatsApp")
    .map((el) => el.closest<HTMLElement>('[role="button"]'))
    .find((el): el is HTMLElement => el !== null);
  if (!card) throw new Error("no WhatsApp card");
  return card;
}

function openWhatsApp() {
  fireEvent.click(whatsAppCard());
}

beforeEach(() => {
  h.setWhatsAppEnabled.mockResolvedValue({ success: true });
});

describe("ChannelsClient after router.refresh()", () => {
  it("★★ the WhatsApp card and modal follow the server's new state", () => {
    const view = render(page(JUST_CONNECTED));
    openWhatsApp();
    expect(screen.getByText("Display name not set yet")).toBeInTheDocument();
    expect(screen.getByText(/0 of 20 approved by Meta/)).toBeInTheDocument();
    expect(within(whatsAppCard()).getByText("Live")).toBeInTheDocument();

    // The refresh lands: Meta's facts, the templates bootstrapped, the QR
    // link, and a token Refresh found revoked.
    view.rerender(
      page({
        ...JUST_CONNECTED,
        verifiedName: "Echos",
        nameStatus: "APPROVED",
        status: "needs_reauth",
        templates: { approved: 20, pending: 0, unsubmitted: 0, total: 20 },
        chatLink: "https://wa.me/919876543210",
      }),
    );
    expect(
      screen.getByText(/Shown to customers as “Echos”/),
    ).toBeInTheDocument();
    expect(screen.getByText(/20 of 20 approved by Meta/)).toBeInTheDocument();
    expect(screen.getByText("Needs reconnecting")).toBeInTheDocument();
    expect(
      screen.getByText("QR for https://wa.me/919876543210"),
    ).toBeInTheDocument();
    // The card stops claiming "Live" for a connection Meta no longer takes.
    expect(within(whatsAppCard()).queryByText("Live")).not.toBeInTheDocument();
    expect(within(whatsAppCard()).getByText("Paused")).toBeInTheDocument();
  });

  it("an action's own result still shows at once, and a re-render with the same server state keeps it", async () => {
    const view = render(page(JUST_CONNECTED));
    openWhatsApp();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Resume" }),
      ).toBeInTheDocument(),
    );
    expect(h.routerRefresh).toHaveBeenCalled();
    // A re-render that brings no new server state does not undo it.
    view.rerender(page(JUST_CONNECTED));
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    // The server's answer, when it comes, is what shows.
    view.rerender(page({ ...JUST_CONNECTED, enabled: false }));
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    view.rerender(page({ ...JUST_CONNECTED }));
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });
});
