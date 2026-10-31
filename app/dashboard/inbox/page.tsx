import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { requireSectionAccess } from "../lib/access";
import { pickParam } from "../lib/list-params";
import {
  getInboxChannelState,
  getInboxConversations,
  getInboxTemplates,
  getInboxWorkspace,
} from "@/app/actions/inbox-actions";
import { InboxClient } from "./inbox-client";

// The WhatsApp inbox (docs/whatsapp-commerce-plan.md §11). Conversations on
// the left, the open thread on the right, the customer's orders beside it.
//
// ★ WHETHER A NUMBER IS CONNECTED IS READ BEHIND THE INBOX GATE. It came from
// the Channels card's state, which answers only people who manage Channels:
// a role with the Inbox and without Channels was shown "Connect a WhatsApp
// number" on a store that had one, and could never use the inbox the sidebar
// showed it.
export const metadata = { title: "Inbox" };

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireSectionAccess("inbox", "view");
  const sp = await searchParams;
  const open = pickParam(sp.c);

  const [state, list, templates, workspace] = await Promise.all([
    getInboxChannelState(),
    getInboxConversations({ filter: "all", q: "", page: 1 }),
    getInboxTemplates(),
    getInboxWorkspace(),
  ]);

  const channel = state.channel;
  if (!channel || !channel.connected) {
    // A link only for someone who can open the page it leads to; the
    // sentence above it already says where the change is made.
    const link = !channel
      ? null
      : channel.planAllows
        ? access.can("channels", "view")
          ? { href: "/dashboard/channels", label: "Open Channels" }
          : null
        : access.can("ai", "view")
          ? { href: "/dashboard/plans", label: "See plans" }
          : null;
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
            {channel
              ? "Connect a WhatsApp number to use the inbox"
              : "Couldn't check your WhatsApp number"}
          </p>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-[var(--dash-text-3)]">
            {!channel
              ? (state.error ?? "Reload the page to try again.")
              : channel.planAllows
                ? "Connect your number in Channels to see customer messages here."
                : "WhatsApp is included from the Basic plan. Upgrade, then connect your number in Channels."}
          </p>
          {link && (
            <Link
              href={link.href}
              className="mt-4 inline-flex rounded-md bg-[var(--dash-text)] px-4 py-2 text-[13px] font-semibold text-[var(--dash-surface)]"
            >
              {link.label}
            </Link>
          )}
        </section>
      </div>
    );
  }

  return (
    <InboxClient
      initial={list}
      templates={templates.templates}
      workspace={workspace.workspace}
      canManage={access.can("inbox", "manage")}
      channelLive={channel.live}
      initialConversationId={open || null}
    />
  );
}
