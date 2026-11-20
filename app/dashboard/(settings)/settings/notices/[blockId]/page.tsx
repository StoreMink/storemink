import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import {
  getActingStoreId,
  requireSectionAccess,
} from "@/app/dashboard/lib/access";
import { istShortDate, istTime } from "@/lib/billing/tax-copy";
import {
  NOTICE,
  NOTICES,
  NOTICE_REPLY,
  liftBanner,
  noticeReasonLabel,
  noticeTitle,
  replyTick,
  whatThisMeans,
  whatYouCanDo,
} from "@/lib/moderation/copy";
import { appealRoute } from "@/lib/moderation/kinds";
import {
  getStoreNotice,
  type StoreNotice,
  type StoreNoticeMessage,
} from "@/lib/moderation/merchant";
import { NoticeReply, NoticeSeen } from "./notice-reply";

/**
 * One notice from StoreMink (takedown design 7.1): what was blocked, why,
 * what it means, what the store can do, the conversation and the reply.
 * Reading needs Settings view; the reply form shows only with Settings
 * manage (A21). A block kept from the store (D21), another store's, an
 * erased one or a made-up id all read "We could not find this notice."
 */

export const metadata = { title: NOTICES.title };

const BACK =
  "mb-4 inline-flex items-center gap-1 text-sm text-[var(--dash-text-2)] hover:text-[var(--dash-text)] pointer-coarse:min-h-11";
const ITEM_LINK =
  "inline-flex items-center font-medium text-[var(--dash-text)] underline-offset-2 hover:underline pointer-coarse:min-h-11";

function BackLink() {
  return (
    <Link href="/dashboard/settings/notices" className={BACK}>
      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      {NOTICES.title}
    </Link>
  );
}

function when(iso: string): string {
  return `${istShortDate(iso)}, ${istTime(iso)}`;
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <section className="dash-card mt-4">
      <div className="dash-card-body">
        <h2 className="text-base font-semibold text-[var(--dash-text)]">
          {heading}
        </h2>
        <div className="mt-2 flex flex-col gap-2 text-sm text-[var(--dash-text-2)]">
          {children}
        </div>
      </div>
    </section>
  );
}

function Message({
  message,
  tick,
}: {
  message: StoreNoticeMessage;
  tick: string;
}) {
  return (
    <li className="rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)] bg-[var(--dash-surface-2)] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-[var(--dash-text)] break-all">
          {message.author}
        </span>
        <time
          dateTime={message.createdAt}
          className="text-xs text-[var(--dash-text-3)]"
        >
          {when(message.createdAt)}
        </time>
      </div>
      <p className="mt-1 text-sm whitespace-pre-wrap text-[var(--dash-text)] break-words">
        {message.body}
      </p>
      {message.asksReview && (
        <p className="mt-1 text-xs text-[var(--dash-text-2)]">{tick}</p>
      )}
    </li>
  );
}

function Facts({
  notice,
  canOpenItem,
}: {
  notice: StoreNotice;
  canOpenItem: boolean;
}) {
  const row = "grid gap-1 sm:grid-cols-[10rem_1fr] sm:gap-4";
  return (
    <dl className="dash-card mt-4">
      <div className="dash-card-body flex flex-col gap-3 text-sm">
        <div className={row}>
          <dt className="text-[var(--dash-text-2)]">{NOTICE.facts.item}</dt>
          <dd className="min-w-0 break-words text-[var(--dash-text)]">
            {notice.edit && canOpenItem ? (
              <Link href={notice.edit.href} className={ITEM_LINK}>
                {notice.itemLabel}
              </Link>
            ) : (
              notice.itemLabel
            )}
            {notice.images.length > 0 && (
              <ul className="mt-1 flex flex-col">
                {notice.images.map((image) => (
                  <li key={image.blockId}>
                    <Link
                      href={`/dashboard/settings/notices/${image.blockId}`}
                      className="inline-flex items-center text-xs text-[var(--dash-text-2)] hover:underline pointer-coarse:min-h-11"
                    >
                      {image.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-[var(--dash-text-2)]">
            {NOTICE.facts.blockedOn}
          </dt>
          <dd className="text-[var(--dash-text)]">
            {istShortDate(notice.blockedAt)}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-[var(--dash-text-2)]">{NOTICE.facts.reason}</dt>
          <dd className="text-[var(--dash-text)]">
            {noticeReasonLabel(notice.reasonKind)}
          </dd>
        </div>
        {notice.reference && (
          <div className={row}>
            <dt className="text-[var(--dash-text-2)]">
              {NOTICE.facts.reference}
            </dt>
            <dd className="font-mono text-[var(--dash-text)]">
              {notice.reference}
            </dd>
          </div>
        )}
      </div>
    </dl>
  );
}

export default async function StoreNoticePage({
  params,
}: {
  params: Promise<{ blockId: string }>;
}) {
  const access = await requireSectionAccess("settings", "view");
  const { blockId } = await params;
  const storeId = await getActingStoreId();
  const notice = await getStoreNotice(storeId, blockId);

  if (!notice) {
    return (
      <div className="dash-page-enter mx-auto w-full max-w-3xl">
        <BackLink />
        <div className="dash-card">
          <div className="dash-empty">
            <p className="dash-empty-text">{NOTICE.notFound}</p>
          </div>
        </div>
      </div>
    );
  }

  const lifted = notice.liftedAt !== null;
  const route = appealRoute(notice);
  const tick = replyTick(route);
  const canOpenItem = notice.edit
    ? access.can(notice.edit.section, "view")
    : false;
  const canReply = access.can("settings", "manage");

  return (
    <div className="dash-page-enter mx-auto w-full max-w-3xl">
      <BackLink />
      <header className="dash-page-header">
        <h1>
          {noticeTitle({
            kind: notice.kind,
            reasonKind: notice.reasonKind,
            contentType: notice.contentType,
            lifted,
          })}
        </h1>
      </header>

      {lifted && notice.liftedAt && (
        <p
          role="status"
          className="mt-4 rounded-[var(--dash-radius)] border border-[var(--dash-border)] bg-[var(--dash-green-soft)] p-3 text-sm text-[var(--dash-text)]"
        >
          {liftBanner(istShortDate(notice.liftedAt), notice.liftNote)}
        </p>
      )}

      <Facts notice={notice} canOpenItem={canOpenItem} />

      <Section heading={NOTICE.messageHeading}>
        <p className="whitespace-pre-wrap text-[var(--dash-text)]">
          {notice.storeMessage}
        </p>
      </Section>

      <Section heading={NOTICE.meaningHeading}>
        {whatThisMeans(notice.kind, notice.contentType).map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </Section>

      {!lifted && (
        <Section heading={NOTICE.canDoHeading}>
          {whatYouCanDo(notice).map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </Section>
      )}

      {notice.messages.length > 0 && (
        <ol className="mt-4 flex flex-col gap-2">
          {notice.messages.map((message) => (
            <Message key={message.id} message={message} tick={tick} />
          ))}
        </ol>
      )}

      <div className="dash-card mt-4">
        <div className="dash-card-body">
          {lifted ? (
            <p className="text-sm text-[var(--dash-text-2)]">
              {NOTICE_REPLY.errors.lifted}
            </p>
          ) : canReply ? (
            <NoticeReply blockId={notice.blockId} tickLabel={tick} />
          ) : (
            <p className="text-sm text-[var(--dash-text-2)]">
              {NOTICE_REPLY.errors.noPermission}
            </p>
          )}
        </div>
      </div>

      <NoticeSeen blockId={notice.blockId} />
    </div>
  );
}
