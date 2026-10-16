import { MessageCircle } from "lucide-react";

/**
 * Where a cash-on-delivery customer's WhatsApp answer stands
 * (`orders.cod_confirmation`, lib/whatsapp/cod-confirmation.ts). Shown only
 * when the customer was actually asked: NULL means the store had the setting
 * off, the customer had no WhatsApp opt-in, or the order predates it, and
 * saying "not confirmed" about any of those would read as a customer who
 * ignored us.
 */
export const COD_CONFIRMATION_LABEL: Record<string, string> = {
  requested: "Awaiting confirmation on WhatsApp",
  confirmed: "Confirmed on WhatsApp",
  cancelled: "Cancelled on WhatsApp",
  // The store's automatic cancellation fired because nobody answered. Not
  // "Cancelled on WhatsApp", which would say the customer chose to.
  expired: "Not confirmed on WhatsApp",
  // ★ Meta took the message and later reported it failed, so the customer
  // never saw the buttons. Not "Awaiting confirmation", which would have the
  // merchant wait for an answer that cannot come; the order is neither
  // reminded nor cancelled automatically (lib/whatsapp/cod-sweep.ts).
  undelivered: "WhatsApp message not delivered",
};

const TONE: Record<string, string> = {
  requested: "text-amber-700",
  confirmed: "text-emerald-700",
  cancelled: "text-[var(--dash-text-3)]",
  expired: "text-[var(--dash-text-3)]",
  // A failure the merchant has to act on, in the drawer's failed-payment tone.
  undelivered: "text-rose-700",
};

export function codConfirmationLabel(value: unknown): string | null {
  return typeof value === "string"
    ? (COD_CONFIRMATION_LABEL[value] ?? null)
    : null;
}

export function CodConfirmationTag({
  value,
  className = "",
}: {
  value: unknown;
  className?: string;
}) {
  const label = codConfirmationLabel(value);
  if (!label) return null;
  const tone = typeof value === "string" ? (TONE[value] ?? "") : "";
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] ${tone} ${className}`}
    >
      <MessageCircle size={11} aria-hidden />
      {label}
    </span>
  );
}
