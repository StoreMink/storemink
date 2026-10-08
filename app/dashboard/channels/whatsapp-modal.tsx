"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Lock,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Unplug,
  X,
} from "lucide-react";
import {
  connectWhatsApp,
  disconnectWhatsApp,
  refreshWhatsApp,
  setWhatsAppEnabled,
  type WhatsAppChannelState,
} from "@/app/actions/whatsapp-provider-actions";
import { runEmbeddedSignup } from "./embedded-signup";

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
}: {
  state: WhatsAppChannelState;
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
        "Disconnect WhatsApp? Order updates and the inbox stop for this number. Your Meta account and number are untouched — you can reconnect any time.",
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
    }));
    toast.success("WhatsApp disconnected.");
    onRefresh();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-xl bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[rgba(17,24,39,0.08)] p-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#25D366] text-white">
              <MessageCircle className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-[#111827]">
                WhatsApp
              </h2>
              <p className="text-xs text-[#5b6472]">
                Your own number, connected through Meta
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#6b7280] hover:bg-[#f3f4f6]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {state.connected ? (
            <ConnectedView state={state} />
          ) : (
            <ConnectView
              state={state}
              coexistence={coexistence}
              onCoexistence={setCoexistence}
            />
          )}

          {canManage && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[rgba(17,24,39,0.08)] pt-4">
              {state.connected ? (
                <>
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    <Unplug className="h-4 w-4" /> Disconnect
                  </button>
                  <button
                    type="button"
                    onClick={handleRefresh}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[rgba(17,24,39,0.16)] px-3 py-2 text-sm font-medium text-[#111827] hover:bg-[#f9fafb] disabled:opacity-50"
                  >
                    <RefreshCw className="h-4 w-4" /> Refresh from Meta
                  </button>
                  <button
                    type="button"
                    onClick={handleToggle}
                    disabled={busy || state.status === "needs_reauth"}
                    className="rounded-md bg-[#111827] px-3 py-2 text-sm font-semibold text-white hover:bg-black disabled:opacity-50"
                  >
                    {state.enabled ? "Pause" : "Resume"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleConnect}
                  disabled={busy || !canConnect}
                  className="inline-flex items-center gap-2 rounded-md bg-[#25D366] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1fb857] disabled:opacity-50"
                >
                  <MessageCircle className="h-4 w-4" />
                  {busy ? "Waiting for Meta…" : "Connect with Meta"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectedView({ state }: { state: WhatsAppChannelState }) {
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

      <div className="rounded-lg border border-[rgba(17,24,39,0.08)] p-4">
        <p className="text-sm font-semibold text-[#111827]">
          One thing Meta needs from you
        </p>
        <p className="mt-1 text-xs text-[#5b6472]">
          Meta bills order updates and offers to <em>your</em> account, not to
          StoreMink. Add a payment method in WhatsApp Manager (Billing &amp;
          payments) or nothing is sent. Replies to customers who message you
          first are free.
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
        Connect the WhatsApp number customers message you on. Meta&apos;s window
        asks you to log in with Facebook, pick your business, enter the number
        and confirm it with a code. StoreMink never sees your Facebook password.
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
              Yes — I use the app on my phone
            </span>
            <span className="mt-0.5 block text-xs text-[#5b6472]">
              Keep replying from your phone; StoreMink sends updates and shows
              the same chats in your dashboard. Group chats aren&apos;t synced.
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
              No — it&apos;s a new number, or not on WhatsApp
            </span>
            <span className="mt-0.5 block text-xs text-[#5b6472]">
              The number is used through StoreMink only. A number already on the
              normal WhatsApp app has to be removed from it first.
            </span>
          </span>
        </label>
      </fieldset>
    </>
  );
}
