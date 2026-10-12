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
};

const TONE: Record<string, string> = {
  requested: "text-amber-700",
  confirmed: "text-emerald-700",
  cancelled: "text-[var(--dash-text-3)]",
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
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] ${TONE[value as string] ?? ""} ${className}`}
    >
      <MessageCircle size={11} aria-hidden />
      {label}
    </span>
  );
}
