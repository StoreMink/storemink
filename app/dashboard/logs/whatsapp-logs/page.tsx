import { requireSectionAccess } from "../../lib/access";
import { pickPage, pickParam } from "../../lib/list-params";
import { getWhatsAppLogs } from "@/app/actions/whatsapp-log-actions";
import { WhatsAppLogsView } from "./whatsapp-logs-view";

// WhatsApp logs — every message this store has sent on its own number.
//
// The sibling of SMS logs, on the SAME `activity` section. What it adds is the
// delivery timeline: Meta reports delivered and read back to us, so a row can
// say "read at 14:05" where an SMS row can only ever say "sent".
export const metadata = { title: "WhatsApp logs" };

export default async function WhatsAppLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSectionAccess("activity", "view");

  const sp = await searchParams;
  const page = pickPage(sp.page);
  const status = pickParam(sp.status);
  const q = pickParam(sp.q);
  const days = Number(pickParam(sp.days)) || 0;

  // Every filter is re-validated in the action — these are a convenience, not
  // the guard.
  const result = await getWhatsAppLogs({ page, status, q, days });

  return (
    <WhatsAppLogsView
      {...result}
      page={page}
      status={status}
      q={q}
      days={days}
    />
  );
}
