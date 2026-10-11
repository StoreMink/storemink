import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { requireSectionAccess } from "../lib/access";
import { pickParam } from "../lib/list-params";
import {
  getInboxConversations,
  getInboxTemplates,
} from "@/app/actions/inbox-actions";
import { getWhatsAppChannelState } from "@/app/actions/whatsapp-provider-actions";
import { InboxClient } from "./inbox-client";

// The WhatsApp inbox (docs/whatsapp-commerce-plan.md §11). Conversations on
// the left, the open thread on the right, the customer's orders beside it.
export const metadata = { title: "Inbox" };

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireSectionAccess("inbox", "view");
  const sp = await searchParams;
  const open = pickParam(sp.c);

  const [channel, list, templates] = await Promise.all([
    getWhatsAppChannelState(),
    getInboxConversations({ filter: "all", q: "", page: 1 }),
    getInboxTemplates(),
  ]);

  if (!channel.connected) {
    return (
      <div className="dash-page-enter flex flex-col gap-4">
        <header className="dash-page-header row">
          <div>
            <h1>Inbox</h1>
            <p>Customer conversations on your WhatsApp number.</p>
          </div>
        </header>
        <section className="dash-card px-5 py-10 text-center">
          <MessageCircle className="mx-auto mb-3 h-6 w-6 opacity-40" />
          <p className="text-[14px] font-medium text-[var(--dash-text)]">
            Connect a WhatsApp number to use the inbox
          </p>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-[var(--dash-text-3)]">
            {channel.planAllows
              ? "Once your number is connected, every message a customer sends to it appears here, and replies to your order updates land in the same place."
              : "WhatsApp is included from the Basic plan. Upgrade under Plans & Billing, then connect your number in Channels."}
          </p>
          <Link
            href={
              channel.planAllows ? "/dashboard/channels" : "/dashboard/plans"
            }
            className="mt-4 inline-flex rounded-md bg-[var(--dash-text)] px-4 py-2 text-[13px] font-semibold text-[var(--dash-surface)]"
          >
            {channel.planAllows ? "Open Channels" : "See plans"}
          </Link>
        </section>
      </div>
    );
  }

  return (
    <InboxClient
      initial={list}
      templates={templates.templates}
      canManage={access.can("inbox", "manage")}
      channelLive={channel.enabled && channel.status === "connected"}
      initialConversationId={open || null}
    />
  );
}
