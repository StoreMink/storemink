import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { ITEM, homeBanner } from "@/lib/moderation/copy";
import {
  storeNoticeSummary,
  type StoreNoticeSummary,
} from "@/lib/moderation/merchant";

/**
 * Dashboard Home's banner while a notice from StoreMink is unopened (takedown
 * design 7.3): "StoreMink has blocked {1 item | N items} on your store." with
 * See why, which opens the notice itself when there is one and the list when
 * there are several.
 *
 * ★ READ BY THE HOME PAGE ALONE, so no other page pays for it, and never an
 * error: `storeNoticeSummary` fails soft to nothing unopened, and a throw is
 * caught here too. A blip must cost the banner, never the dashboard.
 *
 * ★ A BLOCK KEPT FROM THE STORE SHOWS NOTHING (D21): the summary counts only
 * blocks the store was told about, live and not erased, whose notice nobody
 * at the store has opened yet (`merchant_seen_at`, store-wide).
 */

const NOTICES_HREF = "/dashboard/settings/notices";
const TEXT_ID = "store-notice-banner-text";

/** Where See why goes: the one notice, or the list when there are several. */
export function storeNoticeHref(summary: StoreNoticeSummary): string {
  return summary.unopened === 1 && summary.onlyBlockId
    ? `${NOTICES_HREF}/${summary.onlyBlockId}`
    : NOTICES_HREF;
}

export function StoreNoticeBannerView({
  summary,
}: {
  summary: StoreNoticeSummary;
}) {
  if (!(summary.unopened > 0)) return null;
  return (
    <section
      aria-labelledby={TEXT_ID}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--dash-radius)] border border-[var(--dash-red)]/30 bg-[var(--dash-red-soft)] px-4 py-3"
    >
      <ShieldAlert
        className="h-5 w-5 shrink-0 text-[var(--dash-red)]"
        aria-hidden="true"
      />
      <p
        id={TEXT_ID}
        className="min-w-0 flex-1 basis-56 text-[13.5px] font-medium text-[var(--dash-text)]"
      >
        {homeBanner(summary.unopened)}
      </p>
      <Link
        href={storeNoticeHref(summary)}
        aria-describedby={TEXT_ID}
        className="dash-btn dash-btn-ghost dash-btn-sm shrink-0 pointer-coarse:min-h-11"
      >
        {ITEM.seeWhy}
      </Link>
    </section>
  );
}

export async function StoreNoticeBanner({ storeId }: { storeId: string }) {
  let summary: StoreNoticeSummary;
  try {
    summary = await storeNoticeSummary(storeId);
  } catch {
    // storeNoticeSummary logs and fails soft itself; this only guards a
    // future change to it. Nothing shown is the safe answer.
    return null;
  }
  return <StoreNoticeBannerView summary={summary} />;
}
