import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireSectionAccess } from "../../lib/access";
import { getWhatsAppAutoReplies } from "@/app/actions/whatsapp-auto-reply-actions";
import { AutoRepliesForm } from "./auto-replies-form";

// Inbox → Automatic replies (docs/whatsapp-commerce-plan.md §4 Automation).
// A page under Inbox rather than a card on the Channels page, because these
// decide how conversations are handled, and Inbox is where a merchant looks
// for them. Gated on Inbox like the inbox itself; saving needs Inbox: manage.
export const metadata = { title: "Automatic replies" };

export default async function InboxSettingsPage() {
  await requireSectionAccess("inbox", "view");
  const result = await getWhatsAppAutoReplies();

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header">
        <div>
          <Link
            href="/dashboard/inbox"
            className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--dash-ink-2)] hover:underline"
          >
            <ArrowLeft size={14} /> Inbox
          </Link>
          <h1>Automatic replies</h1>
          <p>
            Replies sent for you on WhatsApp. Each is off until you turn it on.
          </p>
        </div>
      </header>

      {result.ok ? (
        <AutoRepliesForm view={result.view} />
      ) : (
        <div className="dash-card max-w-3xl p-8 text-center text-sm text-[var(--dash-ink-2)]">
          {result.error}
        </div>
      )}
    </div>
  );
}
