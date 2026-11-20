"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertTriangle,
  Lock,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoTip } from "@/components/ui/info-tip";
import {
  connectWhatsApp,
  disconnectWhatsApp,
  refreshWhatsApp,
  setupWhatsAppTemplates,
  setWhatsAppEnabled,
  type WhatsAppChannelState,
} from "@/app/actions/whatsapp-provider-actions";
import { runEmbeddedSignup } from "./embedded-signup";
import { WhatsAppQr } from "./whatsapp-qr";
import { FeatureToggles } from "@/app/dashboard/components/feature-toggles";
import type { EditorSetting } from "@/app/actions/store-settings";

// ---------------------------------------------------------------------------
// Channels → WhatsApp. Connect through Meta's popup; afterwards show what Meta
// says about the number and the one thing a merchant must still do.
//
// ★ COEXISTENCE IS ASKED BEFORE THE POPUP (docs/whatsapp-commerce-plan.md §7).
// A number already on the WhatsApp Business app needs Meta's Coexistence
// onboarding, a different popup flow; asking afterwards means a merchant who
// picked the wrong path gets an error from Meta they cannot act on.
// ---------------------------------------------------------------------------

const TIER_LABEL: Record<string, string> = {
  TIER_50: "50 customers / day",
  TIER_250: "250 customers / day",
  TIER_1K: "1,000 customers / day",
  TIER_10K: "10,000 customers / day",
  TIER_100K: "100,000 customers / day",
  TIER_UNLIMITED: "Unlimited",
};

const QUALITY_TONE: Record<string, string> = {
  GREEN: "text-green-700 bg-green-50",
  YELLOW: "text-amber-700 bg-amber-50",
  RED: "text-red-700 bg-red-50",
};

