import Link from "next/link";
import { Mail } from "lucide-react";
import { ResponsiveTable } from "@/app/dashboard/components/responsive-table";
import {
  getActingStoreId,
  requireSectionAccess,
} from "@/app/dashboard/lib/access";
import { istShortDate } from "@/lib/billing/tax-copy";
import { NOTICES, noticeReasonLabel } from "@/lib/moderation/copy";
import {
  listStoreNotices,
  type StoreNoticeRow,
} from "@/lib/moderation/merchant";

/**
 * Settings, Notices from StoreMink (takedown design 7.1): everything
 * StoreMink blocked on this store that the store was told about, newest
 * first. Anyone with Settings view reads it; a block kept from the store
 * (D21) is never listed. The store comes from the request host.
 */

export const metadata = { title: NOTICES.title };

const LINK =
  "inline-flex items-center font-medium text-[var(--dash-text)] hover:underline pointer-coarse:min-h-11";
const SUB_LINK =
  "inline-flex items-center text-xs text-[var(--dash-text-2)] hover:underline pointer-coarse:min-h-11";

function noticeHref(blockId: string): string {
  return `/dashboard/settings/notices/${blockId}`;
}

function StateBadge({ lifted }: { lifted: boolean }) {
  return lifted ? (
    <span className="dash-badge dash-badge-grey">{NOTICES.states.lifted}</span>
  ) : (
    <span className="dash-badge dash-badge-storemink">
      {NOTICES.states.blocked}
    </span>
  );
}

function NoticeRow({ notice }: { notice: StoreNoticeRow }) {
  return (
    <tr>
      <td>
        <Link href={noticeHref(notice.blockId)} className={LINK}>
          {notice.itemLabel}
        </Link>
        {notice.images.length > 0 && (
          <ul className="mt-1 flex flex-col">
            {notice.images.map((image) => (
              <li key={image.blockId}>
                <Link href={noticeHref(image.blockId)} className={SUB_LINK}>
                  {image.label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="text-sm text-[var(--dash-text-2)]">
        {istShortDate(notice.blockedAt)}
      </td>
      <td className="text-sm text-[var(--dash-text-2)]">
        {noticeReasonLabel(notice.reasonKind)}
      </td>
      <td>
        <StateBadge lifted={notice.liftedAt !== null} />
      </td>
    </tr>
  );
}

export default async function StoreNoticesPage() {
  await requireSectionAccess("settings", "view");
  const storeId = await getActingStoreId();
  const notices = await listStoreNotices(storeId);

  return (
    <div className="dash-page-enter mx-auto w-full max-w-4xl">
      <header className="dash-page-header mb-6">
        <h1>{NOTICES.title}</h1>
        <p className="max-w-2xl">{NOTICES.intro}</p>
      </header>

      {notices.length === 0 ? (
        <div className="dash-card">
          <div className="dash-empty">
            <Mail className="dash-empty-icon" aria-hidden="true" />
            <p className="dash-empty-text">{NOTICES.empty}</p>
          </div>
        </div>
      ) : (
        <div className="dash-card overflow-hidden">
          <ResponsiveTable className="dash-table w-full">
            <thead>
              <tr>
                <th>{NOTICES.columns.item}</th>
                <th>{NOTICES.columns.blockedOn}</th>
                <th>{NOTICES.columns.why}</th>
                <th>{NOTICES.columns.state}</th>
              </tr>
            </thead>
            <tbody>
              {notices.map((notice) => (
                <NoticeRow key={notice.blockId} notice={notice} />
              ))}
            </tbody>
          </ResponsiveTable>
        </div>
      )}
    </div>
  );
}
