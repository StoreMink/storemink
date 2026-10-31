import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireSectionAccess } from "../../../lib/access";
import { getWhatsAppTemplateManager } from "@/app/actions/whatsapp-provider-actions";
import { TemplatesClient } from "./templates-client";

// Channels → WhatsApp → Templates (docs/whatsapp-commerce-plan.md §4
// Templates): every template the number holds, Meta's status for each, and
// the editor for the merchant's own. A page under Channels because templates
// belong to the connected number; gated on Channels like the card, and
// submitting or deleting needs Channels: manage.
export const metadata = { title: "WhatsApp templates" };

export default async function WhatsAppTemplatesPage() {
  await requireSectionAccess("channels", "view");
  const result = await getWhatsAppTemplateManager();

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header">
        <div>
          <Link
            href="/dashboard/channels"
            className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--dash-ink-2)] hover:underline"
          >
            <ArrowLeft size={14} /> Channels
          </Link>
          <h1>WhatsApp templates</h1>
          <p>
            Messages Meta approved for this number. Your own can be sent from
            the inbox after a chat&apos;s 24-hour window.
          </p>
        </div>
      </header>

      {result.ok ? (
        <TemplatesClient view={result.view} />
      ) : (
        <div className="dash-card max-w-3xl p-8 text-center text-sm text-[var(--dash-ink-2)]">
          {result.error}
        </div>
      )}
    </div>
  );
}