export function WhatsAppModal({
  state,
  canManage,
  onClose,
  onState,
  onRefresh,
  settings,
}: {
  state: WhatsAppChannelState;
  /** The WhatsApp registry group (SMS/WhatsApp precedence), rendered below
   *  the connection facts once connected. */
  settings?: { plan: string; settings: EditorSetting[] };
  canManage: boolean;
  onClose: () => void;
  onState: React.Dispatch<React.SetStateAction<WhatsAppChannelState>>;
  onRefresh: () => void;
}) {
  const [coexistence, setCoexistence] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const canConnect =
    canManage && state.configured && state.planAllows && coexistence !== null;

  async function handleConnect() {
    if (coexistence === null) return;
    setBusy(true);
    const popup = await runEmbeddedSignup({
      appId: state.appId,
      configId: state.configId,
      graphVersion: state.graphVersion,
      coexistence,
    });
    if (!popup.ok) {
      setBusy(false);
      if (!popup.cancelled) toast.error(popup.error);
      return;
    }
    const result = await connectWhatsApp({
      code: popup.code,
      wabaId: popup.wabaId,
      phoneNumberId: popup.phoneNumberId,
      coexistence,
    });
    setBusy(false);
    if (result.error) return toast.error(result.error);
    onState((s) => ({
      ...s,
      connected: true,
      enabled: true,
      status: "connected",
      displayPhone: result.displayPhone ?? s.displayPhone,
      coexistence,
      lastError: null,
    }));
    toast.success(`WhatsApp connected: ${result.displayPhone ?? ""}`.trim());
    onRefresh();
  }

  async function handleToggle() {
    setBusy(true);
    const next = !state.enabled;
    const result = await setWhatsAppEnabled(next);
    setBusy(false);
    if (result.error) return toast.error(result.error);
    onState((s) => ({ ...s, enabled: next }));
    toast.success(next ? "WhatsApp enabled." : "WhatsApp paused.");
    onRefresh();
  }

  async function handleSetupTemplates() {
    setBusy(true);
    const res = await setupWhatsAppTemplates();
    setBusy(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success(
      res.submitted
        ? `${res.submitted} template${res.submitted === 1 ? "" : "s"} sent to Meta for review.`
        : "Templates are up to date.",
    );
    onRefresh();
  }

  async function handleRefresh() {
    setBusy(true);
    const result = await refreshWhatsApp();
    setBusy(false);
    if (result.error) return toast.error(result.error);
    toast.success("Updated from Meta.");
    onRefresh();
  }

  async function handleDisconnect() {
    if (
      !window.confirm(
        "Disconnect WhatsApp? Order updates and the inbox stop for this number. Your Meta account and number are untouched; you can reconnect any time.",
      )
    )
      return;
    setBusy(true);
    const result = await disconnectWhatsApp();
    setBusy(false);
    if (result.error) return toast.error(result.error);
    onState((s) => ({
      ...s,
      connected: false,
      enabled: false,
      status: null,
      displayPhone: null,
      verifiedName: null,
      nameStatus: null,
      messagingTier: null,
      qualityRating: null,
      lastError: null,
      chatLink: null,
    }));
    toast.success("WhatsApp disconnected.");
    onRefresh();
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-[7.5rem] shrink-0 items-center justify-center">
              {/* The logo the card shows, sized like the Shiprocket and Twilio
                  dialogs' (24px tall). An SVG must skip the optimizer
                  (ChannelLogo explains why). */}
              <Image
                src="/channels/whatsapp.svg"
                alt=""
                width={103}
                height={24}
                unoptimized
              />
            </span>
            <div className="grid gap-1">
              <DialogTitle>WhatsApp</DialogTitle>
              <DialogDescription>
                Your own number, connected through Meta
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {state.connected ? (
          <>
            <ConnectedView
              state={state}
              canManage={canManage}
              busy={busy}
              onSetupTemplates={handleSetupTemplates}
            />
            {/* The one setting that belongs to this channel. Rendered by
                the shared registry card so the select, its plan lock and
                its save all behave exactly as on every other settings
                page, and so the Help guide's "Channels → WhatsApp →
                Settings" names a control that exists. */}
            {settings && settings.settings.length > 0 && (
              <FeatureToggles
                title="Settings"
                subtitle="Applies to the next message sent."
                successMessage="WhatsApp settings saved."
                plan={settings.plan}
                initialSettings={settings.settings}
                canManage={canManage}
              />
            )}
          </>
        ) : (
          <ConnectView
            state={state}
            coexistence={coexistence}
            onCoexistence={setCoexistence}
          />
        )}

        {canManage && (
          <DialogFooter>
            {state.connected ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-red-600 hover:bg-red-50 hover:text-red-700 sm:mr-auto"
                  onClick={handleDisconnect}
                  disabled={busy}
                >
                  <Unplug /> Disconnect
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleRefresh}
                  disabled={busy}
                >
                  <RefreshCw /> Refresh from Meta
                </Button>
                <Button
                  type="button"
                  onClick={handleToggle}
                  disabled={busy || state.status === "needs_reauth"}
                >
                  {state.enabled ? "Pause" : "Resume"}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={handleConnect}
                disabled={busy || !canConnect}
                className="bg-[#25D366] text-white hover:bg-[#1fb857]"
              >
                <MessageCircle />
                {busy ? "Waiting for Meta…" : "Connect with Meta"}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectedView({
  state,
  canManage,
  busy,
  onSetupTemplates,
}: {
  state: WhatsAppChannelState;
  canManage: boolean;
  busy: boolean;
  onSetupTemplates: () => void;
}) {
  const tier = state.messagingTier
    ? (TIER_LABEL[state.messagingTier] ?? state.messagingTier)
    : "Not reported yet";
  const quality = state.qualityRating ?? "UNKNOWN";
  const reauth = state.status === "needs_reauth";
  return (
    <>
      <div className="rounded-lg border border-[rgba(17,24,39,0.08)] bg-[#f9fafb] p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-mono text-sm text-[#111827]">
              {state.displayPhone}
            </p>
            <p className="mt-1 text-xs text-[#5b6472]">
              {state.verifiedName
                ? `Shown to customers as “${state.verifiedName}”`
                : "Display name not set yet"}
              {state.nameStatus && state.nameStatus !== "APPROVED"
                ? ` · name ${state.nameStatus.toLowerCase().replace(/_/g, " ")}`
                : ""}
            </p>
          </div>
          {reauth ? (
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
          ) : (
            <ShieldCheck className="h-5 w-5 shrink-0 text-green-600" />
          )}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
          <div>
            <dt className="text-[#5b6472]">Daily sending limit</dt>
            <dd className="text-[#111827]">{tier}</dd>
          </div>
          <div>
            <dt className="text-[#5b6472]">Quality rating</dt>
            <dd>
              <span
                className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${QUALITY_TONE[quality] ?? "bg-[#f1f3f5] text-[#5b6472]"}`}
              >
                {quality}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-[#5b6472]">
              Also on the WhatsApp Business app
            </dt>
            <dd className="text-[#111827]">
              {state.coexistence ? "Yes" : "No"}
            </dd>
          </div>
          <div>
            <dt className="text-[#5b6472]">Status</dt>
            <dd className="text-[#111827]">
              {reauth
                ? "Needs reconnecting"
                : state.enabled
                  ? "Live"
                  : "Paused"}
            </dd>
          </div>
        </dl>
      </div>

      {state.lastError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-[#111827]">From Meta</p>
          <p className="mt-1 text-xs text-[#5b6472]">{state.lastError}</p>
        </div>
      )}

      {/* Templates: the half that makes the number useful. Order updates send
          only through a template Meta has approved, so a connected number with
          none approved sends nothing — said here, with the count, rather than
          discovered as silence. */}
      <div className="rounded-lg border border-[rgba(17,24,39,0.08)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-semibold text-[#111827]">
                Order update templates
              </p>
              <InfoTip label="About order update templates">
                Meta usually answers within a day. Choose which message goes to
                whom under Settings → Notifications.
              </InfoTip>
            </div>
            <p className="mt-1 text-xs text-[#5b6472]">
              {state.templates.approved} of {state.templates.total} approved by
              Meta
              {state.templates.pending > 0
                ? ` · ${state.templates.pending} still in review`
                : ""}
              {state.templates.unsubmitted > 0
                ? ` · ${state.templates.unsubmitted} still to submit`
                : ""}
              . Each message sends once Meta approves its template.{" "}
              <Link
                href="/dashboard/channels/whatsapp/templates"
                className="font-medium text-[#111827] underline"
              >
                Manage templates
              </Link>
            </p>
          </div>
          {/* ★ Offered whenever Meta holds nothing for a template: never
              submitted, refused or unanswered at submission, or reset by a
              WABA change. Such a row is PENDING too, so "approved + in
              review < total" hid the one button that resubmits it. */}
          {canManage && state.templates.unsubmitted > 0 && (
            <button
              type="button"
              onClick={onSetupTemplates}
              disabled={busy || reauth}
              className="shrink-0 rounded-md border border-[rgba(17,24,39,0.16)] px-3 py-1.5 text-xs font-medium text-[#111827] hover:bg-[#f9fafb] disabled:opacity-50"
            >
              Set up templates
            </button>
          )}
        </div>
      </div>

      {/* The way IN for customers: scan or tap, and the first message opens
          the 24-hour window. The storefront button's switch sits in the
          Settings card below this one. */}
      {state.chatLink && (
        <div className="rounded-lg border border-[rgba(17,24,39,0.08)] p-4">
          <p className="text-sm font-semibold text-[#111827]">
            Chat link and QR code
          </p>
          <p className="mb-3 mt-1 text-xs text-[#5b6472]">
            Print it for your counter or packaging, or share the link. Replies
            arrive in Inbox.
          </p>
          <WhatsAppQr href={state.chatLink} />
        </div>
      )}

      <div className="rounded-lg border border-[rgba(17,24,39,0.08)] p-4">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-semibold text-[#111827]">
            One thing Meta needs from you
          </p>
          <InfoTip label="About WhatsApp billing">
            Add it in WhatsApp Manager under Billing &amp; payments. Replies to
            customers who message you first are free.
          </InfoTip>
        </div>
        <p className="mt-1 text-xs text-[#5b6472]">
          Meta bills order updates and offers to <em>your</em> account. Add a
          payment method in WhatsApp Manager, or nothing is sent.
        </p>
      </div>
    </>
  );
}

function ConnectView({
  state,
  coexistence,
  onCoexistence,
}: {
  state: WhatsAppChannelState;
  coexistence: boolean | null;
  onCoexistence: (v: boolean) => void;
}) {
  return (
    <>
      <p className="text-sm text-[#5b6472]">
        You&apos;ll log in with Facebook in Meta&apos;s window and confirm the
        number with a code. StoreMink never sees your password.
      </p>

      {!state.planAllows && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-[#5b6472]">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>
            WhatsApp is available on the Basic plan and above. Upgrade under
            Plans &amp; Billing to connect.
          </span>
        </div>
      )}
      {!state.configured && state.planAllows && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-[#5b6472]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>WhatsApp isn&apos;t switched on for this environment yet.</span>
        </div>
      )}

      <fieldset className="rounded-lg border border-[rgba(17,24,39,0.08)] p-4">
        <legend className="px-1 text-xs font-semibold text-[#344054]">
          Is this number already on the WhatsApp Business app?
        </legend>
        <label className="mt-2 flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-[#f9fafb]">
          <input
            type="radio"
            name="coexistence"
            checked={coexistence === true}
            onChange={() => onCoexistence(true)}
            className="mt-1"
          />
          <span className="text-sm">
            <span className="font-medium text-[#111827]">
              Yes - I use the app on my phone
            </span>
            <span className="mt-0.5 block text-xs text-[#5b6472]">
              Keep replying from your phone; the same chats show in your
              dashboard. Group chats aren&apos;t synced.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-[#f9fafb]">
          <input
            type="radio"
            name="coexistence"
            checked={coexistence === false}
            onChange={() => onCoexistence(false)}
            className="mt-1"
          />
          <span className="text-sm">
            <span className="font-medium text-[#111827]">
              No - it&apos;s a new number, or not on WhatsApp
            </span>
            <span className="mt-0.5 block text-xs text-[#5b6472]">
              The number works through StoreMink only. Remove it from the normal
              WhatsApp app first.
            </span>
          </span>
        </label>
      </fieldset>
    </>
  );
}
